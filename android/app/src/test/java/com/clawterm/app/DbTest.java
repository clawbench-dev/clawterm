package com.clawterm.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.File;

/** Local storage: the pin table and settings, which the SSH path depends on. */
@RunWith(RobolectricTestRunner.class)
public class DbTest {

    private Context ctx;
    private Db db;

    @Before
    public void setUp() {
        ctx = ApplicationProvider.getApplicationContext();
        File path = ctx.getDatabasePath("clawterm.db");
        //noinspection ResultOfMethodCallIgnored
        path.delete();
        db = new Db(ctx);
    }

    @Test
    public void settingsRoundTrip() {
        assertEquals("fallback", db.getSetting("missing", "fallback"));
        db.setSetting("k", "v1");
        assertEquals("v1", db.getSetting("k", ""));
        db.setSetting("k", "v2");
        assertEquals("v2", db.getSetting("k", ""));
    }

    @Test
    public void unknownHostHasNoPin() {
        assertNull(db.knownHost("example.com:22"));
    }

    @Test
    public void pinAndRead() {
        db.pinHost("example.com:22", "ssh-ed25519", "SHA256:abc", "2026-01-01T00:00:00Z");
        String[] pin = db.knownHost("example.com:22");
        assertNotNull(pin);
        assertEquals("ssh-ed25519", pin[0]);
        assertEquals("SHA256:abc", pin[1]);
    }

    /**
     * Re-pinning must UPDATE the row, not add a second one: a duplicate would
     * make the lookup order-dependent and the "changed key" check unreliable.
     */
    @Test
    public void repinUpdatesInPlace() {
        db.pinHost("h:22", "ssh-ed25519", "SHA256:aaa", "t1");
        db.pinHost("h:22", "ssh-ed25519", "SHA256:bbb", "t2");
        String[] pin = db.knownHost("h:22");
        assertNotNull(pin);
        assertEquals("SHA256:bbb", pin[1]);
    }

    @Test
    public void unpinRemovesTheEntry() {
        db.pinHost("h:22", "ssh-ed25519", "SHA256:aaa", "t");
        db.unpinHost("h:22");
        assertNull(db.knownHost("h:22"));
    }

    /** Two addresses must not share a pin. */
    @Test
    public void pinsArePerAddress() {
        db.pinHost("a:22", "ssh-ed25519", "SHA256:aaa", "t");
        db.pinHost("b:22", "ssh-ed25519", "SHA256:bbb", "t");
        assertEquals("SHA256:aaa", db.knownHost("a:22")[1]);
        assertEquals("SHA256:bbb", db.knownHost("b:22")[1]);
    }

    /** Changing the port is a different address, so it needs its own pin. */
    @Test
    public void portIsPartOfTheIdentity() {
        db.pinHost("h:22", "ssh-ed25519", "SHA256:aaa", "t");
        assertNull(db.knownHost("h:2222"));
    }

    // ── ring buffer ─────────────────────────────────────────────────────────

    @Test
    public void ringBufferKeepsOrder() {
        TerminalManager.RingBuffer r = new TerminalManager.RingBuffer(1024);
        byte[] a = "hello\n".getBytes();
        byte[] b = "world\n".getBytes();
        r.write(a, a.length);
        r.write(b, b.length);
        assertEquals("hello\nworld\n", new String(r.snapshot()));
    }

    /** ANSI escapes straddle reads; splitting on them would corrupt the replay. */
    @Test
    public void ringBufferPreservesAnsiAcrossWrites() {
        TerminalManager.RingBuffer r = new TerminalManager.RingBuffer(1024);
        byte[] a = "\u001b[31mred".getBytes();
        byte[] b = " text\u001b[0m\n".getBytes();
        r.write(a, a.length);
        r.write(b, b.length);
        assertEquals("\u001b[31mred text\u001b[0m\n", new String(r.snapshot()));
    }

    @Test
    public void ringBufferEvictsOldest() {
        TerminalManager.RingBuffer r = new TerminalManager.RingBuffer(1024);
        // Capacity is clamped to at least 1024, so fill past it.
        byte[] chunk = new byte[600];
        java.util.Arrays.fill(chunk, (byte) 'a');
        r.write(chunk, chunk.length);
        byte[] tail = new byte[600];
        java.util.Arrays.fill(tail, (byte) 'b');
        r.write(tail, tail.length);
        byte[] snap = r.snapshot();
        assertEquals(1024, snap.length);
        // The newest byte must be the last one written.
        assertEquals('b', (char) snap[snap.length - 1]);
        // The oldest 'a's must have been evicted.
        assertEquals('a', (char) snap[0]);
        assertEquals('b', (char) snap[1023]);
    }

    @Test
    public void ringBufferWriteLargerThanCapacityKeepsTail() {
        TerminalManager.RingBuffer r = new TerminalManager.RingBuffer(1024);
        byte[] big = new byte[2000];
        for (int i = 0; i < big.length; i++) big[i] = (byte) ('a' + (i % 26));
        r.write(big, big.length);
        byte[] snap = r.snapshot();
        assertEquals(1024, snap.length);
        // The last byte of the write must be the last byte of the snapshot.
        assertEquals(big[big.length - 1], snap[snap.length - 1]);
    }

    /** The snapshot must be a copy: a caller keeping it across writes must not
     *  see its buffer mutate. */
    @Test
    public void ringBufferSnapshotIsACopy() {
        TerminalManager.RingBuffer r = new TerminalManager.RingBuffer(64);
        byte[] a = "abc".getBytes();
        r.write(a, a.length);
        byte[] snap = r.snapshot();
        byte[] b = "def".getBytes();
        r.write(b, b.length);
        assertArrayEquals("abc".getBytes(), snap);
    }
}
