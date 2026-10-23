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
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * The single activity: a WebView pointed at the bundled server.
 *
 * There is deliberately no native UI beyond the error screen and the splash.
 * Every screen is Vue, so a change ships in the web bundle and the two platforms
 * (browser, Android) can never drift.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "ClawTerm";

    private WebView webView;
    private View errorView;
    private ProgressBar loadingBar;
    private boolean foreground = true;
    /** Set when the activity is really going away (not a rotation). */
    private boolean finishingForReal = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyStatusBarTheme("dark".equals(themeBase()));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#1d2021"));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWebView(webView);
        root.addView(webView);

        loadingBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2));
        lp.topMargin = getStatusBarHeight();
        loadingBar.setLayoutParams(lp);
        loadingBar.setMax(100);
        root.addView(loadingBar);

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView);

        setContentView(root);
        applyInsets(root);

        // The server must be up before loadUrl, otherwise the WebView caches a
        // connection-refused error page and shows it even after the server
        // comes online.
        startServerThenLoad();
    }

    private void startServerThenLoad() {
        new Thread(() -> {
            boolean ok = ServerProcess.ensureStarted(getApplicationContext());
            runOnUiThread(() -> {
                if (ok) {
                    loadApp();
                } else {
                    showError();
                }
            });
        }, "termd-boot").start();
    }

    private void loadApp() {
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(ServerConfig.baseUrl());
    }

    private void showError() {
        webView.setVisibility(View.GONE);
        loadingBar.setVisibility(View.GONE);
        TextView detail = errorView.findViewById(R.id.error_detail);
        if (detail != null) {
            StringBuilder sb = new StringBuilder();
            for (String line : ServerProcess.logs()) sb.append(line).append('\n');
            detail.setText(sb.length() == 0 ? getString(R.string.server_start_failed) : sb.toString());
        }
        errorView.setVisibility(View.VISIBLE);
    }

    private View buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(android.view.Gravity.CENTER);
        box.setPadding(dp(24), dp(24), dp(24), dp(24));
        box.setBackgroundColor(Color.parseColor("#1d2021"));
        box.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText(R.string.server_start_failed);
        title.setTextColor(Color.parseColor("#ebdbb2"));
        title.setTextSize(16);
        box.addView(title);

        TextView detail = new TextView(this);
        detail.setId(R.id.error_detail);
        detail.setTextColor(Color.parseColor("#928374"));
        detail.setTextSize(11);
        detail.setPadding(0, dp(12), 0, dp(16));
        box.addView(detail);

        TextView retry = new TextView(this);
        retry.setText(R.string.retry);
        retry.setTextColor(Color.parseColor("#fe8019"));
        retry.setTextSize(15);
        retry.setPadding(dp(20), dp(10), dp(20), dp(10));
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            loadingBar.setVisibility(View.VISIBLE);
            startServerThenLoad();
        });
        box.addView(retry);
        return box;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        // The app is served over http://127.0.0.1. Mixing is irrelevant here,
        // but a WebSocket to ws:// from an http page is "insecure" and must be
        // allowed explicitly on newer WebViews.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        // adjustResize: the layout viewport shrinks with the keyboard, which is
        // what the terminal's FitAddon needs to recompute rows. Without it the
        // terminal keeps its old height and the prompt hides behind the IME.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        wv.addJavascriptInterface(new NativeBridge(this, wv), "ClawTermNative");
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                loadingBar.setProgress(newProgress);
                loadingBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // The theme lives in localStorage, so the native splash cannot
                // read it before the page exists. Push the last known value back
                // once per load so the status bar matches after a restart.
                view.evaluateJavascript(
                        "(function(){try{var v=localStorage.getItem('clawterm-settings-theme');" +
                                "if(v){var id=JSON.parse(v);var d=['solarized-dark','monokai','material-darker','dark-plus','bluloco-dark','nord','everforest-dark','one-dark-pro','dracula','rose-pine','gruvbox-dark','solarized-deep','github-dark','catppuccin-mocha','vitesse-dark','tokyo-night','kanagawa','ayu-dark','night-owl','high-contrast-dark'];" +
                                "window.ClawTermNative&&window.ClawTermNative.setTheme(id,d.indexOf(id)>=0);}}catch(e){}})()",
                        null);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // Only a failure of the main document is worth an error screen;
                // a missing icon must not replace the app.
                if (failingUrl != null && failingUrl.startsWith(ServerConfig.baseUrl())) {
                    Log.e(TAG, "page error " + errorCode + ": " + description);
                    showError();
                }
            }
        });
    }

    private void applyInsets(View root) {
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            int top = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top;
            loadingBar.setTranslationY(top);
            errorView.setPadding(0, top, 0, insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom);
            return insets;
        });
    }

    private int getStatusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private String themeBase() {
        return getSharedPreferences("clawterm", MODE_PRIVATE).getString("themeBase", "dark");
    }

    /**
     * Paint the status/navigation bars for the current theme.
     *
     * The web layer calls this through the bridge whenever the theme changes;
     * the colour itself comes from the page's meta theme-color, so there is one
     * palette rather than a Java copy that drifts.
     */
    void applyStatusBarTheme(boolean dark) {
        Window w = getWindow();
        w.setStatusBarColor(dark ? Color.parseColor("#1d2021") : Color.parseColor("#f0f0f0"));
        w.setNavigationBarColor(dark ? Color.parseColor("#1d2021") : Color.parseColor("#f0f0f0"));
        View decor = w.getDecorView();
        WindowInsetsControllerCompat c = new WindowInsetsControllerCompat(w, decor);
        // Light icons on dark bars and vice versa. Getting this backwards makes
        // the clock unreadable on one of the two themes.
        c.setAppearanceLightStatusBars(!dark);
        c.setAppearanceLightNavigationBars(!dark);
        getSharedPreferences("clawterm", MODE_PRIVATE).edit()
                .putString("themeBase", dark ? "dark" : "light").apply();
    }

    /** Dispatch the web back handler; returns true when the page consumed it. */
    void dispatchWebBack() {
        if (webView == null) return;
        webView.evaluateJavascript(
                "(function(){try{document.dispatchEvent(new Event('clawterm-back-press'));" +
                        "return window.__clawtermBackHandled===true;}catch(e){return false;}})()",
                value -> {
                    if (!"true".equals(value)) {
                        // Nothing in the app wanted the press: ask the page for
                        // the double-press-to-exit confirmation.
                        webView.evaluateJavascript(
                                "(function(){try{return window.__clawtermExitRequested===true;}catch(e){return false;}})()",
                                exit -> {
                                    if ("true".equals(exit)) {
                                        finish();
                                    }
                                });
                    }
                });
    }

    boolean isAppForeground() {
        return foreground;
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
        // A rotation or theme change destroys the activity but must NOT kill the
        // SSH sessions; only a real finish does.
        if (isFinishing()) {
            finishingForReal = true;
            ServerProcess.stop();
        }
    }
}
