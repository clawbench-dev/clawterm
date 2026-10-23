// Package forward runs local port forwards over an SSH connection
// (`127.0.0.1:localPort` → `remoteHost:remotePort`), the feature that makes a
// terminal app useful for databases and web UIs behind a bastion.
package forward

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
)

// Errors surfaced to the API layer.
var (
	ErrAlreadyRunning = errors.New("forward already running")
	ErrNotRunning     = errors.New("forward not running")
)

// Status is the runtime view of one forward.
type Status struct {
	LocalPort   int    `json:"localPort"`
	RemoteHost  string `json:"remoteHost"`
	RemotePort  int    `json:"remotePort"`
	HostID      int64  `json:"hostId"`
	Running     bool   `json:"running"`
	Error       string `json:"error,omitempty"`
	Connections int64  `json:"connections"`
}

// Dialer is the one thing a forward needs from the SSH connection: the ability
// to open a channel to a remote address. `*ssh.Client` satisfies it; declaring
// the interface here is what makes the data path testable without a live sshd.
type Dialer interface {
	Dial(network, addr string) (net.Conn, error)
}

type instance struct {
	ln     net.Listener
	client Dialer
	status Status
	// onStop releases the SSH connection reference the caller took when
	// starting this forward. Called exactly once, from Stop/StopHost/CloseAll.
	onStop func()

	mu       sync.Mutex
	stopOnce sync.Once
}

// Manager owns every running forward, keyed by local port (a port can only be
// bound once, so it is also the natural identity in the UI).
type Manager struct {
	mu        sync.Mutex
	instances map[int]*instance
}

// NewManager returns an empty manager.
func NewManager() *Manager { return &Manager{instances: map[int]*instance{}} }

// Start binds the local port and starts accepting.
func (m *Manager) Start(hostID int64, client Dialer, localPort int, remoteHost string, remotePort int, onStop func()) (*Status, error) {
	if remoteHost == "" {
		remoteHost = "127.0.0.1"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.instances[localPort]; ok {
		return nil, ErrAlreadyRunning
	}

	// Bind loopback only: a forward listening on 0.0.0.0 silently exposes the
	// remote service to the whole local network, which is never what the user
	// meant when they typed a local port.
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(localPort)))
	if err != nil {
		return nil, fmt.Errorf("bind 127.0.0.1:%d: %w", localPort, err)
	}

	inst := &instance{
		ln:     ln,
		client: client,
		onStop: onStop,
		status: Status{
			LocalPort: localPort, RemoteHost: remoteHost, RemotePort: remotePort,
			HostID: hostID, Running: true,
		},
	}
	m.instances[localPort] = inst
	go inst.serve()
	out := inst.snapshot()
	return &out, nil
}

func (i *instance) snapshot() Status {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.status
}

func (i *instance) serve() {
	for {
		c, err := i.ln.Accept()
		if err != nil {
			return
		}
		i.mu.Lock()
		i.status.Connections++
		i.mu.Unlock()
		go i.handle(c)
	}
}

func (i *instance) handle(local net.Conn) {
	defer local.Close()
	target := net.JoinHostPort(i.status.RemoteHost, fmt.Sprint(i.status.RemotePort))
	remote, err := i.client.Dial("tcp", target)
	if err != nil {
		i.mu.Lock()
		i.status.Error = fmt.Sprintf("dial %s: %v", target, err)
		i.mu.Unlock()
		return
	}
	defer remote.Close()

	// Copy both directions; the first side to finish closes both so the other
	// copy cannot block forever on a half-open socket.
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, local); done <- struct{}{} }()
	go func() { _, _ = io.Copy(local, remote); done <- struct{}{} }()
	<-done
}

// Stop closes the listener for localPort.
func (m *Manager) Stop(localPort int) error {
	m.mu.Lock()
	inst, ok := m.instances[localPort]
	delete(m.instances, localPort)
	m.mu.Unlock()
	if !ok {
		return ErrNotRunning
	}
	inst.mu.Lock()
	inst.status.Running = false
	inst.mu.Unlock()
	err := inst.ln.Close()
	inst.stopOnce.Do(func() {
		if inst.onStop != nil {
			inst.onStop()
		}
	})
	return err
}

// StopHost closes every forward belonging to hostID (used when its SSH
// connection goes away, so a stale listener cannot outlive it).
func (m *Manager) StopHost(hostID int64) {
	m.mu.Lock()
	var ports []int
	for p, inst := range m.instances {
		if inst.status.HostID == hostID {
			ports = append(ports, p)
		}
	}
	m.mu.Unlock()
	for _, p := range ports {
		_ = m.Stop(p)
	}
}

// List returns the running forwards.
func (m *Manager) List() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Status, 0, len(m.instances))
	for _, inst := range m.instances {
		out = append(out, inst.snapshot())
	}
	return out
}

// CloseAll stops every forward (shutdown path).
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ports := make([]int, 0, len(m.instances))
	for p := range m.instances {
		ports = append(ports, p)
	}
	m.mu.Unlock()
	for _, p := range ports {
		_ = m.Stop(p)
	}
}
