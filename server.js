const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 10 * 1024 * 1024,
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', async (req, res) => {
  try {
    const collection = await getCollection();
    if (!collection) return res.json({ ok: true, mongodb: false, message: 'Set MONGODB_URI to enable persistence.' });
    await collection.findOne({}, { projection: { _id: 1 } });
    res.json({ ok: true, mongodb: true });
  } catch (error) {
    console.error('MongoDB health check failed:', error.message);
    res.status(500).json({ ok: false, mongodb: false });
  }
});

async function loadRecentMessages() {
  const collection = await getCollection();
  if (!collection) return [];
  return collection
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray()
    .then((rows) => rows.reverse());
}

async function saveMessage(msg) {
  const collection = await getCollection();
  if (!collection) return;
  await collection.updateOne(
    { id: msg.id },
    { $setOnInsert: { ...msg, createdAt: new Date() } },
    { upsert: true }
  );
}

io.on('connection', async (socket) => {
  console.log('New User Connected...', socket.id);

  try {
    const history = await loadRecentMessages();
    socket.emit('history', history);
  } catch (error) {
    console.error('Failed to load MongoDB history:', error.message);
    socket.emit('history', []);
  }

  socket.on('message', async (msg) => {
    if (!msg || !msg.message || !msg.id) return;
    try {
      await saveMessage(msg);
    } catch (error) {
      console.error('Failed to save message:', error.message);
    }
    socket.broadcast.emit('message', msg);
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
    socket.broadcast.emit('user-renamed', { userId: data.userId, name: nextName });
  });

  socket.on('media', async (msg) => {
    if (!msg || !msg.data || !msg.type || !msg.id) return;
    try {
      await saveMessage(msg);
    } catch (error) {
      console.error('Failed to save media:', error.message);
    }
    socket.broadcast.emit('media', msg);
  });

  socket.on('delete-message', async (data) => {
    if (!data || !data.id) return;
    try {
      const collection = await getCollection();
      if (collection) await collection.deleteOne({ id: data.id });
    } catch (error) {
      console.error('Failed to delete message:', error.message);
    }
    socket.broadcast.emit('delete-message', { id: data.id });
  });

  socket.on('clear-chat', async () => {
    try {
      const collection = await getCollection();
      if (collection) await collection.deleteMany({});
    } catch (error) {
      console.error('Failed to clear chat:', error.message);
    }
    socket.broadcast.emit('clear-chat');
  });

  socket.on('disconnect', () => console.log('User disconnected', socket.id));
});

if (!process.env.VERCEL) {
  httpServer.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = httpServer;
