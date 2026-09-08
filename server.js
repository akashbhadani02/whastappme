const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Media is uploaded in small chunks, so individual Socket.IO packets stay small.
  maxHttpBufferSize: 2 * 1024 * 1024,
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 9999;
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'wassup';
const COLLECTION_NAME = 'messages';
const MEDIA_BUCKET_NAME = 'media';

let mongoClientPromise = null;
let dbPromise = null;
let mediaBucket = null;

async function getCollection() {
  if (!MONGODB_URI) return null;
  if (!mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    });
    mongoClientPromise = client.connect().catch((error) => {
      mongoClientPromise = null;
      throw error;
    });
  }
  const client = await mongoClientPromise;
  const db = client.db(DB_NAME);
  mediaBucket = mediaBucket || new GridFSBucket(db, { bucketName: MEDIA_BUCKET_NAME });
  return db.collection(COLLECTION_NAME);
}

async function getMediaBucket() {
  await getCollection();
  return mediaBucket;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/media/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).end();
    const bucket = await getMediaBucket();
    const fileId = new ObjectId(req.params.id);
    const files = await bucket.find({ _id: fileId }).toArray();
    if (!files.length) return res.status(404).end();
    const file = files[0];
    res.setHeader('Content-Type', file.metadata?.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    bucket.openDownloadStream(fileId).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    console.error('Failed to stream media:', error.message);
    res.status(404).end();
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const collection = await getCollection();
    if (!collection) return res.json({ ok: true, mongodb: false, realtime: true, message: 'Set MONGODB_URI to enable persistence.' });
    await collection.findOne({}, { projection: { _id: 1 } });
    res.json({ ok: true, mongodb: true, realtime: true });
  } catch (error) {
    console.error('MongoDB health check failed:', error.message);
    res.status(500).json({ ok: false, mongodb: false, realtime: true });
  }
});

async function loadMessages(after) {
  const collection = await getCollection();
  if (!collection) return [];
  const query = after ? { createdAt: { $gte: new Date(after) } } : {};
  return collection
    .find(query, { projection: { _id: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
}

app.get('/api/messages', async (req, res) => {
  try {
    const after = typeof req.query.after === 'string' && req.query.after ? req.query.after : '';
    const messages = await loadMessages(after);
    res.json({ ok: true, messages });
  } catch (error) {
    console.error('Failed to load messages:', error.message);
    res.status(500).json({ ok: false, messages: [] });
  }
});

async function saveMessage(msg) {
  const collection = await getCollection();
  if (!collection) return { ...msg, createdAt: msg.createdAt || new Date().toISOString() };

  const createdAt = msg.createdAt ? new Date(msg.createdAt) : new Date();
  const saved = { ...msg, createdAt };
  await collection.updateOne({ id: msg.id }, { $setOnInsert: saved }, { upsert: true });
  return saved;
}

async function broadcastSaved(event, msg) {
  const saved = await saveMessage(msg);
  io.emit(event, saved);
  return saved;
}

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);
  const uploads = new Map();

  socket.on('register-user', (data) => {
    socket.userId = data && data.userId ? String(data.userId) : '';
  });

  try {
    const history = await loadMessages('');
    socket.emit('history', history);
  } catch (error) {
    console.error('Failed to load message history:', error.message);
    socket.emit('history', []);
  }

  socket.on('message', async (msg, ack) => {
    if (!msg || !msg.message || !msg.id) return;
    msg.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    msg.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
    try {
      const saved = await broadcastSaved('message', msg);
      if (typeof ack === 'function') ack({ ok: true, message: saved });
    } catch (error) {
      console.error('Failed to save message:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('media-start', async (meta, ack) => {
    try {
      if (!meta || !meta.uploadId || !meta.name || !meta.mime || !meta.type) {
        return typeof ack === 'function' && ack({ ok: false, error: 'Invalid upload' });
      }
      const bucket = await getMediaBucket();
      const stream = bucket.openUploadStream(meta.name, {
        contentType: meta.mime,
        metadata: { mime: meta.mime, type: meta.type, userId: String(meta.userId || '') },
      });
      uploads.set(String(meta.uploadId), { stream, fileId: stream.id, meta });
      stream.on('error', (error) => {
        console.error('Media upload failed:', error.message);
        uploads.delete(String(meta.uploadId));
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      console.error('Media upload start failed:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('media-chunk', async (data, ack) => {
    const upload = data && uploads.get(String(data.uploadId));
    if (!upload || !data.chunk) return typeof ack === 'function' && ack({ ok: false });
    try {
      const buffer = Buffer.from(data.chunk);
      if (buffer.length > 1536 * 1024) throw new Error('Chunk too large');
      const ok = upload.stream.write(buffer);
      if (!ok) await new Promise(resolve => upload.stream.once('drain', resolve));
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      console.error('Media chunk failed:', error.message);
      try { upload.stream.destroy(error); } catch (_) {}
      uploads.delete(String(data.uploadId));
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('media-end', async (data, ack) => {
    const upload = data && uploads.get(String(data.uploadId));
    if (!upload) return typeof ack === 'function' && ack({ ok: false });
    try {
      await new Promise((resolve, reject) => {
        upload.stream.once('finish', resolve);
        upload.stream.once('error', reject);
        upload.stream.end();
      });
      uploads.delete(String(data.uploadId));
      const meta = upload.meta;
      const msg = {
        id: meta.id, senderId: meta.senderId, userId: meta.userId, user: meta.user,
        type: meta.type, mime: meta.mime, mediaId: String(upload.fileId),
        fileName: meta.name, fileSize: Number(meta.size || 0), time: meta.time,
        createdAt: meta.createdAt || new Date().toISOString(), deliveredTo: [], readBy: []
      };
      const saved = await broadcastSaved('media', msg);
      if (typeof ack === 'function') ack({ ok: true, message: saved });
    } catch (error) {
      console.error('Media upload finalize failed:', error.message);
      uploads.delete(String(data.uploadId));
      try { await (await getMediaBucket()).delete(upload.fileId); } catch (_) {}
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('rename-user', (data, ack) => {
    if (!data || !data.userId || !data.name) return;
    const nextName = String(data.name).trim().slice(0, 40);
    if (!nextName) return;

    // Do not block the Socket.IO connection while updating old messages.
    // Broadcast the new name immediately so chat messaging continues normally.
    io.emit('user-renamed', { userId: data.userId, name: nextName });
    if (typeof ack === 'function') ack({ ok: true });

    // Persist the rename in the background.
    getCollection()
      .then(async (collection) => {
        if (!collection) return;
        return collection.updateMany(
          { userId: data.userId },
          { $set: { user: nextName } }
        );
      })
      .catch((error) => {
        console.error('Failed to rename user in MongoDB:', error.message);
      });
  });

  socket.on('delete-message', (data, ack) => {
    if (!data || !data.id) return;

    // Remove it from every open client immediately; do not wait for MongoDB.
    io.emit('delete-message', { id: data.id });
    if (typeof ack === 'function') ack({ ok: true });

    // Persist the deletion in the background.
    getCollection()
      .then(async (collection) => {
        if (!collection) return;
        const existing = await collection.findOne({ id: data.id });
        const result = await collection.deleteOne({ id: data.id });
        if (existing && existing.mediaId) {
          try { await (await getMediaBucket()).delete(new ObjectId(existing.mediaId)); } catch (_) {}
        }
        return result;
      })
      .catch((error) => {
        console.error('Failed to delete message:', error.message);
      });
  });

  socket.on('message-read', async (data) => {
    if (!data || !data.id || !data.userId) return;
    const readerId = String(data.userId);
    try {
      const collection = await getCollection();
      if (collection) {
        await collection.updateOne(
          { id: data.id },
          { $addToSet: { readBy: readerId } }
        );
      }
    } catch (error) {
      console.error('Failed to save read receipt:', error.message);
    }
    io.emit('message-read', { id: data.id, userId: readerId });
  });

  socket.on('message-delivered', async (data) => {
    if (!data || !data.id || !socket.userId) return;
    const receiverId = String(socket.userId);
    try {
      const collection = await getCollection();
      if (collection) {
        await collection.updateOne({ id: data.id }, { $addToSet: { deliveredTo: receiverId } });
      }
    } catch (error) {
      console.error('Failed to save delivery receipt:', error.message);
    }
    io.emit('message-delivered', { id: data.id, userId: receiverId });
  });

  socket.on('clear-chat', async () => {
    try {
      const collection = await getCollection();
      if (collection) {
        const mediaMessages = await collection.find({ mediaId: { $exists: true } }, { projection: { mediaId: 1 } }).toArray();
        await collection.deleteMany({});
        const bucket = await getMediaBucket();
        for (const item of mediaMessages) {
          try { await bucket.delete(new ObjectId(item.mediaId)); } catch (_) {}
        }
      }
      io.emit('clear-chat');
    } catch (error) {
      console.error('Failed to clear chat:', error.message);
    }
  });

  socket.on('disconnect', (reason) => console.log('User disconnected:', socket.id, reason));
});

if (!process.env.VERCEL) {
  httpServer.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = httpServer;
