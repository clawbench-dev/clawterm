package com.clawterm.app;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.json.JSONObject;

/**
 * The whole app: a WebView over local assets, with SSH running in this process.
 *
 * ## Why there is no server
 *
 * The UI is loaded from `file:///android_asset/web/index.html`, and every data
 * operation goes through {@link BridgeDispatcher} straight into JSch and SQLite.
 * Nothing listens on a port, so nothing on the device (or the network) can reach
 * the API, and there is no process to keep alive or restart.
 *
 * ## Why the WebView is still there
 *
 * The UI is Vue. Rewriting it in native views would duplicate every screen and
 * the terminal renderer (xterm) would have to be replaced with a native
 * emulator — a large amount of work for no functional gain. A WebView over local
 * assets is a client, not a server.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "ClawTerm";

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private TextView errorView;
    private Db db;
    private SecretStore secrets;
    private TerminalManager terminals;
    private ForwardManager forwards;
    private BridgeDispatcher bridge;
    private boolean foreground = true;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyStatusBarTheme(AppConfig.themeIsDark(this));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#1d2021"));

        try {
            db = new Db(this);
            secrets = new SecretStore(this);
        } catch (Exception e) {
            // A broken key file is fatal for the session: every credential would
            // be unreadable, so say so instead of showing an empty app.
            Log.e(TAG, "storage init failed", e);
            showFatal(getString(R.string.storage_init_failed) + "\n" + e.getMessage());
            return;
        }

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);

        errorView = new TextView(this);
        errorView.setTextColor(Color.parseColor("#ebdbb2"));
        errorView.setTextSize(12);
        errorView.setPadding(dp(16), dp(16), dp(16), dp(16));
        errorView.setVisibility(View.GONE);
        root.addView(errorView);

        setContentView(root);
        applyInsets(root);

        terminals = new TerminalManager(new TerminalManager.Listener() {
            @Override
            public void onData(String sessionId, byte[] data) {
                // Base64, not text: a PTY stream is arbitrary bytes, and a
                // half-written multi-byte character is normal. Text decoding
                // happens once, in the view, where it can buffer the split.
                bridge.emitEvent("terminal.data", json(
                        "sessionId", sessionId,
                        "data", android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)));
            }

            @Override
            public void onExit(String sessionId, int code) {
                bridge.emitEvent("terminal.exit", json("sessionId", sessionId, "code", code));
            }

            @Override
            public void onState(String sessionId, String state, String message, String code) {
                bridge.emitEvent("terminal.state", json(
                        "sessionId", sessionId, "state", state,
                        "message", message == null ? "" : message,
                        "code", code == null ? "" : code));
            }
        });

        forwards = new ForwardManager((localPort, running, connections, error) -> {
            bridge.emitEvent("forward.status", json(
                    "localPort", localPort, "running", running,
                    "connections", connections, "error", error == null ? "" : error));
        });

        // Assets are served over https, not file://: see AppConfig.startUrl.
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/web/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        configureWebView(webView);
        bridge = new BridgeDispatcher(this, db, secrets, terminals, forwards, webView);
        webView.addJavascriptInterface(new NativeInterface(), "ClawTermNative");

        webView.loadUrl(AppConfig.startUrl());
    }

    private static JSONObject json(Object... kv) {
        JSONObject o = new JSONObject();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            try {
                o.put(String.valueOf(kv[i]), kv[i + 1]);
            } catch (Exception ignored) {
                // Constant keys.
            }
        }
        return o;
    }

    // ── JS bridge ───────────────────────────────────────────────────────────

    /**
     * The single entry point exposed to JavaScript.
     *
     * One method rather than ~35: each `@JavascriptInterface` is a magic string
     * that must match the TypeScript side and be kept by R8, and a typo only
     * surfaces at runtime. The method names live in one TypeScript union and one
     * `switch` here.
     */
    private final class NativeInterface {
        @JavascriptInterface
        public void invoke(String requestId, String method, String payloadJson) {
            bridge.invoke(requestId, method, payloadJson);
        }

        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }
    }

    // ── WebView ─────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Local assets are same-origin under file://, but a keychain-style
        // storage API still needs this on some WebView builds.
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        // adjustResize: the layout viewport shrinks with the keyboard, which is
        // what the terminal's FitAddon needs to recompute rows. Without it the
        // prompt hides behind the IME.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        wv.setWebChromeClient(new WebChromeClient());
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest request) {
                // Serve the APK's assets under the https origin. Returning null
                // lets the request through to the network, which is what a link
                // the user tapped should do.
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Anything that is not our own app origin is a link the user
                // tapped in terminal output; hand it to the system browser so the
                // app never becomes an uncontrolled browser.
                if (!url.startsWith("https://" + AppConfig.ASSET_HOST + "/")) {
                    try {
                        startActivity(new android.content.Intent(
                                android.content.Intent.ACTION_VIEW, request.getUrl()));
                    } catch (Exception ignored) {
                        // No handler installed; dropping the click is better than
                        // crashing the terminal session behind it.
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Push the persisted theme back so the status bar matches after a
                // restart: localStorage is not readable by the activity.
                view.evaluateJavascript(
                        "(function(){try{window.ClawTermNative&&"
                                + "window.ClawTermNative.isNativeApp();}catch(e){}})()", null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    Log.e(TAG, "page load failed: " + error.getDescription());
                    showFatal(getString(R.string.page_load_failed) + "\n"
                            + error.getDescription());
                }
            }
        });
    }

    private void applyInsets(View root) {
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            int top = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top;
            int bottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
            errorView.setPadding(dp(16), top + dp(16), dp(16), bottom + dp(16));
            return insets;
        });
    }

    private void showFatal(String message) {
        if (webView != null) webView.setVisibility(View.GONE);
        errorView.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ── theme ───────────────────────────────────────────────────────────────

    /**
     * Paint the status and navigation bars.
     *
     * Called from the activity (before the page exists) and from the page via
     * `app.info`'s sibling path, so the splash and the running app agree.
     */
    void applyStatusBarTheme(boolean dark) {
        Window w = getWindow();
        int bar = dark ? Color.parseColor("#1d2021") : Color.parseColor("#f0f0f0");
        w.setStatusBarColor(bar);
        w.setNavigationBarColor(bar);
        WindowInsetsControllerCompat c =
                new WindowInsetsControllerCompat(w, w.getDecorView());
        // Light icons on dark bars and vice versa; backwards makes the clock
        // unreadable on one of the two themes.
        c.setAppearanceLightStatusBars(!dark);
        c.setAppearanceLightNavigationBars(!dark);
    }

    // ── back ────────────────────────────────────────────────────────────────

    /**
     * Ask the page to handle back.
     *
     * The page answers SYNCHRONOUSLY (it must, because the result decides whether
     * the activity finishes), so the value is read from a global the page sets
     * before dispatching.
     */
    private void dispatchWebBack() {
        if (webView == null) return;
        webView.evaluateJavascript(
                "(function(){try{document.dispatchEvent(new Event('clawterm-back-press'));"
                        + "return window.__clawtermBackHandled===true;}catch(e){return false;}})()",
                value -> {
                    if ("true".equals(value)) return;
                    webView.evaluateJavascript(
                            "(function(){try{return window.__clawtermExitRequested===true;}"
                                    + "catch(e){return false;}})()",
                            exit -> {
                                if ("true".equals(exit)) finish();
                            });
                });
    }

    @Override
    public void onBackPressed() {
        dispatchWebBack();
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.__clawtermResume&&window.__clawtermResume()", null);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        foreground = false;
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // A rotation keeps the process, and the SSH sessions with it; only a real
        // finish tears them down.
        if (isFinishing()) {
            if (terminals != null) terminals.closeAll();
            if (forwards != null) forwards.stopAll();
            if (bridge != null) bridge.closeAll();
            if (db != null) db.close();
        }
    }
}
