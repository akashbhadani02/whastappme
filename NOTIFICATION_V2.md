# Notification v2.2 — Group-only notifications

- Private-message notification delivery has been removed from native Android and server notification paths.
- Android recovery polling now returns only group messages for groups persisted in `notification_access`.
- Group notification authorization is persistent: leaving the visible chat does not delete `notification_access`, so the user can still receive group notifications while the app is in the background.
- Rejoining a group refreshes/upserts the same notification authorization record.
- Native realtime and web-push group notifications are filtered by the originating group and never notify the sender.
- No Firebase/FCM is used.
