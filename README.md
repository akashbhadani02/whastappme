
AUDIT/FIX NOTES
- Fixed Android delivery receipt runtime bug (undefined group id).
- Fixed group-scoped message/update/delete/restore/typing events.
- Fixed group-scoped web/native notifications using notification_access.
- Fixed Last Seen persistence per group and final-session disconnect handling.
- Fixed multi-device presence: one remaining session keeps User ID online.
- Fixed read receipts to use authenticated socket User ID and retry after reconnect.
- Explicitly leaving a group removes notification authorization only after the User ID has no remaining active session in that group.

- v2.2: notifications are group-only; private message notifications removed. Group notification access persists after leaving the visible group chat and is refreshed on rejoin.
