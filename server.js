const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 12 * 1024 * 1024,
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 9999;
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'wassup';
const COLLECTION_NAME = 'messages';

let mongoClientPromise = null;

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
  return client.db(DB_NAME).collection(COLLECTION_NAME);
}

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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

  try {
    const history = await loadMessages('');
    socket.emit('history', history);
  } catch (error) {
    console.error('Failed to load message history:', error.message);
    socket.emit('history', []);
  }

  socket.on('message', async (msg, ack) => {
    if (!msg || !msg.message || !msg.id) return;
    try {
      const saved = await broadcastSaved('message', msg);
      if (typeof ack === 'function') ack({ ok: true, message: saved });
    } catch (error) {
      console.error('Failed to save message:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('media', async (msg, ack) => {
    if (!msg || !msg.data || !msg.type || !msg.id) return;
    try {
      const saved = await broadcastSaved('media', msg);
      if (typeof ack === 'function') ack({ ok: true, message: saved });
    } catch (error) {
      console.error('Failed to save media:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('rename-user', async (data) => {
    if (!data || !data.userId || !data.name) return;
    const nextName = String(data.name).trim().slice(0, 40);
    if (!nextName) return;
    try {
      const collection = await getCollection();
      if (collection) await collection.updateMany({ userId: data.userId }, { $set: { user: nextName } });
    } catch (error) {
      console.error('Failed to rename user in MongoDB:', error.message);
    }
    io.emit('user-renamed', { userId: data.userId, name: nextName });
  });

  socket.on('delete-message', async (data) => {
    if (!data || !data.id) return;
    try {
      const collection = await getCollection();
      if (collection) await collection.deleteOne({ id: data.id });
      io.emit('delete-message', { id: data.id });
    } catch (error) {
      console.error('Failed to delete message:', error.message);
    }
  });

  socket.on('clear-chat', async () => {
    try {
      const collection = await getCollection();
      if (collection) await collection.deleteMany({});
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
