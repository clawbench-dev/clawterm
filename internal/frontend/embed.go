// Package frontend serves the built Vue app: from disk when a build output
// directory sits next to the running process (development and the desktop /
// Android embedded-server case), otherwise from the copy embedded at build
// time (single-binary distribution).
package frontend

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
)

// DiskDirName is the build output directory, resolved relative to the process
// CWD. Deliberately distinctive: a generic name like "public" collides with
// unrelated directories on real machines (macOS ships ~/Public, and APFS is
// case-insensitive by default), which once made the server serve an empty
// directory and every page 404.
const DiskDirName = ".clawterm-web"

//go:embed all:dist
var embedded embed.FS

// FS returns the filesystem to serve from, and whether it came from disk.
func FS() (fs.FS, bool) {
	if st, err := os.Stat(DiskDirName); err == nil && st.IsDir() {
		return os.DirFS(DiskDirName), true
	}
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil, false
	}
	return sub, false
}

// Handler serves static files with an SPA fallback to index.html.
//
// The fallback is deliberately narrow: only extension-less paths get
// index.html. A missing asset must 404 so the browser's chunk-load recovery
// can see the failure — serving index.html for a missing .js file turns a
// stale-chunk problem into a syntax error from HTML being parsed as JS.
func Handler() http.Handler {
	root, _ := FS()
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if p == "" {
			serveIndex(w, r, root)
			return
		}
		if st, err := fs.Stat(root, p); err == nil && !st.IsDir() {
			// Hashed assets are immutable; index.html must never be cached or a
			// rebuild is invisible until the app is reinstalled.
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		if strings.Contains(path.Base(p), ".") {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r, root)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, root fs.FS) {
	data, err := fs.ReadFile(root, "index.html")
	if err != nil {
		http.Error(w, "frontend not built", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}
