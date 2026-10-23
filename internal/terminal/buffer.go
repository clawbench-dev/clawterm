package terminal

import (
	"sync"
)

// RingBuffer is a byte-bounded circular buffer of raw PTY output.
//
// A terminal's scrollback is what makes reconnect useful: on re-attach the
// client is replayed the tail of the session instead of an empty screen. It
// stores bytes, not lines, because ANSI escape sequences routinely span
// reads and splitting them would corrupt the replay.
type RingBuffer struct {
	mu    sync.Mutex
	data  []byte
	max   int
	start int // index of oldest byte
	size  int // bytes currently held
}

// NewRingBuffer returns a buffer holding at most maxBytes of output.
func NewRingBuffer(maxBytes int) *RingBuffer {
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	return &RingBuffer{data: make([]byte, maxBytes), max: maxBytes}
}

// Write appends p, evicting the oldest bytes when full.
func (r *RingBuffer) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(p) >= r.max {
		// The write alone overflows: keep only its tail.
		copy(r.data, p[len(p)-r.max:])
		r.start, r.size = 0, r.max
		return
	}
	// Free space by dropping the oldest bytes.
	if over := r.size + len(p) - r.max; over > 0 {
		r.start = (r.start + over) % r.max
		r.size -= over
	}
	end := (r.start + r.size) % r.max
	n := copy(r.data[end:], p)
	if n < len(p) {
		copy(r.data, p[n:])
	}
	r.size += len(p)
}

// Snapshot returns a copy of the buffered output, oldest first.
func (r *RingBuffer) Snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, r.size)
	n := copy(out, r.data[r.start:])
	if n < r.size {
		copy(out[n:], r.data[:r.size-n])
	}
	return out
}
