package com.clawterm.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.File;

/**
 * Credential storage and the local access gate.
 *
 * These are the security-relevant invariants: a change that makes the store
 * readable, or lets the password be bypassed, must fail here.
 */
@RunWith(RobolectricTestRunner.class)
public class SecretStoreTest {

    private Context ctx;
    private SecretStore store;

    @Before
    public void setUp() throws Exception {
        ctx = ApplicationProvider.getApplicationContext();
        // Each test gets a clean data dir: Robolectric reuses the app dir across
        // tests in one class, and a leftover master.key would hide a bug in key
        // creation.
        deleteRecursive(new File(AppConfig.dataDir(ctx)));
        store = new SecretStore(ctx);
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    @Test
    public void roundTrip() throws Exception {
        store.set(7, SecretStore.KIND_PASSWORD, "hunter2");
        assertEquals("hunter2", store.get(7, SecretStore.KIND_PASSWORD));
    }

    /** A secret must not be readable in the file: that is the point of the store. */
    @Test
    public void secretIsNotPlaintextOnDisk() throws Exception {
        store.set(1, SecretStore.KIND_PASSWORD, "supersecretvalue");
        File f = new File(new File(AppConfig.dataDir(ctx), "secrets"), "1.password");
        assertTrue(f.isFile());
        byte[] raw = java.nio.file.Files.readAllBytes(f.toPath());
        String text = new String(raw, "UTF-8");
        assertFalse("secret is stored in the clear", text.contains("supersecretvalue"));
    }

    /** An empty value means "clear it": the UI has no other way to delete. */
    @Test
    public void emptyValueDeletes() throws Exception {
        store.set(2, SecretStore.KIND_PASSPHRASE, "x");
        assertTrue(store.has(2, SecretStore.KIND_PASSPHRASE));
        store.set(2, SecretStore.KIND_PASSPHRASE, "");
        assertFalse(store.has(2, SecretStore.KIND_PASSPHRASE));
    }

    /**
     * The kind is authenticated data, so renaming a password file to a
     * passphrase file must FAIL to decrypt rather than silently returning the
     * wrong credential.
     */
    @Test
    public void kindIsBoundToTheCiphertext() throws Exception {
        store.set(3, SecretStore.KIND_PASSWORD, "abc");
        File dir = new File(AppConfig.dataDir(ctx), "secrets");
        File from = new File(dir, "3.password");
        File to = new File(dir, "3.passphrase");
        assertTrue(from.renameTo(to));
        try {
            store.get(3, SecretStore.KIND_PASSPHRASE);
            fail("decryption should have failed for a mismatched kind");
        } catch (Exception expected) {
            // Correct: the GCM tag does not validate.
        }
    }

    @Test
    public void deleteHostRemovesBothKinds() throws Exception {
        store.set(9, SecretStore.KIND_PASSWORD, "a");
        store.set(9, SecretStore.KIND_PASSPHRASE, "b");
        store.deleteHost(9);
        assertFalse(store.has(9, SecretStore.KIND_PASSWORD));
        assertFalse(store.has(9, SecretStore.KIND_PASSPHRASE));
    }

    /**
     * A corrupt master key must be an error, not a silent regeneration:
     * regenerating would make every stored credential unreadable with no
     * explanation.
     */
    @Test
    public void corruptMasterKeyIsRejected() throws Exception {
        File dir = new File(AppConfig.dataDir(ctx), "secrets");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        java.nio.file.Files.write(new File(dir, "master.key").toPath(), new byte[]{1, 2, 3});
        try {
            new SecretStore(ctx);
            fail("a corrupt key must not be accepted");
        } catch (Exception expected) {
            // Correct.
        }
    }

    // ── access password ─────────────────────────────────────────────────────

    @Test
    public void passwordRoundTrip() throws Exception {
        assertFalse(store.hasPassword());
        store.setPassword("s3cret");
        assertTrue(store.hasPassword());
        assertTrue(store.checkPassword("s3cret"));
        assertFalse(store.checkPassword("wrong"));
    }

    /** Two identical passwords must not produce the same hash (salted). */
    @Test
    public void passwordHashIsSalted() throws Exception {
        store.setPassword("same");
        File f = new File(new File(AppConfig.dataDir(ctx), "secrets"), "auth.hash");
        String first = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
        store.setPassword("same");
        String second = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
        assertFalse("the hash must change when re-set with a fresh salt",
                first.equals(second));
        assertTrue(store.checkPassword("same"));
    }

    /** The password itself must not be stored anywhere in the file. */
    @Test
    public void passwordIsNotStoredInPlaintext() throws Exception {
        store.setPassword("plaintext-password");
        File f = new File(new File(AppConfig.dataDir(ctx), "secrets"), "auth.hash");
        String text = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
        assertFalse(text.contains("plaintext-password"));
    }

    @Test
    public void wrongPasswordNeverMatches() throws Exception {
        store.setPassword("right");
        for (String attempt : new String[]{"", "RIGHT", "right ", "righ"}) {
            assertFalse("should not match: " + attempt, store.checkPassword(attempt));
        }
    }
}
