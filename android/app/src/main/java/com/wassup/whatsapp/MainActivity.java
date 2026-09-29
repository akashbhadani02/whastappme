package com.wassup.whatsapp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView web;
    private static final int MEDIA_PERMISSION_REQUEST = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1002;

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        web.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) request.grant(request.getResources());
                });
            }
        });

        web.loadUrl(BuildConfig.APP_URL);
        setContentView(web);

        // Start the notification worker as soon as the app is installed/launched.
        // On Android 13+ the worker can run, but alert notifications require the
        // POST_NOTIFICATIONS permission. Ask for it once the WebView is ready.
        ensureNotificationPermissionAndService();
        if (Build.VERSION.SDK_INT < 33 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, MEDIA_PERMISSION_REQUEST);
        }
    }

    private void ensureNotificationPermissionAndService() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
            return;
        }
        startNotificationService();
        // Do not repeatedly launch the battery-optimization screen. It is a
        // one-time setup aid and Android OEMs can otherwise show it on every
        // resume, which looks like a broken notification prompt.
        android.content.SharedPreferences prefs = getSharedPreferences("wassup", MODE_PRIVATE);
        if (!prefs.getBoolean("batteryPromptShown", false)) {
            prefs.edit().putBoolean("batteryPromptShown", true).apply();
            requestBatteryOptimizationExemption();
        }
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            String pkg = getPackageName();
            if (pm != null && !pm.isIgnoringBatteryOptimizations(pkg)) {
                Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + pkg));
                startActivity(i);
            }
        } catch (Exception ignored) {
            // Some manufacturers do not expose this screen.
        }
    }

    private void startNotificationService() {
        Intent intent = new Intent(this, NotificationPollService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
    }

    private class AndroidBridge {
        @JavascriptInterface public void setUserId(String id) {
            if (id == null) return;
            String next = id.trim();
            if (next.isEmpty()) return;
            android.content.SharedPreferences prefs = getSharedPreferences("wassup", MODE_PRIVATE);
            String previous = prefs.getString("userId", "");
            String deviceId = prefs.getString("androidDeviceId", "");
            if (deviceId.isEmpty()) {
                deviceId = java.util.UUID.randomUUID().toString();
            }
            android.content.SharedPreferences.Editor e = prefs.edit()
                    .putString("userId", next)
                    .putString("androidDeviceId", deviceId);
            if (!next.equals(previous)) e.remove("lastSeenCreatedAt").remove("lastSeenUserId");
            e.putString("lastSeenUserId", next).apply();
            startNotificationService();
        }
        @JavascriptInterface public void setAppUrl(String url) {
            if (url == null || url.trim().isEmpty()) return;
            getSharedPreferences("wassup", MODE_PRIVATE).edit().putString("appUrl", url.trim()).apply();
            // The WebView may provide the real production URL after the service
            // has already started with the build-time placeholder. Kick the
            // service so it reconnects immediately instead of waiting for poll.
            startNotificationService();
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            // Start/restart the worker after the notification permission result.
            // If the user denied it, Android will keep the app's notification
            // channel disabled; the service still stays alive so permission can
            // be granted later from Android Settings.
            startNotificationService();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, MEDIA_PERMISSION_REQUEST);
            }
        } else if (requestCode == MEDIA_PERMISSION_REQUEST && web != null) {
            web.reload();
        }
    }

    @Override protected void onResume() {
        super.onResume();
        // If the user enabled notifications from Android Settings while the app
        // was paused, immediately bring the notification worker back online.
        ensureNotificationPermissionAndService();
    }

    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
