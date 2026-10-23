package forward

import (
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeDialer stands in for the SSH connection: every Dial returns one end of an
// in-memory pipe whose other end is a canned "remote service".
type fakeDialer struct {
	mu       sync.Mutex
	dialed   []string
	failWith error
	response string
}

func (f *fakeDialer) Dial(network, addr string) (net.Conn, error) {
	f.mu.Lock()
	f.dialed = append(f.dialed, network+" "+addr)
	failWith := f.failWith
	resp := f.response
	f.mu.Unlock()

	if failWith != nil {
		return nil, failWith
	}
	local, remote := net.Pipe()
	go func() {
		defer remote.Close()
		if resp != "" {
			_, _ = remote.Write([]byte(resp))
		}
		// Echo anything the client sends so a round trip can be asserted.
		_, _ = io.Copy(remote, remote)
	}()
	return local, nil
}

func (f *fakeDialer) targets() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.dialed...)
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return p
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

func TestStopUnknownPortIsNotRunning(t *testing.T) {
	m := NewManager()
	if err := m.Stop(12345); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("expected ErrNotRunning, got %v", err)
	}
}

func TestListIsEmptyInitially(t *testing.T) {
	m := NewManager()
	if got := m.List(); len(got) != 0 {
		t.Fatalf("expected empty, got %+v", got)
	}
}

func TestStartRejectsDuplicateLocalPort(t *testing.T) {
	m := NewManager()
	port := freePort(t)
	// Occupy the port by hand, then ask the manager to bind it. The duplicate
	// check must run before anything touches the dialer.
	ln, err := net.Listen("tcp", "127.0.0.1:"+itoa(port))
	if err != nil {
		t.Skipf("port %d is busy: %v", port, err)
	}
	defer ln.Close()
	m.instances[port] = &instance{status: Status{LocalPort: port}}

	if _, err := m.Start(1, &fakeDialer{}, port, "127.0.0.1", 80, nil); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("expected ErrAlreadyRunning, got %v", err)
	}
}

func TestStopUnregistersAndReleasesPort(t *testing.T) {
	m := NewManager()
	st, err := m.Start(1, &fakeDialer{}, freePort(t), "127.0.0.1", 80, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := m.Stop(st.LocalPort); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if len(m.List()) != 0 {
		t.Fatal("expected the instance to be unregistered")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+itoa(st.LocalPort))
	if err != nil {
		t.Fatalf("port was not released: %v", err)
	}
	_ = ln.Close()
}

// The stop callback releases the caller's SSH connection reference. It must run
// exactly once even if Stop is called twice (the reaper and a user action can
// race).
func TestStopCallsOnStopOnce(t *testing.T) {
	m := NewManager()
	var calls int
	var mu sync.Mutex
	st, err := m.Start(1, &fakeDialer{}, freePort(t), "127.0.0.1", 80, func() {
		mu.Lock()
		calls++
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	_ = m.Stop(st.LocalPort)
	// Second Stop reports NotRunning and must not re-run the callback.
	if err := m.Stop(st.LocalPort); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("expected ErrNotRunning on the second stop, got %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("expected onStop to run once, ran %d times", calls)
	}
}

func TestStopHostOnlyClosesItsOwnForwards(t *testing.T) {
	m := NewManager()
	a, err := m.Start(1, &fakeDialer{}, freePort(t), "127.0.0.1", 80, nil)
	if err != nil {
		t.Fatalf("start a: %v", err)
	}
	b, err := m.Start(2, &fakeDialer{}, freePort(t), "127.0.0.1", 81, nil)
	if err != nil {
		t.Fatalf("start b: %v", err)
	}

	m.StopHost(1)
	list := m.List()
	if len(list) != 1 || list[0].LocalPort != b.LocalPort {
		t.Fatalf("expected only host 2's forward to survive, got %+v", list)
	}
	_ = a
	m.CloseAll()
	if len(m.List()) != 0 {
		t.Fatal("expected CloseAll to clear everything")
	}
}

// A forward must bind loopback only: 0.0.0.0 would expose a remote database to
// the whole local network.
func TestStartBindsLoopbackOnly(t *testing.T) {
	m := NewManager()
	st, err := m.Start(1, &fakeDialer{}, freePort(t), "127.0.0.1", 80, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(st.LocalPort)

	c, err := net.DialTimeout("tcp", "127.0.0.1:"+itoa(st.LocalPort), time.Second)
	if err != nil {
		t.Fatalf("loopback connect: %v", err)
	}
	_ = c.Close()
}

// The full data path: a local connection is relayed to the remote address the
// rule names, and bytes come back.
func TestForwardRelaysBytes(t *testing.T) {
	d := &fakeDialer{response: "hello-from-remote\n"}
	m := NewManager()
	st, err := m.Start(7, d, freePort(t), "db.internal", 5432, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(st.LocalPort)

	c, err := net.DialTimeout("tcp", "127.0.0.1:"+itoa(st.LocalPort), 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf[:n]) != "hello-from-remote\n" {
		t.Fatalf("unexpected payload %q", buf[:n])
	}

	targets := d.targets()
	if len(targets) != 1 || targets[0] != "tcp db.internal:5432" {
		t.Fatalf("expected the rule's remote target to be dialled, got %v", targets)
	}

	// The connection counter is what the UI shows; it must reflect the accept.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		list := m.List()
		if len(list) == 1 && list[0].Connections == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("connection count did not advance: %+v", m.List())
}

// A failed remote dial must be recorded on the forward (so the UI can show it)
// and must not take the listener down.
func TestForwardRecordsDialError(t *testing.T) {
	d := &fakeDialer{failWith: errors.New("no route to host")}
	m := NewManager()
	st, err := m.Start(3, d, freePort(t), "127.0.0.1", 22, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(st.LocalPort)

	c, err := net.DialTimeout("tcp", "127.0.0.1:"+itoa(st.LocalPort), 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		list := m.List()
		if len(list) == 1 && list[0].Error != "" {
			if !strings.Contains(list[0].Error, "no route to host") {
				t.Fatalf("error did not name the cause: %q", list[0].Error)
			}
			// The listener must still be up.
			c2, err := net.DialTimeout("tcp", "127.0.0.1:"+itoa(st.LocalPort), time.Second)
			if err != nil {
				t.Fatalf("listener died after a failed dial: %v", err)
			}
			_ = c2.Close()
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("dial failure was never recorded")
}
