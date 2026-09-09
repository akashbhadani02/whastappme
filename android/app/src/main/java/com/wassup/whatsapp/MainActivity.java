package com.wassup.whatsapp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView web;
    private static final int NOTIFICATION_REQ = 9001;
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); s.setAllowFileAccess(true);
        web.addJavascriptInterface(new AndroidBridge(), "AndroidNotifications");
        web.setWebViewClient(new WebViewClient());
        web.loadUrl(BuildConfig.APP_URL); setContentView(web);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQ);
        } else startNotificationService();
    }
    private void startNotificationService() {
        Intent i = new Intent(this, NotificationPollService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_REQ && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) startNotificationService();
    }
    public class AndroidBridge {
        @JavascriptInterface public void saveUserId(String id) {
            if (id == null || id.trim().isEmpty()) return;
            getSharedPreferences("wassup", MODE_PRIVATE).edit().putString("userId", id.trim()).apply();
            startNotificationService();
        }
    }
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
