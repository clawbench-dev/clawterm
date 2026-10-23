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

    /**
     * The UI must be served from the asset-loader origin, NOT from file://.
     *
     * A `file://` page has an opaque origin and the browser blocks ES module and
     * stylesheet loads from it with a CORS error — the app renders a blank
     * screen. This was a real bug: the bundle loaded fine over http and showed
     * nothing on a device.
     */
    @Test
    public void startUrlUsesTheAssetLoaderOrigin() {
        String url = AppConfig.startUrl();
        assertEquals("https://" + AppConfig.ASSET_HOST + "/web/index.html", url);
        assertFalse("file:// blocks ES modules, the app would be blank",
                url.startsWith("file://"));
        assertFalse("a client-only build must not talk to a local server",
                url.contains("127.0.0.1") || url.contains("localhost"));
    }

    /** The asset host must be the reserved Android one, never a real domain. */
    @Test
    public void assetHostIsTheReservedDomain() {
        assertEquals("appassets.androidplatform.net", AppConfig.ASSET_HOST);
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

    /**
     * The web bundle must be packaged as assets, or the app has no UI.
     *
     * The asset loader maps the origin's `/web/` prefix onto `assets/web/`, so
     * this exact directory layout is what makes `startUrl()` resolve. Moving the
     * bundle would produce a blank screen with only a 404 in logcat.
     */
    @Test
    public void webBundleIsAnAsset() throws Exception {
        java.io.File web = new java.io.File(appDir(), "src/main/assets/web");
        assertTrue("the built UI must be at assets/web/, missing: " + web, web.isDirectory());
        assertTrue("index.html is missing", new java.io.File(web, "index.html").isFile());
        // The bundle references its chunks relatively, so they must sit beside it.
        java.io.File js = new java.io.File(web, "js");
        assertTrue("the JS chunks must be at assets/web/js/, missing: " + js, js.isDirectory());
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
