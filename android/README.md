# WhatsApp Android wrapper - Firebase-free notifications

This Android wrapper uses a native foreground notification service and the app's existing server API. It does NOT require Firebase/FCM.

## Notification behavior
- The service checks for unread messages about every 2 seconds while Android permits the foreground service to run.
- Only groups that the User ID has successfully joined are eligible for notifications.
- The notification shows the real group name when available.
- The sender does not receive a notification for their own message.
- Android 13+ requires notification permission.

## Important Android limitation
Without FCM (or another OS push provider), Android cannot guarantee an instant wake-up when the process/service is stopped or the device applies aggressive battery/background restrictions. This is a near-realtime, Firebase-free solution. For guaranteed OS-level push delivery, FCM or another push provider is required.

## Build
Open this `android` folder in Android Studio. Set `APP_URL` in `gradle.properties` or pass `-PAPP_URL=https://your-domain.example/` when building.
