package com.clawterm.app;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpException;
import com.jcraft.jsch.UIKeyboardInteractive;
import com.jcraft.jsch.UserInfo;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;

/**
 * One SSH connection, plus the PTY channel that rides on it.
 *
 * ## Why JSch and not a hand-rolled client
 *
 * SSH is not something to implement: key exchange, cipher negotiation, packet
 * MACs and agent forwarding all have to be exactly right. JSch (mwiede's
 * maintained fork) is a pure-Java implementation with no native dependency,
 * which is what lets the app ship as a single APK with no server and no NDK.
 *
 * ## Connection reuse
 *
 * Opening a second SSH connection for a second tab on the same host costs a full
 * handshake and a second auth. This class keeps the {@link Session} and opens an
 * additional channel instead; {@link #refCount} tracks how many channels need it,
 * and the session closes when the last one does.
 */
final class SshConnection {

    private final String host;
    private final int port;
    private final String user;
    private final Session session;

    /** How many channels (terminals + forwards) currently use this session. */
    private int refCount = 1;

    SshConnection(Session session, String host, int port, String user) {
        this.session = session;
        this.host = host;
        this.port = port;
        this.user = user;
    }

    String address() {
        return host + ":" + port;
    }

    String user() {
        return user;
    }

    Session session() {
        return session;
    }

    synchronized int retain() {
        refCount++;
        return refCount;
    }

    /** Returns true when this was the last reference. */
    synchronized boolean release() {
        refCount--;
        return refCount <= 0;
    }

    void close() {
        try {
            session.disconnect();
        } catch (Exception ignored) {
            // Already gone; nothing to do.
        }
    }

    // ── dialling ────────────────────────────────────────────────────────────

    /** Credentials for one attempt. Plaintext lives only in memory. */
    static final class Auth {
        String type = "password";
        String password = "";
        String keyPath = "";
        String passphrase = "";
    }

    /** Host-key verification callback backed by the local pin table. */
    interface HostKeyCheck {
        /**
         * @return null to accept, or a message describing why the key is
         *         rejected. A CHANGED key must be rejected: silently re-pinning
         *         would make the pin pointless.
         */
        String verify(String address, String keyType, String fingerprint);
    }

    /**
     * Open a connection.
     *
     * @throws SshException with a stable code so the UI can translate the failure
     *         instead of matching English text.
     */
    static SshConnection dial(String host, int port, String user, Auth auth,
                              HostKeyCheck check, String knownHostsPin) throws SshException {
        if (port <= 0 || port > 65535) {
            throw new SshException("invalid port " + port, "dial_failed");
        }
        try {
            JSch jsch = new JSch();
            if ("key".equals(auth.type) && auth.keyPath != null && !auth.keyPath.isEmpty()) {
                if (auth.passphrase != null && !auth.passphrase.isEmpty()) {
                    jsch.addIdentity(auth.keyPath, auth.passphrase);
                } else {
                    jsch.addIdentity(auth.keyPath);
                }
            }

            Session session = jsch.getSession(user, host, port);
            session.setConfig("StrictHostKeyChecking", "yes");
            session.setConfig("PreferredAuthentications",
                    "key".equals(auth.type) ? "publickey" : "password,keyboard-interactive");
            // JSch's own host-key repository is bypassed: the pin lives in our
            // database so it survives an app update and can be cleared by the UI.
            session.setHostKeyRepository(new PinningRepository(check));

            if ("password".equals(auth.type)) {
                session.setPassword(auth.password);
                session.setUserInfo(new PasswordUserInfo(auth.password));
            } else if ("agent".equals(auth.type)) {
                // JSch reads SSH_AUTH_SOCK only on a desktop JVM; on Android
                // there is no agent, so fail with a message that says so rather
                // than an empty auth list.
                throw new SshException("ssh agent is not available on Android", "dial_failed");
            }

            // The TCP+handshake timeout. Without it a black-holed route hangs the
            // caller for the OS default (~2 minutes), which reads as a frozen app.
            session.connect(20_000);
            session.setServerAliveInterval(30_000);
            session.setServerAliveCountMax(3);

            if (knownHostsPin != null && !knownHostsPin.isEmpty()) {
                // First successful connection: record the key we just accepted.
                byte[] k = session.getHostKey().getKey().getBytes("UTF-8");
                check.verify(host + ":" + port, session.getHostKey().getType(),
                        "SHA256:" + sha256Base64(k));
            }

            return new SshConnection(session, host, port, user);
        } catch (SshException e) {
            throw e;
        } catch (JSchException e) {
            throw classify(e);
        } catch (Exception e) {
            throw new SshException(String.valueOf(e.getMessage()), "dial_failed");
        }
    }

    /**
     * Map JSch's message strings onto stable codes.
     *
     * JSch has no typed errors, so the only signal is the message. Matching on it
     * is ugly but unavoidable; the codes are what the rest of the app uses, so a
     * JSch wording change breaks translation, not behaviour.
     */
    private static SshException classify(JSchException e) {
        String m = e.getMessage() == null ? "" : e.getMessage();
        String lower = m.toLowerCase();
        String code = "dial_failed";
        if (lower.contains("auth fail") || lower.contains("auth cancel")
                || lower.contains("userauth fail")) {
            code = "auth_failed";
        } else if (lower.contains("connection refused")) {
            code = "connection_refused";
        } else if (lower.contains("timeout") || lower.contains("timed out")) {
            code = "timeout";
        } else if (lower.contains("unknownhost") || lower.contains("unknown host")
                || lower.contains("name or service not known")) {
            code = "host_not_found";
        } else if (lower.contains("hostkey") || lower.contains("host key")) {
            code = "host_key_changed";
        }
        return new SshException(m.isEmpty() ? e.toString() : m, code);
    }

    static String sha256Base64(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        return Base64.getEncoder().withoutPadding().encodeToString(digest);
    }

    /** Answers the host-key question from the local pin table. */
    private static final class PinningRepository implements HostKeyRepository {
        private final HostKeyCheck check;

        PinningRepository(HostKeyCheck check) {
            this.check = check;
        }

        /**
         * Called by JSch BEFORE authentication with the server's key.
         *
         * Returning OK skips JSch's own verification and lets our pin check run
         * here, where the key bytes are available. A changed key must fail the
         * handshake: continuing would mean connecting to an impostor.
         */
        @Override
        public int check(String host, byte[] key) {
            try {
                String type = keyTypeOf(key);
                String fp = "SHA256:" + SshConnection.sha256Base64(key);
                String err = check.verify(host, type, fp);
                return err == null ? OK : NOT_INCLUDED;
            } catch (Exception e) {
                // An unparsable key cannot be verified, so it must not be
                // accepted. Failing closed here is the whole point of pinning.
                return NOT_INCLUDED;
            }
        }

        @Override
        public void add(HostKey hostkey, UserInfo ui) {
            // Pinning is ours, not JSch's.
        }

        @Override
        public void remove(String host, String type) {
            // Same.
        }

        @Override
        public void remove(String host, String type, byte[] key) {
            // Same.
        }

        @Override
        public String getKnownHostsRepositoryID() {
            return "clawterm";
        }

        @Override
        public HostKey[] getHostKey() {
            return new HostKey[0];
        }

        @Override
        public HostKey[] getHostKey(String host, String type) {
            return new HostKey[0];
        }

        /**
         * Read the key algorithm out of the SSH wire encoding.
         *
         * An SSH public key blob starts with a 4-byte big-endian length followed
         * by the algorithm name ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256").
         * Parsing it is cheaper and more reliable than asking JSch, which has no
         * public accessor for a bare key blob.
         */
        private static String keyTypeOf(byte[] blob) {
            if (blob == null || blob.length < 5) return "unknown";
            int len = ((blob[0] & 0xff) << 24) | ((blob[1] & 0xff) << 16)
                    | ((blob[2] & 0xff) << 8) | (blob[3] & 0xff);
            if (len <= 0 || len > blob.length - 4) return "unknown";
            try {
                return new String(blob, 4, len, "UTF-8");
            } catch (Exception e) {
                return "unknown";
            }
        }
    }

    /**
     * Answers password prompts.
     *
     * `promptPassword` returning the password is what makes password auth work at
     * all with JSch; `promptYesNo` must return true only for the host-key
     * question, and we always say no — the pin check has already run.
     */
    private static final class PasswordUserInfo implements UserInfo, UIKeyboardInteractive {
        private final String password;

        PasswordUserInfo(String password) {
            this.password = password;
        }

        @Override
        public String getPassphrase() {
            return null;
        }

        @Override
        public String getPassword() {
            return password;
        }

        @Override
        public boolean promptPassword(String message) {
            return true;
        }

        @Override
        public boolean promptPassphrase(String message) {
            return false;
        }

        @Override
        public boolean promptYesNo(String message) {
            // Never accept an unknown host key here: that path would bypass the
            // pin entirely.
            return false;
        }

        @Override
        public void showMessage(String message) {
            // Nothing to show; the UI reports state from the channel.
        }

        @Override
        public String[] promptKeyboardInteractive(String destination, String name,
                                                  String instruction, String[] prompt, boolean[] echo) {
            String[] answers = new String[prompt.length];
            for (int i = 0; i < answers.length; i++) answers[i] = password;
            return answers;
        }
    }

    // ── shell channel ───────────────────────────────────────────────────────

    /** A PTY-backed shell channel with its I/O streams. */
    static final class Shell {
        /**
         * Typed as ChannelShell: the PTY calls (setPtyType / setPtySize) live on
         * ChannelSession, which is package-private, while ChannelShell is public
         * and inherits them.
         */
        final com.jcraft.jsch.ChannelShell channel;
        final InputStream out;
        final OutputStream in;

        Shell(com.jcraft.jsch.ChannelShell channel, InputStream out, OutputStream in) {
            this.channel = channel;
            this.out = out;
            this.in = in;
        }
    }

    Shell openShell(int cols, int rows) throws SshException {
        try {
            com.jcraft.jsch.ChannelShell channel =
                    (com.jcraft.jsch.ChannelShell) session.openChannel("shell");
            // A 0x0 PTY makes some servers refuse the request outright, so the
            // conventional 80x24 is substituted rather than passed through.
            channel.setPtyType("xterm-256color",
                    Math.max(1, cols <= 0 ? 80 : cols),
                    Math.max(1, rows <= 0 ? 24 : rows), 0, 0);
            InputStream out = channel.getInputStream();
            OutputStream in = channel.getOutputStream();
            channel.connect(15_000);
            return new Shell(channel, out, in);
        } catch (JSchException | IOException e) {
            throw new SshException(String.valueOf(e.getMessage()), "shell_failed");
        }
    }

    void resize(Shell shell, int cols, int rows) {
        try {
            if (cols > 0 && rows > 0) shell.channel.setPtySize(cols, rows, 0, 0);
        } catch (Exception ignored) {
            // A resize on a channel that just died is not worth reporting.
        }
    }

    // ── sftp ────────────────────────────────────────────────────────────────

    ChannelSftp sftp;

    synchronized ChannelSftp sftp() throws SshException {
        if (sftp != null && sftp.isConnected()) return sftp;
        try {
            ChannelSftp ch = (ChannelSftp) session.openChannel("sftp");
            ch.connect(15_000);
            sftp = ch;
            return ch;
        } catch (JSchException e) {
            throw new SshException(String.valueOf(e.getMessage()), "sftp_failed");
        }
    }

    // ── port forwarding ─────────────────────────────────────────────────────

    /**
     * Run a command on the remote host and collect its output.
     *
     * Used by the "test connection" action: a successful auth is not the same as
     * a usable shell (a forced-command account authenticates and then refuses
     * everything).
     */
    String exec(String command) throws SshException {
        try {
            ChannelExec ch = (ChannelExec) session.openChannel("exec");
            ch.setCommand(command);
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            ch.setErrStream(err);
            InputStream in = ch.getInputStream();
            ch.connect(10_000);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            ch.disconnect();
            String s = out.toString("UTF-8");
            return s.isEmpty() ? err.toString("UTF-8") : s;
        } catch (Exception e) {
            throw new SshException(String.valueOf(e.getMessage()), "exec_failed");
        }
    }

    /** Escape a path for a POSIX shell single-quoted string. */
    static String shellQuote(String p) {
        return "'" + p.replace("'", "'\\''") + "'";
    }

    /** Channel type → forward registry, used by the forwarding manager. */
    static final Map<String, Channel> OPEN_FORWARDS = new HashMap<>();

    static void closeQuietly(Channel ch) {
        try {
            if (ch != null) ch.disconnect();
        } catch (Exception ignored) {
            // Best effort.
        }
    }

    static void closeQuietly(ChannelSftp ch) {
        try {
            if (ch != null) ch.disconnect();
        } catch (Exception ignored) {
            // Best effort.
        }
    }

    static boolean isNotFound(SftpException e) {
        return e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE;
    }
}
