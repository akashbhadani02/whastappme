# WhatsApp Android APK

This is an Android WebView wrapper for the Wassup/WhatsApp-style web app.

## Build
1. Open this `android` folder in Android Studio.
2. In `gradle.properties`, replace `APP_URL` with your deployed Vercel URL.
3. Build > Build APK(s).
4. Rename the generated APK to `whatsapp.apk`.
5. Copy `whatsapp.apk` into `public/` and deploy the web app. The Menu > Install WhatsApp shortcut will then open the APK on Android.

Note: Android/browser security still requires the user to confirm installation and, depending on device settings, allow installs from the browser.
