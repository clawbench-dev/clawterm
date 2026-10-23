package terminal

import (
	"bytes"
	"strings"
	"testing"
)

func TestRingBufferKeepsOrder(t *testing.T) {
	r := NewRingBuffer(1024)
	r.Write([]byte("hello\n"))
	r.Write([]byte("world\n"))
	if got := string(r.Snapshot()); got != "hello\nworld\n" {
		t.Fatalf("got %q", got)
	}
}

// ANSI escapes routinely straddle two PTY reads; the buffer must not split on
// them or the replayed screen comes back with literal escape garbage.
func TestRingBufferPreservesAnsiAcrossWrites(t *testing.T) {
	r := NewRingBuffer(1024)
	r.Write([]byte("\x1b[31mred"))
	r.Write([]byte(" text\x1b[0m\n"))
	want := "\x1b[31mred text\x1b[0m\n"
	if got := string(r.Snapshot()); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRingBufferEvictsOldestBytes(t *testing.T) {
	r := NewRingBuffer(10)
	r.Write([]byte("0123456789"))
	r.Write([]byte("abc"))
	if got := string(r.Snapshot()); got != "3456789abc" {
		t.Fatalf("got %q want %q", got, "3456789abc")
	}
}

func TestRingBufferWriteLargerThanCapacityKeepsTail(t *testing.T) {
	r := NewRingBuffer(5)
	r.Write([]byte("0123456789"))
	if got := string(r.Snapshot()); got != "56789" {
		t.Fatalf("got %q want %q", got, "56789")
	}
}

func TestRingBufferWrapAroundOrder(t *testing.T) {
	// Exercise the wrap path several times so a wrong modulo shows up as
	// scrambled output rather than a size mismatch.
	r := NewRingBuffer(8)
	for _, s := range []string{"abc", "def", "ghi", "jkl"} {
		r.Write([]byte(s))
	}
	// Capacity 8, total 12 → the last 8 bytes are "efghijkl".
	if got := string(r.Snapshot()); got != "efghijkl" {
		t.Fatalf("got %q want %q", got, "efghijkl")
	}
	if !bytes.Equal(r.Snapshot(), r.Snapshot()) {
		t.Fatal("snapshot is not stable")
	}
}

func TestRingBufferEmptySnapshot(t *testing.T) {
	r := NewRingBuffer(4)
	if got := r.Snapshot(); len(got) != 0 {
		t.Fatalf("expected empty, got %q", got)
	}
}

// The snapshot must be a COPY: a caller that keeps it across later writes would
// otherwise see its own buffer mutate under it.
func TestRingBufferSnapshotIsCopy(t *testing.T) {
	r := NewRingBuffer(16)
	r.Write([]byte("abc"))
	snap := r.Snapshot()
	r.Write([]byte("def"))
	if strings.Contains(string(snap), "def") {
		t.Fatal("snapshot shares storage with the ring")
	}
}
