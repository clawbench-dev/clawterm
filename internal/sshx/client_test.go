package sshx

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// ── test doubles ─────────────────────────────────────────────────────────────

type memKeys struct {
	mu   sync.Mutex
	pins map[string][2]string
}

func newMemKeys() *memKeys { return &memKeys{pins: map[string][2]string{}} }

func (m *memKeys) Lookup(address string) (string, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.pins[address]
	if !ok {
		return "", "", nil
	}
	return p[0], p[1], nil
}

func (m *memKeys) Pin(address, keyType, fingerprint string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pins[address] = [2]string{keyType, fingerprint}
	return nil
}

func (m *memKeys) Unpin(address string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.pins, address)
	return nil
}

// testServer is a minimal sshd: it accepts one client key and answers the
// session requests the shell path needs.
type testServer struct {
	ln net.Listener
}

func newTestServer(t *testing.T, clientKey ssh.PublicKey) *testServer {
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
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if string(key.Marshal()) == string(clientKey.Marshal()) {
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
	srv := &testServer{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go handleConn(c, cfg)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return srv
}

func handleConn(c net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "only session")
			continue
		}
		ch, requests, err := nc.Accept()
		if err != nil {
			return
		}
		go func() {
			for req := range requests {
				switch req.Type {
				case "pty-req", "window-change":
					_ = req.Reply(true, nil)
				case "shell":
					_ = req.Reply(true, nil)
					_, _ = ch.Write([]byte("ready\r\n"))
				default:
					_ = req.Reply(false, nil)
				}
			}
			_ = ch.Close()
		}()
	}
}

func (s *testServer) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *testServer) addr() string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(s.port()))
}

// newClientKey returns a signer plus a private-key file holding it.
func newClientKey(t *testing.T) (ssh.Signer, ssh.PublicKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	// MarshalPrivateKey returns a *pem.Block; writing block.Bytes gives a file
	// that ParsePrivateKey cannot read ("no key found"), so it has to be PEM
	// encoded first.
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	return signer, sshPub, path
}

// ── tests ────────────────────────────────────────────────────────────────────

// The host-key callback runs BEFORE authentication, so the key must be pinned
// even when the credential is wrong. Otherwise a user who mistypes a password
// would have to retype it after the pin is taken.
func TestDialPinsHostKeyBeforeAuth(t *testing.T) {
	_, pub, _ := newClientKey(t)
	srv := newTestServer(t, pub)
	keys := newMemKeys()

	// Password auth against a server that only accepts a public key: the
	// handshake reaches the host-key check, then auth fails.
	_, _, err := Dial("127.0.0.1", srv.port(), "user", Auth{Type: "password", Password: "wrong"}, keys)
	if err == nil {
		t.Fatal("expected authentication to fail")
	}
	if _, fp, _ := keys.Lookup(srv.addr()); fp == "" {
		t.Fatal("expected the host key to be pinned despite the auth failure")
	}
}

// A credential that cannot even be built (missing key file) must fail BEFORE
// any connection is attempted — there is nothing to pin and nothing to leak.
func TestDialFailsFastOnUnusableCredential(t *testing.T) {
	_, pub, _ := newClientKey(t)
	srv := newTestServer(t, pub)
	keys := newMemKeys()

	_, _, err := Dial("127.0.0.1", srv.port(), "user", Auth{Type: "key", KeyPath: "/nonexistent"}, keys)
	if err == nil {
		t.Fatal("expected an error for a missing key file")
	}
	if _, fp, _ := keys.Lookup(srv.addr()); fp != "" {
		t.Fatal("no connection was attempted, so nothing should be pinned")
	}
}

func TestDialRejectsChangedHostKey(t *testing.T) {
	_, pub, _ := newClientKey(t)
	srv := newTestServer(t, pub)
	keys := newMemKeys()

	if err := keys.Pin(srv.addr(), "ssh-ed25519", "SHA256:not-the-real-one"); err != nil {
		t.Fatal(err)
	}

	_, _, err := Dial("127.0.0.1", srv.port(), "user", Auth{Type: "password", Password: "x"}, keys)
	var mismatch *HostKeyMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("expected HostKeyMismatch, got %v", err)
	}
	if mismatch.OldFinger != "SHA256:not-the-real-one" {
		t.Fatalf("mismatch did not report the pinned value: %+v", mismatch)
	}
	if mismatch.NewFinger == "" || mismatch.NewFinger == mismatch.OldFinger {
		t.Fatalf("mismatch did not report the presented value: %+v", mismatch)
	}
}

func TestDialPinsOnFirstConnectAndIsSilentAfterwards(t *testing.T) {
	_, pub, keyPath := newClientKey(t)
	srv := newTestServer(t, pub)
	keys := newMemKeys()

	c, notice, err := Dial("127.0.0.1", srv.port(), "user", Auth{Type: "key", KeyPath: keyPath}, keys)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	if notice == "" {
		t.Fatal("expected a first-connection notice")
	}
	if _, fp, _ := keys.Lookup(srv.addr()); fp == "" {
		t.Fatal("expected the key to be pinned")
	}

	c2, notice2, err := Dial("127.0.0.1", srv.port(), "user", Auth{Type: "key", KeyPath: keyPath}, keys)
	if err != nil {
		t.Fatalf("second dial: %v", err)
	}
	defer c2.Close()
	if notice2 != "" {
		t.Fatalf("expected no notice on a known host, got %q", notice2)
	}
}

func TestDialInvalidPort(t *testing.T) {
	if _, _, err := Dial("127.0.0.1", 0, "u", Auth{Type: "password", Password: "x"}, newMemKeys()); err == nil {
		t.Fatal("expected an error for port 0")
	}
	if _, _, err := Dial("127.0.0.1", 70000, "u", Auth{Type: "password", Password: "x"}, newMemKeys()); err == nil {
		t.Fatal("expected an error for port 70000")
	}
}

func TestDialRefusedIsClassified(t *testing.T) {
	// Port 1 on loopback is never listening.
	_, _, err := Dial("127.0.0.1", 1, "u", Auth{Type: "password", Password: "x"}, newMemKeys())
	var de *DialError
	if !errors.As(err, &de) {
		t.Fatalf("expected a DialError, got %v", err)
	}
	if de.Code != CodeRefused {
		t.Fatalf("expected %q, got %q (%v)", CodeRefused, de.Code, err)
	}
}

func TestAuthRequiresCredential(t *testing.T) {
	if _, _, err := buildAuth(Auth{Type: "password"}); err == nil {
		t.Fatal("expected an error for password auth without a password")
	}
	if _, _, err := buildAuth(Auth{Type: "key"}); err == nil {
		t.Fatal("expected an error for key auth without a path")
	}
	t.Setenv("SSH_AUTH_SOCK", "")
	if _, _, err := buildAuth(Auth{Type: "agent"}); err == nil {
		t.Fatal("expected an error for agent auth without SSH_AUTH_SOCK")
	}
}

func TestShellReceivesOutputAndResizes(t *testing.T) {
	_, pub, keyPath := newClientKey(t)
	srv := newTestServer(t, pub)
	keys := newMemKeys()

	c, _, err := Dial("127.0.0.1", srv.port(), "user", Auth{Type: "key", KeyPath: keyPath}, keys)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	sh, err := c.OpenShell(PtySize{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("open shell: %v", err)
	}
	defer sh.Close()

	select {
	case data := <-sh.Output():
		if len(data) == 0 {
			t.Fatal("expected some output")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for shell output")
	}

	if err := sh.Resize(PtySize{Cols: 100, Rows: 30}); err != nil {
		t.Fatalf("resize: %v", err)
	}
	// A zero size means "the view has not been measured yet"; sending it to the
	// server would collapse the remote terminal to 0x0.
	if err := sh.Resize(PtySize{}); err != nil {
		t.Fatalf("zero-size resize should be a no-op, got %v", err)
	}
}

func TestShellDefaultsZeroSize(t *testing.T) {
	_, pub, keyPath := newClientKey(t)
	srv := newTestServer(t, pub)
	c, _, err := Dial("127.0.0.1", srv.port(), "user", Auth{Type: "key", KeyPath: keyPath}, newMemKeys())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	// A 0x0 PTY request is rejected by real servers; the client must substitute
	// the conventional 80x24 rather than pass the zeros through.
	sh, err := c.OpenShell(PtySize{})
	if err != nil {
		t.Fatalf("open shell with zero size: %v", err)
	}
	defer sh.Close()
}
