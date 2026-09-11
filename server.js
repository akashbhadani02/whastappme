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
const MEDIA_CHUNKS_BUCKET_NAME = 'media_chunks';
const EVENTS_COLLECTION_NAME = 'realtime_events';
const GROUP_SETTINGS_COLLECTION_NAME = 'group_settings';
const PUSH_SUBSCRIPTIONS_COLLECTION_NAME = 'push_subscriptions';
const MEDIA_UPLOADS_COLLECTION_NAME = 'media_uploads';
const CALL_EVENTS_COLLECTION_NAME = 'call_events';
const RECYCLE_BIN_COLLECTION_NAME = 'recycle_bin';
const MAX_MEDIA_CHUNK = 768 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'deoxy';
const DOWNLOAD_PASSWORD = process.env.DOWNLOAD_PASSWORD || 'kmkm';
const DEFAULT_GROUP_ID = 'main';
// In-memory fallback keeps group/password management working even when MongoDB
// is not configured. MongoDB is still used automatically when MONGODB_URI exists.
const fallbackGroups = new Map([[DEFAULT_GROUP_ID, { _id: DEFAULT_GROUP_ID, name: 'WhatsApp', password: ADMIN_PASSWORD, createdAt: new Date() }]]);

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
let mediaChunksBucket = null;
let realtimeWatchStarted = false;

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
    if (event.event === 'clear-chat') io.emit('clear-chat', payload || {});
    else if (payload !== undefined) io.emit(event.event, payload);
  });
  stream.on('error', (error) => {
    console.error('Realtime MongoDB bridge stopped:', error.message);
    realtimeWatchStarted = false;
    try { stream.close(); } catch (_) {}
    setTimeout(() => startRealtimeBridge().catch(() => {}), 1500);
  });
}

async function getGroupSettingsCollection() {
  const db = await getDb();
  if (!db) return null;
  return db.collection(GROUP_SETTINGS_COLLECTION_NAME);
}

function normalizeGroupId(value) {
  const id = String(value || DEFAULT_GROUP_ID).trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : DEFAULT_GROUP_ID;
}

async function ensureDefaultGroup() {
  const collection = await getGroupSettingsCollection();
  if (!collection) return { _id: DEFAULT_GROUP_ID, name: 'WhatsApp', password: ADMIN_PASSWORD };
  await collection.updateOne(
    { _id: DEFAULT_GROUP_ID },
    { $setOnInsert: { _id: DEFAULT_GROUP_ID, name: 'WhatsApp', password: ADMIN_PASSWORD, createdAt: new Date() } },
    { upsert: true }
  );
  return collection.findOne({ _id: DEFAULT_GROUP_ID });
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

async function getMediaChunksBucket() {
  const db = await getDb();
  if (!db) return null;
  mediaChunksBucket = mediaChunksBucket || new GridFSBucket(db, { bucketName: MEDIA_CHUNKS_BUCKET_NAME });
  return mediaChunksBucket;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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

// ===== WebRTC group-call signaling (REST fallback for Vercel/serverless) =====
// WebRTC carries the actual audio/video peer-to-peer; these endpoints only relay
// small signaling messages so every member of the same group can receive a call.
async function getCallEventsCollection() {
  const db = await getDb();
  if (!db) return null;
  const c = db.collection(CALL_EVENTS_COLLECTION_NAME);
  try { await c.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7200 }); } catch (_) {}
  try { await c.createIndex({ groupId: 1, createdAt: 1 }); } catch (_) {}
  return c;
}

app.post('/api/calls/event', async (req, res) => {
  try {
    const body = req.body || {};
    const groupId = normalizeGroupId(body.groupId);
    const type = String(body.type || '').trim();
    const callId = String(body.callId || '').trim().slice(0, 120);
    const fromUserId = String(body.fromUserId || '').trim().slice(0, 160);
    if (!groupId || !type || !callId || !fromUserId) return res.status(400).json({ ok:false });
    const event = {
      id: crypto.randomUUID(), groupId, callId, type, fromUserId,
      fromName: String(body.fromName || '').slice(0, 80),
      toUserId: body.toUserId ? String(body.toUserId).slice(0,160) : '',
      payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
      createdAt: new Date()
    };
    const collection = await getCallEventsCollection();
    if (collection) await collection.insertOne(event);
    // Socket.IO makes it fast on traditional Node hosting; REST polling below
    // remains the reliable path on Vercel where WebSocket lifetime is limited.
    io.emit('call-event', event);
    res.json({ ok:true, eventId:event.id, createdAt:event.createdAt.toISOString() });
  } catch (error) {
    console.error('Call event failed:', error.message);
    res.status(500).json({ ok:false });
  }
});

app.get('/api/calls/events', async (req, res) => {
  try {
    const groupId = normalizeGroupId(req.query.groupId);
    const userId = String(req.query.userId || '').trim();
    const sinceRaw = String(req.query.since || '');
    const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 15000);
    const safeSince = Number.isNaN(since.getTime()) ? new Date(Date.now() - 15000) : since;
    const collection = await getCallEventsCollection();
    if (!collection) return res.json({ ok:true, events:[] });
    const filter = { groupId, createdAt: { $gt: safeSince } };
    const events = await collection.find(filter).sort({ createdAt: 1 }).limit(300).toArray();
    // Do not send targeted SDP/ICE to unrelated users.
    const visible = events.filter(e => !e.toUserId || e.toUserId === userId || e.fromUserId === userId);
    res.json({ ok:true, events:visible.map(e => ({...e, _id:undefined})) });
  } catch (error) {
    console.error('Call events poll failed:', error.message);
    res.status(500).json({ ok:false, events:[] });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const collection = await getGroupSettingsCollection();
    if (!collection) return res.json({ ok: true, groups: Array.from(fallbackGroups.values()).sort((a,b) => a.createdAt - b.createdAt).map(g => ({ id: String(g._id), name: g.name || 'WhatsApp' })) });
    const groups = await collection.find({}, { projection: { _id: 1, name: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
    res.json({ ok: true, groups: groups.map(g => ({ id: String(g._id), name: g.name || 'WhatsApp' })) });
  } catch (error) {
    console.error('Failed to load groups:', error.message);
    res.json({ ok: true, groups: [{ id: DEFAULT_GROUP_ID, name: 'WhatsApp' }] });
  }
});

app.post('/api/groups/verify', async (req, res) => {
  try {
    const groupId = normalizeGroupId(req.body?.groupId);
    const password = String(req.body?.password || '');
    const collection = await getGroupSettingsCollection();
    if (!collection) {
      const group = fallbackGroups.get(groupId);
      return res.json({ ok: !!group && password === String(group.password || '') });
    }
    const group = await collection.findOne({ _id: groupId });
    if (!group) return res.status(404).json({ ok: false });
    res.json({ ok: password === String(group.password || '') });
  } catch (error) {
    res.status(500).json({ ok: false });
  }
});

app.post('/api/groups', async (req, res) => {
  try {
    if (String(req.body?.adminPassword || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok: false });
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const password = String(req.body?.password || '').trim();
    if (!name || !password) return res.status(400).json({ ok: false });
    const collection = await getGroupSettingsCollection();
    if (!collection) {
      const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'group'}-${crypto.randomBytes(3).toString('hex')}`;
      const doc = { _id: id, name, password, createdAt: new Date(), updatedAt: new Date() };
      fallbackGroups.set(id, doc);
      const group = { id, name };
      io.emit('group-created', group);
      return res.json({ ok: true, group, persistent: false });
    }
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'group'}-${crypto.randomBytes(3).toString('hex')}`;
    const doc = { _id: id, name, password, createdAt: new Date(), updatedAt: new Date() };
    await collection.insertOne(doc);
    const group = { id, name };
    io.emit('group-created', group);
    await publishRealtimeEvent('group-created', group);
    res.json({ ok: true, group });
  } catch (error) {
    console.error('Create group failed:', error.message);
    res.status(500).json({ ok: false });
  }
});

app.put('/api/groups/:id', async (req, res) => {
  try {
    if (String(req.body?.adminPassword || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok: false });
    const groupId = normalizeGroupId(req.params.id);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const password = String(req.body?.password || '').trim();
    if (!name || !password) return res.status(400).json({ ok: false });
    const collection = await getGroupSettingsCollection();
    if (!collection) {
      const group = fallbackGroups.get(groupId);
      if (!group) return res.status(404).json({ ok: false });
      group.name = name; group.password = password; group.updatedAt = new Date();
      const event = { id: groupId, name };
      io.emit('group-updated', event);
      return res.json({ ok: true, group: event, persistent: false });
    }
    const result = await collection.updateOne({ _id: groupId }, { $set: { name, password, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ ok: false });
    const event = { id: groupId, name };
    io.emit('group-updated', event);
    await publishRealtimeEvent('group-updated', event);
    res.json({ ok: true, group: event });
  } catch (error) {
    console.error('Update group failed:', error.message);
    res.status(500).json({ ok: false });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  try {
    if (String(req.body?.adminPassword || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok: false });
    const groupId = normalizeGroupId(req.params.id);
    const collection = await getGroupSettingsCollection();
    if (!collection) {
      const existed = fallbackGroups.delete(groupId);
      if (!existed) return res.status(404).json({ ok: false, error: 'Group not found' });
      const event = { id: groupId };
      io.emit('group-deleted', event);
      return res.json({ ok: true, group: event, persistent: false });
    }
    const groupDoc = await collection.findOne({ _id: groupId });
    const result = await collection.deleteOne({ _id: groupId });
    if (!result.deletedCount) return res.status(404).json({ ok: false, error: 'Group not found' });

    // Keep already-deleted items from this group in the ADMIN MAIN recycle bin.
    // The group is gone, so its old group id is retained as metadata for display.
    try {
      const db = await getDb();
      if (db) {
        await db.collection(RECYCLE_BIN_COLLECTION_NAME).updateMany(
          { groupId },
          { $set: { groupId: DEFAULT_GROUP_ID, deletedGroupId: groupId, deletedGroupName: groupDoc?.name || groupId, movedToMainRecycleAt: new Date() } }
        );
      }
    } catch (_) {}

    // Move the group's live messages to the MAIN ADMIN recycle bin before removing them.
    // This applies to text, images, videos, audio and documents because the complete
    // message record (including mediaId/mime/fileName) is retained in recycle_bin.
    try {
      const messagesCollection = await getCollection();
      if (messagesCollection) {
        const liveMessages = await messagesCollection.find({ groupId }).toArray();
        if (liveMessages.length) {
          await moveMessagesToRecycleBin(liveMessages, groupId, 'group-delete');
        }
        await messagesCollection.deleteMany({ groupId });
      }
    } catch (error) {
      console.error('Failed to archive group messages before group delete:', error.message);
    }
    const event = { id: groupId };
    io.emit('group-deleted', event);
    await publishRealtimeEvent('group-deleted', event);
    res.json({ ok: true, group: event });
  } catch (error) {
    console.error('Delete group failed:', error.message);
    res.status(500).json({ ok: false, error: 'Delete failed' });
  }
});

app.get('/api/group', async (req, res) => {
  try {
    const groupId = normalizeGroupId(req.query?.id);
    const collection = await getGroupSettingsCollection();
    if (!collection) return res.json({ ok: true, id: DEFAULT_GROUP_ID, name: 'WhatsApp' });
    const doc = await collection.findOne({ _id: groupId });
    res.json({ ok: true, id: groupId, name: doc?.name || 'WhatsApp' });
  } catch (error) {
    res.json({ ok: true, id: DEFAULT_GROUP_ID, name: 'WhatsApp' });
  }
});

app.post('/api/admin/groups', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok: false });
    const collection = await getGroupSettingsCollection();
    if (!collection) {
      const groups = Array.from(fallbackGroups.values()).sort((a,b) => a.createdAt - b.createdAt);
      return res.json({ ok: true, groups: groups.map(g => ({ id: String(g._id), name: g.name || 'WhatsApp', password: String(g.password || '') })), persistent: false });
    }
    const groups = await collection.find({}, { projection: { _id: 1, name: 1, password: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
    res.json({ ok: true, groups: groups.map(g => ({ id: String(g._id), name: g.name || 'WhatsApp', password: String(g.password || '') })), persistent: true });
  } catch (error) {
    res.status(500).json({ ok: false });
  }
});


async function moveMessagesToRecycleBin(items, groupId, reason = 'delete') {
  const db = await getDb();
  if (!db || !Array.isArray(items) || !items.length) return;
  const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
  const docs = items.map(item => {
    const message = { ...item };
    delete message._id;
    const originalGroupId = normalizeGroupId(item.groupId || groupId);
    return {
      originalMessageId: String(item.id),
      // Main Recycle Bin is represented by the main group id. Keep the original
      // group separately so every deleted item can still be traced back to its
      // chat/group and can be restored correctly.
      groupId: DEFAULT_GROUP_ID,
      deletedGroupId: originalGroupId,
      deletedGroupName: String(item.groupName || item.deletedGroupName || originalGroupId),
      deletedAt: new Date(),
      deleteReason: reason,
      message: { ...message, groupId: originalGroupId },
    };
  });
  // Keep one recycle record per message id. A deleted message should never be
  // duplicated if a retry reaches the server twice.
  try { await recycle.createIndex({ originalMessageId: 1 }, { unique: true }); } catch (_) {}
  for (const doc of docs) {
    try { await recycle.updateOne({ originalMessageId: doc.originalMessageId }, { $set: doc }, { upsert: true }); } catch (_) {}
  }
}

// Admin-only recycle bin. This is intentionally separate from the normal chat
// UI: only the administrator who can view group passwords can inspect/restore
// deleted group media.
app.post('/api/admin/recycle-bin', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db) return res.json({ ok:true, items:[], persistent:false });
    const requestedGroupId = req.body?.groupId ? normalizeGroupId(req.body.groupId) : null;
    // groupId=main is the ADMIN MAIN recycle bin: it intentionally shows
    // deleted items from every group, including the default group.
    const filter = requestedGroupId && requestedGroupId !== DEFAULT_GROUP_ID ? { groupId: requestedGroupId } : {};
    const items = await db.collection(RECYCLE_BIN_COLLECTION_NAME).find(filter).sort({ deletedAt:-1 }).limit(10000).toArray();
    res.json({ ok:true, persistent:true, items: items.map(x => ({
      id:String(x._id), originalMessageId:String(x.originalMessageId), groupId:String(x.groupId),
      deletedAt:x.deletedAt, deleteReason:x.deleteReason || 'delete',
      deletedGroupId:x.deletedGroupId ? String(x.deletedGroupId) : null,
      deletedGroupName:x.deletedGroupName ? String(x.deletedGroupName) : null,
      message:x.message || {}
    })) });
  } catch (error) {
    console.error('Admin recycle-bin list failed:', error.message);
    res.status(500).json({ ok:false, error:'Recycle bin unavailable' });
  }
});

app.post('/api/admin/recycle-bin/restore', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db || !ObjectId.isValid(String(req.body?.id || ''))) return res.status(400).json({ ok:false, error:'Invalid recycle item' });
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const item = await recycle.findOne({ _id:new ObjectId(String(req.body.id)) });
    if (!item) return res.status(404).json({ ok:false, error:'Recycle item not found' });
    const msg = { ...(item.message || {}) };
    delete msg._id;
    const exists = await collection.findOne({ id:String(item.originalMessageId) });
    if (exists) return res.status(409).json({ ok:false, error:'Message already exists' });
    msg.id = String(item.originalMessageId);
    msg.groupId = normalizeGroupId(item.deletedGroupId || item.message?.groupId || item.groupId);
    await collection.insertOne(msg);
    await recycle.deleteOne({ _id:item._id });
    const event = { message: msg, groupId: msg.groupId };
    io.emit('restore-message', event);
    await publishRealtimeEvent('restore-message', event);
    res.json({ ok:true, message:msg });
  } catch (error) {
    console.error('Admin recycle restore failed:', error.message);
    res.status(500).json({ ok:false, error:'Restore failed' });
  }
});

app.post('/api/admin/recycle-bin/delete', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db || !ObjectId.isValid(String(req.body?.id || ''))) return res.status(400).json({ ok:false, error:'Invalid recycle item' });
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const item = await recycle.findOne({ _id:new ObjectId(String(req.body.id)) });
    if (!item) return res.status(404).json({ ok:false, error:'Recycle item not found' });
    if (item.message?.mediaId) {
      try { await (await getMediaBucket()).delete(new ObjectId(String(item.message.mediaId))); } catch (_) {}
    }
    await recycle.deleteOne({ _id:item._id });
    res.json({ ok:true });
  } catch (error) {
    console.error('Admin recycle permanent delete failed:', error.message);
    res.status(500).json({ ok:false, error:'Permanent delete failed' });
  }
});

app.post('/api/admin/recycle-bin/download', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db || !ObjectId.isValid(String(req.body?.id || ''))) return res.status(400).json({ ok:false, error:'Invalid recycle item' });
    const item = await db.collection(RECYCLE_BIN_COLLECTION_NAME).findOne({ _id:new ObjectId(String(req.body.id)) });
    if (!item) return res.status(404).json({ ok:false, error:'Recycle item not found' });
    const mediaId = item.message?.mediaId;
    if (!mediaId || !ObjectId.isValid(String(mediaId))) return res.status(404).json({ ok:false, error:'No downloadable media' });
    const bucket = await getMediaBucket();
    const fileId = new ObjectId(String(mediaId));
    const files = await bucket.find({ _id:fileId }).toArray();
    if (!files.length) return res.status(404).json({ ok:false, error:'Media file not found' });
    const file = files[0];
    const mime = file.metadata?.mime || 'application/octet-stream';
    const safeName = String(file.metadata?.fileName || file.filename || `media-${fileId}`).replace(/[\\"\\r\\n]/g, '_');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', file.length);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    res.setHeader('Cache-Control', 'no-store');
    bucket.openDownloadStream(fileId).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    console.error('Admin recycle download failed:', error.message);
    res.status(500).json({ ok:false, error:'Download failed' });
  }
});

app.post('/api/admin/recycle-bin/empty', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db) return res.json({ ok:true, count:0, persistent:false });
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const requestedGroupId = req.body?.groupId ? normalizeGroupId(req.body.groupId) : null;
    const filter = requestedGroupId && requestedGroupId !== DEFAULT_GROUP_ID ? { groupId: requestedGroupId } : {};
    const items = await recycle.find(filter, { projection:{ 'message.mediaId':1 } }).toArray();
    const bucket = await getMediaBucket();
    for (const item of items) {
      if (item.message?.mediaId) { try { await bucket.delete(new ObjectId(String(item.message.mediaId))); } catch (_) {} }
    }
    const result = await recycle.deleteMany(filter);
    res.json({ ok:true, count:result.deletedCount || 0 });
  } catch (error) {
    console.error('Admin recycle empty failed:', error.message);
    res.status(500).json({ ok:false, error:'Empty recycle bin failed' });
  }
});

app.post('/api/media/:id/download', express.json({ limit: '2kb' }), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok:false, error:'Invalid media id' });
    if (String(req.body?.password || '') !== DOWNLOAD_PASSWORD) return res.status(403).json({ ok:false, error:'Wrong download password' });
    const bucket = await getMediaBucket();
    const fileId = new ObjectId(req.params.id);
    const files = await bucket.find({ _id: fileId }).toArray();
    if (!files.length) return res.status(404).json({ ok:false, error:'File not found' });
    const file = files[0];
    const mime = file.metadata?.mime || 'application/octet-stream';
    const safeName = String(file.metadata?.fileName || file.filename || `media-${fileId}`).replace(/[\\"\r\n]/g, '_');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', file.length);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    res.setHeader('Cache-Control', 'no-store');
    bucket.openDownloadStream(fileId).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    console.error('Failed to download media:', error.message);
    res.status(500).json({ ok:false, error:'Download failed' });
  }
});

app.get('/api/media/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).end();
    // Media can be viewed inline, but saving/downloading it requires the download password.
    if (String(req.query?.download || '') === '1' && String(req.get('X-Download-Password') || '') !== DOWNLOAD_PASSWORD) {
      return res.status(403).json({ ok: false, error: 'Download password required' });
    }
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

async function loadMessages(after, groupId = DEFAULT_GROUP_ID) {
  const collection = await getCollection();
  if (!collection) return [];
  const gid = normalizeGroupId(groupId);
  const groupFilter = { $or: [{ groupId: gid }, ...(gid === DEFAULT_GROUP_ID ? [{ groupId: { $exists: false } }] : [])] };
  const query = after ? { $and: [groupFilter, { createdAt: { $gte: new Date(after) } }] } : groupFilter;
  return collection
    .find(query, { projection: { _id: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
}


app.post('/api/messages', async (req, res) => {
  try {
    const msg = req.body || {};
    if (!msg.id || !String(msg.message || '').trim()) return res.status(400).json({ ok: false, error: 'Invalid message' });
    msg.message = String(msg.message).trim();
    msg.groupId = normalizeGroupId(msg.groupId);
    msg.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    msg.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
    const saved = await broadcastSaved('message', msg);
    res.json({ ok: true, message: saved });
  } catch (error) {
    console.error('REST message save failed:', error.message);
    res.status(500).json({ ok: false, error: 'Message could not be saved' });
  }
});

// HTTP chunked media upload fallback. This is important on serverless deployments
// where Socket.IO upgrades may not be available/reliable. Each request stays small;
// the server assembles the chunks into GridFS at the end. There is intentionally no
// application-level maximum video size.
app.post('/api/media/start', async (req, res) => {
  try {
    const { uploadId, name, mime, type, size, groupId, userId } = req.body || {};
    if (!uploadId || !name || !mime || !type) return res.status(400).json({ ok:false, error:'Invalid upload' });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok:false, error:'Media storage is unavailable. Configure MONGODB_URI.' });
    const uploads = db.collection(MEDIA_UPLOADS_COLLECTION_NAME);
    const chunksBucket = await getMediaChunksBucket();
    // Clean up a retry of the same upload id.
    const oldChunks = await chunksBucket.find({ 'metadata.uploadId': String(uploadId) }).toArray();
    await Promise.all(oldChunks.map(f => chunksBucket.delete(f._id).catch(() => {})));
    await uploads.deleteMany({ uploadId: String(uploadId) });
    await uploads.insertOne({
      uploadId: String(uploadId), name: String(name), mime: String(mime), type: String(type),
      size: Number(size || 0), groupId: normalizeGroupId(groupId), userId: String(userId || ''),
      received: 0, chunks: 0, createdAt: new Date()
    });
    res.json({ ok:true });
  } catch (error) {
    console.error('REST media start failed:', error.message);
    res.status(500).json({ ok:false, error:'Upload could not start' });
  }
});

// Each media chunk is stored as its own GridFS file. This avoids MongoDB's 16MB
// document limit, so a video can be arbitrarily large at the application layer.
app.post('/api/media/chunk', express.raw({ type: 'application/octet-stream', limit: '1mb' }), async (req, res) => {
  try {
    const uploadId = String(req.query.uploadId || '');
    const index = Number(req.query.index);
    if (!uploadId || !Number.isInteger(index) || index < 0 || !Buffer.isBuffer(req.body) || !req.body.length || req.body.length > MAX_MEDIA_CHUNK) {
      return res.status(400).json({ ok:false, error:'Invalid chunk' });
    }
    const db = await getDb();
    if (!db) return res.status(503).json({ ok:false, error:'Media storage is unavailable' });
    const uploads = db.collection(MEDIA_UPLOADS_COLLECTION_NAME);
    const session = await uploads.findOne({ uploadId });
    if (!session) return res.status(404).json({ ok:false, error:'Upload not found' });
    const chunksBucket = await getMediaChunksBucket();
    const existing = await chunksBucket.find({ 'metadata.uploadId': uploadId, 'metadata.index': index }).toArray();
    await Promise.all(existing.map(f => chunksBucket.delete(f._id).catch(() => {})));
    const stream = chunksBucket.openUploadStream(`${uploadId}-${index}`, {
      contentType: 'application/octet-stream',
      metadata: { uploadId, index }
    });
    await new Promise((resolve, reject) => {
      stream.once('finish', resolve);
      stream.once('error', reject);
      stream.end(req.body);
    });
    await uploads.updateOne({ uploadId }, { $inc: { received: req.body.length }, $max: { chunks: index + 1 } });
    res.json({ ok:true, index });
  } catch (error) {
    console.error('REST media chunk failed:', error.message);
    res.status(500).json({ ok:false, error:'Chunk upload failed' });
  }
});

app.post('/api/media/end', async (req, res) => {
  try {
    const uploadId = String(req.body?.uploadId || '');
    if (!uploadId) return res.status(400).json({ ok:false });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok:false, error:'Media storage is unavailable' });
    const uploads = db.collection(MEDIA_UPLOADS_COLLECTION_NAME);
    const session = await uploads.findOne({ uploadId });
    if (!session) return res.status(404).json({ ok:false, error:'Upload not found' });
    const chunksBucket = await getMediaChunksBucket();
    const media = await getMediaBucket();
    const chunks = await chunksBucket.find({ 'metadata.uploadId': uploadId }).sort({ 'metadata.index': 1 }).toArray();
    if (chunks.length !== Number(session.chunks || 0)) return res.status(409).json({ ok:false, error:'Upload is incomplete' });
    for (let i = 0; i < chunks.length; i++) {
      if (Number(chunks[i].metadata?.index) !== i) return res.status(409).json({ ok:false, error:'Upload has missing chunks' });
    }
    const stream = media.openUploadStream(session.name, {
      contentType: session.mime,
      metadata: { mime: session.mime, type: session.type, userId: session.userId, groupId: session.groupId, fileSize: session.size }
    });
    try {
      for (const chunkFile of chunks) {
        const download = chunksBucket.openDownloadStream(chunkFile._id);
        await new Promise((resolve, reject) => {
          download.on('error', reject);
          stream.on('error', reject);
          download.on('end', resolve);
          download.pipe(stream, { end: false });
        });
      }
      await new Promise((resolve, reject) => {
        stream.once('finish', resolve);
        stream.once('error', reject);
        stream.end();
      });
      await Promise.all(chunks.map(f => chunksBucket.delete(f._id).catch(() => {})));
      await uploads.deleteOne({ _id: session._id });
      const msg = {
        id: crypto.randomUUID(), groupId: session.groupId, userId: session.userId, user: String(req.body?.user || ''),
        type: session.type, mime: session.mime, mediaId: String(stream.id), fileName: session.name, fileSize: session.size,
        time: String(req.body?.time || new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})),
        createdAt: new Date().toISOString(), deliveredTo: [], readBy: []
      };
      const saved = await broadcastSaved('media', msg);
      return res.json({ ok:true, message:saved });
    } catch (e) {
      try { await media.delete(stream.id); } catch (_) {}
      throw e;
    }
  } catch (error) {
    console.error('REST media end failed:', error.message);
    res.status(500).json({ ok:false, error:'Upload could not be finalized' });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const after = typeof req.query.after === 'string' && req.query.after ? req.query.after : '';
    const groupId = normalizeGroupId(req.query?.groupId);
    const messages = await loadMessages(after, groupId);
    res.json({ ok: true, messages });
  } catch (error) {
    console.error('Failed to load messages:', error.message);
    res.status(500).json({ ok: false, messages: [] });
  }
});

async function saveMessage(msg) {
  const collection = await getCollection();
  if (!collection) return { ...msg, groupId: normalizeGroupId(msg.groupId), createdAt: msg.createdAt || new Date().toISOString() };

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
    const senderUserId = String(msg.userId || '').trim();
    // A message must never notify the device/user that sent it. Match the
    // exact userId saved with the browser's push subscription.
    const query = senderUserId
      ? { userId: { $ne: senderUserId } }
      : { userId: { $exists: true } };
    const docs = await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION_NAME).find(query).toArray();
    if (!docs.length) return;
    // Keep notification content generic and let the service worker decide
    // whether the chat is currently open. This matches the reference app:
    // one push per message, no sender/message preview, and never notify the sender.
    const payload = JSON.stringify({
      title: 'WhatsApp',
      body: 'You have new message',
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
  io.emit(event, saved);
  publishRealtimeEvent(event, saved);
  if (event === 'message' || event === 'media') await sendPushToOtherUsers(saved);
  return saved;
}

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);
  const uploads = new Map();

  socket.on('register-user', (data) => {
    socket.userId = data && data.userId ? String(data.userId) : '';
  });

  socket.on('join-group', async (data, ack) => {
    const groupId = normalizeGroupId(data?.groupId);
    socket.groupId = groupId;
    try {
      const history = await loadMessages('', groupId);
      socket.emit('history', history);
      if (typeof ack === 'function') ack({ ok: true, groupId });
    } catch (error) {
      socket.emit('history', []);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.groupId = DEFAULT_GROUP_ID;
  try {
    const history = await loadMessages('', DEFAULT_GROUP_ID);
    socket.emit('history', history);
  } catch (error) {
    console.error('Failed to load message history:', error.message);
    socket.emit('history', []);
  }

  socket.on('message', async (msg, ack) => {
    if (!msg || !msg.message || !msg.id) return;
    msg.groupId = normalizeGroupId(socket.groupId);
    // Prefer the registered socket identity over a client-supplied value.
    if (socket.userId) msg.userId = String(socket.userId);
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
        metadata: { mime: meta.mime, type: meta.type, userId: String(meta.userId || ''), groupId: normalizeGroupId(meta.groupId || socket.groupId) },
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
        id: meta.id, groupId: normalizeGroupId(meta.groupId || socket.groupId), senderId: meta.senderId, userId: meta.userId, user: meta.user,
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

  socket.on('rename-group', async (data, ack) => {
    const nextName = String(data?.name || '').trim().slice(0, 60);
    if (!nextName) { if (typeof ack === 'function') ack({ ok: false }); return; }
    try {
      const collection = await getGroupSettingsCollection();
      const groupId = normalizeGroupId(socket.groupId);
      await collection.updateOne({ _id: groupId }, { $set: { name: nextName, updatedAt: new Date() } }, { upsert: true });
      const event = { id: groupId, name: nextName };
      io.emit('group-renamed', event);
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

  socket.on('update-message', async (data, ack) => {
    if (!data || !data.id || !socket.groupId) return;
    const groupId = normalizeGroupId(socket.groupId);
    const allowed = {};
    if (typeof data.starred === 'boolean') allowed.starred = data.starred;
    if (typeof data.pinned === 'boolean') allowed.pinned = data.pinned;
    if (typeof data.message === 'string') allowed.message = data.message.slice(0, 5000);
    if (data.reactions && typeof data.reactions === 'object') allowed.reactions = Object.fromEntries(Object.entries(data.reactions).slice(0, 100).map(([k,v]) => [String(k).slice(0,100), String(v).slice(0,8)]));
    if (data.replyTo && typeof data.replyTo === 'object') allowed.replyTo = {
      id: String(data.replyTo.id || ''), message: String(data.replyTo.message || '').slice(0, 500), user: String(data.replyTo.user || '').slice(0, 100)
    };
    if (!Object.keys(allowed).length) { if (typeof ack === 'function') ack({ok:false}); return; }
    try {
      const collection = await getCollection();
      if (!collection) { if (typeof ack === 'function') ack({ok:false}); return; }
      const result = await collection.findOneAndUpdate(
        { id: String(data.id), $or: [{ groupId }, ...(groupId === DEFAULT_GROUP_ID ? [{ groupId: { $exists: false } }] : [])] },
        { $set: allowed }, { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) { if (typeof ack === 'function') ack({ok:false}); return; }
      const event = { message: updated, groupId };
      io.emit('message-updated', event);
      publishRealtimeEvent('message-updated', event);
      if (typeof ack === 'function') ack({ok:true, message:updated});
    } catch (error) {
      console.error('Failed to update message:', error.message);
      if (typeof ack === 'function') ack({ok:false});
    }
  });

  socket.on('delete-message', async (data, ack) => {
    if (!data || !data.id) return;
    const deleteEvent = { id: data.id, groupId: normalizeGroupId(socket.groupId) };
    try {
      const collection = await getCollection();
      if (collection) {
        const existing = await collection.findOne({ id: data.id });
        if (existing) await moveMessagesToRecycleBin([existing], normalizeGroupId(socket.groupId), 'message-delete');
        await collection.deleteOne({ id: data.id });
      }
      // Persist first, then broadcast. This prevents another Vercel instance's
      // reconciliation request from briefly re-adding a just-deleted message.
      io.emit('delete-message', deleteEvent);
      publishRealtimeEvent('delete-message', deleteEvent);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      console.error('Failed to delete message:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('delete-messages', async (data, ack) => {
    const ids = Array.isArray(data?.ids)
      ? [...new Set(data.ids.map(id => String(id || '').trim()).filter(Boolean))].slice(0, 500)
      : [];
    if (!ids.length) {
      if (typeof ack === 'function') ack({ ok: true, count: 0 });
      return;
    }

    const groupId = normalizeGroupId(socket.groupId);
    try {
      const collection = await getCollection();
      if (collection) {
        const groupFilter = { $or: [{ groupId }, ...(groupId === DEFAULT_GROUP_ID ? [{ groupId: { $exists: false } }] : [])] };
        const existing = await collection.find(
          { $and: [groupFilter, { id: { $in: ids } }] }
        ).toArray();

        if (existing.length) await moveMessagesToRecycleBin(existing, groupId, 'message-delete');
        await collection.deleteMany({ $and: [groupFilter, { id: { $in: ids } }] });
      }

      const event = { ids, groupId };
      io.emit('delete-messages', event);
      publishRealtimeEvent('delete-messages', event);
      if (typeof ack === 'function') ack({ ok: true, count: ids.length });
    } catch (error) {
      console.error('Failed to delete multiple messages:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  // Fast Socket.IO signaling path. REST /api/calls/events is the fallback.
  socket.on('call-event', (data) => {
    if (!data || !data.callId || !data.type || !socket.groupId) return;
    if (normalizeGroupId(data.groupId || socket.groupId) !== normalizeGroupId(socket.groupId)) return;
    const target = data.toUserId ? String(data.toUserId) : '';
    const payload = { ...data, groupId: normalizeGroupId(socket.groupId), fromUserId: socket.userId || String(data.fromUserId || '') };
    for (const peer of io.sockets.sockets.values()) {
      if (peer.id === socket.id) continue;
      if (normalizeGroupId(peer.groupId) !== normalizeGroupId(socket.groupId)) continue;
      if (target && String(peer.userId || '') !== target) continue;
      peer.emit('call-event', payload);
    }
  });

  socket.on('typing', (data) => {
    if (!data || !socket.groupId || normalizeGroupId(data.groupId) !== normalizeGroupId(socket.groupId)) return;
    io.emit('typing', { groupId: normalizeGroupId(socket.groupId), userId: socket.userId || String(data.userId || ''), name: String(data.name || '').slice(0,60), active: !!data.active });
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
    const readEvent = { id: data.id, userId: readerId, groupId: normalizeGroupId(socket.groupId) };
    io.emit('message-read', readEvent);
    publishRealtimeEvent('message-read', readEvent);
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
    const deliveredEvent = { id: data.id, userId: receiverId, groupId: normalizeGroupId(socket.groupId) };
    io.emit('message-delivered', deliveredEvent);
    publishRealtimeEvent('message-delivered', deliveredEvent);
  });

  socket.on('clear-chat', async () => {
    try {
      const collection = await getCollection();
      if (collection) {
        const gid = normalizeGroupId(socket.groupId);
        const groupFilter = { $or: [{ groupId: gid }, ...(gid === DEFAULT_GROUP_ID ? [{ groupId: { $exists: false } }] : [])] };
        const allMessages = await collection.find(groupFilter).toArray();
        if (allMessages.length) await moveMessagesToRecycleBin(allMessages, gid, 'clear-chat');
        await collection.deleteMany(groupFilter);
      }
      // Persist first, then broadcast so every instance is immediately consistent.
      const clearEvent = { groupId: normalizeGroupId(socket.groupId) };
      io.emit('clear-chat', clearEvent);
      publishRealtimeEvent('clear-chat', clearEvent);
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
