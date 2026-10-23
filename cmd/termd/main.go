// Command termd is the ClawTerm server: an SSH/SFTP client whose UI is a Vue
// app served from the same process. The Android build runs this binary inside
// the APK (via a Go-built .so) or on a companion host; the desktop/browser
// build runs it directly.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"clawterm/internal/handler"
	"clawterm/internal/secret"
	"clawterm/internal/store"
	"clawterm/internal/terminal"
	"clawterm/internal/version"
)

func main() {
	port := flag.Int("port", 20010, "listen port")
	host := flag.String("host", "127.0.0.1", "listen address (127.0.0.1 keeps the API on this machine; 0.0.0.0 exposes every stored credential to the LAN)")
	dataDir := flag.String("data-dir", "", "data directory (default: ~/.clawterm)")
	noBrowser := flag.Bool("no-browser", false, "do not open a browser on start")
	flag.Parse()

	dir := *dataDir
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("resolve home dir: %v", err)
		}
		dir = filepath.Join(home, ".clawterm")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	st, err := store.Open(dir)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer st.Close()

	sec, err := secret.Open(dir)
	if err != nil {
		log.Fatalf("open secret store: %v", err)
	}

	terms := terminal.NewManager()
	defer terms.Shutdown()

	srv := handler.New(st, sec, terms, version.Version)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	httpSrv := &http.Server{
		Addr:              net.JoinHostPort(*host, itoa(*port)),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: the terminal WebSocket is long-lived by design.
	}

	ln, err := net.Listen("tcp", httpSrv.Addr)
	if err != nil {
		log.Fatalf("listen on %s: %v", httpSrv.Addr, err)
	}
	log.Printf("ClawTerm %s listening on http://%s (data: %s)", version.Version, httpSrv.Addr, dir)
	if !*noBrowser {
		go openBrowser("http://" + *host + ":" + itoa(*port))
	}

	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Print("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
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
