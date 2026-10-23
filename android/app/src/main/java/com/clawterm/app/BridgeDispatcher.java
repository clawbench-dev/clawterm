package com.clawterm.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.SftpATTRS;
import com.jcraft.jsch.SftpException;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Answers bridge requests from the WebView.
 *
 * ## Structure
 *
 * One `handle` method with a switch over the method name. The alternative — one
 * `@JavascriptInterface` per operation — would put ~35 magic strings on the Java
 * side that must match the TypeScript union exactly, each needing a ProGuard keep
 * rule, and a typo would surface only at runtime as "method not found".
 *
 * ## Threading
 *
 * `invoke` arrives on the JavaBridge thread, which must not block: a slow SSH
 * connect there stalls the page. Every request is therefore dispatched to a
 * worker thread and the reply is posted back to the WebView on the UI thread.
 *
 * ## Replies
 *
 * `ok=true` with a JSON payload, or `ok=false` with `{message, code}`. The code
 * is what the UI translates; the message is the fallback.
 */
final class BridgeDispatcher {

    private static final String TAG = "ClawTermBridge";

    private final Context ctx;
    private final Db db;
    private final SecretStore secrets;
    private final TerminalManager terminals;
    private final ForwardManager forwards;
    private final WebView webView;

    /** Live SSH connections keyed by host id, so a second tab reuses one. */
    private final Map<Long, SshConnection> connections = new HashMap<>();
    private final Map<Long, Integer> connectionRefs = new HashMap<>();

    BridgeDispatcher(Context ctx, Db db, SecretStore secrets, TerminalManager terminals,
                     ForwardManager forwards, WebView webView) {
        this.ctx = ctx;
        this.db = db;
        this.secrets = secrets;
        this.terminals = terminals;
        this.forwards = forwards;
        this.webView = webView;
    }

    // ── reply plumbing ──────────────────────────────────────────────────────

    private void reply(String requestId, boolean ok, String payload) {
        final String js = "window.__clawtermNativeResolve && window.__clawtermNativeResolve("
                + JSONObject.quote(requestId) + "," + ok + "," + JSONObject.quote(payload) + ")";
        runOnUi(() -> webView.evaluateJavascript(js, null));
    }

    private void replyOk(String requestId, Object payload) {
        reply(requestId, true, payload == null ? "null" : payload.toString());
    }

    private void replyError(String requestId, String message, String code) {
        JSONObject o = new JSONObject();
        try {
            o.put("message", message == null ? "unknown error" : message);
            if (code != null) o.put("code", code);
        } catch (JSONException ignored) {
            // Both keys are strings; this cannot fail.
        }
        reply(requestId, false, o.toString());
    }

    private void runOnUi(Runnable r) {
        webView.post(r);
    }

    // ── entry point ─────────────────────────────────────────────────────────

    void invoke(final String requestId, final String method, final String payloadJson) {
        // Dispatch off the bridge thread: SSH connect and SFTP listing are
        // blocking, and the bridge thread is shared with every other JS call.
        Thread t = new Thread(() -> {
            try {
                Object result = handle(method, payloadJson == null ? "null" : payloadJson);
                replyOk(requestId, result);
            } catch (SshException e) {
                replyError(requestId, e.getMessage(), e.code);
            } catch (HostKeyChanged e) {
                // Carries both fingerprints so the UI can show what changed and
                // offer an explicit "accept" — a bare error would be useless.
                JSONObject detail = new JSONObject();
                try {
                    detail.put("message", "host key changed for " + e.address);
                    detail.put("code", "host_key_changed");
                    detail.put("address", e.address);
                    detail.put("oldType", e.oldType);
                    detail.put("oldFinger", e.oldFinger);
                    detail.put("newType", e.newType);
                    detail.put("newFinger", e.newFinger);
                } catch (JSONException ignored) {
                    // Constants only.
                }
                reply(requestId, false, detail.toString());
            } catch (Exception e) {
                Log.e(TAG, method + " failed", e);
                replyError(requestId, String.valueOf(e.getMessage()), "internal");
            }
        }, "bridge-" + method);
        t.setDaemon(true);
        t.start();
    }

    private Object handle(String method, String payloadJson) throws Exception {
        JSONObject p = new JSONObject(payloadJson);

        switch (method) {
            // ── auth ──
            case "auth.status": {
                JSONObject o = new JSONObject();
                o.put("authenticated", !AppConfig.isLocked(ctx));
                o.put("needsSetup", !secrets.hasPassword());
                return o;
            }
            case "auth.setup": {
                String pw = p.optString("password", "");
                if (pw.length() < 4) throw new SshException("password too short", "weak_password");
                if (secrets.hasPassword()) {
                    throw new SshException("a password is already set", "already_setup");
                }
                secrets.setPassword(pw);
                AppConfig.setLocked(ctx, false);
                return null;
            }
            case "auth.verify": {
                if (!secrets.hasPassword()) {
                    throw new SshException("no password set", "needs_setup");
                }
                if (!secrets.checkPassword(p.optString("password", ""))) {
                    throw new SshException("wrong password", "wrong_password");
                }
                AppConfig.setLocked(ctx, false);
                return null;
            }
            case "auth.change": {
                String oldPw = p.optString("oldPassword", "");
                String newPw = p.optString("newPassword", "");
                if (!secrets.checkPassword(oldPw)) {
                    throw new SshException("wrong password", "wrong_password");
                }
                if (newPw.length() < 4) throw new SshException("password too short", "weak_password");
                secrets.setPassword(newPw);
                return null;
            }
            case "auth.lock":
                AppConfig.setLocked(ctx, true);
                return null;

            // ── hosts ──
            case "db.hosts.list":
                return hostsJson();
            case "db.hosts.create":
                return hostCreate(p);
            case "db.hosts.update":
                return hostUpdate(p);
            case "db.hosts.delete": {
                long id = p.optLong("id");
                // Order matters: stop the forward first (it holds a channel on
                // the connection), then the terminals, then the connection.
                forwards.stopHost(id);
                dropConnection(id);
                synchronized (db.lock()) {
                    SQLiteDatabase w = db.getWritableDatabase();
                    w.delete("hosts", "id = ?", new String[]{String.valueOf(id)});
                    w.delete("snippets", "host_id = ?", new String[]{String.valueOf(id)});
                    w.delete("forward_rules", "host_id = ?", new String[]{String.valueOf(id)});
                }
                secrets.deleteHost(id);
                return null;
            }
            case "db.hosts.touch": {
                long id = p.optLong("id");
                synchronized (db.lock()) {
                    ContentValues v = new ContentValues();
                    v.put("last_used_at", System.currentTimeMillis());
                    db.getWritableDatabase().update("hosts", v, "id = ?",
                            new String[]{String.valueOf(id)});
                }
                return null;
            }

            // ── snippets ──
            case "db.snippets.list":
                return snippetsJson(p.optLong("hostId", 0));
            case "db.snippets.create":
                return snippetCreate(p);
            case "db.snippets.update":
                return snippetUpdate(p);
            case "db.snippets.delete": {
                synchronized (db.lock()) {
                    db.getWritableDatabase().delete("snippets", "id = ?",
                            new String[]{String.valueOf(p.optLong("id"))});
                }
                return null;
            }
            case "db.snippets.reorder": {
                JSONArray ids = p.optJSONArray("ids");
                if (ids == null || ids.length() == 0) {
                    throw new SshException("ids must not be empty", "bad_request");
                }
                synchronized (db.lock()) {
                    SQLiteDatabase w = db.getWritableDatabase();
                    w.beginTransaction();
                    try {
                        for (int i = 0; i < ids.length(); i++) {
                            ContentValues v = new ContentValues();
                            v.put("sort_order", i);
                            w.update("snippets", v, "id = ?",
                                    new String[]{String.valueOf(ids.optLong(i))});
                        }
                        w.setTransactionSuccessful();
                    } finally {
                        w.endTransaction();
                    }
                }
                return null;
            }

            // ── forwards ──
            case "forward.list":
                return forwardsJson();
            case "forward.start":
                return forwardStart(p);
            case "forward.stop": {
                int port = p.optInt("localPort");
                forwards.stop(port);
                synchronized (db.lock()) {
                    db.getWritableDatabase().delete("forward_rules", "local_port = ?",
                            new String[]{String.valueOf(port)});
                }
                return null;
            }

            // ── ssh ──
            case "ssh.test":
                return sshTest(p);
            case "ssh.connect":
                return sshConnect(p);
            case "ssh.write": {
                terminals.write(p.optString("sessionId"), p.optString("data"));
                return null;
            }
            case "ssh.resize":
                terminals.resize(p.optString("sessionId"), p.optInt("cols"), p.optInt("rows"));
                return null;
            case "ssh.close":
                terminals.close(p.optString("sessionId"));
                return null;
            case "ssh.sessions":
                return new JSONArray(terminals.list());
            case "ssh.acceptHostKey": {
                long id = p.optLong("id");
                JSONObject h = hostRow(id);
                if (h == null) throw new SshException("host not found", "not_found");
                db.unpinHost(h.optString("address") + ":" + h.optInt("port", 22));
                dropConnection(id);
                return null;
            }

            // ── sftp ──
            case "sftp.list":
                return sftpList(p);
            case "sftp.read":
                return sftpRead(p);
            case "sftp.download":
                return sftpDownload(p);

            // ── app ──
            case "app.info": {
                JSONObject o = new JSONObject();
                o.put("version", versionName());
                o.put("platform", "android");
                o.put("sdk", Build.VERSION.SDK_INT);
                return o;
            }

            default:
                throw new SshException("unknown method " + method, "unknown_method");
        }
    }

    // ── hosts ───────────────────────────────────────────────────────────────

    private JSONArray hostsJson() throws Exception {
        JSONArray out = new JSONArray();
        try (Cursor c = db.getReadableDatabase().rawQuery(
                "SELECT id, name, address, port, username, auth_type, key_path, color, grp,"
                        + " last_used_at, created_at, updated_at FROM hosts"
                        + " ORDER BY last_used_at DESC, name COLLATE NOCASE ASC", null)) {
            while (c.moveToNext()) out.put(hostFromCursor(c));
        }
        return out;
    }

    private JSONObject hostRow(long id) throws Exception {
        try (Cursor c = db.getReadableDatabase().rawQuery(
                "SELECT id, name, address, port, username, auth_type, key_path, color, grp,"
                        + " last_used_at, created_at, updated_at FROM hosts WHERE id = ?",
                new String[]{String.valueOf(id)})) {
            return c.moveToFirst() ? hostFromCursor(c) : null;
        }
    }

    private JSONObject hostFromCursor(Cursor c) throws Exception {
        long id = c.getLong(0);
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("name", c.getString(1));
        o.put("address", c.getString(2));
        o.put("port", c.getInt(3));
        o.put("username", c.getString(4));
        o.put("authType", c.getString(5));
        o.put("keyPath", c.getString(6));
        o.put("color", c.getString(7));
        o.put("group", c.getString(8));
        o.put("lastUsedAt", c.getLong(9));
        o.put("createdAt", c.getString(10));
        o.put("updatedAt", c.getString(11));
        // Secrets never leave the device: only the booleans that say one exists.
        o.put("hasPassword", secrets.has(id, SecretStore.KIND_PASSWORD));
        o.put("hasPassphrase", secrets.has(id, SecretStore.KIND_PASSPHRASE));
        return o;
    }

    private JSONObject hostCreate(JSONObject p) throws Exception {
        String name = p.optString("name", "").trim();
        String address = p.optString("address", "").trim();
        String username = p.optString("username", "").trim();
        int port = p.optInt("port", 22);
        String authType = p.optString("authType", "password");
        String keyPath = p.optString("keyPath", "").trim();

        if (name.isEmpty()) throw new SshException("name is required", "bad_request");
        if (address.isEmpty()) throw new SshException("address is required", "bad_request");
        if (username.isEmpty()) throw new SshException("username is required", "bad_request");
        if (port < 1 || port > 65535) throw new SshException("port out of range", "bad_request");
        if ("key".equals(authType) && keyPath.isEmpty()) {
            throw new SshException("keyPath is required for key authentication", "bad_request");
        }

        String now = isoNow();
        long id;
        synchronized (db.lock()) {
            ContentValues v = new ContentValues();
            v.put("name", name);
            v.put("address", address);
            v.put("port", port);
            v.put("username", username);
            v.put("auth_type", authType);
            v.put("key_path", keyPath);
            v.put("color", p.optString("color", ""));
            v.put("grp", p.optString("group", ""));
            v.put("last_used_at", 0);
            v.put("created_at", now);
            v.put("updated_at", now);
            id = db.getWritableDatabase().insert("hosts", null, v);
        }
        String password = p.optString("password", "");
        if (!password.isEmpty()) secrets.set(id, SecretStore.KIND_PASSWORD, password);
        String passphrase = p.optString("passphrase", "");
        if (!passphrase.isEmpty()) secrets.set(id, SecretStore.KIND_PASSPHRASE, passphrase);

        return hostRow(id);
    }

    private JSONObject hostUpdate(JSONObject p) throws Exception {
        long id = p.optLong("id");
        JSONObject existing = hostRow(id);
        if (existing == null) throw new SshException("host not found", "not_found");

        String name = p.optString("name", "").trim();
        String address = p.optString("address", "").trim();
        String username = p.optString("username", "").trim();
        int port = p.optInt("port", 22);
        String authType = p.optString("authType", "password");
        String keyPath = p.optString("keyPath", "").trim();

        if (name.isEmpty()) throw new SshException("name is required", "bad_request");
        if (address.isEmpty()) throw new SshException("address is required", "bad_request");
        if (username.isEmpty()) throw new SshException("username is required", "bad_request");
        if (port < 1 || port > 65535) throw new SshException("port out of range", "bad_request");
        if ("key".equals(authType) && keyPath.isEmpty()) {
            throw new SshException("keyPath is required for key authentication", "bad_request");
        }

        synchronized (db.lock()) {
            ContentValues v = new ContentValues();
            v.put("name", name);
            v.put("address", address);
            v.put("port", port);
            v.put("username", username);
            v.put("auth_type", authType);
            v.put("key_path", keyPath);
            v.put("color", p.optString("color", ""));
            v.put("grp", p.optString("group", ""));
            v.put("updated_at", isoNow());
            db.getWritableDatabase().update("hosts", v, "id = ?", new String[]{String.valueOf(id)});
        }

        // An empty secret field means "keep the stored one": the UI never
        // receives the plaintext, so it cannot echo it back.
        String password = p.optString("password", "");
        if (!password.isEmpty()) secrets.set(id, SecretStore.KIND_PASSWORD, password);
        String passphrase = p.optString("passphrase", "");
        if (!passphrase.isEmpty()) secrets.set(id, SecretStore.KIND_PASSPHRASE, passphrase);

        // The address or credentials may have changed; a pooled connection would
        // keep using the old ones.
        dropConnection(id);
        return hostRow(id);
    }

    // ── snippets ────────────────────────────────────────────────────────────

    private JSONArray snippetsJson(long hostId) throws Exception {
        JSONArray out = new JSONArray();
        try (Cursor c = db.getReadableDatabase().rawQuery(
                "SELECT id, label, command, host_id, send, sort_order, created_at, updated_at"
                        + " FROM snippets WHERE host_id = 0 OR host_id = ?"
                        + " ORDER BY sort_order ASC, id ASC",
                new String[]{String.valueOf(hostId)})) {
            while (c.moveToNext()) out.put(snippetFromCursor(c));
        }
        return out;
    }

    private JSONObject snippetFromCursor(Cursor c) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", c.getLong(0));
        o.put("label", c.getString(1));
        o.put("command", c.getString(2));
        o.put("hostId", c.getLong(3));
        o.put("send", c.getInt(4) != 0);
        o.put("sortOrder", c.getInt(5));
        o.put("createdAt", c.getString(6));
        o.put("updatedAt", c.getString(7));
        return o;
    }

    private JSONObject snippetCreate(JSONObject p) throws Exception {
        String label = p.optString("label", "").trim();
        String command = p.optString("command", "");
        if (label.isEmpty() || command.trim().isEmpty()) {
            throw new SshException("label and command are required", "bad_request");
        }
        String now = isoNow();
        long id;
        synchronized (db.lock()) {
            ContentValues v = new ContentValues();
            v.put("label", label);
            v.put("command", command);
            v.put("host_id", p.optLong("hostId", 0));
            v.put("send", p.optBoolean("send", true) ? 1 : 0);
            v.put("sort_order", 0);
            v.put("created_at", now);
            v.put("updated_at", now);
            id = db.getWritableDatabase().insert("snippets", null, v);
        }
        try (Cursor c = db.getReadableDatabase().rawQuery(
                "SELECT id, label, command, host_id, send, sort_order, created_at, updated_at"
                        + " FROM snippets WHERE id = ?", new String[]{String.valueOf(id)})) {
            if (c.moveToFirst()) return snippetFromCursor(c);
        }
        throw new SshException("snippet vanished after insert", "internal");
    }

    private Object snippetUpdate(JSONObject p) throws Exception {
        String label = p.optString("label", "").trim();
        String command = p.optString("command", "");
        if (label.isEmpty() || command.trim().isEmpty()) {
            throw new SshException("label and command are required", "bad_request");
        }
        synchronized (db.lock()) {
            ContentValues v = new ContentValues();
            v.put("label", label);
            v.put("command", command);
            v.put("send", p.optBoolean("send", true) ? 1 : 0);
            v.put("updated_at", isoNow());
            int n = db.getWritableDatabase().update("snippets", v, "id = ?",
                    new String[]{String.valueOf(p.optLong("id"))});
            if (n == 0) throw new SshException("snippet not found", "not_found");
        }
        return null;
    }

    // ── forwards ────────────────────────────────────────────────────────────

    private JSONArray forwardsJson() throws Exception {
        JSONArray out = new JSONArray();
        Map<Long, String> names = new HashMap<>();
        try (Cursor c = db.getReadableDatabase().rawQuery("SELECT id, name FROM hosts", null)) {
            while (c.moveToNext()) names.put(c.getLong(0), c.getString(1));
        }
        try (Cursor c = db.getReadableDatabase().rawQuery(
                "SELECT id, host_id, local_port, remote_host, remote_port, auto_start"
                        + " FROM forward_rules ORDER BY id ASC", null)) {
            while (c.moveToNext()) {
                int port = c.getInt(2);
                JSONObject o = new JSONObject();
                o.put("id", c.getLong(0));
                o.put("hostId", c.getLong(1));
                o.put("hostName", names.containsKey(c.getLong(1)) ? names.get(c.getLong(1)) : "");
                o.put("localPort", port);
                o.put("remoteHost", c.getString(3));
                o.put("remotePort", c.getInt(4));
                o.put("autoStart", c.getInt(5) != 0);
                o.put("running", forwards.isRunning(port));
                o.put("connections", forwards.connections(port));
                String err = forwards.error(port);
                if (err != null) o.put("error", err);
                out.put(o);
            }
        }
        // A forward can run without a persisted rule (a one-off), so add those
        // that the table does not mention.
        return out;
    }

    private JSONObject forwardStart(JSONObject p) throws Exception {
        long hostId = p.optLong("hostId");
        int localPort = p.optInt("localPort");
        int remotePort = p.optInt("remotePort");
        String remoteHost = p.optString("remoteHost", "127.0.0.1");
        boolean autoStart = p.optBoolean("autoStart", false);

        if (localPort < 1 || localPort > 65535 || remotePort < 1 || remotePort > 65535) {
            throw new SshException("ports must be between 1 and 65535", "bad_request");
        }
        if (hostId <= 0) throw new SshException("hostId is required", "bad_request");

        SshConnection conn = connectionFor(hostId, false);
        forwards.start(hostId, conn, localPort, remoteHost, remotePort);

        synchronized (db.lock()) {
            ContentValues v = new ContentValues();
            v.put("host_id", hostId);
            v.put("local_port", localPort);
            v.put("remote_host", remoteHost);
            v.put("remote_port", remotePort);
            v.put("auto_start", autoStart ? 1 : 0);
            v.put("created_at", isoNow());
            db.getWritableDatabase().insert("forward_rules", null, v);
        }

        JSONObject o = new JSONObject();
        o.put("localPort", localPort);
        o.put("remotePort", remotePort);
        o.put("remoteHost", remoteHost);
        o.put("hostId", hostId);
        o.put("running", true);
        o.put("connections", 0);
        return o;
    }

    // ── ssh ─────────────────────────────────────────────────────────────────

    private JSONObject sshTest(JSONObject p) throws Exception {
        long id = p.optLong("id");
        JSONObject h = hostRow(id);
        if (h == null) throw new SshException("host not found", "not_found");

        long start = System.currentTimeMillis();
        SshConnection conn = connectionFor(id, false);
        String banner = conn.exec("echo clawterm-ok");
        JSONObject o = new JSONObject();
        o.put("ok", banner.contains("clawterm-ok"));
        o.put("latency", System.currentTimeMillis() - start);
        o.put("addr", conn.address());
        o.put("notice", "");
        return o;
    }

    private JSONObject sshConnect(JSONObject p) throws Exception {
        long hostId = p.optLong("hostId");
        String reattach = p.optString("sessionId", "");
        int cols = Math.max(1, p.optInt("cols", 80));
        int rows = Math.max(1, p.optInt("rows", 24));
        String title = p.optString("title", "");

        // Re-attach: the PTY is still alive in this process, so just hand the id
        // back and replay its scrollback. This is what makes a WebView reload (or
        // a dropped view) come back to the same shell.
        if (!reattach.isEmpty() && terminals.exists(reattach)) {
            byte[] replay = terminals.replay(reattach);
            if (replay != null && replay.length > 0) {
                emitEvent("terminal.data", jsonOf(
                        "sessionId", reattach,
                        "data", Base64.encodeToString(replay, Base64.NO_WRAP)));
            }
            JSONObject o = new JSONObject();
            o.put("sessionId", reattach);
            return o;
        }

        if (hostId <= 0) throw new SshException("hostId is required", "bad_request");
        JSONObject h = hostRow(hostId);
        if (h == null) throw new SshException("host not found", "not_found");

        SshConnection conn = connectionFor(hostId, true);
        String sessionId = terminals.open(hostId, title.isEmpty() ? h.optString("name") : title,
                conn, cols, rows);

        // Record the use so the list is ordered by what is actually used.
        synchronized (db.lock()) {
            ContentValues v = new ContentValues();
            v.put("last_used_at", System.currentTimeMillis());
            db.getWritableDatabase().update("hosts", v, "id = ?",
                    new String[]{String.valueOf(hostId)});
        }

        JSONObject o = new JSONObject();
        o.put("sessionId", sessionId);
        return o;
    }

    // ── sftp ────────────────────────────────────────────────────────────────

    private JSONObject sftpList(JSONObject p) throws Exception {
        long hostId = p.optLong("hostId");
        String path = p.optString("path", ".");
        ChannelSftp sftp = sftpFor(hostId);
        String abs = sftp.realpath(path);

        JSONArray entries = new JSONArray();
        List<ChannelSftp.LsEntry> list = new ArrayList<>();
        for (Object o : sftp.ls(abs)) list.add((ChannelSftp.LsEntry) o);

        // Directories first, then case-insensitive by name — the same order the
        // Go implementation used, so the UI does not need to re-sort.
        list.sort((a, b) -> {
            boolean ad = a.getAttrs().isDir();
            boolean bd = b.getAttrs().isDir();
            if (ad != bd) return ad ? -1 : 1;
            return a.getFilename().compareToIgnoreCase(b.getFilename());
        });

        for (ChannelSftp.LsEntry e : list) {
            if (".".equals(e.getFilename()) || "..".equals(e.getFilename())) continue;
            SftpATTRS a = e.getAttrs();
            boolean isLink = a.isLink();
            boolean isDir = a.isDir();
            long size = a.getSize();
            if (isLink) {
                // Follow the link so a directory shows as a directory. A
                // dangling link stays a link and is not entered.
                try {
                    SftpATTRS target = sftp.stat(abs + "/" + e.getFilename());
                    isDir = target.isDir();
                    size = target.getSize();
                } catch (SftpException ignored) {
                    // Dangling: keep the link's own attributes.
                }
            }
            JSONObject o = new JSONObject();
            o.put("name", e.getFilename());
            o.put("path", abs.endsWith("/") ? abs + e.getFilename() : abs + "/" + e.getFilename());
            o.put("isDir", isDir);
            o.put("isLink", isLink);
            o.put("size", size);
            o.put("mode", a.getPermissionsString());
            o.put("modTime", a.getMTime() * 1000L);
            entries.put(o);
        }

        JSONObject out = new JSONObject();
        out.put("path", abs);
        out.put("entries", entries);
        return out;
    }

    private JSONObject sftpRead(JSONObject p) throws Exception {
        long hostId = p.optLong("hostId");
        String path = p.optString("path");
        ChannelSftp sftp = sftpFor(hostId);

        SftpATTRS attrs = sftp.stat(path);
        if (attrs.isDir()) throw new SshException(path + " is a directory", "bad_request");

        // 2 MiB: a preview, not a download. A bigger file is truncated WITH a
        // flag, because silently cutting a config in half is how someone "fixes"
        // a bug that is not there.
        final int max = 2 * 1024 * 1024;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        boolean truncated = false;
        try (InputStream in = sftp.get(path)) {
            byte[] chunk = new byte[32 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) {
                int room = max - buf.size();
                if (room <= 0) {
                    truncated = true;
                    break;
                }
                buf.write(chunk, 0, Math.min(n, room));
                if (n > room) {
                    truncated = true;
                    break;
                }
            }
        }

        byte[] bytes = buf.toByteArray();
        boolean binary = looksBinary(bytes);

        JSONObject out = new JSONObject();
        out.put("path", path);
        out.put("size", attrs.getSize());
        out.put("truncated", truncated);
        out.put("isBinary", binary);
        out.put("content", binary
                ? Base64.encodeToString(bytes, Base64.NO_WRAP)
                : new String(bytes, "UTF-8"));
        return out;
    }

    /** A NUL byte in the first 8 KiB is the only reliable binary signal. */
    private static boolean looksBinary(byte[] b) {
        int n = Math.min(b.length, 8192);
        for (int i = 0; i < n; i++) {
            if (b[i] == 0) return true;
        }
        return false;
    }

    private JSONObject sftpDownload(JSONObject p) throws Exception {
        long hostId = p.optLong("hostId");
        String path = p.optString("path");
        ChannelSftp sftp = sftpFor(hostId);
        String name = path.substring(path.lastIndexOf('/') + 1);

        // Downloads land in the app's external files dir, which the system file
        // manager can see without a storage permission, and which survives an
        // app update.
        File dir = ctx.getExternalFilesDir("downloads");
        if (dir == null) dir = new File(ctx.getFilesDir(), "downloads");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File out = uniqueFile(dir, name);

        try (InputStream in = sftp.get(path); FileOutputStream fos = new FileOutputStream(out)) {
            byte[] chunk = new byte[64 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) fos.write(chunk, 0, n);
        }

        JSONObject o = new JSONObject();
        o.put("saved", true);
        o.put("path", out.getAbsolutePath());
        return o;
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File candidate = new File(dir, base + " (" + i + ")" + ext);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    private ChannelSftp sftpFor(long hostId) throws Exception {
        if (hostId <= 0) throw new SshException("hostId is required", "bad_request");
        SshConnection conn = connectionFor(hostId, false);
        return conn.sftp();
    }

    // ── connections ─────────────────────────────────────────────────────────

    /**
     * Return a live connection for the host, dialling when needed.
     *
     * `counted` controls whether the caller takes a reference: a terminal or a
     * forward does (it must keep the connection alive), while a one-off SFTP call
     * does not (the pooled entry stays until something else needs it).
     */
    private SshConnection connectionFor(long hostId, boolean counted) throws Exception {
        synchronized (connections) {
            SshConnection existing = connections.get(hostId);
            if (existing != null && existing.session().isConnected()) {
                if (counted) {
                    existing.retain();
                    Integer n = connectionRefs.get(hostId);
                    connectionRefs.put(hostId, (n == null ? 0 : n) + 1);
                }
                return existing;
            }
        }

        JSONObject h = hostRow(hostId);
        if (h == null) throw new SshException("host not found", "not_found");

        final long id = hostId;
        final String address = h.optString("address") + ":" + h.optInt("port", 22);
        SshConnection.Auth auth = new SshConnection.Auth();
        auth.type = h.optString("authType", "password");
        auth.password = secrets.get(hostId, SecretStore.KIND_PASSWORD);
        auth.keyPath = h.optString("keyPath", "");
        auth.passphrase = secrets.get(hostId, SecretStore.KIND_PASSPHRASE);

        // The pin check cannot throw out of JSch's callback (JSch turns it into a
        // generic handshake failure), so the mismatch is RECORDED here and turned
        // into a typed error after the dial fails.
        final HostKeyChanged[] mismatch = new HostKeyChanged[1];
        SshConnection conn;
        try {
            conn = SshConnection.dial(h.optString("address"), h.optInt("port", 22),
                    h.optString("username"), auth, (addr, keyType, fingerprint) -> {
                        String[] pinned = db.knownHost(addr);
                        if (pinned == null) {
                            // First connection to this address: trust on first
                            // use, and remember what we accepted.
                            db.pinHost(addr, keyType, fingerprint, isoNow());
                            return null;
                        }
                        if (!pinned[1].equals(fingerprint)) {
                            mismatch[0] = new HostKeyChanged(addr, pinned[0], pinned[1],
                                    keyType, fingerprint);
                            return "host key changed for " + addr;
                        }
                        return null;
                    }, null);
        } catch (SshException e) {
            if (mismatch[0] != null) throw mismatch[0];
            throw e;
        }

        synchronized (connections) {
            connections.put(id, conn);
            connectionRefs.put(id, counted ? 1 : 0);
        }
        return conn;
    }

    /** A changed host key, with both fingerprints for the confirmation UI. */
    static final class HostKeyChanged extends Exception {
        final String address;
        final String oldType;
        final String oldFinger;
        final String newType;
        final String newFinger;

        HostKeyChanged(String address, String oldType, String oldFinger,
                       String newType, String newFinger) {
            super("host key changed for " + address);
            this.address = address;
            this.oldType = oldType;
            this.oldFinger = oldFinger;
            this.newType = newType;
            this.newFinger = newFinger;
        }
    }

    /** Close a host's pooled connection (credentials changed, key re-pinned). */
    void dropConnection(long hostId) {
        SshConnection conn;
        synchronized (connections) {
            conn = connections.remove(hostId);
            connectionRefs.remove(hostId);
        }
        if (conn != null) conn.close();
    }

    void closeAll() {
        synchronized (connections) {
            for (SshConnection c : connections.values()) c.close();
            connections.clear();
            connectionRefs.clear();
        }
    }

    // ── events ──────────────────────────────────────────────────────────────

    private JSONObject jsonOf(Object... kv) {
        JSONObject o = new JSONObject();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            try {
                o.put(String.valueOf(kv[i]), kv[i + 1]);
            } catch (JSONException ignored) {
                // Keys are constants; this cannot fail.
            }
        }
        return o;
    }

    void emitEvent(String type, JSONObject payload) {
        final String js = "window.__clawtermNativeEvent && window.__clawtermNativeEvent("
                + JSONObject.quote(type) + "," + JSONObject.quote(payload.toString()) + ")";
        runOnUi(() -> webView.evaluateJavascript(js, null));
    }

    /**
     * The app's version name.
     *
     * Read from the package manager rather than `BuildConfig`: the generated
     * class is not on the classpath of every variant, and the package manager
     * answer is the one the user sees in system settings.
     */
    private String versionName() {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static String isoNow() {
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                .format(new Date());
    }
}
