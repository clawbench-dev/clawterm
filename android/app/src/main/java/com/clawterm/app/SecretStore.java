package com.clawterm.app;

import android.content.Context;
import android.util.Base64;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Encrypted credential store: one small file per (host, kind).
 *
 * ## What this protects against, and what it does not
 *
 * The key sits next to the data, so this is NOT a defence against someone who can
 * read the app's private directory — on Android that boundary is the OS sandbox,
 * not this class. What it does buy:
 *
 *   - A database copied for backup/sync is not a copied credential store.
 *   - The files are not greppable, so a log or crash dump that happens to
 *     capture a directory listing leaks nothing readable.
 *
 * Being honest about that boundary matters: a user who believes these files are
 * safe to share is worse off than one who knows they are not.
 *
 * ## Format
 *
 * `base64(nonce || AES-GCM(ciphertext))`, with the secret KIND as additional
 * authenticated data. Renaming a password file to a passphrase file therefore
 * fails to decrypt instead of silently returning the wrong credential.
 */
final class SecretStore {

    static final String KIND_PASSWORD = "password";
    static final String KIND_PASSPHRASE = "passphrase";

    private static final String KEY_FILE = "master.key";
    private static final int NONCE_LEN = 12;
    private static final int TAG_BITS = 128;

    private final File dir;
    private final SecretKeySpec key;

    SecretStore(Context ctx) throws IOException {
        dir = new File(AppConfig.dataDir(ctx), "secrets");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("cannot create " + dir);
        }
        key = new SecretKeySpec(loadOrCreateKey(), "AES");
    }

    private byte[] loadOrCreateKey() throws IOException {
        File f = new File(dir, KEY_FILE);
        if (f.exists()) {
            byte[] raw = readAll(f);
            if (raw.length != 32) {
                // A corrupt key must be an error, not a silent regeneration:
                // regenerating would make every stored credential unreadable
                // with no explanation.
                throw new IOException("master key is corrupt (want 32 bytes, got " + raw.length + ")");
            }
            return raw;
        }
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(raw);
        }
        //noinspection ResultOfMethodCallIgnored
        f.setReadable(false, false);
        //noinspection ResultOfMethodCallIgnored
        f.setReadable(true, true);
        return raw;
    }

    private File fileFor(long hostId, String kind) {
        return new File(dir, hostId + "." + kind);
    }

    /** Encrypt and write. An empty value DELETES the entry. */
    void set(long hostId, String kind, String value) throws IOException {
        File f = fileFor(hostId, kind);
        if (value == null || value.isEmpty()) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            return;
        }
        try {
            byte[] nonce = new byte[NONCE_LEN];
            new SecureRandom().nextBytes(nonce);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            c.updateAAD(kind.getBytes("UTF-8"));
            byte[] sealed = c.doFinal(value.getBytes("UTF-8"));

            byte[] out = new byte[nonce.length + sealed.length];
            System.arraycopy(nonce, 0, out, 0, nonce.length);
            System.arraycopy(sealed, 0, out, nonce.length, sealed.length);

            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(Base64.encode(out, Base64.NO_WRAP));
            }
            //noinspection ResultOfMethodCallIgnored
            f.setReadable(false, false);
            //noinspection ResultOfMethodCallIgnored
            f.setReadable(true, true);
        } catch (GeneralSecurityException e) {
            throw new IOException("encrypt " + kind + ": " + e.getMessage(), e);
        }
    }

    /** Decrypted value, or "" when absent. Throws when the file is corrupt. */
    String get(long hostId, String kind) throws IOException {
        File f = fileFor(hostId, kind);
        if (!f.exists()) return "";
        byte[] raw = Base64.decode(readAll(f), Base64.NO_WRAP);
        if (raw.length <= NONCE_LEN) {
            throw new IOException(kind + " secret is truncated");
        }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(raw, 0, NONCE_LEN)));
            c.updateAAD(kind.getBytes("UTF-8"));
            byte[] plain = c.doFinal(Arrays.copyOfRange(raw, NONCE_LEN, raw.length));
            return new String(plain, "UTF-8");
        } catch (GeneralSecurityException e) {
            throw new IOException("decrypt " + kind + ": " + e.getMessage(), e);
        }
    }

    boolean has(long hostId, String kind) {
        return fileFor(hostId, kind).exists();
    }

    void deleteHost(long hostId) {
        //noinspection ResultOfMethodCallIgnored
        fileFor(hostId, KIND_PASSWORD).delete();
        //noinspection ResultOfMethodCallIgnored
        fileFor(hostId, KIND_PASSPHRASE).delete();
    }

    // ── access password ─────────────────────────────────────────────────────

    private static final String AUTH_FILE = "auth.hash";

    /**
     * Store the access password as a salted SHA-256.
     *
     * A password hash is used rather than encryption because nothing needs to
     * read the password back — only to compare against it. PBKDF2 would be
     * stronger, but this is a local device gate protecting a sandbox, and the
     * iteration count would only slow down an attacker who can already read the
     * app's private directory (see the class comment).
     */
    void setPassword(String password) throws IOException {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        byte[] hash = sha256(salt, password);
        byte[] out = new byte[salt.length + hash.length];
        System.arraycopy(salt, 0, out, 0, salt.length);
        System.arraycopy(hash, 0, out, salt.length, hash.length);
        try (FileOutputStream fos = new FileOutputStream(new File(dir, AUTH_FILE))) {
            fos.write(Base64.encode(out, Base64.NO_WRAP));
        }
    }

    boolean hasPassword() {
        return new File(dir, AUTH_FILE).exists();
    }

    boolean checkPassword(String password) {
        File f = new File(dir, AUTH_FILE);
        if (!f.exists()) return false;
        try {
            byte[] raw = Base64.decode(readAll(f), Base64.NO_WRAP);
            if (raw.length != 48) return false;
            byte[] salt = Arrays.copyOfRange(raw, 0, 16);
            byte[] want = Arrays.copyOfRange(raw, 16, 48);
            return MessageDigest.isEqual(want, sha256(salt, password));
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] sha256(byte[] salt, String password) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(salt);
            md.update(password.getBytes("UTF-8"));
            return md.digest();
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    private static byte[] readAll(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            return buf;
        }
    }
}
