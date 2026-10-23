package com.clawterm.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Launch settings for the bundled server.
 *
 * The server is a Go PIE binary shipped as {@code libtermd.so} in the APK's
 * native library directory — that directory is the only place Android allows a
 * binary to be executed from (the data directory is mounted noexec on most
 * devices, so copying it out and chmod +x would fail with EACCES).
 *
 * The port is fixed at 20010 and bound to loopback: the WebView is the only
 * client, and a LAN-reachable port would expose every stored SSH credential to
 * anyone on the same Wi-Fi.
 */
final class ServerConfig {

    static final int PORT = 20010;
    static final String LOOPBACK = "127.0.0.1";

    private static final String PREFS = "clawterm";
    private static final String KEY_THEME = "lastTheme";

    private ServerConfig() {}

    /** Base URL the WebView loads. */
    static String baseUrl() {
        return "http://" + LOOPBACK + ":" + PORT + "/";
    }

    /**
     * Path of the bundled server binary.
     *
     * {@code applicationInfo.nativeLibraryDir} is the extracted lib directory;
     * the "lib" prefix and ".so" suffix are stripped by the packager only for
     * JNI libraries, so the file keeps the name it was packaged under.
     */
    static String binaryPath(Context ctx) {
        return ctx.getApplicationInfo().nativeLibraryDir + "/libtermd.so";
    }

    /** Data directory: inside the app's private files dir, so no permission is needed. */
    static String dataDir(Context ctx) {
        return ctx.getFilesDir().getAbsolutePath() + "/clawterm";
    }

    /**
     * The theme is stored here as well as in localStorage: the splash screen and
     * the status bar are painted by the ACTIVITY, before the WebView exists, and
     * a light theme under a dark status bar looks broken on every launch.
     */
    static String lastTheme(Context ctx) {
        return prefs(ctx).getString(KEY_THEME, "gruvbox-dark");
    }

    static void setLastTheme(Context ctx, String themeId) {
        prefs(ctx).edit().putString(KEY_THEME, themeId).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
