package com.clawterm.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Local app settings and paths.
 *
 * There is no server, so there is no port and no URL: the UI is loaded from the
 * APK's own assets and the data lives in the app's private storage.
 */
final class AppConfig {

    private static final String PREFS = "clawterm";
    private static final String KEY_THEME = "lastTheme";
    private static final String KEY_THEME_BASE = "themeBase";
    private static final String KEY_LOCKED = "locked";

    private AppConfig() {}

    /**
     * The origin the UI is served from.
     *
     * NOT `file:///android_asset/…`: a `file://` page has an opaque origin, and
     * the browser blocks ES module and stylesheet loads from it with a CORS
     * error — the app would render a blank screen with nothing in the UI to
     * explain why. `WebViewAssetLoader` serves the same APK assets over a real
     * https origin instead, which the module loader accepts.
     *
     * The host is the reserved `appassets.androidplatform.net` domain, so it can
     * never collide with a real site and never leaves the device.
     */
    static final String ASSET_HOST = "appassets.androidplatform.net";

    /** The page the WebView loads. */
    static String startUrl() {
        return "https://" + ASSET_HOST + "/web/index.html";
    }

    /**
     * Root of the app's private data.
     *
     * `getFilesDir()` is inside the app sandbox, so no storage permission is
     * needed and no other app can read the host list or the credentials.
     */
    static String dataDir(Context ctx) {
        return ctx.getFilesDir().getAbsolutePath() + "/clawterm";
    }

    /**
     * The theme is mirrored here because the activity paints the splash and the
     * status bar BEFORE the WebView exists — localStorage is not readable yet,
     * and a light theme under a dark status bar looks broken on every launch.
     */
    static String lastTheme(Context ctx) {
        return prefs(ctx).getString(KEY_THEME, "gruvbox-dark");
    }

    static void setLastTheme(Context ctx, String themeId, boolean dark) {
        prefs(ctx).edit()
                .putString(KEY_THEME, themeId)
                .putString(KEY_THEME_BASE, dark ? "dark" : "light")
                .apply();
    }

    static boolean themeIsDark(Context ctx) {
        return !"light".equals(prefs(ctx).getString(KEY_THEME_BASE, "dark"));
    }

    /**
     * Whether the app is locked.
     *
     * Defaults to TRUE: a fresh install has no password, and the setup screen is
     * what unlocks it. Defaulting to false would let the host list render for a
     * moment before the gate closes.
     */
    static boolean isLocked(Context ctx) {
        return prefs(ctx).getBoolean(KEY_LOCKED, true);
    }

    static void setLocked(Context ctx, boolean locked) {
        prefs(ctx).edit().putBoolean(KEY_LOCKED, locked).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
