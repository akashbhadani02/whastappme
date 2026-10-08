# WhatsApp-style realtime fixes

- Group messages: sender can delete their own message for everyone; deletion is persisted in MongoDB and broadcast only to that exact group.
- Private messages: sender can delete their own message for everyone; deletion is persisted and broadcast to both participants.
- Removed the old hard-coded delete password from client delete requests.
- Multiple-message delete only deletes messages owned by the current user.
- Online/offline presence now treats stale heartbeats as offline and pushes offline state to personal-chat viewers.
- Existing group-scoped Socket.IO presence and last-seen behavior is preserved.
