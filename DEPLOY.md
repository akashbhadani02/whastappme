# WhatsApp app — MongoDB + Vercel deployment

## 1. GitHub
Upload the contents of this folder to the **root** of the GitHub repository. Do not upload the outer folder as an extra nesting level.

## 2. Vercel
Import/connect the GitHub repository. Keep Root Directory at the repository root. The included `vercel.json` points Vercel at `api/index.js` and routes the app through the Express + Socket.IO server.

## 3. MongoDB
Create a MongoDB Atlas database, then in Vercel go to **Project Settings → Environment Variables** and add:

- `MONGODB_URI` = your MongoDB connection string
- `MONGODB_DB` = `wassup` (optional)

Do not put the real connection string in GitHub, source files, or this ZIP.

After saving the variables, redeploy the project.

## 4. Health check
Open `/api/health`. With MongoDB configured it should return JSON with `mongodb: true`.

## Notes
- Messages and media are stored in MongoDB.
- The app keeps the most recent 100 messages for the chat history sent to a new client.
- Media is currently stored as base64 inside MongoDB. The UI limits individual media files to 8 MB; for a production app, object storage (such as Vercel Blob or S3) is preferable for large media.
- The password in the browser is not a secure authentication mechanism. Use real server-side authentication for production.
