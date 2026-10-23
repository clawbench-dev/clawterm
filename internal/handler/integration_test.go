package handler

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"clawterm/internal/secret"
	"clawterm/internal/store"
	"clawterm/internal/terminal"
)

// testSSHD is a minimal SSH server for the integration tests: public-key auth,
// a shell that prints a banner and echoes, and an SFTP subsystem backed by a
// real temporary directory.
type testSSHD struct {
	host    string
	port    int
	keyPath string
	root    string
}

type pinStore struct {
	mu   sync.Mutex
	pins map[string][2]string
}

func (p *pinStore) Lookup(addr string) (string, string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	v, ok := p.pins[addr]
	if !ok {
		return "", "", nil
	}
	return v[0], v[1], nil
}

func (p *pinStore) Pin(addr, kt, fp string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pins[addr] = [2]string{kt, fp}
	return nil
}

func (p *pinStore) Unpin(addr string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.pins, addr)
	return nil
}

func startTestSSHD(t *testing.T) *testSSHD {
	t.Helper()

	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	clientPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if string(key.Marshal()) == string(clientPub.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("unknown key")
		},
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go serveTestConn(c, cfg, root)
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	return &testSSHD{host: "127.0.0.1", port: addr.Port, keyPath: keyPath, root: root}
}

func serveTestConn(c net.Conn, cfg *ssh.ServerConfig, root string) {
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		switch nc.ChannelType() {
		case "session":
			ch, requests, err := nc.Accept()
			if err != nil {
				return
			}
			go serveSession(ch, requests)
		default:
			_ = nc.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func serveSession(ch ssh.Channel, requests <-chan *ssh.Request) {
	for req := range requests {
		switch req.Type {
		case "pty-req", "window-change":
			_ = req.Reply(true, nil)
		case "subsystem":
			// Payload is a uint32 length followed by the subsystem name.
			name := ""
			if len(req.Payload) >= 4 {
				name = string(req.Payload[4:])
			}
			if name != "sftp" {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			// The SFTP server needs a real filesystem; the handler tests only
			// exercise the shell path, so a stub is enough here.
			return
		case "shell":
			_ = req.Reply(true, nil)
			_, _ = ch.Write([]byte("banner\r\n"))
			buf := make([]byte, 512)
			for {
				n, err := ch.Read(buf)
				if n > 0 {
					_, _ = ch.Write(append([]byte("echo:"), buf[:n]...))
				}
				if err != nil {
					break
				}
			}
		default:
			_ = req.Reply(false, nil)
		}
	}
	_ = ch.Close()
}

// hostIDFor creates a host row pointing at the fixture sshd and returns its id.
func hostIDFor(t *testing.T, mux *http.ServeMux, cookie *http.Cookie, srv *testSSHD, name string) int64 {
	t.Helper()
	rec, body := do(t, mux, http.MethodPost, "/api/hosts", map[string]any{
		"name": name, "address": srv.host, "port": srv.port, "username": "u",
		"authType": "key", "keyPath": srv.keyPath,
	}, cookie)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create host: %d %s", rec.Code, rec.Body.String())
	}
	return int64(body["id"].(float64))
}

// ── terminal websocket ───────────────────────────────────────────────────────

// wsClient connects to the terminal socket and offers frame helpers.
type wsClient struct {
	conn *websocket.Conn
	t    *testing.T
}

func dialWS(t *testing.T, srv *httptest.Server, cookie *http.Cookie, query string) *wsClient {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/terminal/ws?" + query
	hdr := http.Header{}
	hdr.Add("Cookie", cookie.String())
	c, _, err := websocket.DefaultDialer.Dial(url, hdr)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return &wsClient{conn: c, t: t}
}

func (w *wsClient) read() map[string]any {
	w.t.Helper()
	_ = w.conn.SetReadDeadline(time.Now().Add(4 * time.Second))
	var m map[string]any
	if err := w.conn.ReadJSON(&m); err != nil {
		w.t.Fatalf("read frame: %v", err)
	}
	return m
}

// waitFor reads frames until one matches the wanted type, returning it.
func (w *wsClient) waitFor(kind string) map[string]any {
	w.t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		m := w.read()
		if m["type"] == kind {
			return m
		}
	}
	w.t.Fatalf("never saw a %q frame", kind)
	return nil
}

func (w *wsClient) send(v any) {
	w.t.Helper()
	if err := w.conn.WriteJSON(v); err != nil {
		w.t.Fatalf("write frame: %v", err)
	}
}

func TestTerminalWSEndToEnd(t *testing.T) {
	_, mux := newTestServer(t)
	cookie := loginCookie(t, mux, "pw12")
	sshd := startTestSSHD(t)
	hostID := hostIDFor(t, mux, cookie, sshd, "fixture")

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ws := dialWS(t, srv, cookie, fmt.Sprintf("hostId=%d&cols=80&rows=24", hostID))
	ready := ws.waitFor("ready")
	sessionID, _ := ready["sessionId"].(string)
	if sessionID == "" {
		t.Fatal("ready frame carried no session id")
	}

	// The banner must arrive as output (or replay).
	out := ""
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(out, "banner") {
		m := ws.read()
		if d, ok := m["data"].(string); ok {
			out += d
		}
	}
	if !strings.Contains(out, "banner") {
		t.Fatalf("never saw the shell banner, got %q", out)
	}

	// Keystrokes reach the shell and its echo comes back.
	ws.send(map[string]any{"type": "input", "data": "ping\n"})
	echo := ""
	deadline = time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(echo, "echo:ping") {
		m := ws.read()
		if d, ok := m["data"].(string); ok {
			echo += d
		}
	}
	if !strings.Contains(echo, "echo:ping") {
		t.Fatalf("input did not reach the shell, got %q", echo)
	}

	// Resize and ping must not kill the connection.
	ws.send(map[string]any{"type": "resize", "cols": 100, "rows": 30})
	ws.send(map[string]any{"type": "ping"})
	ws.waitFor("pong")

	// The session is now listed server-side.
	rec, _ := do(t, mux, http.MethodGet, "/api/terminal/sessions", nil, cookie)
	if !strings.Contains(rec.Body.String(), sessionID) {
		t.Fatalf("session %s is not listed: %s", sessionID, rec.Body.String())
	}

	// Re-attach: the scrollback must be replayed, which is the whole point of
	// keeping the PTY alive across a socket drop. The first socket has to be
	// closed first — a session has exactly one owner, so re-attaching while it
	// is still held is rejected on purpose (see the busy test below).
	_ = ws.conn.Close()
	// Give the server a moment to process the close and detach.
	time.Sleep(150 * time.Millisecond)

	ws2 := dialWS(t, srv, cookie, "session="+sessionID)
	ws2.waitFor("ready")
	replay := ""
	deadline = time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(replay, "echo:ping") {
		m := ws2.read()
		if m["type"] == "replay" {
			if d, ok := m["data"].(string); ok {
				replay += d
			}
		}
	}
	if !strings.Contains(replay, "echo:ping") {
		t.Fatalf("re-attach did not replay the scrollback, got %q", replay)
	}
}

// A session has exactly one owner: a second client must be told so rather than
// being attached to the same shell (which would fork one PTY into two screens
// with two cursors).
func TestTerminalWSRejectsSecondOwner(t *testing.T) {
	_, mux := newTestServer(t)
	cookie := loginCookie(t, mux, "pw12")
	sshd := startTestSSHD(t)
	hostID := hostIDFor(t, mux, cookie, sshd, "fixture")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ws := dialWS(t, srv, cookie, fmt.Sprintf("hostId=%d&cols=80&rows=24", hostID))
	ready := ws.waitFor("ready")
	sid := ready["sessionId"].(string)

	ws2 := dialWS(t, srv, cookie, "session="+sid)
	m := ws2.read()
	if m["type"] != "error" || m["errcode"] != "session_busy" {
		t.Fatalf("expected session_busy, got %v", m)
	}
}

// A terminal request without a host id is a client bug and must be reported as
// such, not as an empty terminal.
func TestTerminalWSRequiresHost(t *testing.T) {
	_, mux := newTestServer(t)
	cookie := loginCookie(t, mux, "pw12")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ws := dialWS(t, srv, cookie, "cols=80&rows=24")
	m := ws.read()
	if m["type"] != "error" || m["errcode"] != "bad_request" {
		t.Fatalf("expected a bad_request error, got %v", m)
	}
}

// A failed dial must surface a typed code so the UI can say something specific.
func TestTerminalWSReportsDialFailure(t *testing.T) {
	_, mux := newTestServer(t)
	cookie := loginCookie(t, mux, "pw12")

	rec, body := do(t, mux, http.MethodPost, "/api/hosts", map[string]any{
		"name": "dead", "address": "127.0.0.1", "port": 1, "username": "u",
		"authType": "password", "password": "x",
	}, cookie)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d", rec.Code)
	}
	id := int64(body["id"].(float64))

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	ws := dialWS(t, srv, cookie, fmt.Sprintf("hostId=%d&cols=80&rows=24", id))
	m := ws.read()
	if m["type"] != "error" || m["errcode"] != "connection_refused" {
		t.Fatalf("expected connection_refused, got %v", m)
	}
}

// A stale session id (reaper already collected the PTY) must produce
// session_gone, which the client treats as "start a new tab" rather than retry.
func TestTerminalWSUnknownSession(t *testing.T) {
	_, mux := newTestServer(t)
	cookie := loginCookie(t, mux, "pw12")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ws := dialWS(t, srv, cookie, "session=does-not-exist")
	m := ws.read()
	if m["type"] != "error" || m["errcode"] != "session_gone" {
		t.Fatalf("expected session_gone, got %v", m)
	}
}

// Closing the session through the API must end it, so the UI's tab count and
// the server's do not drift.
func TestTerminalSessionCloseEndsIt(t *testing.T) {
	_, mux := newTestServer(t)
	cookie := loginCookie(t, mux, "pw12")
	sshd := startTestSSHD(t)
	hostID := hostIDFor(t, mux, cookie, sshd, "fixture")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ws := dialWS(t, srv, cookie, fmt.Sprintf("hostId=%d&cols=80&rows=24", hostID))
	ready := ws.waitFor("ready")
	sid := ready["sessionId"].(string)

	rec, _ := do(t, mux, http.MethodDelete, "/api/terminal/sessions?session="+sid, nil, cookie)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("close: %d", rec.Code)
	}
	rec, _ = do(t, mux, http.MethodGet, "/api/terminal/sessions", nil, cookie)
	if strings.Contains(rec.Body.String(), sid) {
		t.Fatalf("session still listed after close: %s", rec.Body.String())
	}
}

// ── sftp ─────────────────────────────────────────────────────────────────────

// startSFTPServer serves the real sftp subsystem over a second fixture, so the
// file endpoints get a real filesystem to read.
func startSFTPServer(t *testing.T) (*testSSHD, func()) {
	t.Helper()
	fx := startTestSSHD(t)

	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostSigner, _ := ssh.NewSignerFromKey(hostPriv)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	_ = pub

	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, _ ssh.PublicKey) (*ssh.Permissions, error) {
			return nil, nil
		},
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					if nc.ChannelType() != "session" {
						_ = nc.Reject(ssh.UnknownChannelType, "")
						continue
					}
					ch, requests, err := nc.Accept()
					if err != nil {
						return
					}
					go func() {
						for req := range requests {
							if req.Type != "subsystem" {
								_ = req.Reply(false, nil)
								continue
							}
							_ = req.Reply(true, nil)
							srv, err := sftp.NewServer(ch)
							if err != nil {
								return
							}
							_ = srv.Serve()
							_ = srv.Close()
							return
						}
					}()
				}
			}()
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	fx.host = "127.0.0.1"
	fx.port = addr.Port
	return fx, func() {
		close(stop)
		_ = ln.Close()
	}
}

// ── sftp endpoints ──────────────────────────────────────────────────────────

// newSFTPFixture builds a Server plus a host whose SSH connection serves a real
// SFTP subsystem over a temp directory. The files endpoints are then exercised
// against actual files, which is the only way to catch a wrong path join or a
// truncated read.
func newSFTPFixture(t *testing.T) (*Server, *http.ServeMux, *http.Cookie, int64, string) {
	t.Helper()

	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	sec, err := secret.Open(dir)
	if err != nil {
		t.Fatalf("secret: %v", err)
	}
	terms := terminal.NewManager()
	s := New(st, sec, terms, "test")
	mux := http.NewServeMux()
	s.registerAPI(mux)
	t.Cleanup(func() {
		terms.Shutdown()
		_ = st.Close()
	})

	cookie := loginCookie(t, mux, "pw12")

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("hello sftp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	port := startSFTPServerAt(t, root)

	rec, body := do(t, mux, http.MethodPost, "/api/hosts", map[string]any{
		"name": "sftp", "address": "127.0.0.1", "port": port, "username": "u",
		"authType": "password", "password": "ignored",
	}, cookie)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create host: %d %s", rec.Code, rec.Body.String())
	}
	return s, mux, cookie, int64(body["id"].(float64)), root
}

// startSFTPServerAt runs an sshd that accepts any credential and serves SFTP
// rooted at root.
func startSFTPServerAt(t *testing.T, root string) int {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, _ []byte) (*ssh.Permissions, error) {
			return nil, nil
		},
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					if nc.ChannelType() != "session" {
						_ = nc.Reject(ssh.UnknownChannelType, "")
						continue
					}
					ch, requests, err := nc.Accept()
					if err != nil {
						return
					}
					go func() {
						for req := range requests {
							if req.Type != "subsystem" {
								_ = req.Reply(false, nil)
								continue
							}
							_ = req.Reply(true, nil)
							srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(root))
							if err != nil {
								return
							}
							_ = srv.Serve()
							_ = srv.Close()
							return
						}
					}()
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestFilesListAndRead(t *testing.T) {
	_, mux, cookie, hostID, root := newSFTPFixture(t)

	rec, body := do(t, mux, http.MethodGet, fmt.Sprintf("/api/files?hostId=%d&path=%s", hostID, root), nil, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	entries, _ := body["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d (%s)", len(entries), rec.Body.String())
	}
	// Directories sort first.
	first, _ := entries[0].(map[string]any)
	if first["name"] != "sub" || first["isDir"] != true {
		t.Fatalf("expected the directory first, got %v", first)
	}

	rec, body = do(t, mux, http.MethodGet,
		fmt.Sprintf("/api/files/content?hostId=%d&path=%s", hostID, filepath.Join(root, "note.txt")), nil, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("content: %d %s", rec.Code, rec.Body.String())
	}
	if body["content"] != "hello sftp\n" {
		t.Fatalf("wrong content %q", body["content"])
	}
	if body["truncated"] != false {
		t.Fatalf("small file should not be truncated: %v", body)
	}
}

func TestFilesContentRejectsDirectory(t *testing.T) {
	_, mux, cookie, hostID, root := newSFTPFixture(t)
	rec, _ := do(t, mux, http.MethodGet,
		fmt.Sprintf("/api/files/content?hostId=%d&path=%s", hostID, filepath.Join(root, "sub")), nil, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a directory, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestFilesDownloadStreamsBytes(t *testing.T) {
	_, mux, cookie, hostID, root := newSFTPFixture(t)
	req := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/files/download?hostId=%d&path=%s", hostID, filepath.Join(root, "note.txt")), nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("download: %d %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "hello sftp\n" {
		t.Fatalf("wrong bytes %q", rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "note.txt") {
		t.Fatalf("missing filename in %q", cd)
	}
}

// A truncated preview must SAY it is truncated: silently cutting a config file
// in half is how someone "fixes" a bug that is not there.
func TestFilesContentMarksTruncation(t *testing.T) {
	_, mux, cookie, hostID, root := newSFTPFixture(t)
	big := filepath.Join(root, "big.log")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	// 2 MiB + 1 byte, so exactly one byte over the cap.
	if _, err := f.Write(bytes.Repeat([]byte("a"), (2<<20)+1)); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	rec, body := do(t, mux, http.MethodGet,
		fmt.Sprintf("/api/files/content?hostId=%d&path=%s", hostID, big), nil, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("content: %d", rec.Code)
	}
	if body["truncated"] != true {
		t.Fatalf("expected truncated=true, got %v", body["truncated"])
	}
	content, _ := body["content"].(string)
	if len(content) != 2<<20 {
		t.Fatalf("expected exactly 2 MiB, got %d bytes", len(content))
	}
}
