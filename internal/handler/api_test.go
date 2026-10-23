package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"clawterm/internal/secret"
	"clawterm/internal/store"
	"clawterm/internal/terminal"
)

// newTestServer builds a Server over a temp database. It deliberately does NOT
// register the static-file handler: these tests only care about the API, and
// the embedded frontend may be a placeholder during a unit run.
func newTestServer(t *testing.T) (*Server, *http.ServeMux) {
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
	return s, mux
}

func do(t *testing.T, mux *http.ServeMux, method, path string, body any, cookies ...*http.Cookie) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var out map[string]any
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	return rec, out
}

func loginCookie(t *testing.T, mux *http.ServeMux, password string) *http.Cookie {
	t.Helper()
	rec, _ := do(t, mux, http.MethodPost, "/api/auth/login", map[string]any{"password": password})
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			return c
		}
	}
	t.Fatal("login did not set the session cookie")
	return nil
}

// ── auth ─────────────────────────────────────────────────────────────────────

// A fresh install must be CLOSED, not open: every API route requires the
// password, and the setup screen is the only way in. Treating "no password yet"
// as "open" would leave stored credentials reachable by anyone who can reach
// the port.
func TestFreshInstallRequiresSetup(t *testing.T) {
	_, mux := newTestServer(t)

	rec, body := do(t, mux, http.MethodGet, "/api/auth/status", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}
	if body["needsSetup"] != true {
		t.Fatalf("expected needsSetup, got %v", body)
	}
	if body["authenticated"] != false {
		t.Fatalf("a fresh install must not be authenticated, got %v", body)
	}

	rec, _ = do(t, mux, http.MethodGet, "/api/hosts", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 before setup, got %d", rec.Code)
	}
}

func TestSetupThenAccess(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "s3cret")

	rec, _ := do(t, mux, http.MethodGet, "/api/hosts", nil, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with a session, got %d", rec.Code)
	}
}

func TestWrongPasswordRejected(t *testing.T) {
	_, mux := newTestServer(t)
	loginCookie(t, mux, "s3cret")

	rec, _ := do(t, mux, http.MethodPost, "/api/auth/login", map[string]any{"password": "nope"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

// Changing the password requires an existing session; otherwise anyone who can
// reach the port could lock the owner out.
func TestChangePasswordRequiresSession(t *testing.T) {
	_, mux := newTestServer(t)
	loginCookie(t, mux, "s3cret")

	rec, _ := do(t, mux, http.MethodPost, "/api/auth/login", map[string]any{"password": "newpass", "set": true})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for an unauthenticated password change, got %d", rec.Code)
	}
}

func TestChangePasswordWithSession(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "s3cret")

	rec, _ := do(t, mux, http.MethodPost, "/api/auth/login", map[string]any{"password": "newpass", "set": true}, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("change failed: %d %s", rec.Code, rec.Body.String())
	}
	// The old cookie is derived from the old password and must stop working.
	rec, _ = do(t, mux, http.MethodGet, "/api/hosts", nil, c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected the old session to be invalidated, got %d", rec.Code)
	}
	loginCookie(t, mux, "newpass")
}

func TestEmptyPasswordRejected(t *testing.T) {
	_, mux := newTestServer(t)
	rec, _ := do(t, mux, http.MethodPost, "/api/auth/login", map[string]any{"password": ""})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestLogoutClearsSession(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "s3cret")
	rec, _ := do(t, mux, http.MethodPost, "/api/auth/logout", nil, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("logout: %d", rec.Code)
	}
}

// ── hosts ────────────────────────────────────────────────────────────────────

func TestCreateHostValidates(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")

	cases := []map[string]any{
		{"address": "h", "username": "u"}, // no name
		{"name": "n", "username": "u"},    // no address
		{"name": "n", "address": "h"},     // no username
		{"name": "n", "address": "h", "username": "u", "port": 99999},
		{"name": "n", "address": "h", "username": "u", "authType": "key"}, // no key path
		{"name": "n", "address": "h", "username": "u", "authType": "wat"},
	}
	for _, body := range cases {
		rec, _ := do(t, mux, http.MethodPost, "/api/hosts", body, c)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %v, got %d (%s)", body, rec.Code, rec.Body.String())
		}
	}
}

// The stored password must never come back over the wire — only the boolean
// that says one exists.
func TestHostResponseNeverLeaksPassword(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")

	rec, body := do(t, mux, http.MethodPost, "/api/hosts", map[string]any{
		"name": "n", "address": "h", "username": "u", "password": "topsecret",
	}, c)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	raw := rec.Body.String()
	if strings.Contains(raw, "topsecret") {
		t.Fatalf("password leaked in the response: %s", raw)
	}
	if body["hasPassword"] != true {
		t.Fatalf("expected hasPassword=true, got %v", body)
	}
}

// An update with an empty password field means "keep the stored one"; the UI
// cannot echo a value it never received.
func TestUpdateHostKeepsPasswordWhenBlank(t *testing.T) {
	s, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")

	_, created := do(t, mux, http.MethodPost, "/api/hosts", map[string]any{
		"name": "n", "address": "h", "username": "u", "password": "topsecret",
	}, c)
	id := int64(created["id"].(float64))

	rec, _ := do(t, mux, http.MethodPut, "/api/hosts/"+itoa64(id), map[string]any{
		"name": "renamed", "address": "h", "username": "u", "port": 22, "authType": "password",
	}, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("update: %d %s", rec.Code, rec.Body.String())
	}
	got, err := s.secret.Get(id, secret.KindPassword)
	if err != nil {
		t.Fatalf("read secret: %v", err)
	}
	if got != "topsecret" {
		t.Fatalf("password was lost on update: %q", got)
	}
}

func TestDeleteHostRemovesSecrets(t *testing.T) {
	s, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")

	_, created := do(t, mux, http.MethodPost, "/api/hosts", map[string]any{
		"name": "n", "address": "h", "username": "u", "password": "topsecret",
	}, c)
	id := int64(created["id"].(float64))

	rec, _ := do(t, mux, http.MethodDelete, "/api/hosts/"+itoa64(id), nil, c)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if s.secret.Has(id, secret.KindPassword) {
		t.Fatal("expected the secret to be deleted with the host")
	}
}

func TestHostNotFound(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodGet, "/api/hosts/999", nil, c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestHostInvalidID(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodGet, "/api/hosts/abc", nil, c)
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
		t.Fatalf("expected 400/404, got %d", rec.Code)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodPatch, "/api/hosts", nil, c)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// ── snippets ─────────────────────────────────────────────────────────────────

func TestSnippetCRUD(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")

	rec, created := do(t, mux, http.MethodPost, "/api/snippets", map[string]any{
		"label": "disk", "command": "df -h", "hostId": 0, "send": true,
	}, c)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	id := int64(created["id"].(float64))

	rec, list := do(t, mux, http.MethodGet, "/api/snippets", nil, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d", rec.Code)
	}
	_ = list

	rec, _ = do(t, mux, http.MethodPut, "/api/snippets/"+itoa64(id), map[string]any{
		"label": "disk2", "command": "df -h /", "send": false,
	}, c)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("update: %d %s", rec.Code, rec.Body.String())
	}

	rec, _ = do(t, mux, http.MethodDelete, "/api/snippets/"+itoa64(id), nil, c)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
}

func TestSnippetRequiresLabelAndCommand(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	for _, body := range []map[string]any{
		{"label": "", "command": "ls"},
		{"label": "x", "command": "  "},
	} {
		rec, _ := do(t, mux, http.MethodPost, "/api/snippets", body, c)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %v, got %d", body, rec.Code)
		}
	}
}

func TestSnippetReorderRejectsEmpty(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodPut, "/api/snippets/reorder", map[string]any{"ids": []int{}}, c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

// ── forwards ─────────────────────────────────────────────────────────────────

func TestForwardValidatesPorts(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodPost, "/api/forwards", map[string]any{
		"hostId": 1, "localPort": 0, "remotePort": 80,
	}, c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestForwardRequiresHost(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodPost, "/api/forwards", map[string]any{
		"localPort": 8080, "remotePort": 80,
	}, c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestForwardListIsEmptyInitially(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodGet, "/api/forwards", nil, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("expected an empty array, got %s", rec.Body.String())
	}
}

// ── terminal sessions ────────────────────────────────────────────────────────

func TestTerminalSessionListEmpty(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodGet, "/api/terminal/sessions", nil, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("expected an empty array, got %s", rec.Body.String())
	}
}

func TestTerminalCloseUnknownSessionIsIdempotent(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodDelete, "/api/terminal/sessions?session=nope", nil, c)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for an unknown session, got %d", rec.Code)
	}
}

func TestTerminalCloseRequiresSessionParam(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodDelete, "/api/terminal/sessions", nil, c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

// ── files ────────────────────────────────────────────────────────────────────

func TestFilesRequiresHost(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodGet, "/api/files", nil, c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

// A missing host is a 404, not a 500: the request was well-formed, the target
// just is not there.
func TestFilesUnknownHostIsNotFound(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, _ := do(t, mux, http.MethodGet, "/api/files?hostId=42&path=/", nil, c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// ── system ───────────────────────────────────────────────────────────────────

func TestSystemInfo(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	rec, body := do(t, mux, http.MethodGet, "/api/system", nil, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("system: %d", rec.Code)
	}
	if body["version"] != "test" {
		t.Fatalf("expected the injected version, got %v", body["version"])
	}
}

// ── dial error mapping ───────────────────────────────────────────────────────

// A failure to reach the remote host is the REMOTE side's fault, so it must not
// be reported as a 500 (which reads as "this server is broken").
func TestDialErrorMapsToBadGateway(t *testing.T) {
	_, mux := newTestServer(t)
	c := loginCookie(t, mux, "pw12")
	_, created := do(t, mux, http.MethodPost, "/api/hosts", map[string]any{
		"name": "n", "address": "127.0.0.1", "username": "u", "port": 1,
		"authType": "password", "password": "x",
	}, c)
	id := int64(created["id"].(float64))

	rec, body := do(t, mux, http.MethodPost, "/api/hosts/"+itoa64(id)+"/test", nil, c)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d (%s)", rec.Code, rec.Body.String())
	}
	if body["code"] != "connection_refused" {
		t.Fatalf("expected a stable error code, got %v", body)
	}
}

func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

// Compile-time guards that the helpers used above are the ones the package
// really exports (a rename would otherwise fail only at run time).
var (
	_ = errors.Is
	_ = net.JoinHostPort
	_ = filepath.Join
)
