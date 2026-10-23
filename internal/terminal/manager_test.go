package terminal

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"clawterm/internal/sshx"
)

// ── sshd fixture ─────────────────────────────────────────────────────────────

type keys struct {
	mu   sync.Mutex
	pins map[string][2]string
}

func (k *keys) Lookup(address string) (string, string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	p, ok := k.pins[address]
	if !ok {
		return "", "", nil
	}
	return p[0], p[1], nil
}

func (k *keys) Pin(address, keyType, fp string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.pins[address] = [2]string{keyType, fp}
	return nil
}

func (k *keys) Unpin(address string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.pins, address)
	return nil
}

// startSSHD runs a minimal sshd that accepts one key and answers a shell
// request by printing a banner and then echoing whatever it receives.
func startSSHD(t *testing.T) (host string, port int, keyPath string) {
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
	keyPath = filepath.Join(t.TempDir(), "id_ed25519")
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := os.WriteFile(keyPath, pemBytes, 0o600); err != nil {
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
			go serveConn(c, cfg)
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port, keyPath
}

func serveConn(c net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "session only")
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
					_, _ = ch.Write([]byte("banner\r\n"))
					// Echo one line back, then keep the channel open until the
					// client closes it.
					buf := make([]byte, 256)
					if n, err := ch.Read(buf); err == nil && n > 0 {
						_, _ = ch.Write(append([]byte("echo:"), buf[:n]...))
					}
				default:
					_ = req.Reply(false, nil)
				}
			}
			_ = ch.Close()
		}()
	}
}

func dial(t *testing.T, host string, port int, keyPath string) *sshx.Client {
	t.Helper()
	c, _, err := sshx.Dial(host, port, "user", sshx.Auth{Type: "key", KeyPath: keyPath}, &keys{pins: map[string][2]string{}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// ── tests ────────────────────────────────────────────────────────────────────

func TestOpenProducesOutputAndReplays(t *testing.T) {
	host, port, keyPath := startSSHD(t)
	client := dial(t, host, port, keyPath)

	m := NewManager()
	t.Cleanup(m.Shutdown)

	sess, err := m.Open(1, "test", client, sshx.PtySize{Cols: 80, Rows: 24}, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	ch, replay, err := sess.Attach("c1")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if len(replay) != 0 {
		t.Fatalf("a fresh session should have no scrollback yet, got %q", replay)
	}

	select {
	case data := <-ch:
		if len(data) == 0 {
			t.Fatal("expected output")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for output")
	}

	// A second attach must be replayed the same bytes: this is what makes a
	// reconnect show the previous screen instead of an empty terminal.
	sess.Detach("c1")
	ch2, replay2, err := sess.Attach("c2")
	if err != nil {
		t.Fatalf("re-attach: %v", err)
	}
	_ = ch2
	if len(replay2) == 0 {
		t.Fatal("expected the scrollback to be replayed on re-attach")
	}
}

// A second client must not steal a session that is already attached; that would
// silently fork one shell into two screens.
func TestAttachRejectsSecondOwner(t *testing.T) {
	host, port, keyPath := startSSHD(t)
	client := dial(t, host, port, keyPath)
	m := NewManager()
	t.Cleanup(m.Shutdown)

	sess, err := m.Open(1, "t", client, sshx.PtySize{Cols: 80, Rows: 24}, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, _, err := sess.Attach("a"); err != nil {
		t.Fatalf("first attach: %v", err)
	}
	if _, _, err := sess.Attach("b"); !errors.Is(err, ErrOwnerActive) {
		t.Fatalf("expected ErrOwnerActive, got %v", err)
	}
	// After the owner leaves, the session can be taken over.
	sess.Detach("a")
	if _, _, err := sess.Attach("b"); err != nil {
		t.Fatalf("attach after detach: %v", err)
	}
}

func TestCloseSessionUnregisters(t *testing.T) {
	host, port, keyPath := startSSHD(t)
	client := dial(t, host, port, keyPath)
	m := NewManager()
	t.Cleanup(m.Shutdown)

	sess, err := m.Open(1, "t", client, sshx.PtySize{Cols: 80, Rows: 24}, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := m.CloseSession(sess.ID); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := m.Get(sess.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := m.CloseSession(sess.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound on the second close, got %v", err)
	}
}

// The session cap protects the device: each session is an SSH channel plus a
// goroutine pair, and a runaway client would exhaust both.
func TestOpenEnforcesSessionLimit(t *testing.T) {
	host, port, keyPath := startSSHD(t)
	client := dial(t, host, port, keyPath)
	m := NewManager()
	t.Cleanup(m.Shutdown)

	for i := 0; i < MaxSessions; i++ {
		if _, err := m.Open(1, "t", client, sshx.PtySize{Cols: 80, Rows: 24}, nil); err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
	}
	if _, err := m.Open(1, "t", client, sshx.PtySize{Cols: 80, Rows: 24}, nil); !errors.Is(err, ErrLimit) {
		t.Fatalf("expected ErrLimit, got %v", err)
	}
}

// The close callback releases the caller's SSH reference. It must run exactly
// once per session even when both the reaper and the user close it.
func TestOnCloseRunsOnce(t *testing.T) {
	host, port, keyPath := startSSHD(t)
	client := dial(t, host, port, keyPath)
	m := NewManager()
	t.Cleanup(m.Shutdown)

	var mu sync.Mutex
	calls := 0
	sess, err := m.Open(1, "t", client, sshx.PtySize{Cols: 80, Rows: 24}, func() {
		mu.Lock()
		calls++
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	_ = m.CloseSession(sess.ID)
	// A direct Close on the (now unregistered) session must not double-release.
	sess.Close()
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("expected onClose once, ran %d times", calls)
	}
}

func TestListReportsAllSessions(t *testing.T) {
	host, port, keyPath := startSSHD(t)
	client := dial(t, host, port, keyPath)
	m := NewManager()
	t.Cleanup(m.Shutdown)

	a, err := m.Open(1, "a", client, sshx.PtySize{Cols: 80, Rows: 24}, nil)
	if err != nil {
		t.Fatalf("open a: %v", err)
	}
	b, err := m.Open(2, "b", client, sshx.PtySize{Cols: 80, Rows: 24}, nil)
	if err != nil {
		t.Fatalf("open b: %v", err)
	}
	list := m.List()
	if len(list) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(list))
	}
	ids := map[string]bool{}
	for _, s := range list {
		ids[s.ID] = true
	}
	if !ids[a.ID] || !ids[b.ID] {
		t.Fatal("list is missing a session")
	}
}

// A write must reach the remote shell and its echo must come back.
func TestWriteReachesRemote(t *testing.T) {
	host, port, keyPath := startSSHD(t)
	client := dial(t, host, port, keyPath)
	m := NewManager()
	t.Cleanup(m.Shutdown)

	sess, err := m.Open(1, "t", client, sshx.PtySize{Cols: 80, Rows: 24}, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	ch, _, err := sess.Attach("c")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	// Drain the banner first.
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("no banner")
	}
	if err := sess.Write([]byte("ping\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case data := <-ch:
		if !strings.Contains(string(data), "echo:ping") {
			t.Fatalf("unexpected echo %q", data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no echo")
	}
}
