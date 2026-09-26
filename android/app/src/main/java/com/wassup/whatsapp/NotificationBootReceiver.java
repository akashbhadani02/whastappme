package com.wassup.whatsapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class NotificationBootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        Intent service = new Intent(context, NotificationPollService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
        else context.startService(service);
    }
}
