# Notification fixes (v1.5)

- Android notification channel version bumped to v8 so users get a fresh channel configuration.
- Native private-message notifications now pass the recipient chat ID into the notification tap intent.
- Notifications display the sender/group title, a generic “New message” preview, sound/vibration defaults, and an unread badge count.
- Existing Socket.IO realtime delivery and HTTP recovery polling remain enabled.

Android version: 1.5 (versionCode 6). Build and install a new APK for these native changes.


## v1.7 notification reliability
- Android native recovery polling reduced from 2 seconds to 1 second.
- HTTP timeouts tightened so a slow request cannot block the next recovery cycle for long.
- Android notification client sends an explicit native-client header for diagnostics.
- Android version bumped to 1.7 / versionCode 8.
- Web Push service-worker cache/version bumped so stale notification workers are replaced.


## Instant notification delivery
- Socket.IO/native realtime and Web Push are the primary notification paths.
- Browser polling is recovery-only (30 seconds) and is not used for normal instant delivery.
- Web Push uses high urgency with a short TTL (60 seconds) so queued alerts do not become stale.
- Android native realtime reconnect is aggressive; HTTP polling remains a 10-second recovery path only.
