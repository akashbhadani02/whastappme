package com.wassup.whatsapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.net.URL;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class NotificationService extends Service {
    private static final String CHANNEL_ID = "whatsapp_messages";
    private static final int SERVICE_ID = 1001;
    private ScheduledExecutorService executor;
    private volatile boolean running = false;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(SERVICE_ID, buildServiceNotification());
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::poll, 2, 7, TimeUnit.SECONDS);
    }

    private Notification buildServiceNotification() {
        Intent i = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
                .setContentTitle("WhatsApp")
                .setContentText("Message notifications are active")
                .setContentIntent(pi)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "WhatsApp messages", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("New WhatsApp message notifications");
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(ch);
        }
    }

    private void poll() {
        if (running) return;
        running = true;
        try {
            android.content.SharedPreferences p = getSharedPreferences("wassup", MODE_PRIVATE);
            String appUrl = BuildConfig.APP_URL;
            if (appUrl == null || appUrl.contains("YOUR-VERCEL-APP")) return;
            String userId = p.getString("userId", "");
            if (userId.isEmpty()) return;
            String last = p.getString("lastSeenAt", "");
            String sep = appUrl.contains("?") ? "&" : "?";
            String endpoint = appUrl.endsWith("/") ? appUrl + "api/messages" : appUrl + "/api/messages";
            if (!last.isEmpty()) endpoint += sep + "after=" + URLEncoder.encode(last, "UTF-8");

            HttpURLConnection c = (HttpURLConnection) new URL(endpoint).openConnection();
            c.setConnectTimeout(5000); c.setReadTimeout(7000); c.setRequestMethod("GET");
            if (c.getResponseCode() != 200) return;
            InputStream in = c.getInputStream();
            BufferedReader br = new BufferedReader(new InputStreamReader(in));
            StringBuilder sb = new StringBuilder(); String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close(); c.disconnect();
            JSONObject root = new JSONObject(sb.toString());
            JSONArray arr = root.optJSONArray("messages");
            if (arr == null || arr.length() == 0) return;

            String newest = last;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.optJSONObject(i); if (m == null) continue;
                String id = m.optString("id", "");
                String created = m.optString("createdAt", "");
                String from = m.optString("userId", "");
                if (created.compareTo(newest) > 0) newest = created;
                if (id.isEmpty() || from.equals(userId)) continue;
                if (!last.isEmpty() && created.compareTo(last) <= 0) continue;
                showMessageNotification(m);
            }
            if (!newest.isEmpty() && newest.compareTo(last) > 0) p.edit().putString("lastSeenAt", newest).apply();
        } catch (Exception ignored) {
        } finally { running = false; }
    }

    private void showMessageNotification(JSONObject m) {
        String sender = m.optString("user", "New message");
        String body = m.optString("message", "");
        if (body.isEmpty()) {
            String type = m.optString("type", "");
            body = "image".equals(type) ? "📷 Photo" : "video".equals(type) ? "🎥 Video" : "New message";
        }
        String group = m.optString("groupName", "WhatsApp");
        String id = m.optString("id", String.valueOf(System.currentTimeMillis()));
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, id.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
                .setContentTitle(group)
                .setContentText(sender + ": " + body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(sender + ": " + body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_ALL)
                .setContentIntent(pi)
                .build();
        NotificationManager nm = (NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(Math.abs(id.hashCode()), n);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }
    @Override public void onDestroy() { if (executor != null) executor.shutdownNow(); super.onDestroy(); }
    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
