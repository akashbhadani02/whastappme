# Notification + Online/Offline Fix v2.4

- Private-message notification polling now includes the sender user ID, so Android notification taps can open the correct private chat.
- Group native notification eligibility is now scoped to the exact group instead of every group the user has ever joined.
- Android notification service remains START_STICKY and reconnects Socket.IO while HTTP polling remains the recovery path.
- App-level group presence heartbeat remains 3 seconds; server stale timeout remains 20 seconds, so suspended/disconnected group sessions are removed from online presence.
- Android project version bumped to 1.6 / versionCode 7.
- No APK/AAB is included; the source is ready to build a fresh APK.
