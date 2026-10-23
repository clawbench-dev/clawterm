package handler

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"clawterm/internal/forward"
	"clawterm/internal/model"
	"clawterm/internal/secret"
	"clawterm/internal/sshx"
	"clawterm/internal/store"
	"clawterm/internal/terminal"
)

// Server wires the HTTP API to the stores.
type Server struct {
	store    *store.Store
	secret   *secret.Store
	terms    *terminal.Manager
	forwards *forward.Manager

	// conns holds the SSH clients currently in use, keyed by host id, so a
	// second terminal tab on the same host reuses the connection instead of
	// opening a new SSH session (and re-running the whole auth dance).
	mu    sync.Mutex
	conns map[int64]*sshx.Client
	// refs counts how many terminals use each host connection.
	refs map[int64]int

	authMu    sync.RWMutex
	password  string // empty = no password configured (first-run)
	secretKey []byte

	version string
}

// New builds a Server. version is embedded in the binary at build time.
func New(st *store.Store, sec *secret.Store, terms *terminal.Manager, version string) *Server {
	s := &Server{
		store:    st,
		secret:   sec,
		terms:    terms,
		forwards: forward.NewManager(),
		conns:    map[int64]*sshx.Client{},
		refs:     map[int64]int{},
		version:  version,
	}
	s.password = st.GetSetting("auth.password", "")
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		// A per-process key invalidates sessions on restart, which is
		// acceptable and better than a predictable key.
		copy(key, []byte(time.Now().String()))
	}
	s.secretKey = key
	return s
}

// ── host key store adapter ───────────────────────────────────────────────────

func (s *Server) Lookup(address string) (string, string, error) {
	kh, err := s.store.GetKnownHost(address)
	if errors.Is(err, store.ErrNotFound) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	return kh.KeyType, kh.Fingerprint, nil
}

func (s *Server) Pin(address, keyType, fingerprint string) error {
	return s.store.SaveKnownHost(address, keyType, fingerprint)
}

func (s *Server) Unpin(address string) error { return s.store.DeleteKnownHost(address) }

// ── connection pool ──────────────────────────────────────────────────────────

// acquire returns a live SSH client for host, dialling when needed.
func (s *Server) acquire(h *model.Host) (*sshx.Client, string, error) {
	s.mu.Lock()
	if c, ok := s.conns[h.ID]; ok {
		s.refs[h.ID]++
		s.mu.Unlock()
		return c, "", nil
	}
	s.mu.Unlock()

	pw, err := s.secret.Get(h.ID, secret.KindPassword)
	if err != nil {
		return nil, "", err
	}
	pass, err := s.secret.Get(h.ID, secret.KindPassphrase)
	if err != nil {
		return nil, "", err
	}
	c, notice, err := sshx.Dial(h.Address, h.Port, h.Username, sshx.Auth{
		Type: h.AuthType, Password: pw, KeyPath: h.KeyPath, Passphrase: pass,
	}, s)
	if err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	// A concurrent dial may have won the race; keep theirs and close ours.
	if existing, ok := s.conns[h.ID]; ok {
		s.refs[h.ID]++
		s.mu.Unlock()
		c.Close()
		return existing, "", nil
	}
	s.conns[h.ID] = c
	s.refs[h.ID] = 1
	s.mu.Unlock()
	_ = s.store.TouchHost(h.ID)
	return c, notice, nil
}

// release drops one reference and closes the connection at zero.
func (s *Server) release(hostID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refs[hostID] > 0 {
		s.refs[hostID]--
	}
	if s.refs[hostID] == 0 {
		if c, ok := s.conns[hostID]; ok {
			delete(s.conns, hostID)
			go c.Close()
		}
	}
}

// dropConn closes a host's connection unconditionally (used after an auth
// change, so the next terminal re-authenticates).
func (s *Server) dropConn(hostID int64) {
	s.mu.Lock()
	c := s.conns[hostID]
	delete(s.conns, hostID)
	s.refs[hostID] = 0
	s.mu.Unlock()
	if c != nil {
		go c.Close()
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// apiError is a JSON error body plus the status to send.
type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string { return e.msg }

func badRequest(format string, args ...any) *apiError {
	return &apiError{status: http.StatusBadRequest, msg: fmt.Sprintf(format, args...)}
}

func notFound(msg string) *apiError { return &apiError{status: http.StatusNotFound, msg: msg} }

// fail writes err, unwrapping apiError into its status.
func fail(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeErr(w, ae.status, ae.msg)
		return
	}
	var dialErr *sshx.DialError
	if errors.As(err, &dialErr) {
		// The remote host failed, not this server: 502 keeps the two apart in
		// logs and lets the UI say "cannot reach that host" instead of "the app
		// broke".
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": dialErr.Error(),
			"code":  dialErr.Code,
		})
		return
	}
	var mismatch *sshx.HostKeyMismatch
	if errors.As(err, &mismatch) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":     "host key changed",
			"code":      "host_key_changed",
			"address":   mismatch.Address,
			"oldType":   mismatch.OldType,
			"oldFinger": mismatch.OldFinger,
			"newType":   mismatch.NewType,
			"newFinger": mismatch.NewFinger,
		})
		return
	}
	writeErr(w, http.StatusInternalServerError, err.Error())
}

func decode(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return badRequest("invalid request body: %v", err)
	}
	return nil
}

func pathID(r *http.Request) (int64, error) {
	raw := r.PathValue("id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, badRequest("invalid id %q", raw)
	}
	return id, nil
}

// ── auth ─────────────────────────────────────────────────────────────────────

const sessionCookie = "clawterm_session"

// NeedsSetup reports whether no password has been set yet.
func (s *Server) NeedsSetup() bool {
	s.authMu.RLock()
	defer s.authMu.RUnlock()
	return s.password == ""
}

func (s *Server) setPassword(pw string) {
	s.authMu.Lock()
	s.password = pw
	s.authMu.Unlock()
	_ = s.store.SetSetting("auth.password", pw)
}

func (s *Server) token() string {
	s.authMu.RLock()
	pw := s.password
	s.authMu.RUnlock()
	mac := hmac.New(sha256.New, s.secretKey)
	mac.Write([]byte("clawterm:" + pw))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) authorized(r *http.Request) bool {
	s.authMu.RLock()
	pw := s.password
	s.authMu.RUnlock()
	if pw == "" {
		// No password yet: NOTHING is authorised. The setup screen exists
		// precisely to close this state, and treating it as "open" would leave a
		// fresh install with every stored host reachable by anyone who can open
		// the URL (which on a desktop build is the whole LAN, since the server
		// binds a real interface).
		return false
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.token())) == 1
}

// RequireAuth wraps h with the session check.
func (s *Server) RequireAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeErr(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		h(w, r)
	}
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": s.authorized(r),
		"needsSetup":    s.NeedsSetup(),
		"version":       s.version,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
		Set      bool   `json:"set"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, err)
		return
	}
	if body.Password == "" {
		fail(w, badRequest("password must not be empty"))
		return
	}
	if s.NeedsSetup() {
		// First run: this request IS the authentication, so it cannot require
		// one. It is also the only request that may create the password.
		s.setPassword(body.Password)
	} else if body.Set {
		// Changing an existing password requires being signed in — otherwise
		// anyone who can reach the port could lock the owner out.
		if !s.authorized(r) {
			writeErr(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		s.setPassword(body.Password)
	} else {
		s.authMu.RLock()
		ok := subtle.ConstantTimeCompare([]byte(body.Password), []byte(s.password)) == 1
		s.authMu.RUnlock()
		if !ok {
			writeErr(w, http.StatusUnauthorized, "wrong password")
			return
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    s.token(),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((30 * 24 * time.Hour).Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── hosts ────────────────────────────────────────────────────────────────────

// hostPayload is the create/update body. Password is write-only.
type hostPayload struct {
	Name       string `json:"name"`
	Address    string `json:"address"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	AuthType   string `json:"authType"`
	KeyPath    string `json:"keyPath"`
	Password   string `json:"password"`
	Passphrase string `json:"passphrase"`
	Color      string `json:"color"`
	Group      string `json:"group"`
}

func (p *hostPayload) validate() error {
	p.Name = strings.TrimSpace(p.Name)
	p.Address = strings.TrimSpace(p.Address)
	p.Username = strings.TrimSpace(p.Username)
	if p.Name == "" {
		return badRequest("name is required")
	}
	if p.Address == "" {
		return badRequest("address is required")
	}
	if p.Username == "" {
		return badRequest("username is required")
	}
	if p.Port == 0 {
		p.Port = 22
	}
	if p.Port < 1 || p.Port > 65535 {
		return badRequest("port must be between 1 and 65535")
	}
	switch p.AuthType {
	case "":
		p.AuthType = "password"
	case "password", "key", "agent":
	default:
		return badRequest("authType must be password, key or agent")
	}
	if p.AuthType == "key" && strings.TrimSpace(p.KeyPath) == "" {
		return badRequest("keyPath is required for key authentication")
	}
	return nil
}

// decorate fills the write-only indicators.
func (s *Server) decorate(h *model.Host) {
	h.HasPassword = s.secret.Has(h.ID, secret.KindPassword)
	h.HasPassphrase = s.secret.Has(h.ID, secret.KindPassphrase)
}

func (s *Server) handleHosts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		hosts, err := s.store.ListHosts()
		if err != nil {
			fail(w, err)
			return
		}
		for _, h := range hosts {
			s.decorate(h)
		}
		writeJSON(w, http.StatusOK, hosts)

	case http.MethodPost:
		var p hostPayload
		if err := decode(r, &p); err != nil {
			fail(w, err)
			return
		}
		if err := p.validate(); err != nil {
			fail(w, err)
			return
		}
		h, err := s.store.CreateHost(&model.Host{
			Name: p.Name, Address: p.Address, Port: p.Port, Username: p.Username,
			AuthType: p.AuthType, KeyPath: p.KeyPath, Color: p.Color, Group: p.Group,
		})
		if err != nil {
			fail(w, err)
			return
		}
		if p.Password != "" {
			if err := s.secret.Set(h.ID, secret.KindPassword, p.Password); err != nil {
				fail(w, err)
				return
			}
		}
		if p.Passphrase != "" {
			if err := s.secret.Set(h.ID, secret.KindPassphrase, p.Passphrase); err != nil {
				fail(w, err)
				return
			}
		}
		s.decorate(h)
		writeJSON(w, http.StatusCreated, h)

	default:
		w.Header().Set("Allow", "GET, POST")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleHostByID(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h, err := s.store.GetHost(id)
		if errors.Is(err, store.ErrNotFound) {
			fail(w, notFound("host not found"))
			return
		}
		if err != nil {
			fail(w, err)
			return
		}
		s.decorate(h)
		writeJSON(w, http.StatusOK, h)

	case http.MethodPut:
		existing, err := s.store.GetHost(id)
		if errors.Is(err, store.ErrNotFound) {
			fail(w, notFound("host not found"))
			return
		}
		if err != nil {
			fail(w, err)
			return
		}
		var p hostPayload
		if err := decode(r, &p); err != nil {
			fail(w, err)
			return
		}
		if err := p.validate(); err != nil {
			fail(w, err)
			return
		}
		existing.Name, existing.Address, existing.Port = p.Name, p.Address, p.Port
		existing.Username, existing.AuthType, existing.KeyPath = p.Username, p.AuthType, p.KeyPath
		existing.Color, existing.Group = p.Color, p.Group
		if err := s.store.UpdateHost(existing); err != nil {
			fail(w, err)
			return
		}
		// An empty secret field means "keep the stored one" — the UI never
		// receives the plaintext, so it cannot echo it back.
		if p.Password != "" {
			if err := s.secret.Set(id, secret.KindPassword, p.Password); err != nil {
				fail(w, err)
				return
			}
		}
		if p.Passphrase != "" {
			if err := s.secret.Set(id, secret.KindPassphrase, p.Passphrase); err != nil {
				fail(w, err)
				return
			}
		}
		// Credentials or address may have changed; the pooled connection would
		// keep using the old ones.
		s.dropConn(id)
		s.decorate(existing)
		writeJSON(w, http.StatusOK, existing)

	case http.MethodDelete:
		if err := s.store.DeleteHost(id); err != nil {
			fail(w, err)
			return
		}
		s.dropConn(id)
		_ = s.secret.DeleteHost(id)
		w.WriteHeader(http.StatusNoContent)

	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleHostTest dials and immediately closes, reporting the fingerprint. Used
// by the "test connection" button before a host is saved for real.
func (s *Server) handleHostTest(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	h, err := s.store.GetHost(id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, notFound("host not found"))
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	start := time.Now()
	c, notice, err := s.acquire(h)
	if err != nil {
		fail(w, err)
		return
	}
	defer s.release(h.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"latency": time.Since(start).Milliseconds(),
		"notice":  notice,
		"addr":    c.Addr(),
	})
}

// handleHostForgetKey unpins the host key so the next connection re-pins it.
// This is the explicit "I accept the new key" action.
func (s *Server) handleHostForgetKey(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	h, err := s.store.GetHost(id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, notFound("host not found"))
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	address := fmt.Sprintf("%s:%d", h.Address, h.Port)
	if err := s.Unpin(address); err != nil {
		fail(w, err)
		return
	}
	s.dropConn(id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── snippets ─────────────────────────────────────────────────────────────────

func (s *Server) handleSnippets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		hostID, _ := strconv.ParseInt(r.URL.Query().Get("hostId"), 10, 64)
		list, err := s.store.ListSnippets(hostID)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)

	case http.MethodPost:
		var body struct {
			Label   string `json:"label"`
			Command string `json:"command"`
			HostID  int64  `json:"hostId"`
			Send    *bool  `json:"send"`
		}
		if err := decode(r, &body); err != nil {
			fail(w, err)
			return
		}
		if strings.TrimSpace(body.Label) == "" || strings.TrimSpace(body.Command) == "" {
			fail(w, badRequest("label and command are required"))
			return
		}
		send := true
		if body.Send != nil {
			send = *body.Send
		}
		sn, err := s.store.CreateSnippet(&model.Snippet{
			Label: strings.TrimSpace(body.Label), Command: body.Command,
			HostID: body.HostID, Send: send,
		})
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, sn)

	default:
		w.Header().Set("Allow", "GET, POST")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSnippetByID(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, err)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var body struct {
			Label   string `json:"label"`
			Command string `json:"command"`
			Send    bool   `json:"send"`
		}
		if err := decode(r, &body); err != nil {
			fail(w, err)
			return
		}
		if strings.TrimSpace(body.Label) == "" || strings.TrimSpace(body.Command) == "" {
			fail(w, badRequest("label and command are required"))
			return
		}
		err := s.store.UpdateSnippet(&model.Snippet{ID: id, Label: body.Label, Command: body.Command, Send: body.Send})
		if errors.Is(err, store.ErrNotFound) {
			fail(w, notFound("snippet not found"))
			return
		}
		if err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case http.MethodDelete:
		if err := s.store.DeleteSnippet(id); err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		w.Header().Set("Allow", "PUT, DELETE")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSnippetReorder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, err)
		return
	}
	if len(body.IDs) == 0 {
		fail(w, badRequest("ids must not be empty"))
		return
	}
	if err := s.store.ReorderSnippets(body.IDs); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── meta ─────────────────────────────────────────────────────────────────────

func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":     s.version,
		"terminalMax": terminal.MaxSessions,
	})
}
