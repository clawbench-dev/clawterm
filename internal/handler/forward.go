package handler

import (
	"errors"
	"net/http"
	"strconv"

	"clawterm/internal/forward"
	"clawterm/internal/sshx"
	"clawterm/internal/store"
)

// forwardView is one running or configured forward, merged for the UI.
type forwardView struct {
	ID          int64  `json:"id"`
	HostID      int64  `json:"hostId"`
	HostName    string `json:"hostName"`
	LocalPort   int    `json:"localPort"`
	RemoteHost  string `json:"remoteHost"`
	RemotePort  int    `json:"remotePort"`
	AutoStart   bool   `json:"autoStart"`
	Running     bool   `json:"running"`
	Error       string `json:"error,omitempty"`
	Connections int64  `json:"connections"`
}

// handleForwards lists the merged view, or starts/stops a rule.
//
// POST   /api/forwards  {hostId, localPort, remoteHost, remotePort, autoStart}
// DELETE /api/forwards?port=NNNN
//
// A rule can exist without running (autoStart off, or its host is not
// connected) and can run without a rule (a one-off from the UI), so the list is
// a union keyed by local port.
func (s *Server) handleForwards(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rules, err := s.store.ListForwardRules()
		if err != nil {
			fail(w, err)
			return
		}
		hosts, err := s.store.ListHosts()
		if err != nil {
			fail(w, err)
			return
		}
		names := make(map[int64]string, len(hosts))
		for _, h := range hosts {
			names[h.ID] = h.Name
		}
		running := make(map[int]forward.Status)
		for _, st := range s.forwards.List() {
			running[st.LocalPort] = st
		}
		out := make([]forwardView, 0, len(rules)+len(running))
		seen := map[int]bool{}
		for _, rule := range rules {
			v := forwardView{
				ID: rule.ID, HostID: rule.HostID, HostName: names[rule.HostID],
				LocalPort: rule.LocalPort, RemoteHost: rule.RemoteHost,
				RemotePort: rule.RemotePort, AutoStart: rule.AutoStart,
			}
			if st, ok := running[rule.LocalPort]; ok {
				v.Running, v.Error, v.Connections = st.Running, st.Error, st.Connections
			}
			seen[rule.LocalPort] = true
			out = append(out, v)
		}
		for port, st := range running {
			if seen[port] {
				continue
			}
			out = append(out, forwardView{
				HostID: st.HostID, HostName: names[st.HostID], LocalPort: st.LocalPort,
				RemoteHost: st.RemoteHost, RemotePort: st.RemotePort,
				Running: st.Running, Error: st.Error, Connections: st.Connections,
			})
		}
		writeJSON(w, http.StatusOK, out)

	case http.MethodPost:
		var body struct {
			HostID     int64  `json:"hostId"`
			LocalPort  int    `json:"localPort"`
			RemoteHost string `json:"remoteHost"`
			RemotePort int    `json:"remotePort"`
			AutoStart  bool   `json:"autoStart"`
		}
		if err := decode(r, &body); err != nil {
			fail(w, err)
			return
		}
		if body.LocalPort < 1 || body.LocalPort > 65535 || body.RemotePort < 1 || body.RemotePort > 65535 {
			fail(w, badRequest("ports must be between 1 and 65535"))
			return
		}
		if body.HostID <= 0 {
			fail(w, badRequest("hostId is required"))
			return
		}
		if body.RemoteHost == "" {
			body.RemoteHost = "127.0.0.1"
		}
		client, err := s.dialHost(body.HostID)
		if err != nil {
			fail(w, err)
			return
		}
		// The reference moves to the forward: a running forward must keep its
		// SSH connection alive even after every terminal on that host closes.
		hostID := body.HostID
		st, err := s.forwards.Start(hostID, client.Conn, body.LocalPort, body.RemoteHost, body.RemotePort,
			func() { s.release(hostID) })
		if err != nil {
			s.release(hostID)
			if errors.Is(err, forward.ErrAlreadyRunning) {
				fail(w, &apiError{status: http.StatusConflict, msg: err.Error()})
				return
			}
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, st)

	case http.MethodDelete:
		port, _ := strconv.Atoi(r.URL.Query().Get("port"))
		if port <= 0 {
			fail(w, badRequest("port is required"))
			return
		}
		if err := s.forwards.Stop(port); err != nil && !errors.Is(err, forward.ErrNotRunning) {
			fail(w, err)
			return
		}
		// Deleting the runtime forward also drops the persisted rule, so the
		// list does not keep showing a rule whose port is free.
		rules, err := s.store.ListForwardRules()
		if err != nil {
			fail(w, err)
			return
		}
		for _, rule := range rules {
			if rule.LocalPort == port {
				if err := s.store.DeleteForwardRule(rule.ID); err != nil {
					fail(w, err)
					return
				}
			}
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// dialHost opens (or reuses) a connection for a non-terminal operation and
// returns it with one reference taken. The caller must release that reference
// (or hand it to something that will), otherwise the connection is pinned open
// forever.
func (s *Server) dialHost(hostID int64) (*sshx.Client, error) {
	h, err := s.store.GetHost(hostID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, notFound("host not found")
	}
	if err != nil {
		return nil, err
	}
	c, _, err := s.acquire(h)
	if err != nil {
		return nil, err
	}
	return c, nil
}
