package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"clawterm/internal/sshx"
	"clawterm/internal/terminal"
)

// Terminal protocol (JSON frames, mirrored in web/src/utils/terminalProtocol.ts).
//
// Client → server:
//
//	{type:"input", data:"..."}          keystrokes (already UTF-8 text)
//	{type:"resize", cols, rows}         window size
//	{type:"ping"}                       keepalive (the phone sleeps mid-session)
//
// Server → client:
//
//	{type:"ready", sessionId, cwd, title}
//	{type:"replay", data:"..."}         scrollback, sent before any output
//	{type:"output", data:"..."}
//	{type:"exit", code}
//	{type:"error", message, code}
//	{type:"pong"}
type clientMsg struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

type serverMsg struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"`
	Data      string `json:"data,omitempty"`
	Title     string `json:"title,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	Code      int    `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
	ErrCode   string `json:"errcode,omitempty"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  16 * 1024,
	WriteBufferSize: 16 * 1024,
	// Same-origin is enforced by the session cookie plus this check. The app is
	// served from the same origin in every deployment (embedded server), so a
	// blanket allow would only weaken the check.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // native WebView and non-browser clients send none
		}
		host := r.Host
		return strings.HasSuffix(origin, "://"+host)
	},
}

// handleTerminalWS attaches a WebSocket to a PTY.
//
// Query: hostId (required for a new session), session (to re-attach),
// cols/rows (initial geometry), title (tab label).
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	q := r.URL.Query()
	connID := fmt.Sprintf("%p", conn)

	var sess *terminal.Session
	if sid := q.Get("session"); sid != "" {
		sess, err = s.terms.Get(sid)
		if err != nil {
			writeWS(conn, serverMsg{Type: "error", ErrCode: "session_gone", Message: "terminal session no longer exists"})
			return
		}
	} else {
		hostID := int64(0)
		if raw := q.Get("hostId"); raw != "" {
			fmt.Sscanf(raw, "%d", &hostID)
		}
		if hostID <= 0 {
			writeWS(conn, serverMsg{Type: "error", ErrCode: "bad_request", Message: "hostId is required"})
			return
		}
		h, gerr := s.store.GetHost(hostID)
		if gerr != nil {
			writeWS(conn, serverMsg{Type: "error", ErrCode: "host_not_found", Message: "host not found"})
			return
		}
		client, notice, derr := s.acquire(h)
		if derr != nil {
			var mismatch *sshx.HostKeyMismatch
			if errors.As(derr, &mismatch) {
				writeWS(conn, serverMsg{
					Type:    "error",
					ErrCode: "host_key_changed",
					Message: fmt.Sprintf("host key changed: %s %s → %s %s", mismatch.OldType, mismatch.OldFinger, mismatch.NewType, mismatch.NewFinger),
				})
				return
			}
			code := "connect_failed"
			var dialErr *sshx.DialError
			if errors.As(derr, &dialErr) {
				code = dialErr.Code
			}
			writeWS(conn, serverMsg{Type: "error", ErrCode: code, Message: derr.Error()})
			return
		}
		title := q.Get("title")
		if title == "" {
			title = h.Name
		}
		// The reference taken by acquire() is handed to the session: it must
		// survive this WebSocket, otherwise a dropped connection (phone sleeps,
		// network change) would close the SSH client and kill the PTY we are
		// deliberately keeping alive for re-attach.
		sess, err = s.terms.Open(hostID, title, client, sshx.PtySize{Cols: atoi16(q.Get("cols"), 80), Rows: atoi16(q.Get("rows"), 24)},
			func() { s.release(hostID) })
		if err != nil {
			s.release(hostID)
			code := "shell_failed"
			if errors.Is(err, terminal.ErrLimit) {
				code = "session_limit"
			}
			writeWS(conn, serverMsg{Type: "error", ErrCode: code, Message: err.Error()})
			return
		}
		_ = notice
	}

	chunks, replay, aerr := sess.Attach(connID)
	if aerr != nil {
		writeWS(conn, serverMsg{Type: "error", ErrCode: "session_busy", Message: aerr.Error()})
		return
	}
	defer sess.Detach(connID)

	if err := writeWS(conn, serverMsg{Type: "ready", SessionID: sess.ID, Title: sess.Title}); err != nil {
		return
	}
	if len(replay) > 0 {
		if err := writeWS(conn, serverMsg{Type: "replay", Data: string(replay)}); err != nil {
			return
		}
	}

	// One writer goroutine owns the connection: gorilla/websocket forbids
	// concurrent writes, and both the PTY pump and the reader's pong need to
	// write.
	var wmu sync.Mutex
	send := func(m serverMsg) error {
		wmu.Lock()
		defer wmu.Unlock()
		return conn.WriteJSON(m)
	}

	done := make(chan struct{})
	var closeOnce sync.Once
	shutdown := func() { closeOnce.Do(func() { close(done) }) }

	// PTY → client
	go func() {
		for chunk := range chunks {
			if err := send(serverMsg{Type: "output", Data: string(chunk)}); err != nil {
				shutdown()
				return
			}
		}
		if exited, code := sess.Exited(); exited {
			_ = send(serverMsg{Type: "exit", Code: code})
		}
		shutdown()
	}()

	// Keepalive: a phone that backgrounds for a minute must not have its
	// connection reaped by an intermediary while the PTY stays alive.
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if err := send(serverMsg{Type: "pong"}); err != nil {
					shutdown()
					return
				}
			}
		}
	}()

	// client → PTY (this goroutine owns reads)
	for {
		var m clientMsg
		if err := conn.ReadJSON(&m); err != nil {
			return
		}
		switch m.Type {
		case "input":
			if m.Data != "" {
				if err := sess.Write([]byte(m.Data)); err != nil {
					_ = send(serverMsg{Type: "error", ErrCode: "write_failed", Message: err.Error()})
					return
				}
			}
		case "resize":
			_ = sess.Resize(sshx.PtySize{Cols: m.Cols, Rows: m.Rows})
		case "ping":
			if err := send(serverMsg{Type: "pong"}); err != nil {
				return
			}
		}
		select {
		case <-done:
			return
		default:
		}
	}
}

func writeWS(conn *websocket.Conn, m serverMsg) error { return conn.WriteJSON(m) }

func atoi16(s string, def uint16) uint16 {
	var v int
	if _, err := fmt.Sscanf(s, "%d", &v); err != nil || v <= 0 || v > 65535 {
		return def
	}
	return uint16(v)
}

// ── terminal session list / close ────────────────────────────────────────────

type terminalInfo struct {
	ID     string `json:"id"`
	HostID int64  `json:"hostId"`
	Title  string `json:"title"`
	Exited bool   `json:"exited"`
	Code   int    `json:"code"`
}

func (s *Server) handleTerminalSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list := s.terms.List()
		out := make([]terminalInfo, 0, len(list))
		for _, t := range list {
			exited, code := t.Exited()
			out = append(out, terminalInfo{ID: t.ID, HostID: t.HostID, Title: t.Title, Exited: exited, Code: code})
		}
		writeJSON(w, http.StatusOK, out)

	case http.MethodDelete:
		id := r.URL.Query().Get("session")
		if id == "" {
			fail(w, badRequest("session is required"))
			return
		}
		if err := s.terms.CloseSession(id); err != nil && !errors.Is(err, terminal.ErrNotFound) {
			fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		w.Header().Set("Allow", "GET, DELETE")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// ── SFTP file browsing ───────────────────────────────────────────────────────

type fileEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	IsLink  bool   `json:"isLink"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime int64  `json:"modTime"` // unix millis
}

// sftpFor resolves host → SFTP client, registering a temporary reference so a
// file operation cannot race a terminal closing the pooled connection.
func (s *Server) sftpFor(hostID int64) (*sshx.Client, error) {
	h, err := s.store.GetHost(hostID)
	if err != nil {
		return nil, notFound("host not found")
	}
	c, _, err := s.acquire(h)
	if err != nil {
		return nil, err
	}
	return c, nil
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	hostID, _ := parseI64(r.URL.Query().Get("hostId"))
	if hostID <= 0 {
		fail(w, badRequest("hostId is required"))
		return
	}
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = "."
	}
	client, err := s.sftpFor(hostID)
	if err != nil {
		fail(w, err)
		return
	}
	defer s.release(hostID)

	sc, err := client.SFTP()
	if err != nil {
		fail(w, err)
		return
	}
	abs, err := sc.RealPath(dir)
	if err != nil {
		fail(w, fmt.Errorf("resolve %s: %w", dir, err))
		return
	}
	infos, err := sc.ReadDir(abs)
	if err != nil {
		fail(w, fmt.Errorf("read dir %s: %w", abs, err))
		return
	}
	out := make([]fileEntry, 0, len(infos))
	for _, fi := range infos {
		link := fi.Mode()&os.ModeSymlink != 0
		isDir := fi.IsDir()
		size := fi.Size()
		if link {
			// Follow the link so the UI shows a directory as a directory. A
			// dangling link stays a link and is not entered.
			if st, err := sc.Stat(path.Join(abs, fi.Name())); err == nil {
				isDir = st.IsDir()
				size = st.Size()
			}
		}
		out = append(out, fileEntry{
			Name:    fi.Name(),
			Path:    path.Join(abs, fi.Name()),
			IsDir:   isDir,
			IsLink:  link,
			Size:    size,
			Mode:    fi.Mode().String(),
			ModTime: fi.ModTime().UnixMilli(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"path": abs, "entries": out})
}

// handleFileContent streams a remote file to the browser. Large files are
// truncated with an explicit flag rather than silently cut.
func (s *Server) handleFileContent(w http.ResponseWriter, r *http.Request) {
	hostID, _ := parseI64(r.URL.Query().Get("hostId"))
	p := r.URL.Query().Get("path")
	if hostID <= 0 || p == "" {
		fail(w, badRequest("hostId and path are required"))
		return
	}
	const maxBytes = 2 << 20 // 2 MiB: a text preview, not a download

	client, err := s.sftpFor(hostID)
	if err != nil {
		fail(w, err)
		return
	}
	defer s.release(hostID)
	sc, err := client.SFTP()
	if err != nil {
		fail(w, err)
		return
	}
	f, err := sc.Open(p)
	if err != nil {
		fail(w, fmt.Errorf("open %s: %w", p, err))
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		fail(w, err)
		return
	}
	if st.IsDir() {
		fail(w, badRequest("%s is a directory", p))
		return
	}
	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		fail(w, err)
		return
	}
	truncated := n > maxBytes
	if truncated {
		n = maxBytes
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":      p,
		"size":      st.Size(),
		"truncated": truncated,
		"content":   string(buf[:n]),
	})
}

// handleFileDownload streams the raw bytes (used for "save to device").
func (s *Server) handleFileDownload(w http.ResponseWriter, r *http.Request) {
	hostID, _ := parseI64(r.URL.Query().Get("hostId"))
	p := r.URL.Query().Get("path")
	if hostID <= 0 || p == "" {
		fail(w, badRequest("hostId and path are required"))
		return
	}
	client, err := s.sftpFor(hostID)
	if err != nil {
		fail(w, err)
		return
	}
	defer s.release(hostID)
	sc, err := client.SFTP()
	if err != nil {
		fail(w, err)
		return
	}
	f, err := sc.Open(p)
	if err != nil {
		fail(w, fmt.Errorf("open %s: %w", p, err))
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		fail(w, err)
		return
	}
	if st.IsDir() {
		fail(w, badRequest("%s is a directory", p))
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", path.Base(p)))
	if _, err := io.Copy(w, f); err != nil {
		// Headers are gone; the client sees a truncated body, which is the
		// only signal available at this point.
		return
	}
}

func parseI64(s string) (int64, bool) {
	var v int64
	if _, err := fmt.Sscanf(s, "%d", &v); err != nil {
		return 0, false
	}
	return v, true
}
