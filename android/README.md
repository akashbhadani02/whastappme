# Android APK notifications

This build uses a native Android foreground polling service for message notifications. It does not depend on WebView push support.

## Build

You MUST provide the deployed website URL when building the APK:

```bash
./gradlew assembleDebug -PAPP_URL=https://your-app.vercel.app/
```

The app stores only the origin of the loaded URL and polls `/api/notifications/poll` for new messages.

Android 13+ also requires the notification permission to be allowed.
