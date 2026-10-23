package sshx

import (
	"errors"
	"fmt"
	"io"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Shell is an interactive PTY session on a Client.
type Shell struct {
	session *ssh.Session
	stdin   io.WriteCloser

	// output is the single consumer channel: PTY stdout and stderr are merged
	// (a PTY has one stream), so ordering is preserved by construction.
	output chan []byte
	exitCh chan int

	closeOnce sync.Once
}

// PtySize is the terminal geometry.
type PtySize struct{ Cols, Rows uint16 }

// OpenShell requests a PTY and starts the user's login shell.
func (c *Client) OpenShell(size PtySize) (*Shell, error) {
	sess, err := c.Conn.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open session: %w", err)
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if size.Cols == 0 {
		size.Cols = 80
	}
	if size.Rows == 0 {
		size.Rows = 24
	}
	if err := sess.RequestPty("xterm-256color", int(size.Rows), int(size.Cols), modes); err != nil {
		sess.Close()
		return nil, fmt.Errorf("request pty: %w", err)
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}

	s := &Shell{
		session: sess,
		stdin:   stdin,
		output:  make(chan []byte, 256),
		exitCh:  make(chan int, 1),
	}

	// Two readers feed one channel. With a PTY the server normally merges them,
	// but a server that keeps them apart would otherwise deadlock on a full
	// stderr pipe — reading both is the only safe arrangement.
	go s.pump(stdout)
	go s.pump(stderr)

	if err := sess.Shell(); err != nil {
		sess.Close()
		return nil, fmt.Errorf("start shell: %w", err)
	}

	go func() {
		err := sess.Wait()
		code := 0
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitStatus()
		} else if err != nil {
			code = -1
		}
		select {
		case s.exitCh <- code:
		default:
		}
		close(s.output)
	}()

	return s, nil
}

func (s *Shell) pump(r io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			// Copy: buf is reused by the next Read, and the consumer may hold
			// the slice past this iteration.
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			select {
			case s.output <- chunk:
			case <-s.exitCh:
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// Output yields PTY bytes until the shell exits (channel closed).
func (s *Shell) Output() <-chan []byte { return s.output }

// ExitCode yields the exit status once, after Output closes.
func (s *Shell) ExitCode() <-chan int { return s.exitCh }

// Write sends keystrokes to the PTY.
func (s *Shell) Write(p []byte) (int, error) { return s.stdin.Write(p) }

// Resize applies a new window size.
func (s *Shell) Resize(size PtySize) error {
	if size.Cols == 0 || size.Rows == 0 {
		return nil
	}
	return s.session.WindowChange(int(size.Rows), int(size.Cols))
}

// Close terminates the shell. Safe to call multiple times and from any
// goroutine; the session close unblocks both pump goroutines.
func (s *Shell) Close() error {
	var err error
	s.closeOnce.Do(func() {
		err = s.session.Close()
	})
	return err
}
