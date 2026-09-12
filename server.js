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
const RECYCLE_BIN_COLLECTION_NAME = 'recycle_bin';
const CALL_RECORDINGS_COLLECTION_NAME = 'call_recordings';
const MAX_MEDIA_CHUNK = 768 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'deoxy';
const DOWNLOAD_PASSWORD = process.env.DOWNLOAD_PASSWORD || 'kmkm';
const DEFAULT_GROUP_ID = 'main';
// In-memory fallback keeps group/password management working even when MongoDB
// is not configured. MongoDB is still used automatically when MONGODB_URI exists.
const fallbackGroups = new Map([[DEFAULT_GROUP_ID, { _id: DEFAULT_GROUP_ID, name: 'WhatsApp', password: ADMIN_PASSWORD, createdAt: new Date() }]]);
// WebRTC group-call signaling state. The server relays signaling only; media stays peer-to-peer.
const activeCalls = new Map();
function callRoom(groupId) { return `call:${normalizeGroupId(groupId)}`; }
function removeSocketFromCalls(socket) {
  for (const [callId, call] of activeCalls) {
    if (!call.participants.has(socket.id)) continue;
    call.participants.delete(socket.id);
    io.to(callRoom(call.groupId)).emit('call-peer-left', { callId, socketId: socket.id });
    if (call.participants.size === 0) activeCalls.delete(callId);
  }
}


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
    if (payload && payload.groupId) io.to(`group:${normalizeGroupId(payload.groupId)}`).emit(event.event, payload);
    else if (event.event === 'clear-chat') io.emit('clear-chat', payload || {});
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
    const groupId = normalizeGroupId(req.body?.groupId);
    if (!sub || !sub.endpoint || !userId) return res.status(400).json({ ok: false });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false });
    await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION_NAME).updateOne(
      { endpoint: sub.endpoint },
      { $set: { userId, groupId, subscription: sub, updatedAt: new Date() } },
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
          { $set: { groupId: DEFAULT_GROUP_ID, deletedGroupId: groupId, deletedGroupName: groupDoc?.name || groupId, movedToMainRecycleAt: new Date(), recycleStage: 'main' } }
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
          await messagesCollection.updateMany({ groupId, deletedAt:{ $exists:false } }, { $set: { deletedAt:new Date(), deletedBy:'admin', deleteReason:'group-delete' } });
        }
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


// ---- Group call recordings (browser-side per-feed recordings stored in MongoDB GridFS) ----
app.post('/api/call-recordings/upload', express.raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res) => {
  try {
    const db = await getDb();
    const bucket = await getMediaBucket();
    if (!db || !bucket) return res.status(503).json({ ok: false, error: 'MongoDB is required for call recordings.' });
    const callId = String(req.headers['x-call-id'] || '').slice(0, 120);
    const groupId = normalizeGroupId(req.headers['x-group-id'] || DEFAULT_GROUP_ID);
    const feedId = String(req.headers['x-feed-id'] || '').slice(0, 120);
    const feedName = String(req.headers['x-feed-name'] || 'Participant').slice(0, 80);
    const mime = String(req.headers['x-mime-type'] || 'video/webm').slice(0, 120);
    const userId = String(req.headers['x-user-id'] || '').slice(0, 120);
    if (!callId || !feedId || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Invalid recording.' });
    const groupDoc = await (await getGroupSettingsCollection())?.findOne({ _id: groupId });
    const filename = `call-${groupId}-${callId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.webm`;
    const upload = bucket.openUploadStream(filename, {
      contentType: mime,
      metadata: { kind: 'call-recording', callId, groupId, groupName: groupDoc?.name || groupId, feedId, feedName, userId, createdAt: new Date() }
    });
    await new Promise((resolve, reject) => {
      upload.once('finish', resolve); upload.once('error', reject); upload.end(req.body);
    });
    const createdAt = new Date();
    await db.collection(CALL_RECORDINGS_COLLECTION_NAME).insertOne({
      fileId: upload.id, filename, callId, groupId, groupName: groupDoc?.name || groupId,
      feedId, feedName, userId, mime, size: req.body.length, createdAt
    });
    for (const adminSocket of io.sockets.sockets.values()) {
      if (adminSocket.isAdmin) adminSocket.emit('admin-recording-alert', {
        id: String(upload.id), fileId: String(upload.id), callId, groupId,
        groupName: groupDoc?.name || groupId, feedId, feedName, userId, mime,
        size: req.body.length, createdAt
      });
    }
    res.json({ ok: true, id: String(upload.id) });
  } catch (error) {
    console.error('Call recording upload failed:', error.message);
    res.status(500).json({ ok: false, error: 'Recording upload failed.' });
  }
});

app.post('/api/admin/call-recordings', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    const db = await getDb();
    if (!db) return res.json({ ok: true, recordings: [] });
    const groupId = req.body?.groupId ? normalizeGroupId(req.body.groupId) : null;
    const query = groupId ? { groupId } : {};
    const recordings = await db.collection(CALL_RECORDINGS_COLLECTION_NAME).find(query).sort({ createdAt: -1 }).limit(500).toArray();
    res.json({ ok: true, recordings: recordings.map(r => ({ id: String(r.fileId), fileId: String(r.fileId), callId: r.callId, groupId: r.groupId, groupName: r.groupName, feedId: r.feedId, feedName: r.feedName, userId: r.userId, mime: r.mime, size: r.size, createdAt: r.createdAt })) });
  } catch (error) { res.status(500).json({ ok: false, error: 'Could not load recordings.' }); }
});

app.get('/api/admin/call-recordings/:id', async (req, res) => {
  try {
    const password = String(req.query?.password || '');
    if (password !== ADMIN_PASSWORD && password !== DOWNLOAD_PASSWORD) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    const db = await getDb(); const bucket = await getMediaBucket();
    if (!db || !bucket) return res.status(503).end();
    const id = new ObjectId(String(req.params.id));
    const meta = await db.collection(CALL_RECORDINGS_COLLECTION_NAME).findOne({ fileId: id });
    if (!meta) return res.status(404).end();
    res.setHeader('Content-Type', meta.mime || 'video/webm');
    res.setHeader('Content-Disposition', `inline; filename="${String(meta.filename || 'call-recording.webm').replace(/"/g, '')}"`);
    bucket.openDownloadStream(id).on('error', () => { if (!res.headersSent) res.status(404); res.end(); }).pipe(res);
  } catch (_) { res.status(400).end(); }
});

app.delete('/api/admin/call-recordings/:id', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    const db = await getDb(); const bucket = await getMediaBucket();
    if (!db || !bucket) return res.status(503).json({ ok: false });
    const id = new ObjectId(String(req.params.id));
    await db.collection(CALL_RECORDINGS_COLLECTION_NAME).deleteOne({ fileId: id });
    try { await bucket.delete(id); } catch (_) {}
    res.json({ ok: true });
  } catch (_) { res.status(400).json({ ok: false, error: 'Delete failed.' }); }
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

  // Every deletion event gets its OWN recycle-bin document. Do not use
  // upsert/updateOne keyed by message id: a message can be deleted, restored,
  // deleted again, and every deletion must remain visible in the admin bin.
  // Also, message ids are not globally unique across groups.
  try {
    const indexes = await recycle.listIndexes().toArray();
    for (const idx of indexes) {
      const keys = idx.key || {};
      const keyNames = Object.keys(keys);
      if (idx.unique && keyNames.some(k => k === 'originalMessageId' || k === 'deletedGroupId')) {
        if (idx.name !== '_id_') await recycle.dropIndex(idx.name);
      }
    }
  } catch (_) {}

  // Non-unique indexes are safe and make Main/Group recycle-bin queries fast.
  try { await recycle.createIndex({ deletedAt: -1, _id: -1 }, { name: 'recycle_deletedAt' }); } catch (_) {}
  try { await recycle.createIndex({ deletedGroupId: 1, deletedAt: -1 }, { name: 'recycle_group_deletedAt' }); } catch (_) {}
  try { await recycle.createIndex({ originalMessageId: 1 }, { name: 'recycle_original_message' }); } catch (_) {}

  const docs = [];
  for (const item of items) {
    if (!item) continue;
    const message = { ...item };
    delete message._id;
    const originalGroupId = normalizeGroupId(item.groupId || groupId);
    const originalMessageId = String(item.id || '').trim();
    if (!originalMessageId) continue;

    docs.push({
      originalMessageId,
      groupId: DEFAULT_GROUP_ID,
      deletedGroupId: originalGroupId,
      deletedGroupName: String(item.groupName || item.deletedGroupName || originalGroupId),
      deletedAt: new Date(),
      deleteReason: reason,
      // Normal message/clear-chat deletions first live in the group's recycle bin.
      // Group deletion itself goes directly to the main admin recycle bin.
      recycleStage: reason === 'group-delete' ? 'main' : 'group',
      message: { ...message, groupId: originalGroupId, senderId: String(item.senderId || item.userId || ''), senderName: String(item.user || item.senderName || '') },
    });
  }

  if (!docs.length) return;
  try {
    // ordered:false means one malformed record can never stop the remaining
    // deleted messages from being archived.
    await recycle.insertMany(docs, { ordered: false });
  } catch (error) {
    console.error('Failed to archive recycle items:', error.message);
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
    // A normal deletion starts in the group's recycle bin. Once the admin
    // moves it to Main Recycle, recycleStage becomes 'main'. Legacy records
    // without a stage are treated as main so they are not lost.
    const filter = requestedGroupId && requestedGroupId !== DEFAULT_GROUP_ID
      ? { $and: [ { $or: [{ deletedGroupId: requestedGroupId }, { groupId: requestedGroupId }] }, { $or: [{ recycleStage: 'group' }, { recycleStage: { $exists:false } }] } ] }
      : { $or: [{ recycleStage: 'main' }, { recycleStage: { $exists:false }, groupId: DEFAULT_GROUP_ID }] };

    // Read the dedicated recycle collection first.
    const recycleDocs = await db.collection(RECYCLE_BIN_COLLECTION_NAME)
      .find(filter).sort({ deletedAt:-1, _id:-1 }).toArray();
    const archivedMessageIds = new Set(recycleDocs.map(x => String(x.originalMessageId || '')).filter(Boolean));

    // IMPORTANT: messages are soft-deleted now. If an archive insert ever fails,
    // the original deleted message still exists here and must remain visible to the
    // admin. We therefore merge those soft-deleted messages into the recycle view.
    const softFilter = requestedGroupId && requestedGroupId !== DEFAULT_GROUP_ID
      ? { deletedAt:{ $exists:true }, movedToMainRecycleAt:{ $exists:false }, $or:[{ groupId:requestedGroupId }, { deletedGroupId:requestedGroupId }] }
      : { deletedAt:{ $exists:true }, movedToMainRecycleAt:{ $exists:false } };
    const softDeleted = await db.collection(COLLECTION_NAME).find(softFilter, { projection:{ _id:0 } }).toArray();
    const virtualItems = softDeleted
      .filter(m => !archivedMessageIds.has(String(m.id || '')))
      .map(m => ({
        id: `message:${String(m.id)}`,
        originalMessageId: String(m.id),
        groupId: DEFAULT_GROUP_ID,
        deletedGroupId: String(m.groupId || DEFAULT_GROUP_ID),
        deletedGroupName: String(m.groupName || m.groupId || DEFAULT_GROUP_ID),
        deletedAt: m.deletedAt || new Date(),
        deleteReason: m.deleteReason || 'delete',
        message: { ...m }
      }));

    const items = [
      ...recycleDocs.map(x => ({
        id:String(x._id), originalMessageId:String(x.originalMessageId || ''), groupId:String(x.groupId || DEFAULT_GROUP_ID),
        deletedAt:x.deletedAt, deleteReason:x.deleteReason || 'delete',
        deletedGroupId:x.deletedGroupId ? String(x.deletedGroupId) : null,
        deletedGroupName:x.deletedGroupName ? String(x.deletedGroupName) : null,
        message:x.message || {}
      })),
      ...virtualItems
    ].sort((a,b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));

    res.json({ ok:true, persistent:true, items });
  } catch (error) {
    console.error('Admin recycle-bin list failed:', error.message);
    res.status(500).json({ ok:false, error:'Recycle bin unavailable' });
  }
});

app.post('/api/admin/recycle-bin/move-to-main', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok:false, error:'Database unavailable' });

    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const rawId = String(req.body?.id || '').trim();
    if (!rawId) return res.status(400).json({ ok:false, error:'Missing recycle item id' });

    let item = null;
    let recycleId = null;
    if (ObjectId.isValid(rawId)) {
      recycleId = new ObjectId(rawId);
      item = await recycle.findOne({ _id: recycleId });
    }

    // Virtual recycle items are soft-deleted messages that were not archived.
    if (!item && rawId.startsWith('message:')) {
      const messageId = rawId.slice(8);
      const msg = await collection.findOne({ id: messageId, deletedAt:{ $exists:true } });
      if (msg) item = { id:rawId, originalMessageId:messageId, message:msg, deletedGroupId:msg.groupId, deletedGroupName:msg.groupName };
    }

    if (!item) return res.status(404).json({ ok:false, error:'Recycle item not found' });

    const msg = { ...(item.message || {}) };
    delete msg._id;
    const originalMessageId = String(item.originalMessageId || msg.id || rawId.slice(8) || '').trim();
    const originalGroupId = normalizeGroupId(item.deletedGroupId || msg.groupId || DEFAULT_GROUP_ID);
    if (!originalMessageId) return res.status(400).json({ ok:false, error:'Invalid message' });

    const mainCopy = {
      originalMessageId,
      groupId: DEFAULT_GROUP_ID,
      deletedGroupId: originalGroupId,
      deletedGroupName: String(item.deletedGroupName || msg.groupName || originalGroupId),
      deletedAt: item.deletedAt || msg.deletedAt || new Date(),
      deleteReason: item.deleteReason || msg.deleteReason || 'delete',
      recycleStage: 'main',
      movedToMainRecycleAt: new Date(),
      message: { ...msg, groupId: originalGroupId }
    };

    // IMPORTANT: Main Recycle gets its own document. Never rename/mutate the
    // Group Recycle document into Main Recycle.
    const existingMain = await recycle.findOne({ originalMessageId, recycleStage:'main' });
    if (!existingMain) {
      try {
        await recycle.insertOne(mainCopy);
      } catch (insertError) {
        // Older deployments may still have a legacy UNIQUE index on
        // originalMessageId/deletedGroupId. That index can make a valid
        // Group -> Main copy fail with MongoDB E11000. Remove only those
        // legacy unique indexes and retry the insert once.
        if (insertError && insertError.code === 11000) {
          try {
            const indexes = await recycle.listIndexes().toArray();
            for (const idx of indexes) {
              if (idx.name === '_id_') continue;
              const keys = idx.key || {};
              const names = Object.keys(keys);
              if (idx.unique && names.some(k => ['originalMessageId','deletedGroupId','groupId'].includes(k))) {
                try { await recycle.dropIndex(idx.name); } catch (_) {}
              }
            }
          } catch (_) {}
          await recycle.insertOne(mainCopy);
        } else {
          throw insertError;
        }
      }
    }

    // Mark the original soft-deleted message as moved to Main. This is important:
    // Group Recycle -> Empty must never remove a message that has already been
    // copied into Main Recycle.
    if (originalMessageId) {
      try {
        await collection.updateOne(
          { id: originalMessageId, deletedAt: { $exists: true } },
          { $set: { movedToMainRecycleAt: new Date(), recycleStage: 'main' } }
        );
      } catch (_) {}
    }

    // Only after the Main copy exists do we remove the Group Recycle record.
    if (recycleId) {
      await recycle.deleteOne({ _id: recycleId });
    }

    res.json({ ok:true, moved:true });
  } catch (error) {
    console.error('Move recycle item to main failed:', error.stack || error.message);
    res.status(500).json({ ok:false, error:`Move to main failed: ${error.message || 'unknown error'}` });
  }
});

app.post('/api/admin/recycle-bin/restore', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok:false, error:'Database unavailable' });
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const collection = db.collection(COLLECTION_NAME);
    let item = null;
    let recycleId = null;
    const rawId = String(req.body?.id || '');
    if (ObjectId.isValid(rawId)) {
      recycleId = new ObjectId(rawId);
      item = await recycle.findOne({ _id:recycleId });
    }
    if (!item && rawId.startsWith('message:')) {
      const messageId = rawId.slice(8);
      const msg = await collection.findOne({ id:messageId, deletedAt:{ $exists:true } });
      if (msg) item = { originalMessageId:messageId, message:msg, deletedGroupId:msg.groupId };
    }
    if (!item) return res.status(404).json({ ok:false, error:'Recycle item not found' });

    const msg = { ...(item.message || {}) };
    delete msg._id; delete msg.deletedAt; delete msg.deletedBy; delete msg.deleteReason; delete msg.deletedGroupId;
    msg.id = String(item.originalMessageId || msg.id);
    msg.groupId = normalizeGroupId(item.deletedGroupId || msg.groupId || item.groupId);
    const existing = await collection.findOne({ id:msg.id, groupId:msg.groupId });
    if (existing && !existing.deletedAt) return res.status(409).json({ ok:false, error:'Message already exists' });
    if (existing) await collection.replaceOne({ _id:existing._id }, msg);
    else await collection.insertOne(msg);
    if (recycleId) await recycle.deleteOne({ _id:recycleId });
    else await collection.updateOne({ id:msg.id, groupId:msg.groupId }, { $unset:{ deletedAt:'', deletedBy:'', deleteReason:'' } });
    const event = { message: msg, groupId: msg.groupId };
    io.to(`group:${normalizeGroupId(msg.groupId)}`).emit('restore-message', event);
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
    if (!db) return res.status(503).json({ ok:false, error:'Database unavailable' });
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const rawId = String(req.body?.id || '').trim();
    let item = null;
    let recycleId = null;
    if (ObjectId.isValid(rawId)) { recycleId = new ObjectId(rawId); item = await recycle.findOne({ _id:recycleId }); }
    if (!item && rawId.startsWith('message:')) {
      const messageId = rawId.slice(8);
      const msg = await collection.findOne({ id:messageId, deletedAt:{ $exists:true } });
      if (msg) item = { id:rawId, originalMessageId:messageId, message:msg, deletedGroupId:msg.groupId, deletedGroupName:msg.groupName, recycleStage:'group' };
    }
    if (!item) return res.status(404).json({ ok:false, error:'Recycle item not found' });

    // GROUP RECYCLE DELETE IS NEVER PERMANENT.
    // It always transfers the item to Main Recycle. Only deleting from Main
    // Recycle can permanently remove the message/media.
    const stage = String(item.recycleStage || '').toLowerCase();
    const isGroupItem = stage === 'group' || (stage !== 'main' && String(item.groupId || '') !== DEFAULT_GROUP_ID);
    if (isGroupItem) {
      const msg = { ...(item.message || {}) };
      delete msg._id;
      const originalMessageId = String(item.originalMessageId || msg.id || rawId.slice(8) || '').trim();
      const originalGroupId = normalizeGroupId(item.deletedGroupId || msg.groupId || DEFAULT_GROUP_ID);
      if (!originalMessageId) return res.status(400).json({ ok:false, error:'Invalid message' });

      const mainCopy = {
        originalMessageId,
        groupId: DEFAULT_GROUP_ID,
        deletedGroupId: originalGroupId,
        deletedGroupName: String(item.deletedGroupName || msg.groupName || originalGroupId),
        deletedAt: item.deletedAt || msg.deletedAt || new Date(),
        deleteReason: item.deleteReason || msg.deleteReason || 'delete',
        recycleStage: 'main',
        movedToMainRecycleAt: new Date(),
        message: { ...msg, groupId: originalGroupId }
      };

      const existingMain = await recycle.findOne({ originalMessageId, recycleStage:'main' });
      if (!existingMain) {
        try { await recycle.insertOne(mainCopy); }
        catch (insertError) {
          if (insertError?.code !== 11000) throw insertError;
          try {
            const indexes = await recycle.listIndexes().toArray();
            for (const idx of indexes) {
              if (idx.name === '_id_') continue;
              const names = Object.keys(idx.key || {});
              if (idx.unique && names.some(k => ['originalMessageId','deletedGroupId','groupId'].includes(k))) {
                try { await recycle.dropIndex(idx.name); } catch (_) {}
              }
            }
          } catch (_) {}
          await recycle.insertOne(mainCopy);
        }
      }
      try {
        await collection.updateOne(
          { id: originalMessageId, deletedAt:{ $exists:true } },
          { $set:{ movedToMainRecycleAt:new Date(), recycleStage:'main' } }
        );
      } catch (_) {}
      if (recycleId) await recycle.deleteOne({ _id:recycleId });
      return res.json({ ok:true, moved:true, permanent:false });
    }

    // MAIN RECYCLE DELETE = PERMANENT DELETE.
    if (item.message?.mediaId) {
      try { await (await getMediaBucket()).delete(new ObjectId(String(item.message.mediaId))); } catch (_) {}
    }
    if (recycleId) await recycle.deleteOne({ _id:recycleId });

    // Remove the soft-deleted source only when no recycle history remains for it.
    const originalMessageId = String(item.originalMessageId || '');
    if (originalMessageId) {
      const remaining = await recycle.countDocuments({ originalMessageId });
      if (!remaining) await collection.deleteOne({ id:originalMessageId, deletedAt:{ $exists:true } });
    }
    res.json({ ok:true, permanent:true });
  } catch (error) {
    console.error('Admin recycle delete failed:', error.message);
    res.status(500).json({ ok:false, error:'Recycle delete failed' });
  }
});

app.post('/api/admin/recycle-bin/download', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD && String(req.body?.password || '') !== DOWNLOAD_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok:false, error:'Database unavailable' });
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const rawId = String(req.body?.id || '');
    let item = null;
    if (ObjectId.isValid(rawId)) item = await recycle.findOne({ _id:new ObjectId(rawId) });
    if (!item && rawId.startsWith('message:')) {
      const messageId = rawId.slice(8);
      const msg = await collection.findOne({ id:messageId, deletedAt:{ $exists:true } });
      if (msg) item = { id:rawId, originalMessageId:messageId, message:msg };
    }
    if (!item) return res.status(404).json({ ok:false, error:'Recycle item not found' });
    const mediaId = item.message?.mediaId || item.mediaId;
    if (!mediaId || !ObjectId.isValid(String(mediaId))) return res.status(404).json({ ok:false, error:'No downloadable media' });
    const bucket = await getMediaBucket();
    const fileId = new ObjectId(String(mediaId));
    const files = await bucket.find({ _id:fileId }).toArray();
    if (!files.length) return res.status(404).json({ ok:false, error:'Media file not found' });
    const file = files[0];
    const mime = file.metadata?.mime || 'application/octet-stream';
    const safeName = String(file.metadata?.fileName || file.filename || `media-${fileId}`).replace(/[\\"\r\n]/g, '_');
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
    if (!db) return res.status(503).json({ ok:false, error:'Database unavailable' });
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const requestedGroupId = req.body?.groupId ? normalizeGroupId(req.body.groupId) : null;

    // GROUP RECYCLE: Empty means MOVE TO MAIN, never permanent deletion.
    if (requestedGroupId && requestedGroupId !== DEFAULT_GROUP_ID) {
      const filter = { $and:[
        { $or:[{deletedGroupId:requestedGroupId},{groupId:requestedGroupId}] },
        { $or:[{recycleStage:'group'},{recycleStage:{$exists:false}}] }
      ] };
      const groupDocs = await recycle.find(filter).toArray();
      const softItems = await collection.find({
        deletedAt:{$exists:true}, movedToMainRecycleAt:{$exists:false},
        $or:[{groupId:requestedGroupId},{deletedGroupId:requestedGroupId}]
      }).toArray();
      let movedCount = 0;
      let skipped = 0;

      const dropLegacyUniqueIndexes = async () => {
        try {
          const indexes = await recycle.listIndexes().toArray();
          for (const idx of indexes) {
            if (idx.name === '_id_') continue;
            const names = Object.keys(idx.key || {});
            if (idx.unique && names.some(k => ['originalMessageId','deletedGroupId','groupId'].includes(k))) {
              try { await recycle.dropIndex(idx.name); } catch (_) {}
            }
          }
        } catch (_) {}
      };

      const putMainCopy = async (item, fallbackMsg) => {
        const msg = { ...(item.message || fallbackMsg || {}) };
        delete msg._id;
        const originalMessageId = String(item.originalMessageId || msg.id || '').trim();
        if (!originalMessageId) return false;
        const originalGroupId = normalizeGroupId(item.deletedGroupId || msg.groupId || requestedGroupId);
        const mainCopy = {
          originalMessageId, groupId:DEFAULT_GROUP_ID,
          deletedGroupId:originalGroupId,
          deletedGroupName:String(item.deletedGroupName || msg.groupName || originalGroupId),
          deletedAt:item.deletedAt || msg.deletedAt || new Date(),
          deleteReason:item.deleteReason || msg.deleteReason || 'delete',
          recycleStage:'main', movedToMainRecycleAt:new Date(),
          message:{...msg, groupId:originalGroupId}
        };
        if (!(await recycle.findOne({originalMessageId,recycleStage:'main'}))) {
          try { await recycle.insertOne(mainCopy); }
          catch (e) {
            if (e?.code !== 11000) throw e;
            await dropLegacyUniqueIndexes();
            try { await recycle.insertOne(mainCopy); }
            catch (e2) {
              // A concurrent request may have created the Main copy.
              if (e2?.code !== 11000) throw e2;
            }
          }
        }
        await collection.updateOne(
          {id:originalMessageId, deletedAt:{$exists:true}},
          {$set:{movedToMainRecycleAt:new Date(), recycleStage:'main'}}
        );
        return true;
      };

      // Move dedicated Group Recycle records first. Do NOT delete media here:
      // the Main Recycle copy still needs its mediaId for View/Download.
      for (const item of groupDocs) {
        try {
          if (await putMainCopy(item, null)) {
            await recycle.deleteOne({_id:item._id});
            movedCount++;
          } else skipped++;
        } catch (e) { skipped++; console.error('Group empty move failed:', e.stack || e.message); }
      }

      // Also recover soft-deleted messages that were never archived successfully.
      for (const msg of softItems) {
        try {
          if (await putMainCopy({
            originalMessageId:msg.id, deletedGroupId:msg.groupId,
            deletedGroupName:msg.groupName, deletedAt:msg.deletedAt,
            deleteReason:msg.deleteReason, message:msg
          }, msg)) {
            movedCount++;
          } else skipped++;
        } catch (e) { skipped++; console.error('Soft group empty move failed:', e.stack || e.message); }
      }

      return res.json({ok:true,count:movedCount,moved:true,permanent:false,skipped});
    }

    // MAIN RECYCLE: this is the ONLY Empty operation that permanently deletes.
    const filter = { $or:[{recycleStage:'main'},{recycleStage:{$exists:false},groupId:DEFAULT_GROUP_ID}] };
    const recycleItems = await recycle.find(filter,{projection:{'message.mediaId':1}}).toArray();
    const mediaIds = new Set();
    for (const item of recycleItems) if (item.message?.mediaId) mediaIds.add(String(item.message.mediaId));
    const mainSoftFilter = {deletedAt:{$exists:true},movedToMainRecycleAt:{$exists:true}};
    const softItems = await collection.find(mainSoftFilter,{projection:{mediaId:1}}).toArray();
    for (const item of softItems) if (item.mediaId) mediaIds.add(String(item.mediaId));
    const bucket = await getMediaBucket();
    for (const mediaId of mediaIds) if (ObjectId.isValid(mediaId)) { try { await bucket.delete(new ObjectId(mediaId)); } catch (_) {} }
    const recycleResult = await recycle.deleteMany(filter);
    const messageResult = await collection.deleteMany(mainSoftFilter);
    return res.json({ok:true,count:(recycleResult.deletedCount||0)+(messageResult.deletedCount||0),permanent:true});
  } catch (error) {
    console.error('Admin recycle empty failed:', error.stack || error.message);
    res.status(500).json({ok:false,error:`Empty recycle bin failed: ${error.message || 'unknown error'}`});
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
  const visibleFilter = { $and: [groupFilter, { deletedAt: { $exists: false } }] };
  const query = after ? { $and: [visibleFilter, { createdAt: { $gte: new Date(after) } }] } : visibleFilter;
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

app.get('/api/messages/deleted', async (req, res) => {
  try {
    const groupId = normalizeGroupId(req.query?.groupId);
    const collection = await getCollection();
    if (!collection) return res.json({ ok:true, ids:[] });
    const groupFilter = { $or: [{ groupId }, ...(groupId === DEFAULT_GROUP_ID ? [{ groupId: { $exists:false } }] : [])] };
    const docs = await collection.find(
      { $and: [groupFilter, { deletedAt:{ $exists:true } }] },
      { projection:{ _id:0, id:1 } }
    ).toArray();
    res.setHeader('Cache-Control','no-store');
    res.json({ ok:true, ids:docs.map(x=>String(x.id)).filter(Boolean) });
  } catch (error) {
    console.error('Failed to load deleted message ids:', error.message);
    res.status(500).json({ ok:false, ids:[] });
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
  const groupId = normalizeGroupId(msg.groupId);
  await collection.updateOne({ id: msg.id, groupId }, { $setOnInsert: saved }, { upsert: true });
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
    const groupId = normalizeGroupId(msg.groupId);
    const query = senderUserId
      ? { groupId, userId: { $ne: senderUserId } }
      : { groupId, userId: { $exists: true } };
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
  io.to(`group:${normalizeGroupId(saved.groupId)}`).emit(event, saved);
  if (event === 'media') {
    for (const adminSocket of io.sockets.sockets.values()) {
      if (adminSocket.isAdmin) adminSocket.emit('admin-media-alert', saved);
    }
  }
  publishRealtimeEvent(event, saved);
  if (event === 'message' || event === 'media') await sendPushToOtherUsers(saved);
  return saved;
}

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);
  const uploads = new Map();

  socket.on('register-user', (data) => {
    socket.userId = data && data.userId ? String(data.userId) : '';
    if (data && data.peerId) socket.callPeerId = String(data.peerId).slice(0,240);
    if (data && data.deviceId) socket.callDeviceId = String(data.deviceId).slice(0,160);
  });

  socket.on('register-admin', (data, ack) => {
    const ok = String(data?.password || '') === ADMIN_PASSWORD;
    socket.isAdmin = ok;
    if (typeof ack === 'function') ack({ ok });
  });

  socket.on('join-group', async (data, ack) => {
    const groupId = normalizeGroupId(data?.groupId);
    const previousGroupId = socket.groupId;
    if (previousGroupId) socket.leave(`group:${normalizeGroupId(previousGroupId)}`);
    socket.groupId = groupId;
    socket.join(`group:${groupId}`);
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
      io.to(`group:${groupId}`).emit('message-updated', event);
      publishRealtimeEvent('message-updated', event);
      if (typeof ack === 'function') ack({ok:true, message:updated});
    } catch (error) {
      console.error('Failed to update message:', error.message);
      if (typeof ack === 'function') ack({ok:false});
    }
  });

  socket.on('delete-message', async (data, ack) => {
    if (!data || !data.id) return;
    const groupId = normalizeGroupId(socket.groupId);
    const deleteEvent = { id: data.id, groupId };
    try {
      const collection = await getCollection();
      if (collection) {
        const groupFilter = { $or: [{ groupId }, ...(groupId === DEFAULT_GROUP_ID ? [{ groupId: { $exists: false } }] : [])] };
        const existing = await collection.findOne({ $and: [groupFilter, { id: String(data.id) }, { deletedAt: { $exists:false } }] });
        if (existing) {
          await moveMessagesToRecycleBin([existing], groupId, 'message-delete');
          await collection.updateOne({ _id: existing._id }, { $set: { deletedAt: new Date(), deletedBy: String(socket.userId || ''), deleteReason: 'message-delete' } });
        }
      }
      // Persist first, then broadcast. This prevents another Vercel instance's
      // reconciliation request from briefly re-adding a just-deleted message.
      io.to(`group:${groupId}`).emit('delete-message', deleteEvent);
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

        if (existing.length) {
          await moveMessagesToRecycleBin(existing, groupId, 'message-delete');
          await collection.updateMany({ $and: [groupFilter, { id: { $in: ids } }, { deletedAt: { $exists:false } }] }, { $set: { deletedAt: new Date(), deletedBy: String(socket.userId || ''), deleteReason: 'message-delete' } });
        }
      }

      const event = { ids, groupId };
      io.to(`group:${groupId}`).emit('delete-messages', event);
      publishRealtimeEvent('delete-messages', event);
      if (typeof ack === 'function') ack({ ok: true, count: ids.length });
    } catch (error) {
      console.error('Failed to delete multiple messages:', error.message);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  socket.on('typing', (data) => {
    if (!data || !socket.groupId || normalizeGroupId(data.groupId) !== normalizeGroupId(socket.groupId)) return;
    io.to(`group:${normalizeGroupId(socket.groupId)}`).emit('typing', { groupId: normalizeGroupId(socket.groupId), userId: socket.userId || String(data.userId || ''), name: String(data.name || '').slice(0,60), active: !!data.active });
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
    io.to(`group:${readEvent.groupId}`).emit('message-read', readEvent);
    publishRealtimeEvent('message-read', readEvent);
  });

  socket.on('message-delivered', async (data) => {
    if (!data || !data.id || !socket.userId) return;
    const receiverId = String(socket.userId);
    try {
      const collection = await getCollection();
      if (collection) {
        await collection.updateOne({ id: data.id, groupId: normalizeGroupId(socket.groupId) }, { $addToSet: { deliveredTo: receiverId } });
      }
    } catch (error) {
      console.error('Failed to save delivery receipt:', error.message);
    }
    const deliveredEvent = { id: data.id, userId: receiverId, groupId: normalizeGroupId(socket.groupId) };
    io.to(`group:${deliveredEvent.groupId}`).emit('message-delivered', deliveredEvent);
    publishRealtimeEvent('message-delivered', deliveredEvent);
  });

  socket.on('clear-chat', async () => {
    try {
      const collection = await getCollection();
      if (collection) {
        const gid = normalizeGroupId(socket.groupId);
        const groupFilter = { $or: [{ groupId: gid }, ...(gid === DEFAULT_GROUP_ID ? [{ groupId: { $exists: false } }] : [])] };
        const allMessages = await collection.find(groupFilter).toArray();
        if (allMessages.length) {
          await moveMessagesToRecycleBin(allMessages, gid, 'clear-chat');
          await collection.updateMany({ $and: [groupFilter, { deletedAt: { $exists:false } }] }, { $set: { deletedAt: new Date(), deletedBy: String(socket.userId || ''), deleteReason: 'clear-chat' } });
        }
      }
      // Persist first, then broadcast so every instance is immediately consistent.
      const clearEvent = { groupId: normalizeGroupId(socket.groupId) };
      io.to(`group:${clearEvent.groupId}`).emit('clear-chat', clearEvent);
      publishRealtimeEvent('clear-chat', clearEvent);
    } catch (error) {
      console.error('Failed to clear chat:', error.message);
    }
  });


  // ---- WebRTC group audio/video call signaling ----
  socket.on('call-start', async (data, ack) => {
    const groupId = normalizeGroupId(socket.groupId || data?.groupId);
    const type = data?.type === 'audio' ? 'audio' : 'video';
    const callId = String(data?.callId || crypto.randomUUID()).slice(0, 100);
    const existing = [...activeCalls.values()].find(c => c.groupId === groupId);
    if (existing) return typeof ack === 'function' && ack({ ok: false, error: 'A call is already active in this group.' });
    const call = {
      callId, groupId, type, participants: new Set([socket.id]),
      startedBy: socket.id, startedByUserId: String(socket.userId || data?.userId || ''),
      startedByName: String(data?.name || '').slice(0, 60), createdAt: Date.now()
    };
    activeCalls.set(callId, call);
    socket.join(callRoom(groupId)); socket.callId = callId; socket.callType = type;
    io.to(callRoom(groupId)).emit('incoming-call', {
      callId, groupId, type, fromSocketId: socket.id,
      fromUserId: call.startedByUserId, fromName: call.startedByName
    });
    if (typeof ack === 'function') ack({ ok: true, callId, type });
  });

  socket.on('call-join', async (data, ack) => {
    const callId = String(data?.callId || ''), call = activeCalls.get(callId);
    const requestedGroupId = normalizeGroupId(data?.groupId || socket.groupId);
    if (!call) {
      return typeof ack === 'function' && ack({ ok: false, error: 'Call is no longer active.' });
    }
    if (requestedGroupId !== call.groupId || normalizeGroupId(socket.groupId) !== call.groupId) {
      return typeof ack === 'function' && ack({ ok: false, error: 'This call belongs to another group.' });
    }
    socket.join(callRoom(call.groupId)); socket.callId = callId; socket.callType = call.type;
    const peers = [...call.participants].filter(id => id !== socket.id);
    call.participants.add(socket.id);
    socket.to(callRoom(call.groupId)).emit('call-peer-joined', {
      callId, socketId: socket.id, userId: String(socket.userId || data?.userId || ''),
      name: String(data?.name || '').slice(0, 60)
    });
    if (typeof ack === 'function') ack({ ok: true, callId, type: call.type, peers });
  });

  socket.on('call-signal', (data) => {
    const callId = String(data?.callId || ''), call = activeCalls.get(callId);
    if (!call || !call.participants.has(socket.id)) return;
    const to = String(data?.to || '');
    if (!to || !call.participants.has(to)) return;
    io.to(to).emit('call-signal', {
      callId, from: socket.id, kind: String(data?.kind || ''), data: data?.data || null
    });
  });

  socket.on('call-leave', (data) => {
    const callId = String(data?.callId || socket.callId || ''), call = activeCalls.get(callId);
    if (!call) return;
    const name = String(data?.name || '').slice(0, 60);
    // If ANY participant presses End/Close, terminate the whole group call for everyone.
    io.to(callRoom(call.groupId)).emit('call-ended', {
      callId, reason: 'ended', endedBy: socket.id, name
    });
    for (const participantId of call.participants) {
      const participantSocket = io.sockets.sockets.get(participantId);
      if (participantSocket) {
        participantSocket.leave(callRoom(call.groupId));
        participantSocket.callId = '';
        participantSocket.callType = '';
      }
    }
    activeCalls.delete(callId);
  });

  socket.on('call-reject', (data) => {
    const callId = String(data?.callId || ''), call = activeCalls.get(callId);
    if (!call) return;
    const name = String(data?.name || '').slice(0, 60);
    // If ANY group member declines, terminate the whole group call for everyone.
    io.to(callRoom(call.groupId)).emit('call-ended', {
      callId, reason: 'declined', declinedBy: socket.id, name
    });
    for (const participantId of call.participants) {
      const participantSocket = io.sockets.sockets.get(participantId);
      if (participantSocket) {
        participantSocket.callId = '';
        participantSocket.callType = '';
      }
    }
    activeCalls.delete(callId);
  });

  socket.on('disconnect', (reason) => {
    removeSocketFromCalls(socket);
    for (const upload of uploads.values()) { try { upload.stream.destroy(); } catch (_) {} }
    uploads.clear();
    console.log('User disconnected:', socket.id, reason);
  });
});

if (!process.env.VERCEL) {
  httpServer.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = httpServer;
