# WhatsApp Android wrapper - realtime group notifications

The Android wrapper uses a native Socket.IO realtime notification channel as the primary path, with a 2-second HTTP polling fallback. The notification service also checks Android notification permission/channel state and uses a short partial wake lock while polling.

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
This wrapper does not contain Firebase/FCM configuration. Socket.IO + foreground service + polling can deliver while Android keeps the service alive, but an OEM force-stop or a fully killed process can prevent delivery. Guaranteed OS-level background delivery after process death requires FCM and a Firebase project configuration (`google-services.json`).

## Build
Open this `android` folder in Android Studio. Set `APP_URL` in `gradle.properties`
or pass `-PAPP_URL=https://your-domain.example/` when building.

## Android 13+ notification permission
Android 13/API 33+ requires `POST_NOTIFICATIONS`; the app requests it at startup. If the user previously denied notifications, enable notifications for the app in Android Settings.
