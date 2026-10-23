package com.clawterm.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

/**
 * Facts about a client-only build that fail SILENTLY when wrong.
 */
@RunWith(RobolectricTestRunner.class)
public class AppConfigTest {

    private Context ctx() {
        return ApplicationProvider.getApplicationContext();
    }

    /** The UI must come from the APK, not from a loopback server. */
    @Test
    public void startUrlIsALocalAsset() {
        String url = AppConfig.startUrl();
        assertTrue("the page must load from the apk, got " + url,
                url.startsWith("file:///android_asset/"));
        assertFalse("a client-only build must not talk to a local server",
                url.contains("127.0.0.1") || url.contains("localhost"));
        assertFalse(url.contains("://http"));
    }

    /** Data must live in the app sandbox: no storage permission, no other app. */
    @Test
    public void dataDirIsInsidePrivateFiles() {
        String dir = AppConfig.dataDir(ctx());
        assertTrue("data dir must be inside the app's private files, got " + dir,
                dir.startsWith(ctx().getFilesDir().getAbsolutePath()));
    }

    /**
     * A fresh install is LOCKED.
     *
     * Defaulting to unlocked would render the host list for a moment before the
     * setup screen appeared — on a device someone else is holding.
     */
    @Test
    public void freshInstallIsLocked() {
        assertTrue(AppConfig.isLocked(ctx()));
    }

    @Test
    public void lockStateIsPersisted() {
        AppConfig.setLocked(ctx(), false);
        assertFalse(AppConfig.isLocked(ctx()));
        AppConfig.setLocked(ctx(), true);
        assertTrue(AppConfig.isLocked(ctx()));
    }

    /** The activity paints the splash from this before the page exists. */
    @Test
    public void themeDefaultsToTheFactoryDarkTheme() {
        assertEquals("gruvbox-dark", AppConfig.lastTheme(ctx()));
        assertTrue(AppConfig.themeIsDark(ctx()));
    }

    @Test
    public void themeBaseIsPersisted() {
        AppConfig.setLastTheme(ctx(), "github-light", false);
        assertEquals("github-light", AppConfig.lastTheme(ctx()));
        assertFalse(AppConfig.themeIsDark(ctx()));
    }

    // ── build-config guards ─────────────────────────────────────────────────

    /**
     * The build must not depend on a bundled native server binary.
     *
     * A `jniLibs` directory with a Go-built `.so` was how the previous version
     * shipped a server inside the APK; its presence now means the client-only
     * refactor was reverted by accident.
     */
    @Test
    public void noBundledServerBinary() throws Exception {
        java.io.File jniLibs = new java.io.File(appDir(), "src/main/jniLibs");
        assertFalse("a client-only build must not ship a native server binary: " + jniLibs,
                jniLibs.exists());
    }

    /** The web bundle must be packaged as assets, or the app has no UI. */
    @Test
    public void webBundleIsAnAsset() throws Exception {
        java.io.File index = new java.io.File(appDir(), "src/main/assets/web/index.html");
        assertTrue("the built UI must be at assets/web/index.html, missing: " + index,
                index.isFile());
    }

    private java.io.File appDir() throws Exception {
        java.io.File dir = new java.io.File("").getAbsoluteFile();
        for (int i = 0; i < 8 && dir != null; i++) {
            if (new java.io.File(dir, "app/build.gradle").isFile()) {
                return new java.io.File(dir, "app");
            }
            if (new java.io.File(dir, "build.gradle").isFile()
                    && new java.io.File(dir, "src/main").isDirectory()) {
                return dir;
            }
            dir = dir.getParentFile();
        }
        throw new IllegalStateException("cannot locate the app module from "
                + new java.io.File("").getAbsolutePath());
    }
}
