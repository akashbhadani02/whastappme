# WhatsApp app — MongoDB + Vercel deployment

## Notifications on mobile

Mobile notifications need **Web Push**, not only `new Notification()` from the page. This build registers a Service Worker and stores each phone/browser push subscription in MongoDB.

### Required

1. Deploy the app over **HTTPS** (Vercel provides HTTPS).
2. Keep `MONGODB_URI` configured because push subscriptions are stored in MongoDB.
3. On the phone, open the deployed site in Chrome/Edge/Safari.
4. Allow notifications when prompted.
5. For **iPhone/iPad**, add the site to the Home Screen and open it as the installed web app before enabling notifications. iOS web push requires an installed Home Screen web app.

### VAPID

The server derives a stable VAPID key from `MONGODB_URI`, so no extra VAPID secret is required for this project. If you want an explicit VAPID private key, set `VAPID_PRIVATE_KEY` and optionally `VAPID_SUBJECT` in Vercel Environment Variables.

## GitHub

Upload the contents of this folder to the **root** of the GitHub repository. Do not upload the outer folder as an extra nesting level.

## Vercel

Import/connect the GitHub repository. Keep Root Directory at the repository root. The included `vercel.json` points Vercel at `api/index.js` and routes the app through the Express + Socket.IO server.

## MongoDB

In Vercel → Project Settings → Environment Variables add:

- `MONGODB_URI` = your MongoDB connection string
- `MONGODB_DB` = `wassup` (optional)

Do not put the real connection string in GitHub, source files, or this ZIP.

After saving variables, redeploy the project.

## Notification behavior

- A new text/photo/video message sends a Web Push notification to subscribed users other than the sender.
- Notification delivery works when the mobile browser/PWA is in the background or the app is not currently open, subject to browser/OS notification settings.
- Clicking the notification opens the chat.
- Invalid/expired subscriptions are removed automatically.


### Notification behavior
- The sender is excluded by the exact registered `userId` on the push subscription.
- Other subscribed users receive one push per message.
- If the recipient already has the chat open and visible, the service worker suppresses the notification.

## Recycle-bin flow
Normal message/image/video/audio/document deletions are first kept in the group's Recycle Bin. From a group's Recycle Bin, an admin can use **Move to Main Recycle**. Once moved, the item appears in **Main Recycle Bin**. Only the Main Recycle Bin's **Delete permanently** action removes the recycle record, the soft-deleted message, and its stored media permanently. Group deletion archives its remaining messages directly to Main Recycle Bin.
