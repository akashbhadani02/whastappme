# Notification v2 — Firebase-free background delivery

This version keeps the existing app UI unchanged and improves Android background notification delivery without Firebase/FCM.

## Behavior
- Android runs a foreground notification service after login.
- Socket.IO is the instant path while the service is connected.
- HTTP recovery polling runs about every 1.5 seconds while the service is alive.
- If the app task is swiped away, the service is configured not to stop with the task and schedules a restart alarm as an OEM fallback.
- The service starts again after device boot/app replacement.
- Server polling is recipient-aware: group messages exclude the sender; private messages are returned only when `peerId` equals the logged-in user.
- Notification delivery is deduplicated locally.
- No Firebase/FCM dependency was added.

## Important Android requirement
The user must allow Notifications and, for best reliability on aggressive OEMs, disable battery optimization for the app. If Android Settings force-stops the app, Android itself prevents background execution until the user opens it again; no non-FCM code can bypass that OS rule.
