const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Media is uploaded in small chunks, so individual Socket.IO packets stay small.
  maxHttpBufferSize: 1024 * 1024,
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 9999;
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'wassup';
const COLLECTION_NAME = 'messages';
const MEDIA_BUCKET_NAME = 'media';
const EVENTS_COLLECTION_NAME = 'realtime_events';
const GROUP_SETTINGS_COLLECTION_NAME = 'group_settings';
const PUSH_SUBSCRIPTIONS_COLLECTION_NAME = 'push_subscriptions';
const CHATS_COLLECTION_NAME = 'chats';

function getVapidKeys() {
  // Prefer an explicit VAPID private key. If it is not configured, derive a stable
  // server-only key from MONGODB_URI so deployments do not need another secret.
  const privateKey = process.env.VAPID_PRIVATE_KEY || crypto.createHash('sha256').update((MONGODB_URI || 'wassup-push-fallback') + ':vapid').digest().toString('base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  const publicKey = ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
  return { privateKey, publicKey };
}

const vapid = getVapidKeys();
try { webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey); } catch (error) { console.error('VAPID setup failed:', error.message); }

let mongoClientPromise = null;
let dbPromise = null;
let mediaBucket = null;
let realtimeWatchStarted = false;
function hashChatPassword(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password || ''), actualSalt, 120000, 32, 'sha256').toString('hex');
  return { salt: actualSalt, hash };
}
function verifyChatPassword(password, salt, expectedHash) {
  const actual = crypto.pbkdf2Sync(String(password || ''), String(salt), 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(String(expectedHash), 'hex'));
}
async function getChatsCollection() {
  const db = await getDb();
  return db ? db.collection(CHATS_COLLECTION_NAME) : null;
}

function chatQuery(chatId) {
  const id = String(chatId || 'main');
  return ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
}
async function getAuthorizedChat(socket, chatId) {
  const id = String(chatId || 'main');
  if (!socket.authorizedChats || !socket.authorizedChats.has(id)) return false;
  return true;
}


async function getDb() {
  if (!MONGODB_URI) return null;
  if (!mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 8000,
    });
    mongoClientPromise = client.connect().catch((error) => {
      mongoClientPromise = null;
      throw error;
    });
  }
  const client = await mongoClientPromise;
  return client.db(DB_NAME);
}

async function startRealtimeBridge() {
  if (!MONGODB_URI || realtimeWatchStarted) return;
  const db = await getDb();
  if (!db) return;
  realtimeWatchStarted = true;
  const events = db.collection(EVENTS_COLLECTION_NAME);
  try {
    await events.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
  } catch (_) {}

  const stream = events.watch([{ $match: { operationType: 'insert' } }], {
    fullDocument: 'default',
  });
  stream.on('change', (change) => {
    const event = change.fullDocument;
    if (!event || !event.event) return;
    const payload = event.payload;
    const chatId = payload && payload.chatId ? String(payload.chatId) : 'main';
    if (event.event === 'clear-chat') io.to(`chat:${chatId}`).emit('clear-chat', payload || { chatId });
    else if (payload !== undefined) io.to(`chat:${chatId}`).emit(event.event, payload);
  });
  stream.on('error', (error) => {
    console.error('Realtime MongoDB bridge stopped:', error.message);
    realtimeWatchStarted = false;
    try { stream.close(); } catch (_) {}
    setTimeout(() => startRealtimeBridge().catch(() => {}), 1500);
  });
}

async function getCollection() {
  const db = await getDb();
  if (!db) return null;
  mediaBucket = mediaBucket || new GridFSBucket(db, { bucketName: MEDIA_BUCKET_NAME });
  startRealtimeBridge().catch((error) => console.error('Realtime bridge start failed:', error.message));
  return db.collection(COLLECTION_NAME);
}

async function publishRealtimeEvent(event, payload) {
  if (!MONGODB_URI) return;
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection(EVENTS_COLLECTION_NAME).insertOne({
      event,
      payload: payload === undefined ? null : payload,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('Failed to publish realtime event:', error.message);
  }
}

async function getMediaBucket() {
  await getCollection();
  return mediaBucket;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/push/public-key', (req, res) => {
  res.json({ ok: true, publicKey: vapid.publicKey });
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const sub = req.body && req.body.subscription;
    const userId = req.body && String(req.body.userId || '');
    if (!sub || !sub.endpoint || !userId) return res.status(400).json({ ok: false });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false });
    await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION_NAME).updateOne(
      { endpoint: sub.endpoint },
      { $set: { userId, subscription: sub, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Push subscription save failed:', error.message);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.json({ ok: true });
    const db = await getDb();
    if (db) await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION_NAME).deleteOne({ endpoint });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ ok: false }); }
});

app.get('/api/group', async (req, res) => {
  try {
    const collection = await getGroupSettingsCollection();
    const doc = await collection.findOne({ _id: 'main' });
    res.json({ ok: true, name: doc?.name || 'WhatsApp' });
  } catch (error) {
    console.error('Failed to load group name:', error.message);
    res.json({ ok: true, name: 'WhatsApp' });
  }
});

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

async function loadMessages(after, chatId = 'main') {
  const collection = await getCollection();
  if (!collection) return [];
  const requestedChatId = String(chatId || 'main');
  const query = requestedChatId === 'main' ? { $or: [{ chatId: 'main' }, { chatId: { $exists: false } }] } : { chatId: requestedChatId };
  if (after) query.createdAt = { $gte: new Date(after) };
  return collection.find(query, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
}

app.get('/api/chats', async (req, res) => {
  try {
    const chats = await getChatsCollection();
    if (!chats) return res.json({ ok: true, chats: [{ id: 'main', name: 'WhatsApp' }] });
    const rows = await chats.find({}, { projection: { _id: 1, name: 1 } }).sort({ createdAt: 1 }).toArray();
    res.json({ ok: true, chats: rows.map(c => ({ id: String(c._id), name: c.name })) });
  } catch (error) {
    console.error('Failed to load chats:', error.message);
    res.status(500).json({ ok: false, chats: [] });
  }
});


app.get('/api/chat-passwords', async (req, res) => {
  try {
    const chats = await getChatsCollection();
    if (!chats) return res.json({ ok: true, chats: [{ id: 'main', name: 'WhatsApp', password: 'kmkm' }] });
    const rows = await chats.find({}, { projection: { _id: 1, name: 1, passwordPlain: 1 } }).sort({ createdAt: 1 }).toArray();
    res.json({ ok: true, chats: rows.map(c => ({ id: String(c._id), name: c.name, password: c.passwordPlain || '' })) });
  } catch (error) {
    console.error('Failed to load chat passwords:', error.message);
    res.status(500).json({ ok: false, chats: [] });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const after = typeof req.query.after === 'string' && req.query.after ? req.query.after : '';
    const chatId = typeof req.query.chatId === 'string' && req.query.chatId ? req.query.chatId : 'main';
    const password = typeof req.headers['x-chat-password'] === 'string' ? req.headers['x-chat-password'] : '';
    const chats = await getChatsCollection();
    if (chats) {
      const chat = await chats.findOne(chatQuery(chatId));
      if (!chat || !verifyChatPassword(password, chat.passwordSalt, chat.passwordHash)) return res.status(403).json({ ok: false, messages: [] });
    }
    const messages = await loadMessages(after, chatId);
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

async function sendPushToOtherUsers(msg) {
  if (!MONGODB_URI || !msg || !msg.id) return;
  try {
    const db = await getDb();
    if (!db) return;
    const docs = await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION_NAME).find({ userId: { $ne: String(msg.userId || '') } }).toArray();
    if (!docs.length) return;
    const body = msg.message || (msg.type === 'image' ? '📷 Photo' : msg.type === 'video' ? '🎥 Video' : 'New message');
    const payload = JSON.stringify({
      title: msg.groupName || 'WhatsApp',
      body: `${msg.user || 'New message'}: ${body}`,
      messageId: msg.id,
      url: '/#chat'
    });
    await Promise.all(docs.map(async (doc) => {
      try {
        await webpush.sendNotification(doc.subscription, payload, { TTL: 120, urgency: 'high' });
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION_NAME).deleteOne({ _id: doc._id });
        }
      }
    }));
  } catch (error) {
    console.error('Web push failed:', error.message);
  }
}

async function broadcastSaved(event, msg) {
  const saved = await saveMessage(msg);
  const room = `chat:${String(saved.chatId || 'main')}`;
  io.to(room).emit(event, saved);
  publishRealtimeEvent(event, saved);
  if (event === 'message' || event === 'media') sendPushToOtherUsers(saved);
  return saved;
}

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);
  const uploads = new Map();

  socket.on('register-user', (data) => {
    socket.userId = data && data.userId ? String(data.userId) : '';
  });

  socket.authorizedChats = new Set();

  socket.on('join-chat', async (data, ack) => {
    const chatId = String(data?.chatId || 'main');
    const password = String(data?.password || '');
    try {
      const chats = await getChatsCollection();
      let chat = chats ? await chats.findOne(chatQuery(chatId)) : null;
      if (!chat && chatId === 'main' && !chats) chat = { _id: 'main', name: 'WhatsApp' };
      if (!chat) return typeof ack === 'function' && ack({ ok: false, error: 'Chat not found' });
      if (chats && !verifyChatPassword(password, chat.passwordSalt, chat.passwordHash)) return typeof ack === 'function' && ack({ ok: false, error: 'Wrong password' });
      socket.join(`chat:${chatId}`);
      socket.authorizedChats.add(chatId);
      const history = await loadMessages('', chatId);
      socket.emit('history', { chatId, messages: history });
      if (typeof ack === 'function') ack({ ok: true, chat: { id: chatId, name: chat.name } });
    } catch (error) {
      console.error('Join chat failed:', error.message);
      if (typeof ack === 'function') ack({ ok: false, error: 'Unable to open chat' });
    }
  });

  socket.on('delete-chat', async (data, ack) => {
    const chatId = String(data?.chatId || '');
    if (!chatId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Chat id is required' });
      return;
    }
    if (!(await getAuthorizedChat(socket, chatId))) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Chat password required' });
      return;
    }
    try {
      const chats = await getChatsCollection();
      const collection = await getCollection();
      if (!chats) {
        if (typeof ack === 'function') ack({ ok: false, error: 'MongoDB is required' });
        return;
      }
      const chat = await chats.findOne(chatQuery(chatId));
      if (!chat) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Chat not found' });
        return;
      }

      // Remove all persisted messages/media belonging to this chat first.
      // The original/default chat may contain legacy messages without chatId.
      const chatMessageQuery = chatId === 'main'
        ? { $or: [{ chatId: 'main' }, { chatId: { $exists: false } }] }
        : { chatId };
      if (collection) {
        const mediaMessages = await collection.find(
          { ...chatMessageQuery, mediaId: { $exists: true } },
          { projection: { mediaId: 1 } }
        ).toArray();
        await collection.deleteMany(chatMessageQuery);
        let bucket = null;
        try { bucket = await getMediaBucket(); } catch (_) {}
        if (bucket) {
          for (const item of mediaMessages) {
            try { await bucket.delete(new ObjectId(item.mediaId)); } catch (_) {}
          }
        }
      }

      await chats.deleteOne({ _id: chatId });

      const deleted = { chatId, name: String(chat.name || 'Chat') };
      io.emit('chat-deleted', deleted);
      await publishRealtimeEvent('chat-deleted', deleted);

      if (typeof ack === 'function') ack({ ok: true, chat: deleted });
    } catch (error) {
      console.error('Delete chat failed:', error.message);
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not delete chat' });
    }
  });

  socket.on('create-chat', async (data, ack) => {
    const name = String(data?.name || '').trim().slice(0, 60);
    const password = String(data?.password || '');
    if (!name || password.length < 1) return typeof ack === 'function' && ack({ ok: false, error: 'Name and password are required' });
    try {
      const chats = await getChatsCollection();
      if (!chats) return typeof ack === 'function' && ack({ ok: false, error: 'MongoDB is required' });
      const chatId = crypto.randomUUID();
      const hp = hashChatPassword(password);
      await chats.insertOne({ _id: chatId, name, passwordHash: hp.hash, passwordSalt: hp.salt, passwordPlain: password, createdAt: new Date() });
      const chat = { id: chatId, name };
      io.emit('chat-created', chat);
      await publishRealtimeEvent('chat-created', chat);
      socket.join(`chat:${chatId}`);
      socket.authorizedChats.add(chatId);
      socket.emit('history', { chatId, messages: [] });
      if (typeof ack === 'function') ack({ ok: true, chat });
    } catch (error) {
      console.error('Create chat failed:', error.message);
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not create chat' });
    }
  });


  socket.on('message', async (msg, ack) => {
    if (!msg || !msg.message || !msg.id || !(await getAuthorizedChat(socket, msg.chatId))) return;
    msg.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    msg.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
    try {
      msg.chatId = String(msg.chatId || 'main');
      const saved = await broadcastSaved('message', msg);
      if (typeof ack === 'function') ack({ ok: true, message: saved });
    } catch (error) {
      console.error('Failed to save message:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('media-start', async (meta, ack) => {
    try {
      if (!meta || !meta.uploadId || !meta.name || !meta.mime || !meta.type || !(await getAuthorizedChat(socket, meta.chatId))) {
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
        type: meta.type, chatId: String(meta.chatId || 'main'), mime: meta.mime, mediaId: String(upload.fileId),
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

  socket.on('rename-group', async (data, ack) => {
    const nextName = String(data?.name || '').trim().slice(0, 60);
    if (!nextName) { if (typeof ack === 'function') ack({ ok: false }); return; }
    try {
      const chatId = String(data?.chatId || 'main');
      if (!(await getAuthorizedChat(socket, chatId))) return typeof ack === 'function' && ack({ ok: false });
      const chats = await getChatsCollection();
      if (chats) await chats.updateOne({ _id: chatId }, { $set: { name: nextName, updatedAt: new Date() } });
      const collection = await getGroupSettingsCollection();
      await collection.updateOne({ _id: 'main' }, { $set: { name: nextName, updatedAt: new Date() } }, { upsert: true });
      const event = { chatId, name: nextName };
      io.to(`chat:${chatId}`).emit('group-renamed', event);
      await publishRealtimeEvent('group-renamed', event);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      console.error('Group rename failed:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('rename-user', (data, ack) => {
    if (!data || !data.userId || !data.name) return;
    const nextName = String(data.name).trim().slice(0, 40);
    if (!nextName) return;

    // Do not block the Socket.IO connection while updating old messages.
    // Broadcast the new name immediately so chat messaging continues normally.
    const renameEvent = { userId: data.userId, name: nextName };
    io.emit('user-renamed', renameEvent);
    publishRealtimeEvent('user-renamed', renameEvent);
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

  socket.on('delete-message', async (data, ack) => {
    if (!data || !data.id) return;
    const deleteEvent = { id: data.id, chatId: String(data.chatId || 'main') };
    if (!(await getAuthorizedChat(socket, deleteEvent.chatId))) return;
    try {
      const collection = await getCollection();
      if (collection) {
        const existing = await collection.findOne({ id: data.id, chatId: deleteEvent.chatId });
        await collection.deleteOne({ id: data.id, chatId: deleteEvent.chatId });
        if (existing && existing.mediaId) {
          try { await (await getMediaBucket()).delete(new ObjectId(existing.mediaId)); } catch (_) {}
        }
      }
      // Persist first, then broadcast. This prevents another Vercel instance's
      // reconciliation request from briefly re-adding a just-deleted message.
      io.to(`chat:${deleteEvent.chatId}`).emit('delete-message', deleteEvent);
      publishRealtimeEvent('delete-message', deleteEvent);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      console.error('Failed to delete message:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('message-read', async (data) => {
    if (!data || !data.id || !data.userId) return;
    const chatId = String(data.chatId || 'main');
    if (!(await getAuthorizedChat(socket, chatId))) return;
    const readerId = String(data.userId);
    try {
      const collection = await getCollection();
      if (collection) {
        await collection.updateOne(
          { id: data.id, chatId },
          { $addToSet: { readBy: readerId } }
        );
      }
    } catch (error) {
      console.error('Failed to save read receipt:', error.message);
    }
    const readEvent = { id: data.id, userId: readerId, chatId };
    io.to(`chat:${chatId}`).emit('message-read', readEvent);
    publishRealtimeEvent('message-read', readEvent);
  });

  socket.on('message-delivered', async (data) => {
    if (!data || !data.id || !socket.userId) return;
    const chatId = String(data.chatId || 'main');
    if (!(await getAuthorizedChat(socket, chatId))) return;
    const receiverId = String(socket.userId);
    try {
      const collection = await getCollection();
      if (collection) {
        await collection.updateOne({ id: data.id, chatId }, { $addToSet: { deliveredTo: receiverId } });
      }
    } catch (error) {
      console.error('Failed to save delivery receipt:', error.message);
    }
    const deliveredEvent = { id: data.id, userId: receiverId, chatId };
    io.to(`chat:${chatId}`).emit('message-delivered', deliveredEvent);
    publishRealtimeEvent('message-delivered', deliveredEvent);
  });

  socket.on('clear-chat', async (data) => {
    const chatId = String(data?.chatId || 'main');
    if (!(await getAuthorizedChat(socket, chatId))) return;
    try {
      const collection = await getCollection();
      if (collection) {
        const mediaMessages = await collection.find({ chatId, mediaId: { $exists: true } }, { projection: { mediaId: 1 } }).toArray();
        await collection.deleteMany({ chatId });
        const bucket = await getMediaBucket();
        for (const item of mediaMessages) {
          try { await bucket.delete(new ObjectId(item.mediaId)); } catch (_) {}
        }
      }
      // Persist first, then broadcast so every instance is immediately consistent.
      io.to(`chat:${chatId}`).emit('clear-chat', { chatId });
      publishRealtimeEvent('clear-chat', { chatId });
    } catch (error) {
      console.error('Failed to clear chat:', error.message);
    }
  });

  socket.on('disconnect', (reason) => {
    for (const upload of uploads.values()) { try { upload.stream.destroy(); } catch (_) {} }
    uploads.clear();
    console.log('User disconnected:', socket.id, reason);
  });
});

if (!process.env.VERCEL) {
  httpServer.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = httpServer;
