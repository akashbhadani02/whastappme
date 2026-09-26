package com.wassup.whatsapp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

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

        // Ask for notification permission only after the activity/WebView is ready.
        // This avoids racing the media permission dialog and makes the Android
        // notification flow reliable on Android 13+.
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        } else {
            startNotificationService();
        }
        if (Build.VERSION.SDK_INT < 33 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, MEDIA_PERMISSION_REQUEST);
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
            android.content.SharedPreferences.Editor e = prefs.edit().putString("userId", next);
            if (!next.equals(previous)) e.remove("lastSeenCreatedAt").remove("lastSeenUserId");
            e.putString("lastSeenUserId", next).apply();
            startNotificationService();
        }
        @JavascriptInterface public void setAppUrl(String url) {
            if (url == null || url.trim().isEmpty()) return;
            getSharedPreferences("wassup", MODE_PRIVATE).edit().putString("appUrl", url.trim()).apply();
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            // Start the foreground notification worker after the notification
            // permission result, regardless of whether media permissions are
            // still pending.
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
        startNotificationService();
    }

    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
