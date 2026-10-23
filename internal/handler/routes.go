package handler

import (
	"net/http"

	"clawterm/internal/frontend"
)

// RegisterRoutes is the single source of truth for the HTTP surface. The
// binary and the tests both build the mux from here, so a route cannot exist in
// one and be missing from the other.
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	s.registerAPI(mux)
	// The static app must be registered last: "/" matches everything, so any
	// API route added after it would be shadowed.
	mux.Handle("/", frontend.Handler())
}
