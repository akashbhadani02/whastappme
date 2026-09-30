package com.wassup.whatsapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.app.PendingIntent;
import android.media.RingtoneManager;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashSet;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;

public class NotificationPollService extends Service {
    private static final String CHANNEL_ID = "wassup_messages_v6";
    private static final String FG_CHANNEL_ID = "wassup_background_v6";
    private static final String CALL_CHANNEL_ID = "wassup_calls_v1";
    private static final int SERVICE_ID = 7001;

    private ScheduledExecutorService executor;
    private final HashSet<String> seen = new HashSet<>();
    private final HashSet<String> seenCalls = new HashSet<>();
    private volatile boolean polling = false;
    private PowerManager.WakeLock pollWakeLock;

    private Socket realtimeSocket;
    private String realtimeUserId = "";
    private String realtimeUrl = "";

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(SERVICE_ID, foregroundNotification());

        executor = Executors.newSingleThreadScheduledExecutor();
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) pollWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wassup:notification-poll");
        } catch (Exception ignored) {}

        // Polling remains as a recovery path. Realtime Socket.IO is the primary
        // notification path and normally delivers the alert immediately.
        executor.scheduleWithFixedDelay(this::poll, 1, 2, TimeUnit.SECONDS);
        executor.scheduleWithFixedDelay(this::pollCalls, 1, 2, TimeUnit.SECONDS);
        connectRealtimeIfNeeded();
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

            NotificationChannel messages = new NotificationChannel(
                    CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH
            );
            messages.setDescription("Instant group message notifications");
            messages.setShowBadge(true);
            messages.enableVibration(true);
            nm.createNotificationChannel(messages);

            NotificationChannel background = new NotificationChannel(
                    FG_CHANNEL_ID, "Background service", NotificationManager.IMPORTANCE_LOW
            );
            background.setDescription("Keeps realtime message notifications active");
            background.setShowBadge(false);
            nm.createNotificationChannel(background);

            NotificationChannel calls = new NotificationChannel(CALL_CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            calls.setDescription("Incoming group call alerts");
            calls.enableVibration(true);
            calls.setVibrationPattern(new long[]{0,500,250,500,250,500});
            calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(calls);
        }
    }

    private String getUserId() {
        return getSharedPreferences("wassup", MODE_PRIVATE)
                .getString("userId", "").trim();
    }

    private String getBaseUrl() {
        String base = getSharedPreferences("wassup", MODE_PRIVATE)
                .getString("appUrl", BuildConfig.APP_URL);
        if (base == null) return "";
        base = base.trim();
        if (base.isEmpty() || base.contains("YOUR-VERCEL-APP")) return "";
        try {
            URL u = new URL(base);
            return u.getProtocol() + "://" + u.getAuthority();
        } catch (Exception ignored) {
            return base.replaceAll("/$", "");
        }
    }

    private synchronized void connectRealtimeIfNeeded() {
        String userId = getUserId();
        String base = getBaseUrl();
        if (userId.isEmpty() || base.isEmpty()) return;

        if (realtimeSocket != null &&
                realtimeSocket.connected() &&
                userId.equals(realtimeUserId) &&
                base.equals(realtimeUrl)) {
            return;
        }

        disconnectRealtime();

        realtimeUserId = userId;
        realtimeUrl = base;

        try {
            IO.Options options = new IO.Options();
            options.forceNew = true;
            options.reconnection = true;
            options.reconnectionAttempts = Integer.MAX_VALUE;
            options.reconnectionDelay = 1000;
            options.reconnectionDelayMax = 10000;
            options.timeout = 10000;
            options.transports = new String[]{"websocket", "polling"};
            options.upgrade = true;
            options.forceNew = false;

            realtimeSocket = IO.socket(base, options);

            realtimeSocket.on(Socket.EVENT_CONNECT, args -> {
                try {
                    JSONObject identity = new JSONObject();
                    identity.put("userId", getUserId());
                    identity.put("name", "");
                    identity.put("deviceId", getSharedPreferences("wassup", MODE_PRIVATE)
                            .getString("androidDeviceId", ""));
                    realtimeSocket.emit("register-user", identity);
                } catch (Exception ignored) {}
            });

            realtimeSocket.on("native-notification", args -> {
                if (args == null || args.length == 0 || !(args[0] instanceof JSONObject)) return;
                JSONObject data = (JSONObject) args[0];
                String id = data.optString("id", "");
                String groupName = data.optString("groupName", "WhatsApp");
                String groupId = data.optString("groupId", "");
                String body = data.optString("body", "New message");
                if (id.isEmpty()) return;

                // Do not show the sender's own message. The server also filters
                // it, but this extra check makes the client defensive.
                showMessageNotification(id, groupName, groupId, body);
            });

            realtimeSocket.on(Socket.EVENT_CONNECT_ERROR, args -> {
                // Socket.IO will retry automatically; HTTP polling remains the
                // independent recovery path below.
            });

            realtimeSocket.on(Socket.EVENT_DISCONNECT, args -> {
                // Keep the service alive. Socket.IO reconnection and HTTP polling
                // will restore delivery when connectivity returns.
            });

            realtimeSocket.connect();
        } catch (Exception ignored) {
            realtimeSocket = null;
        }
    }

    private synchronized void disconnectRealtime() {
        try {
            if (realtimeSocket != null) {
                realtimeSocket.off();
                realtimeSocket.disconnect();
                realtimeSocket.close();
            }
        } catch (Exception ignored) {}
        realtimeSocket = null;
    }

    private void poll() {
        if (polling) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        if (pollWakeLock != null) { try { pollWakeLock.acquire(12000); } catch (Exception ignored) {} }
        polling = true;
        try {
            // If the user changed account after service startup, reconnect the
            // realtime channel immediately.
            connectRealtimeIfNeeded();

            String userId = getUserId();
            if (userId.isEmpty()) return;

            String after = getSharedPreferences("wassup", MODE_PRIVATE)
                    .getString("lastSeenCreatedAt", "");

            if (!after.isEmpty()) {
                try {
                    new java.text.SimpleDateFormat(
                            "yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US
                    ).parse(after);
                } catch (Exception ignored) {
                    after = "";
                }
            }

            String base = getBaseUrl();
            if (base.isEmpty()) return;

            String urlText = base.replaceAll("/$", "") +
                    "/api/notifications/poll?userId=" +
                    URLEncoder.encode(userId, "UTF-8") +
                    "&after=" + URLEncoder.encode(after, "UTF-8");

            HttpURLConnection c = (HttpURLConnection)new URL(urlText).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            c.setRequestMethod("GET");
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache, no-store");
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "WhatsAppAndroidNotification/2.0");

            int status = c.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                c.disconnect();
                return;
            }

            InputStream in = c.getInputStream();
            BufferedReader br = new BufferedReader(new InputStreamReader(in));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();
            c.disconnect();

            JSONObject root = new JSONObject(sb.toString());
            if (!root.optBoolean("ok", false)) return;

            JSONArray arr = root.optJSONArray("messages");
            if (arr == null) return;

            String newest = after;
            boolean firstPoll = after.isEmpty();

            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.getJSONObject(i);
                String id = m.optString("id", "");
                String created = m.optString("createdAt", "");

                if (created.compareTo(newest) > 0) newest = created;
                if (id.isEmpty() || seen.contains(id)) continue;

                seen.add(id);

                if (!firstPoll) {
                    showMessageNotification(
                            id,
                            m.optString("groupName", "WhatsApp"),
                            m.optString("groupId", ""),
                            m.optString("body", "New message")
                    );
                }
            }

            if (!newest.isEmpty()) {
                getSharedPreferences("wassup", MODE_PRIVATE)
                        .edit().putString("lastSeenCreatedAt", newest).apply();
            }
        } catch (Exception ignored) {
        } finally {
            polling = false;
            if (pollWakeLock != null && pollWakeLock.isHeld()) { try { pollWakeLock.release(); } catch (Exception ignored) {} }
        }
    }


    private void pollCalls() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        String userId=getUserId(), base=getBaseUrl(); if(userId.isEmpty()||base.isEmpty()) return;
        try {
            String after=getSharedPreferences("wassup",MODE_PRIVATE).getString("lastCallSeenAt","");
            String urlText=base.replaceAll("/$","")+"/api/notifications/calls?userId="+URLEncoder.encode(userId,"UTF-8")+"&after="+URLEncoder.encode(after,"UTF-8");
            HttpURLConnection c=(HttpURLConnection)new URL(urlText).openConnection(); c.setConnectTimeout(5000); c.setReadTimeout(5000); c.setRequestMethod("GET"); c.setUseCaches(false); c.setRequestProperty("Cache-Control","no-cache,no-store");
            if(c.getResponseCode()!=HttpURLConnection.HTTP_OK){c.disconnect();return;}
            BufferedReader br=new BufferedReader(new InputStreamReader(c.getInputStream())); StringBuilder sb=new StringBuilder(); String line; while((line=br.readLine())!=null)sb.append(line); br.close(); c.disconnect();
            JSONObject root=new JSONObject(sb.toString()); JSONArray arr=root.optJSONArray("calls"); if(arr==null)return;
            String newest=after;
            for(int i=0;i<arr.length();i++){JSONObject call=arr.getJSONObject(i);String id=call.optString("callId","");String created=call.optString("createdAt","");if(created.compareTo(newest)>0)newest=created;if(id.isEmpty()||seenCalls.contains(id))continue;seenCalls.add(id);showCallNotification(id,call.optString("groupName","WhatsApp"),call.optString("groupId",""),call.optString("fromName","Someone"),call.optString("type","audio"));}
            if(!newest.isEmpty())getSharedPreferences("wassup",MODE_PRIVATE).edit().putString("lastCallSeenAt",newest).apply();
        } catch(Exception ignored){}
    }

    private void showCallNotification(String callId,String groupName,String groupId,String fromName,String type){
        Intent open=new Intent(this,MainActivity.class); open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP); open.putExtra("groupId",groupId); open.putExtra("incomingCallId",callId);
        int flags=PendingIntent.FLAG_UPDATE_CURRENT; if(Build.VERSION.SDK_INT>=23)flags|=PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending=PendingIntent.getActivity(this,Math.abs(callId.hashCode()),open,flags);
        Notification n=new NotificationCompat.Builder(this,CALL_CHANNEL_ID)
          .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
          .setContentTitle(groupName==null||groupName.trim().isEmpty()?"WhatsApp":groupName)
          .setContentText((type.equals("video")?"📹 ":"📞 ")+fromName+" is calling")
          .setContentIntent(pending).setAutoCancel(true).setOngoing(false).setOnlyAlertOnce(false)
          .setPriority(NotificationCompat.PRIORITY_MAX).setCategory(NotificationCompat.CATEGORY_CALL).setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
          .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)).setVibrate(new long[]{0,500,250,500,250,500}).build();
        NotificationManager nm=(NotificationManager)getSystemService(NOTIFICATION_SERVICE); if(nm!=null&& (Build.VERSION.SDK_INT<24||nm.areNotificationsEnabled()))nm.notify(Math.abs(("call:"+callId).hashCode()),n);
    }

    private void showMessageNotification(String id, String groupName, String groupId, String body) {
        synchronized (seen) {
            if (seen.contains("notified:" + id)) return;
            seen.add("notified:" + id);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (groupId != null && !groupId.isEmpty()) {
            open.putExtra("groupId", groupId);
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;

        PendingIntent pending = PendingIntent.getActivity(
                this, Math.abs(id.hashCode()), open, flags
        );

        String title = groupName == null || groupName.trim().isEmpty()
                ? "WhatsApp" : groupName.trim();

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.wassup.whatsapp.R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(body == null || body.trim().isEmpty() ? "New message" : body.trim())
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .build();

        NotificationManager nm =
                (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) {
            if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return;
            nm.notify(Math.abs(id.hashCode()), n);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        connectRealtimeIfNeeded();
        return START_STICKY;
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        try {
            Intent restart = new Intent(getApplicationContext(), NotificationPollService.class);
            if (Build.VERSION.SDK_INT >= 26) {
                getApplicationContext().startForegroundService(restart);
            } else {
                getApplicationContext().startService(restart);
            }
        } catch (Exception ignored) {}
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy() {
        disconnectRealtime();
        if (executor != null) executor.shutdownNow();
        if (pollWakeLock != null && pollWakeLock.isHeld()) { try { pollWakeLock.release(); } catch (Exception ignored) {} }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
