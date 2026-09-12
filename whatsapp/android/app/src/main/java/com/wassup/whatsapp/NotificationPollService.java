package com.wassup.whatsapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public class NotificationPollService extends Service {
    private static final String CHANNEL_ID = "wassup_messages";
    private static final int SERVICE_ID = 7001;
    private ScheduledExecutorService executor;
    private final HashSet<String> seen = new HashSet<>();

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(SERVICE_ID, foregroundNotification());
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::poll, 2, 15, TimeUnit.SECONDS);
    }

    private Notification foregroundNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
                .setContentTitle("WhatsApp")
                .setContentText("Notifications are enabled")
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_DEFAULT);
            c.setDescription("New message notifications");
            c.setShowBadge(true);
            ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
        }
    }

    private void poll() {
        try {
            String userId = getSharedPreferences("wassup", MODE_PRIVATE).getString("userId", "");
            if (userId.isEmpty()) return;
            String after = getSharedPreferences("wassup", MODE_PRIVATE).getString("lastSeenCreatedAt", "");
            // If the stored timestamp is malformed, reset it so polling can recover.
            if (!after.isEmpty()) {
                try { new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", java.util.Locale.US).parse(after); }
                catch (Exception ignored) { after = ""; }
            }
            String base = getSharedPreferences("wassup", MODE_PRIVATE).getString("appUrl", BuildConfig.APP_URL);
            if (base == null || base.trim().isEmpty() || base.contains("YOUR-VERCEL-APP")) return;
            try { base = new URL(base).getProtocol() + "://" + new URL(base).getAuthority(); } catch (Exception ignored) {}
            String sep = base.contains("?") ? "&" : "?";
            String urlText = base.replaceAll("/$", "") + "/api/notifications/poll" + sep + "userId=" + URLEncoder.encode(userId, "UTF-8") + "&after=" + URLEncoder.encode(after, "UTF-8");
            HttpURLConnection c = (HttpURLConnection)new URL(urlText).openConnection();
            c.setConnectTimeout(10000); c.setReadTimeout(10000); c.setRequestMethod("GET");
            if (c.getResponseCode() != 200) return;
            InputStream in = c.getInputStream();
            BufferedReader br = new BufferedReader(new InputStreamReader(in));
            StringBuilder sb = new StringBuilder(); String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close(); c.disconnect();
            JSONObject root = new JSONObject(sb.toString());
            if (!root.optBoolean("ok", false)) return;
            JSONArray arr = root.optJSONArray("messages");
            if (arr == null) return;
            String newest = after;
            boolean firstPoll = after.isEmpty();
            for (int i=0; i<arr.length(); i++) {
                JSONObject m = arr.getJSONObject(i);
                String id = m.optString("id", "");
                String created = m.optString("createdAt", "");
                if (created.compareTo(newest) > 0) newest = created;
                if (id.isEmpty() || seen.contains(id)) continue;
                seen.add(id);
                if (!firstPoll) showMessageNotification(id);
            }
            if (!newest.isEmpty()) getSharedPreferences("wassup", MODE_PRIVATE).edit().putString("lastSeenCreatedAt", newest).apply();
        } catch (Exception ignored) {}
    }

    private void showMessageNotification(String id) {
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
                .setContentTitle("WhatsApp")
                .setContentText("You have new message")
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .build();
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(Math.abs(id.hashCode()), n);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }
    @Override public void onDestroy() { if (executor != null) executor.shutdownNow(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
