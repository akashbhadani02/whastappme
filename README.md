
## Notification architecture (clean single-path)

- Web/browser notifications use one Web Push + VAPID path through `public/sw.js`. The old direct `new Notification()` fallback is intentionally removed to prevent duplicate or unauthorized notifications.
- Vercel should define `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` (matching pair), and optionally `VAPID_SUBJECT`. The server derives the public key from the private key and warns if the configured public key does not match.
- Group message push recipients come from persistent `notification_access` records created after a successful group-password join. The sender is excluded.
- Android uses a Firebase-free Socket.IO realtime channel with a polling recovery path. Message polling is not blocked by `readBy`, so reading a message on one device does not suppress the notification on another device.
- Incoming calls have a dedicated high-importance Android notification channel with vibration/default notification sound, plus Web Push call alerts. Call alerts are never suppressed just because a browser chat is visible.
- Startup is cache-first: only the lightweight group list is shown immediately. Group history, unread counts, presence, and call state are loaded only after the user opens a password-protected group.


AUDIT/FIX NOTES
- Fixed Android delivery receipt runtime bug (undefined group id).
- Fixed group-scoped message/update/delete/restore/typing events.
- Fixed group-scoped web/native notifications using notification_access.
- Fixed Last Seen persistence per group and final-session disconnect handling.
- Fixed multi-device presence: one remaining session keeps User ID online.
- Fixed read receipts to use authenticated socket User ID and retry after reconnect.
- Explicitly leaving a group removes notification authorization only after the User ID has no remaining active session in that group.
