package handler

import "net/http"

// registerAPI wires every /api/ route without the static-file handler.
//
// It exists separately from RegisterRoutes so unit tests can build the API
// surface on its own: the embedded frontend may be a placeholder during a test
// run, and serving it would only add noise. RegisterRoutes must stay a thin
// wrapper around this plus the static handler, so a new route cannot be added
// to one and forgotten in the other.
func (s *Server) registerAPI(mux *http.ServeMux) {
	// ── unauthenticated ──
	// Status and login stay open: they are how a client discovers that it must
	// set (or enter) the password at all.
	mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)

	// ── hosts ──
	mux.HandleFunc("GET /api/hosts", s.RequireAuth(s.handleHosts))
	mux.HandleFunc("POST /api/hosts", s.RequireAuth(s.handleHosts))
	mux.HandleFunc("GET /api/hosts/{id}", s.RequireAuth(s.handleHostByID))
	mux.HandleFunc("PUT /api/hosts/{id}", s.RequireAuth(s.handleHostByID))
	mux.HandleFunc("DELETE /api/hosts/{id}", s.RequireAuth(s.handleHostByID))
	mux.HandleFunc("POST /api/hosts/{id}/test", s.RequireAuth(s.handleHostTest))
	mux.HandleFunc("POST /api/hosts/{id}/forget-key", s.RequireAuth(s.handleHostForgetKey))

	// ── snippets ──
	mux.HandleFunc("GET /api/snippets", s.RequireAuth(s.handleSnippets))
	mux.HandleFunc("POST /api/snippets", s.RequireAuth(s.handleSnippets))
	mux.HandleFunc("PUT /api/snippets/reorder", s.RequireAuth(s.handleSnippetReorder))
	mux.HandleFunc("PUT /api/snippets/{id}", s.RequireAuth(s.handleSnippetByID))
	mux.HandleFunc("DELETE /api/snippets/{id}", s.RequireAuth(s.handleSnippetByID))

	// ── forwards ──
	mux.HandleFunc("GET /api/forwards", s.RequireAuth(s.handleForwards))
	mux.HandleFunc("POST /api/forwards", s.RequireAuth(s.handleForwards))
	mux.HandleFunc("DELETE /api/forwards", s.RequireAuth(s.handleForwards))

	// ── terminal ──
	mux.HandleFunc("GET /api/terminal/ws", s.RequireAuth(s.handleTerminalWS))
	mux.HandleFunc("GET /api/terminal/sessions", s.RequireAuth(s.handleTerminalSessions))
	mux.HandleFunc("DELETE /api/terminal/sessions", s.RequireAuth(s.handleTerminalSessions))

	// ── sftp files ──
	mux.HandleFunc("GET /api/files", s.RequireAuth(s.handleFiles))
	mux.HandleFunc("GET /api/files/content", s.RequireAuth(s.handleFileContent))
	mux.HandleFunc("GET /api/files/download", s.RequireAuth(s.handleFileDownload))

	// ── meta ──
	mux.HandleFunc("GET /api/system", s.RequireAuth(s.handleSystem))
}
