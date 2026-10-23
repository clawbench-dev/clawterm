// Package terminal owns live PTY sessions: one SSH shell per terminal tab,
// kept alive across WebSocket reconnects so a phone that sleeps and wakes does
// not lose its scrollback.
package terminal

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"clawterm/internal/sshx"
)

// Errors surfaced to the API layer.
var (
	ErrNotFound    = errors.New("terminal session not found")
	ErrLimit       = errors.New("too many terminal sessions")
	ErrOwnerActive = errors.New("terminal session is attached to another client")
)

// Defaults. A phone rarely needs more than a handful of tabs; the cap exists
// so a runaway client cannot pin unbounded SSH channels.
const (
	MaxSessions    = 16
	replayBytes    = 512 * 1024
	detachGrace    = 2 * time.Minute
	reaperInterval = 15 * time.Second
)

// Session is one PTY plus its scrollback.
type Session struct {
	ID     string
	HostID int64
	Title  string

	shell *sshx.Shell
	buf   *RingBuffer

	mu       sync.Mutex
	owner    string    // connection id currently attached ("" = detached)
	detach   time.Time // when the last client left
	subs     map[string]chan []byte
	exited   bool
	exitMsg  string
	exitCode int

	done chan struct{}

	// onClose runs once when the session is torn down. It releases the SSH
	// connection reference this session holds: the connection must outlive the
	// WebSocket that created it, because the whole point of keeping the session
	// alive is to re-attach after the socket drops.
	onClose func()
}

// Manager tracks all live sessions.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	stop     chan struct{}
}

// NewManager starts the idle reaper.
func NewManager() *Manager {
	m := &Manager{sessions: make(map[string]*Session), stop: make(chan struct{})}
	go m.reapLoop()
	return m
}

// Shutdown terminates every session and stops the reaper.
func (m *Manager) Shutdown() {
	close(m.stop)
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = map[string]*Session{}
	m.mu.Unlock()
	for _, s := range sessions {
		s.Close()
	}
}

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is unrecoverable for identity generation; fall
		// back to a timestamp so the app still works in a degraded sandbox.
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b)
}

// Open starts a shell for host and registers it.
func (m *Manager) Open(hostID int64, title string, client *sshx.Client, size sshx.PtySize, onClose func()) (*Session, error) {
	m.mu.Lock()
	if len(m.sessions) >= MaxSessions {
		m.mu.Unlock()
		return nil, ErrLimit
	}
	m.mu.Unlock()

	shell, err := client.OpenShell(size)
	if err != nil {
		return nil, err
	}
	s := &Session{
		ID:     newID(),
		HostID: hostID,
		Title:  title,
		shell:  shell,
		buf:    NewRingBuffer(replayBytes),
		subs:   make(map[string]chan []byte),
		done:   make(chan struct{}),

		onClose: onClose,
	}
	go s.pump()

	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()
	return s, nil
}

// Get returns a session by id.
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return s, nil
}

// List returns all live sessions (metadata only).
func (m *Manager) List() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	return out
}

// CloseSession kills a session and unregisters it.
func (m *Manager) CloseSession(id string) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	s.Close()
	return nil
}

// pump copies PTY output into the scrollback and to every subscriber.
func (s *Session) pump() {
	for chunk := range s.shell.Output() {
		s.buf.Write(chunk)
		s.mu.Lock()
		subs := make([]chan []byte, 0, len(s.subs))
		for _, ch := range s.subs {
			subs = append(subs, ch)
		}
		s.mu.Unlock()
		for _, ch := range subs {
			// Non-blocking: a stalled client must not stall the PTY. Dropping
			// here is safe because the client re-syncs from the ring buffer on
			// the next attach.
			select {
			case ch <- chunk:
			default:
			}
		}
	}
	code := 0
	select {
	case code = <-s.shell.ExitCode():
	case <-time.After(time.Second):
	}
	s.mu.Lock()
	s.exited = true
	s.exitCode = code
	s.exitMsg = "shell exited"
	for _, ch := range s.subs {
		close(ch)
	}
	s.subs = map[string]chan []byte{}
	s.mu.Unlock()
	close(s.done)
}

// Attach registers a subscriber. The caller receives the full scrollback
// first, then live output. A session that already exited replays and closes.
func (s *Session) Attach(connID string) (<-chan []byte, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.owner != "" && s.owner != connID {
		return nil, nil, ErrOwnerActive
	}
	s.owner = connID
	s.detach = time.Time{}
	ch := make(chan []byte, 256)
	if s.exited {
		close(ch)
		return ch, s.buf.Snapshot(), nil
	}
	s.subs[connID] = ch
	return ch, s.buf.Snapshot(), nil
}

// Detach unregisters a subscriber and starts the idle clock.
func (s *Session) Detach(connID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch, ok := s.subs[connID]; ok {
		delete(s.subs, connID)
		close(ch)
	}
	if s.owner == connID {
		s.owner = ""
		s.detach = time.Now()
	}
}

// Write forwards keystrokes.
func (s *Session) Write(p []byte) error {
	_, err := s.shell.Write(p)
	return err
}

// Resize forwards a window size.
func (s *Session) Resize(size sshx.PtySize) error { return s.shell.Resize(size) }

// Exited reports whether the shell has terminated.
func (s *Session) Exited() (bool, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exited, s.exitCode
}

// Close tears the PTY down and releases the connection reference.
func (s *Session) Close() {
	s.shell.Close()
	s.mu.Lock()
	cb := s.onClose
	s.onClose = nil
	s.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func (m *Manager) reapLoop() {
	t := time.NewTicker(reaperInterval)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
			now := time.Now()
			var dead []string
			m.mu.Lock()
			for id, s := range m.sessions {
				s.mu.Lock()
				idle := s.owner == "" && !s.detach.IsZero() && now.Sub(s.detach) > detachGrace
				gone := s.exited && s.owner == ""
				s.mu.Unlock()
				if idle || gone {
					dead = append(dead, id)
				}
			}
			m.mu.Unlock()
			for _, id := range dead {
				_ = m.CloseSession(id)
			}
		}
	}
}
