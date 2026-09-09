# Android APK

This Android build uses the same simple WebView setup as the earlier working notification version.

Build with:

```bash
./gradlew assembleDebug -PAPP_URL=https://your-app.vercel.app/
```

Web Push notifications are handled by the deployed website. The Android wrapper does not replace the website push system with a native polling service.
