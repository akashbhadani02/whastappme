# WhatsApp Android wrapper - realtime group notifications

The Android wrapper now uses a native Socket.IO realtime notification channel as
the primary notification path, with HTTP polling retained as a recovery fallback.

## Notification behavior
- Group member messages trigger a native Android notification immediately when the
  app's background notification service has a live connection.
- Notifications show the group name and "New message"; message text is not exposed.
- The sender's own messages do not trigger a notification.
- Only groups the User ID has previously joined are eligible.
- Android 13+ requires POST_NOTIFICATIONS permission.
- The foreground service requests battery-optimization exemption to improve
  reliability on Android devices that aggressively stop background work.
- The service reconnects automatically after network interruptions, app task
  removal, reboot, or package replacement.
- HTTP polling remains enabled as a fallback if realtime Socket.IO is temporarily
  unavailable.

## Important Android limitation
This is a native realtime Socket.IO channel, not Firebase Cloud Messaging. It can
deliver instantly while Android keeps the foreground service alive. Some OEMs can
still force-stop background services or disable network activity. For guaranteed
OS-level delivery even after the app process is killed, integrate FCM with a
Firebase project.

## Build
Open this `android` folder in Android Studio. Set `APP_URL` in `gradle.properties`
or pass `-PAPP_URL=https://your-domain.example/` when building.
