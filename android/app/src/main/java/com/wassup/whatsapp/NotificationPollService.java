package com.wassup.whatsapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.Context;
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
    private static final String CHANNEL_ID = "wassup_messages_v3";
    private static final String FG_CHANNEL_ID = "wassup_background_v3";
    private static final int SERVICE_ID = 7001;
    private ScheduledExecutorService executor;
    private final HashSet<String> seen = new HashSet<>();
    private volatile boolean polling = false;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(SERVICE_ID, foregroundNotification());
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::poll, 1, 2, TimeUnit.SECONDS);
    }

    private Notification foregroundNotification() {
        return new NotificationCompat.Builder(this, FG_CHANNEL_ID)
                .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
                .setContentTitle("WhatsApp")
                .setContentText("Message notifications are active")
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
            NotificationChannel messages = new NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH);
            messages.setDescription("New message notifications");
            messages.setShowBadge(true);
            messages.enableVibration(true);
            nm.createNotificationChannel(messages);
            NotificationChannel background = new NotificationChannel(FG_CHANNEL_ID, "Background service", NotificationManager.IMPORTANCE_LOW);
            background.setDescription("Keeps message notifications available in the background");
            background.setShowBadge(false);
            nm.createNotificationChannel(background);
        }
    }

    private void poll() {
        if (polling) return;
        polling = true;
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
            c.setConnectTimeout(5000); c.setReadTimeout(5000); c.setRequestMethod("GET");
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache, no-store");
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "WhatsAppAndroidNotification/1.0");
            int status = c.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) { c.disconnect(); return; }
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
                if (!firstPoll) showMessageNotification(id, m.optString("groupName", "WhatsApp"), m.optString("groupId", ""));
            }
            if (!newest.isEmpty()) getSharedPreferences("wassup", MODE_PRIVATE).edit().putString("lastSeenCreatedAt", newest).apply();
        } catch (Exception ignored) {}
        finally { polling = false; }
    }

    private void showMessageNotification(String id, String groupName, String groupId) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (groupId != null && !groupId.isEmpty()) open.putExtra("groupId", groupId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, Math.abs(id.hashCode()), open, flags);

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
                .setContentTitle(groupName == null || groupName.trim().isEmpty() ? "WhatsApp" : groupName.trim())
                .setContentText("New message in " + (groupName == null || groupName.trim().isEmpty() ? "WhatsApp" : groupName.trim()))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .build();
        NotificationManager nm = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        nm.notify(Math.abs(id.hashCode()), n);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // Keep the notification worker alive after the activity is removed.
        // The service is foreground + START_STICKY, so Android can recreate it.
        return START_STICKY;
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        try {
            Intent restart = new Intent(getApplicationContext(), NotificationPollService.class);
            if (Build.VERSION.SDK_INT >= 26) getApplicationContext().startForegroundService(restart);
            else getApplicationContext().startService(restart);
        } catch (Exception ignored) {}
        super.onTaskRemoved(rootIntent);
    }
    @Override public void onDestroy() { if (executor != null) executor.shutdownNow(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
