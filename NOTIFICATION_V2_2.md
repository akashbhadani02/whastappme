# v2.2 PWA group notification

- Chrome-installed PWA uses Web Push as the primary background notification path.
- Notifications are group-only; private-message notifications are not sent.
- A user who has previously joined a group keeps notification authorization after leaving the visible chat.
- Rejoining the group refreshes the same authorization record.
- Server sends push to all active browser subscriptions belonging to users authorized for that group.
- Service worker cache/version is bumped to v27 so stale workers are replaced.
- No Firebase/FCM is used.

Important: Chrome notification permission must be allowed. If the browser/app is force-stopped or notifications are blocked by OS/browser settings, no web-only solution can override that restriction.

## v2.3 locked/background reliability
- PWA push subscription identity is also stored in IndexedDB.
- The service worker renews a rotated PushSubscription in `pushsubscriptionchange`, so a locked/background PWA does not need to be opened just to repair a rotated subscription.
- Service worker push handling accepts both JSON and text payloads.
- The notification path remains Web Push for the PWA and native background service for the Android APK.
