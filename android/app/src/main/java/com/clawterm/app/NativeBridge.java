package com.clawterm.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * The JS bridge exposed as {@code window.ClawTermNative}.
 *
 * ## Rules this class follows
 *
 * 1. Every method is called on the WebView's JavaBridge thread, never the UI
 *    thread. Anything touching a View must be posted.
 * 2. Methods must never throw: an exception crossing the bridge surfaces in JS
 *    as a bare "Java exception was raised" with no type, which is impossible to
 *    debug from the web side. Every entry point catches and returns a sentinel.
 * 3. Names are stable API. The web layer feature-detects each one
 *    ({@code typeof window.ClawTermNative?.x === 'function'}), so adding a
 *    method is backwards compatible and removing one silently degrades — keep
 *    the old name when changing behaviour.
 */
final class NativeBridge {

    private final MainActivity activity;
    private final WebView webView;

    NativeBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public boolean isNativeApp() {
        return true;
    }

    @JavascriptInterface
    public String getAppVersion() {
        try {
            return activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public String getPlatform() {
        return "android";
    }

    @JavascriptInterface
    public int getAndroidSdk() {
        return Build.VERSION.SDK_INT;
    }

    @JavascriptInterface
    public String getServerUrl() {
        return ServerConfig.baseUrl();
    }

    /**
     * Clipboard read.
     *
     * On Android 10+ an app that is not the focused one gets null back from the
     * clipboard — the framework's own anti-snooping measure. Returning "" makes
     * the web side fall back to its own paste UI instead of pasting nothing.
     */
    @JavascriptInterface
    public String readClipboardText() {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(activity);
            return text == null ? "" : text.toString();
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean writeClipboardText(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(ClipData.newPlainText("clawterm", text));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Short haptic tick for the key bar. No-op when the device has no vibrator. */
    @JavascriptInterface
    public void vibrate(int ms) {
        try {
            Vibrator v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(Math.max(1, ms), VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(Math.max(1, ms));
            }
        } catch (Exception ignored) {
            // Vibration is a nicety; never let it break a key press.
        }
    }

    /**
     * Persist the theme for the native side.
     *
     * The activity paints the splash and the status bar before the WebView
     * exists, so it cannot read localStorage. Without this the first frame of a
     * light theme would still show the dark splash.
     */
    @JavascriptInterface
    public void setTheme(String themeId, boolean dark) {
        try {
            ServerConfig.setLastTheme(activity, themeId);
            activity.applyStatusBarTheme(dark);
        } catch (Exception ignored) {
            // Cosmetic only.
        }
    }

    /** Ask the activity to dispatch a back press through the web handler. */
    @JavascriptInterface
    public void requestBack() {
        activity.runOnUiThread(activity::dispatchWebBack);
    }

    /** True while the app is in the foreground (the web side uses it to gate retries). */
    @JavascriptInterface
    public boolean isForeground() {
        return activity.isAppForeground();
    }

    /** Reload the WebView (used by the "server restarted" recovery path). */
    @JavascriptInterface
    public void reload() {
        activity.runOnUiThread(() -> webView.reload());
    }

    /** Server log tail, for the diagnostics screen. */
    @JavascriptInterface
    public String getServerLog() {
        StringBuilder sb = new StringBuilder();
        for (String line : ServerProcess.logs()) sb.append(line).append('\n');
        return sb.toString();
    }
}
