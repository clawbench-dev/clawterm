package main

import (
	"os/exec"
	"runtime"
)

// openBrowser launches the system browser. Failure is deliberately silent: on
// a headless machine (or Android, where the URL is loaded by the WebView) there
// is nothing to open, and the URL is already printed to the log.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
