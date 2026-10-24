package com.clawterm.app;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Live terminal sessions: one PTY-backed SSH channel per tab.
 *
 * ## Why sessions outlive the view
 *
 * A phone that sleeps, a network change, a WebView reload — none of those mean
 * the remote shell should die. Sessions are held here, keyed by id, with a
 * scrollback ring buffer; the view can re-attach and be replayed.
 *
 * ## Threading
 *
 * Every public method is callable from the bridge thread. PTY reads happen on a
 * dedicated reader thread per session, and events are pushed through a listener
 * that marshals to the WebView. Nothing here touches a View.
 */
final class TerminalManager {

    /** How much scrollback to keep for replay. */
    private static final int REPLAY_BYTES = 256 * 1024;
    /** More than this many open terminals is a runaway client, not a user. */
    static final int MAX_SESSIONS = 12;

    interface Listener {
        /** Raw PTY bytes; the caller base64-encodes them for the bridge. */
        void onData(String sessionId, byte[] data);

        void onExit(String sessionId, int code);

        void onState(String sessionId, String state, String message, String code);
    }

    private static final class Session {
        final String id;
        final long hostId;
        final String title;
        final SshConnection conn;
        final SshConnection.Shell shell;
        final RingBuffer buffer = new RingBuffer(REPLAY_BYTES);

        volatile boolean closed;
        volatile boolean exited;
        volatile int exitCode;

        Session(String id, long hostId, String title, SshConnection conn, SshConnection.Shell shell) {
            this.id = id;
            this.hostId = hostId;
            this.title = title;
            this.conn = conn;
            this.shell = shell;
        }
    }

    private final Map<String, Session> sessions = new HashMap<>();
    private final Listener listener;
    private int seq = 0;

    TerminalManager(Listener listener) {
        this.listener = listener;
    }

    synchronized int count() {
        return sessions.size();
    }

    /** Open a new PTY session on an existing connection. */
    synchronized String open(long hostId, String title, SshConnection conn, int cols, int rows)
            throws SshException {
        if (sessions.size() >= MAX_SESSIONS) {
            throw new SshException("too many terminals", "session_limit");
        }
        SshConnection.Shell shell = conn.openShell(cols, rows);
        String id = "s" + (++seq) + "-" + Long.toHexString(System.nanoTime());
        Session s = new Session(id, hostId, title, conn, shell);
        conn.retain();
        sessions.put(id, s);
        startReader(s);
        return id;
    }

    private void startReader(Session s) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[16 * 1024];
            try {
                InputStream in = s.shell.out;
                while (!s.closed) {
                    int n = in.read(buf);
                    if (n < 0) break;
                    if (n == 0) continue;
                    s.buffer.write(buf, n);
                    listener.onData(s.id, java.util.Arrays.copyOf(buf, n));
                }
            } catch (IOException e) {
                // The channel died. A close() from the UI also lands here, which
                // is why the exit is only reported when we did not ask for it.
            } finally {
                s.exited = true;
                int code = s.shell.channel.getExitStatus();
                s.exitCode = code < 0 ? 0 : code;
                listener.onExit(s.id, s.exitCode);
                // Release the connection reference: the PTY is gone, so this
                // channel no longer needs it. The connection itself stays while
                // another tab uses it.
                if (s.conn.release()) s.conn.close();
                synchronized (TerminalManager.this) {
                    sessions.remove(s.id);
                }
            }
        }, "pty-" + s.id);
        t.setDaemon(true);
        t.start();
    }

    /** Replay the scrollback for a session, or null when it is gone. */
    synchronized byte[] replay(String sessionId) {
        Session s = sessions.get(sessionId);
        return s == null ? null : s.buffer.snapshot();
    }

    synchronized boolean exists(String sessionId) {
        return sessions.containsKey(sessionId);
    }

    synchronized long hostOf(String sessionId) {
        Session s = sessions.get(sessionId);
        return s == null ? -1 : s.hostId;
    }

    void write(String sessionId, String data) throws SshException {
        Session s;
        synchronized (this) {
            s = sessions.get(sessionId);
        }
        if (s == null) throw new SshException("session is gone", "session_gone");
        try {
            OutputStream out = s.shell.in;
            out.write(data.getBytes("UTF-8"));
            out.flush();
        } catch (IOException e) {
            throw new SshException(String.valueOf(e.getMessage()), "write_failed");
        }
    }

    void resize(String sessionId, int cols, int rows) {
        Session s;
        synchronized (this) {
            s = sessions.get(sessionId);
        }
        if (s == null) return;
        s.conn.resize(s.shell, cols, rows);
    }

    /** End a session. Idempotent: closing twice is not an error. */
    void close(String sessionId) {
        Session s;
        synchronized (this) {
            s = sessions.remove(sessionId);
        }
        if (s == null) return;
        s.closed = true;
        try {
            s.shell.channel.disconnect();
        } catch (Exception ignored) {
            // Already dead.
        }
    }

    /** Close every session (app shutdown). */
    void closeAll() {
        List<String> ids;
        synchronized (this) {
            ids = new ArrayList<>(sessions.keySet());
        }
        for (String id : ids) close(id);
    }

    /** Snapshot for the session list endpoint. */
    List<Map<String, Object>> list() {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (this) {
            for (Session s : sessions.values()) {
                Map<String, Object> m = new HashMap<>();
                m.put("id", s.id);
                m.put("hostId", s.hostId);
                m.put("title", s.title);
                m.put("state", s.exited ? "exited" : "connected");
                m.put("exited", s.exited);
                m.put("code", s.exitCode);
                out.add(m);
            }
        }
        return out;
    }

    /** Report a state change for a session (used by the connect path). */
    void reportState(String sessionId, String state, String message, String code) {
        listener.onState(sessionId, state, message, code);
    }

    // ── ring buffer ─────────────────────────────────────────────────────────

    /**
     * Byte-bounded circular buffer of raw PTY output.
     *
     * Stores BYTES, not lines: ANSI escape sequences routinely straddle two
     * reads, and splitting on newlines would corrupt the replay into a screen of
     * literal escape codes.
     */
    static final class RingBuffer {
        private final byte[] data;
        private final int cap;
        private int start;
        private int size;

        RingBuffer(int cap) {
            this.cap = Math.max(1024, cap);
            this.data = new byte[this.cap];
        }

        synchronized void write(byte[] p, int len) {
            if (len <= 0) return;
            if (len >= cap) {
                // The write alone overflows: keep only its tail.
                System.arraycopy(p, len - cap, data, 0, cap);
                start = 0;
                size = cap;
                return;
            }
            if (size + len > cap) {
                int over = size + len - cap;
                start = (start + over) % cap;
                size -= over;
            }
            int end = (start + size) % cap;
            int first = Math.min(len, cap - end);
            System.arraycopy(p, 0, data, end, first);
            if (first < len) System.arraycopy(p, first, data, 0, len - first);
            size += len;
        }

        synchronized byte[] snapshot() {
            byte[] out = new byte[size];
            int first = Math.min(size, cap - start);
            System.arraycopy(data, start, out, 0, first);
            if (first < size) System.arraycopy(data, 0, out, first, size - first);
            return out;
        }
    }
}
