package com.clawterm.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * The bundled server is a PIE executable shipped as {@code libtermd.so}.
 *
 * Two build facts make that work, and both fail SILENTLY when wrong:
 *
 *   1. The path must be under {@code nativeLibraryDir}. Android mounts the app's
 *      data directory noexec, so a binary copied there fails with EACCES.
 *   2. The APK must be built with {@code extractNativeLibs="true"} (AGP 8
 *      defaults to false, and {@code useLegacyPackaging = true} is what sets
 *      it). With false the library stays INSIDE the apk, the path does not
 *      exist, and every launch shows "server binary missing".
 *
 * Robolectric reports {@code nativeLibraryDir} as null, so fact 1's prefix is
 * checked only when the platform supplies it, and fact 2 is checked by reading
 * the build files — the only place the regression can actually appear.
 */
@RunWith(RobolectricTestRunner.class)
public class ServerConfigTest {

    private Context ctx() {
        return ApplicationProvider.getApplicationContext();
    }

    @Test
    public void binaryPathNamesTheBundledServer() {
        String path = ServerConfig.binaryPath(ctx());
        assertTrue("expected the libtermd name, got " + path, path.endsWith("/libtermd.so"));

        String nativeDir = ctx().getApplicationInfo().nativeLibraryDir;
        if (nativeDir != null) {
            assertTrue("server binary must live in the native library dir, got " + path,
                    path.startsWith(nativeDir));
        }
    }

    @Test
    public void dataDirIsInsidePrivateFiles() {
        String dir = ServerConfig.dataDir(ctx());
        assertTrue("data dir must be inside the app's private files, got " + dir,
                dir.startsWith(ctx().getFilesDir().getAbsolutePath()));
    }

    /** The server binds loopback only: a LAN-reachable port would expose every
     *  stored credential. */
    @Test
    public void baseUrlIsLoopback() {
        assertEquals("http://127.0.0.1:20010/", ServerConfig.baseUrl());
        assertFalse(ServerConfig.baseUrl().contains("0.0.0.0"));
    }

    /** The activity paints the splash from this value before the WebView exists;
     *  an empty default would show a white flash on every launch. */
    @Test
    public void themeDefaultsToTheFactoryDarkTheme() {
        assertEquals("gruvbox-dark", ServerConfig.lastTheme(ctx()));
    }

    @Test
    public void themeIsPersisted() {
        ServerConfig.setLastTheme(ctx(), "github-light");
        assertEquals("github-light", ServerConfig.lastTheme(ctx()));
    }

    // ── build-config guards ─────────────────────────────────────────────────

    /** Without legacy packaging the server binary is never extracted. */
    @Test
    public void buildUsesLegacyNativePackaging() throws IOException {
        String gradle = readAppFile("build.gradle");
        assertTrue(
                "app/build.gradle must set jniLibs.useLegacyPackaging = true, "
                        + "otherwise libtermd.so stays inside the apk and cannot be executed",
                gradle.contains("useLegacyPackaging"));
        assertTrue("useLegacyPackaging must be true", gradle.contains("useLegacyPackaging = true")
                || gradle.contains("useLegacyPackaging true"));
    }

    /** Belt and braces: the manifest must also request extraction. */
    @Test
    public void manifestExtractsNativeLibs() throws IOException {
        String manifest = readAppFile("src/main/AndroidManifest.xml");
        assertTrue(
                "AndroidManifest must declare android:extractNativeLibs=\"true\"",
                manifest.contains("extractNativeLibs=\"true\""));
    }

    /** The server must never be reachable from the network. */
    @Test
    public void serverBindsLoopbackOnly() throws IOException {
        String cfg = readAppFile("src/main/java/com/clawterm/app/ServerConfig.java");
        assertTrue("ServerConfig must define the loopback address",
                cfg.contains("\"127.0.0.1\""));
        assertFalse("ServerConfig must not bind 0.0.0.0", cfg.contains("\"0.0.0.0\""));
    }

    /**
     * Read a file from the app module, resolving {@code app/} from wherever the
     * test happens to run.
     *
     * Gradle sets the working directory to {@code android/app}, but that is not
     * contractual (IDE runners and different Gradle versions differ). The root
     * is found by walking up until a directory containing
     * {@code app/build.gradle} is visible — that marker cannot be confused with
     * the project-level build.gradle, which lives one level up and has no
     * {@code app/} child.
     */
    private String readAppFile(String relative) throws IOException {
        File dir = new File("").getAbsoluteFile();
        for (int i = 0; i < 8 && dir != null; i++) {
            File appMarker = new File(dir, "app/build.gradle");
            if (appMarker.isFile()) {
                File target = new File(new File(dir, "app"), relative);
                if (!target.isFile()) {
                    throw new IOException("missing " + target.getAbsolutePath());
                }
                return new String(Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8);
            }
            // Also handle the case where the working dir IS the app module.
            if (new File(dir, "build.gradle").isFile() && new File(dir, "src/main").isDirectory()) {
                File target = new File(dir, relative);
                if (target.isFile()) {
                    return new String(Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8);
                }
            }
            dir = dir.getParentFile();
        }
        throw new IOException("could not locate app/ from " + new File("").getAbsolutePath());
    }
}
