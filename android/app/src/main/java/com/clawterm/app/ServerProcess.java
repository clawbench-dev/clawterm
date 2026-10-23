package com.clawterm.app;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * Runs the bundled Go server as a child process.
 *
 * ## Why a child process and not an embedded library
 *
 * The Go side needs a PTY-equivalent (it opens SSH channels, not local PTYs) and
 * a real HTTP server; both are ordinary Go code that already exists for the
 * desktop build. Loading Go as a shared library would require cgo + the NDK,
 * which is a build-toolchain dependency for no runtime benefit. A PIE binary in
 * {@code nativeLibraryDir} is executable, and a child process is also what lets
 * the server outlive a WebView recreation.
 *
 * ## Lifecycle
 *
 * The server is started from {@link MainActivity#onCreate} and stopped in
 * {@link MainActivity#onDestroy} ONLY when the activity is really finishing —
 * a configuration change (rotation) must not kill the SSH sessions. The
 * process therefore has to be tracked here rather than owned by the activity.
 */
final class ServerProcess {

    private static final String TAG = "ClawTermServer";

    private static Process process;
    private static Thread logPump;
    /** Last few lines of server output, shown in the error screen. */
    private static final List<String> recentLog = new ArrayList<>();

    private ServerProcess() {}

    /** True when something is already answering on the loopback port. */
    static boolean isRunning() {
        return portOpen(ServerConfig.PORT, 150);
    }

    /**
     * Start the server if it is not already up.
     *
     * Returns true when the port is answering. The check is a real TCP connect,
     * not a flag: the process can die at any time (OOM, crash), and a stale
     * "started" flag would leave the WebView loading a dead URL forever.
     */
    static synchronized boolean ensureStarted(Context ctx) {
        if (isRunning()) return true;

        File bin = new File(ServerConfig.binaryPath(ctx));
        if (!bin.exists()) {
            appendLog("server binary missing: " + bin.getAbsolutePath());
            return false;
        }

        try {
            ProcessBuilder pb = new ProcessBuilder(
                    bin.getAbsolutePath(),
                    "--port", String.valueOf(ServerConfig.PORT),
                    "--data-dir", ServerConfig.dataDir(ctx),
                    "--no-browser");
            // Merge stderr into stdout so the pump sees panic output too.
            pb.redirectErrorStream(true);
            pb.directory(ctx.getFilesDir());
            process = pb.start();
            startLogPump(process);
        } catch (IOException e) {
            appendLog("failed to start: " + e.getMessage());
            Log.e(TAG, "start failed", e);
            return false;
        }

        // The server opens SQLite and the secret store before it listens; on a
        // cold device that can take a moment. 6s is generous but bounded — a
        // longer wait would just delay showing the error screen.
        for (int i = 0; i < 60; i++) {
            if (portOpen(ServerConfig.PORT, 120)) {
                Log.i(TAG, "server is up");
                return true;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        appendLog("server did not open port " + ServerConfig.PORT + " in time");
        return false;
    }

    /** Stop the server (activity finishing for good). */
    static synchronized void stop() {
        if (process != null) {
            process.destroy();
            process = null;
        }
    }

    /** Recent server output, newest last. */
    static List<String> logs() {
        synchronized (recentLog) {
            return new ArrayList<>(recentLog);
        }
    }

    private static void startLogPump(Process p) {
        logPump = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) {
                    appendLog(line);
                    Log.i(TAG, line);
                }
            } catch (IOException ignored) {
                // The process ended; nothing left to read.
            }
        }, "termd-log");
        logPump.setDaemon(true);
        logPump.start();
    }

    private static void appendLog(String line) {
        synchronized (recentLog) {
            recentLog.add(line);
            while (recentLog.size() > 50) recentLog.remove(0);
        }
    }

    /** TCP connect probe with a short timeout. */
    static boolean portOpen(int port, int timeoutMs) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(ServerConfig.LOOPBACK, port), timeoutMs);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** HTTP probe, used to confirm the app is really being served. */
    static boolean httpReady() {
        try {
            URL url = new URL(ServerConfig.baseUrl() + "api/auth/status");
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(800);
            c.setReadTimeout(1500);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (IOException e) {
            return false;
        }
    }
}
