const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const webpush = require('web-push');
const crypto = require('crypto');
const zlib = require('zlib');

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
const USER_PROFILES_COLLECTION_NAME = 'user_profiles';
const MAX_MEDIA_CHUNK = 768 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'deoxy';
const DOWNLOAD_PASSWORD = process.env.DOWNLOAD_PASSWORD || 'kmkm';
const DEFAULT_GROUP_ID = 'main';
const fallbackUsers = new Map();
function makeDirectChatId(a, b) {
  const ids = [String(a || '').trim(), String(b || '').trim()].sort();
  return 'dm-' + crypto.createHash('sha256').update(ids.join(':')).digest('hex').slice(0, 48);
}
function isDirectChatId(id) { return /^dm-[a-f0-9]{48}$/.test(String(id || '')); }
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
    if (payload === undefined) return;
    const gid = normalizeGroupId(payload?.groupId);
    // Realtime events are always scoped to their originating group. Never
    // broadcast a group message/event to every connected socket.
    if (gid) io.to(`group:${gid}`).emit(event.event, payload);
    if ((event.event === 'message' || event.event === 'media') && payload?.id) {
      sendNativeRealtimeNotification(payload).catch(() => {});
    }

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

async function getUserProfilesCollection() {
  const db = await getDb();
  return db ? db.collection(USER_PROFILES_COLLECTION_NAME) : null;
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

app.post('/api/notifications/access', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const groupId = normalizeGroupId(req.body?.groupId || '');
    if (!userId || !groupId) return res.status(400).json({ ok: false });
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false });
    await db.collection('notification_access').updateOne(
      { userId, groupId },
      { $set: { userId, groupId, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Notification access save failed:', error.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/api/notifications/poll', async (req, res) => {
  try {
    const userId = String(req.query?.userId || '').trim();
    const after = String(req.query?.after || '').trim();
    if (!userId) return res.json({ ok: true, messages: [] });
    const collection = await getCollection();
    const db = await getDb();
    if (!collection || !db) return res.json({ ok: true, messages: [] });

    // Notification access is granted only after the user successfully joins a
    // password-protected group. This keeps background notifications group-scoped
    // without requiring Firebase or trusting arbitrary group IDs from the app.
    const access = await db.collection('notification_access').find({ userId }).project({ _id: 0, groupId: 1 }).toArray();
    const groupIds = access.map(x => normalizeGroupId(x.groupId)).filter(Boolean);
    if (!groupIds.length) return res.json({ ok: true, messages: [] });

    const filter = {
      groupId: { $in: groupIds },
      userId: { $ne: userId },
      deletedAt: { $exists: false },
      readBy: { $ne: userId }
    };
    if (after) {
      const d = new Date(after);
      if (!Number.isNaN(d.getTime())) filter.createdAt = { $gt: d };
    }
    const messages = await collection.find(filter, { projection: { _id: 0, id: 1, groupId: 1, user: 1, message: 1, createdAt: 1 } })
      .sort({ createdAt: 1 }).limit(50).toArray();

    const settings = db.collection(GROUP_SETTINGS_COLLECTION_NAME);
    const ids = [...new Set(messages.map(m => normalizeGroupId(m.groupId)))];
    const groups = await settings.find({ _id: { $in: ids } }, { projection: { _id: 1, name: 1 } }).toArray();
    const groupNames = new Map(groups.map(g => [String(g._id), String(g.name || 'WhatsApp')]));

    res.json({ ok: true, messages: messages.map(m => ({
      ...m,
      createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt || ''),
      groupName: groupNames.get(String(m.groupId || '')) || String(m.groupId || 'WhatsApp')
    })) });
  } catch (error) {
    console.error('Notification poll failed:', error.message);
    res.status(500).json({ ok: false, messages: [] });
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

app.post('/api/admin/users', async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ ok:false, error:'Name is required' });
    const userPassword = String(req.body?.userPassword || '').trim().slice(0, 120);
    if (!userPassword) return res.status(400).json({ ok:false, error:'User password is required' });
    const makeId = () => 'WA-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const profiles = await getUserProfilesCollection();
    let userId = makeId();
    for (let i=0; i<10; i++) {
      const exists = profiles ? await profiles.findOne({ _id:userId }) : fallbackUsers.get(userId);
      if (!exists) break;
      userId = makeId();
    }
    const now = new Date();
    const user = { _id:userId, name, userPassword, createdAt:now, updatedAt:now, adminCreated:true, enabled:true };
    if (profiles) await profiles.insertOne(user);
    fallbackUsers.set(userId, { id:userId, name, userPassword, updatedAt:now, adminCreated:true, enabled:true });
    io.emit('user-registered', { userId, name });
    res.json({ ok:true, user:{ id:userId, name, userPassword } });
  } catch (error) {
    console.error('Admin user creation failed:', error.message);
    res.status(500).json({ ok:false, error:'Could not create user' });
  }
});

app.post('/api/admin/users/list', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ok:false,error:'Unauthorized'});
    const profiles = await getUserProfilesCollection();
    let users = profiles ? await profiles.find({ adminCreated:true, deleted:{$ne:true}, deletedAt:{$exists:false} }).sort({name:1,_id:1}).limit(1000).toArray() : [...fallbackUsers.values()].filter(u=>u.adminCreated===true && u.deleted!==true && !u.deletedAt);
    res.json({ok:true, users:users.map(u=>({id:String(u._id||u.id),name:String(u.name||''),userPassword:String(u.userPassword||''),enabled:u.enabled!==false}))});
  } catch(e){ res.status(500).json({ok:false,error:'Could not load users'}); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    if (String(req.body?.adminPassword || '') !== ADMIN_PASSWORD) return res.status(403).json({ok:false,error:'Unauthorized'});
    const id = String(req.params.id || '').trim().toUpperCase();
    if (!id) return res.status(400).json({ok:false,error:'User ID is required'});
    const profiles = await getUserProfilesCollection();
    const now = new Date();
    if (profiles) {
      const r = await profiles.updateOne({_id:id}, {$set:{deleted:true, deletedAt:now, enabled:false, updatedAt:now}});
      if (!r.matchedCount) return res.status(404).json({ok:false,error:'User not found'});
    }
    const old = fallbackUsers.get(id);
    if (old) fallbackUsers.set(id,{...old,id,deleted:true,deletedAt:now,enabled:false,updatedAt:now});
    io.emit('user-deleted',{userId:id});
    res.json({ok:true,userId:id});
  } catch(e) { console.error('Admin user delete failed:',e.message); res.status(500).json({ok:false,error:'Could not delete user'}); }
});

app.put('/api/admin/users/:id', async (req, res) => {
  try {
    if (String(req.body?.adminPassword || '') !== ADMIN_PASSWORD) return res.status(403).json({ok:false,error:'Unauthorized'});
    const id=String(req.params.id||'').trim().toUpperCase();
    const name=String(req.body?.name||'').trim().slice(0,60);
    const userPassword=String(req.body?.userPassword||'').trim().slice(0,120);
    if(!id || !name || !userPassword) return res.status(400).json({ok:false,error:'Name and password are required'});
    const profiles=await getUserProfilesCollection();
    const update={name,userPassword,updatedAt:new Date()};
    if(profiles){ const r=await profiles.updateOne({_id:id},{$set:update}); if(!r.matchedCount) return res.status(404).json({ok:false,error:'User not found'}); }
    const old=fallbackUsers.get(id)||{id}; fallbackUsers.set(id,{...old,id,name,userPassword,updatedAt:new Date(),enabled:old.enabled!==false,adminCreated:true});
    io.emit('user-renamed',{userId:id,name});
    res.json({ok:true,user:{id,name,userPassword}});
  } catch(e){ res.status(500).json({ok:false,error:'Could not update user'}); }
});

app.post('/api/users/verify-password', async (req,res)=>{
  try {
    const userId=String(req.body?.userId||'').trim().toUpperCase();
    const password=String(req.body?.password||'');
    const profiles=await getUserProfilesCollection();
    const user=profiles ? await profiles.findOne({_id:userId}) : fallbackUsers.get(userId);
    if(!user || user.adminCreated !== true || user.deleted === true || user.deletedAt || user.enabled===false) return res.status(404).json({ok:false,error:'User not found'});
    if(String(user.userPassword||'')!==password) return res.status(401).json({ok:false,error:'Wrong password'});
    res.json({ok:true});
  } catch(e){ res.status(500).json({ok:false,error:'Could not verify password'}); }
});

app.get('/api/users', async (req, res) => {
  try {
    const exclude = String(req.query?.exclude || '').trim();
    const profiles = await getUserProfilesCollection();
    let users = [];
    if (profiles) {
      const activeFilter = exclude ? { _id: { $ne: exclude }, adminCreated: true, enabled: { $ne: false }, deleted: { $ne: true }, deletedAt: { $exists: false } } : { adminCreated: true, enabled: { $ne: false }, deleted: { $ne: true }, deletedAt: { $exists: false } };
      users = await profiles.find(activeFilter).project({ _id: 1, name: 1, updatedAt: 1, enabled: 1 }).sort({ name: 1, _id: 1 }).limit(500).toArray();
    } else {
      users = [...fallbackUsers.values()].filter(u => u.adminCreated === true && u.enabled !== false && u.deleted !== true && !u.deletedAt && (!exclude || String(u.id) !== exclude));
    }
    res.setHeader('Cache-Control','no-store');
    res.json({ ok:true, users: users.map(u => ({ id:String(u._id || u.id), name:String(u.name || u._id || u.id).slice(0,60) })) });
  } catch (error) {
    console.error('Failed to load users:', error.message);
    res.json({ ok:true, users:[] });
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
    const recordingStartHeader = String(req.headers['x-recording-start'] || '');
    const recordingEndHeader = String(req.headers['x-recording-end'] || '');
    const requestedDurationMs = Number(req.headers['x-recording-duration-ms'] || 0);
    const recordingStart = new Date(recordingStartHeader);
    const recordingEnd = new Date(recordingEndHeader);
    const validStart = Number.isNaN(recordingStart.getTime()) ? new Date() : recordingStart;
    const validEnd = Number.isNaN(recordingEnd.getTime()) ? new Date() : recordingEnd;
    const durationMs = Math.max(0, Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
      ? requestedDurationMs : validEnd.getTime() - validStart.getTime());
    if (!callId || !feedId || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Invalid recording.' });
    const groupDoc = await (await getGroupSettingsCollection())?.findOne({ _id: groupId });
    const pad = n => String(n).padStart(2,'0');
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const sec = totalSeconds % 60;
    const datePart = `${validStart.getFullYear()}-${pad(validStart.getMonth()+1)}-${pad(validStart.getDate())}`;
    const timePart = `${pad(validStart.getHours())}-${pad(validStart.getMinutes())}-${pad(validStart.getSeconds())}`;
    const durationPart = `${pad(h)}h${pad(m)}m${pad(sec)}s`;
    const safeFeed = feedName.replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40) || 'Participant';
    const filename = `${datePart}_${timePart}_${durationPart}.webm`;
    // Recordings are organized user-wise in the downloadable archive. Every
    // recording made by the same participant (across multiple calls) stays in
    // that participant's folder.
    const folderPath = safeFeed;
    const upload = bucket.openUploadStream(filename, {
      contentType: mime,
      metadata: { kind: 'call-recording', callId, groupId, groupName: groupDoc?.name || groupId, feedId, feedName, userId, folderPath, recordingStart: validStart, recordingEnd: validEnd, durationMs, createdAt: new Date() }
    });
    await new Promise((resolve, reject) => {
      upload.once('finish', resolve); upload.once('error', reject); upload.end(req.body);
    });
    const createdAt = new Date();
    await db.collection(CALL_RECORDINGS_COLLECTION_NAME).insertOne({
      fileId: upload.id, filename, callId, groupId, groupName: groupDoc?.name || groupId,
      feedId, feedName, userId, folderPath, mime, size: req.body.length, recordingStart: validStart, recordingEnd: validEnd, durationMs, createdAt
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
    res.json({ ok: true, recordings: recordings.map(r => ({ id: String(r.fileId), fileId: String(r.fileId), callId: r.callId, groupId: r.groupId, groupName: r.groupName, feedId: r.feedId, feedName: r.feedName, userId: r.userId, folderPath: r.folderPath || r.feedName || r.userId || 'Participant', recordingStart: r.recordingStart, recordingEnd: r.recordingEnd, durationMs: r.durationMs, filename: r.filename, mime: r.mime, size: r.size, createdAt: r.createdAt })) });
  } catch (error) { res.status(500).json({ ok: false, error: 'Could not load recordings.' }); }
});


// Download all call recordings as one ZIP archive.
// Admin media folders: photos and videos received in group chats.
app.post('/api/admin/group-media/delete', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ok:false,error:'Unauthorized'});
    const mediaId = String(req.body?.mediaId || '');
    const messageId = String(req.body?.messageId || '');
    const db = await getDb();
    if (!db) return res.status(503).json({ok:false,error:'Database unavailable'});
    if (messageId) await db.collection(COLLECTION_NAME).deleteOne({id:messageId});
    if (ObjectId.isValid(mediaId)) { try { await (await getMediaBucket()).delete(new ObjectId(mediaId)); } catch (_) {} }
    res.json({ok:true});
  } catch (error) {
    console.error('Admin group media delete failed:', error.message);
    res.status(500).json({ok:false,error:'Could not delete group media'});
  }
});

app.post('/api/admin/group-media', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) {
      return res.status(403).json({ ok:false, error:'Unauthorized' });
    }
    const db = await getDb();
    if (!db) return res.json({ ok:true, media:[] });

    const type = String(req.body?.type || '');
    if (!['image','video'].includes(type)) {
      return res.status(400).json({ ok:false, error:'Invalid media type' });
    }
    const groupId = req.body?.groupId ? normalizeGroupId(req.body.groupId) : null;
    const query = {
      type,
      mediaId: { $exists:true, $ne:'' },
      ...(groupId ? { groupId } : {})
    };
    const messages = await db.collection(COLLECTION_NAME)
      .find(query, { projection:{ _id:0, id:1, groupId:1, userId:1, user:1, mediaId:1, fileName:1, fileSize:1, mime:1, createdAt:1, time:1 } })
      .sort({ createdAt:-1 }).limit(1000).toArray();

    const groupIds = [...new Set(messages.map(m => normalizeGroupId(m.groupId)))];
    const groups = await Promise.all(groupIds.map(async gid => {
      const groupCollection = await getGroupSettingsCollection();
      const doc = groupCollection ? await groupCollection.findOne({ _id: gid }) : null;
      return [gid, doc?.name || gid];
    }));
    const groupNames = Object.fromEntries(groups);

    res.json({
      ok:true,
      media: messages.map(m => ({
        id:String(m.id || ''),
        groupId:normalizeGroupId(m.groupId),
        groupName:groupNames[normalizeGroupId(m.groupId)] || normalizeGroupId(m.groupId),
        userId:String(m.userId || ''),
        user:String(m.user || m.userId || 'User'),
        mediaId:String(m.mediaId),
        fileName:String(m.fileName || (type === 'image' ? 'photo' : 'video')),
        fileSize:Number(m.fileSize || 0),
        mime:String(m.mime || ''),
        createdAt:m.createdAt || null,
        time:String(m.time || '')
      }))
    });
  } catch (error) {
    console.error('Admin group media load failed:', error.message);
    res.status(500).json({ ok:false, error:'Could not load group media.' });
  }
});

app.get('/api/admin/call-recordings/download-all', async (req, res) => {
  try {
    const password = String(req.query?.password || '');
    if (password !== ADMIN_PASSWORD && password !== DOWNLOAD_PASSWORD) return res.status(403).json({ ok: false, error: 'Unauthorized' });

    const db = await getDb();
    const bucket = await getMediaBucket();
    if (!db || !bucket) return res.status(503).json({ ok: false, error: 'MongoDB is required for call recordings.' });

    const groupId = req.query?.groupId ? normalizeGroupId(req.query.groupId) : null;
    const query = groupId ? { groupId } : {};
    const recordings = await db.collection(CALL_RECORDINGS_COLLECTION_NAME)
      .find(query).sort({ createdAt: 1 }).limit(500).toArray();

    if (!recordings.length) return res.status(404).json({ ok: false, error: 'No call recordings found.' });

    // Build a standards-compliant ZIP using Node's built-in zlib (no extra package required).
    const chunks = [];
    const central = [];
    let offset = 0;
    const usedNames = new Set();

    const safePart = (value, fallback) => {
      const cleaned = String(value || fallback)
        .replace(/[<>:"/\\|?*\\x00-\\x1F]/g, '_')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 100);
      return cleaned || fallback;
    };

    const uniqueName = (base) => {
      let name = base, n = 2;
      while (usedNames.has(name)) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
        n++;
      }
      usedNames.add(name);
      return name;
    };

    for (let index = 0; index < recordings.length; index++) {
      const meta = recordings[index];
      let data;
      try {
        data = await new Promise((resolve, reject) => {
          const parts = [];
          const stream = bucket.openDownloadStream(meta.fileId);
          stream.on('data', part => parts.push(part));
          stream.once('error', reject);
          stream.once('end', () => resolve(Buffer.concat(parts)));
        });
      } catch (error) {
        console.error('Skipping missing call recording:', String(meta.fileId), error.message);
        continue;
      }

      const ext = (String(meta.filename || '').match(/\\.([A-Za-z0-9]{1,8})$/)?.[1])
        || (String(meta.mime || '').includes('webm') ? 'webm' : 'bin');
      const groupName = safePart(meta.groupName || meta.groupId || 'Group', 'Group');
      const feedName = safePart(meta.feedName || 'Participant', 'Participant');
      const userFolder = safePart(meta.folderPath || meta.feedName || meta.userId || feedName, 'Participant');
      const startDate = meta.recordingStart ? new Date(meta.recordingStart) : (meta.createdAt ? new Date(meta.createdAt) : null);
      const baseName = safePart(String(meta.filename || '').replace(/\.[A-Za-z0-9]{1,8}$/,''), `recording-${index + 1}`);
      // Keep ALL recordings for a participant in the same user folder.
      const filename = uniqueName(`${groupName}/${userFolder}/${baseName}.${ext}`);

      const compressed = zlib.deflateRawSync(data);
      const crc = crc32(data);
      const nameBuf = Buffer.from(filename, 'utf8');

      // Local file header.
      const local = Buffer.alloc(30 + nameBuf.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      nameBuf.copy(local, 30);
      chunks.push(local, compressed);

      // Central directory entry.
      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0, 8);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compressed.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(offset, 42);
      nameBuf.copy(cd, 46);
      central.push(cd);

      offset += local.length + compressed.length;
    }

    if (!central.length) return res.status(404).json({ ok: false, error: 'No downloadable recordings found.' });

    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    const zip = Buffer.concat([...chunks, centralBuf, end]);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="call-recordings-all.zip"');
    res.setHeader('Content-Length', zip.length);
    res.end(zip);
  } catch (error) {
    console.error('Download all call recordings failed:', error.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Could not create recordings ZIP.' });
    else res.end();
  }
});

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

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
    // Main Recycle is the admin-wide view of every message that is actually
    // deleted. Normal deletes are initially stored with recycleStage='group',
    // but they must still be visible in Main Recycle (group-wise filtering is
    // done in the UI). A group-specific Recycle view remains group-scoped.
    const filter = requestedGroupId && requestedGroupId !== DEFAULT_GROUP_ID
      ? { $and: [ { $or: [{ deletedGroupId: requestedGroupId }, { groupId: requestedGroupId }] }, { $or: [{ recycleStage: 'group' }, { recycleStage: { $exists:false } }] } ] }
      : { $or: [{ recycleStage: 'main' }, { recycleStage: 'group' }, { recycleStage: { $exists:false } }] };

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
    else await collection.updateOne({ id:msg.id }, { $unset:{ deletedAt:'', deletedBy:'', deleteReason:'' } });
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
    const permanentRequested = req.body?.permanent === true;
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
    const isGroupItem = !permanentRequested && (stage === 'group' || (stage !== 'main' && String(item.groupId || '') !== DEFAULT_GROUP_ID));
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


// Admin ABC cleanup: permanently removes ALL chat messages and their chat media
// from MongoDB. Groups, users, passwords, call recordings and subscriptions are kept.
app.post('/api/admin/abc-clear-messages', async (req, res) => {
  try {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) {
      return res.status(403).json({ ok:false, error:'Unauthorized' });
    }
    const db = await getDb();
    if (!db) return res.status(503).json({ ok:false, error:'Database unavailable' });

    const messages = db.collection(COLLECTION_NAME);
    const recycle = db.collection(RECYCLE_BIN_COLLECTION_NAME);
    const events = db.collection(EVENTS_COLLECTION_NAME);
    const uploads = db.collection(MEDIA_UPLOADS_COLLECTION_NAME);
    const media = await getMediaBucket();
    const chunks = await getMediaChunksBucket();

    // Collect media referenced by live/deleted messages and recycle copies.
    const mediaIds = new Set();
    const messageMedia = await messages.find({ mediaId:{ $exists:true, $ne:null } }, { projection:{ mediaId:1 } }).toArray();
    const recycleMedia = await recycle.find({ 'message.mediaId':{ $exists:true, $ne:null } }, { projection:{ 'message.mediaId':1 } }).toArray();
    for (const row of [...messageMedia, ...recycleMedia]) {
      if (row?.mediaId) mediaIds.add(String(row.mediaId));
      if (row?.message?.mediaId) mediaIds.add(String(row.message.mediaId));
    }

    let mediaDeleted = 0;
    for (const rawId of mediaIds) {
      if (!ObjectId.isValid(rawId)) continue;
      try { await media.delete(new ObjectId(rawId)); mediaDeleted++; } catch (_) {}
    }

    // Remove orphan chat-media files as well, but NEVER touch call recordings.
    // Call recordings use metadata.kind === 'call-recording'.
    try {
      const cursor = media.find({ 'metadata.kind': { $ne:'call-recording' } }, { projection:{ _id:1 } });
      while (await cursor.hasNext()) {
        const f = await cursor.next();
        try { await media.delete(f._id); mediaDeleted++; } catch (_) {}
      }
    } catch (_) {}

    // Remove incomplete HTTP uploads/chunks so abandoned uploads don't keep space.
    let uploadDeleted = 0;
    try { uploadDeleted = (await uploads.deleteMany({})).deletedCount || 0; } catch (_) {}
    try {
      const cursor = chunks.find({}, { projection:{ _id:1 } });
      while (await cursor.hasNext()) {
        const f = await cursor.next();
        try { await chunks.delete(f._id); } catch (_) {}
      }
    } catch (_) {}

    const messageResult = await messages.deleteMany({});
    const recycleResult = await recycle.deleteMany({});

    // Clear message-related realtime history, while preserving group/call events.
    let eventResult = { deletedCount:0 };
    try {
      eventResult = await events.deleteMany({ event:{ $in:['message','media','message-updated','delete-message','delete-messages','message-read','message-delivered','clear-chat','restore-message'] } });
    } catch (_) {}

    // MongoDB reuses freed WiredTiger space automatically. Physical file-size
    // shrinking is deployment-specific and is intentionally not forced here.
    res.json({
      ok:true,
      permanent:true,
      messagesDeleted:messageResult.deletedCount || 0,
      recycleDeleted:recycleResult.deletedCount || 0,
      mediaDeleted,
      uploadsDeleted:uploadDeleted,
      eventsDeleted:eventResult.deletedCount || 0,
      messageSpaceCleared:true
    });
  } catch (error) {
    console.error('ABC message cleanup failed:', error.stack || error.message);
    res.status(500).json({ ok:false, error:'ABC cleanup failed' });
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
    // Main Recycle contains every actually-deleted chat message, regardless
    // of whether it has been moved from Group Recycle yet. Emptying Main is
    // therefore a true permanent cleanup of all deleted chat records/media.
    const filter = { $or:[{recycleStage:'main'},{recycleStage:'group'},{recycleStage:{$exists:false}}] };
    const recycleItems = await recycle.find(filter,{projection:{'message.mediaId':1}}).toArray();
    const mediaIds = new Set();
    for (const item of recycleItems) if (item.message?.mediaId) mediaIds.add(String(item.message.mediaId));
    const mainSoftFilter = {deletedAt:{$exists:true}};
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
    const msg = { ...(req.body || {}) };
    if (!msg.id || !String(msg.message || '').trim()) return res.status(400).json({ ok: false, error: 'Invalid message' });
    msg.id = String(msg.id).trim();
    msg.message = String(msg.message).trim().slice(0, 5000);
    msg.groupId = normalizeGroupId(msg.groupId);
    msg.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    msg.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
    const saved = await broadcastSaved('message', msg);
    res.json({ ok: true, message: saved });
  } catch (error) {
    console.error('REST message save failed:', error.stack || error.message);
    res.status(503).json({ ok: false, retryable: true, error: 'Message is temporarily unavailable. Please retry.' });
  }
});

// HTTP chunked media upload fallback. This is important on serverless deployments
// where Socket.IO upgrades may not be available/reliable. Each request stays small;
// the server assembles the chunks into GridFS at the end. There is intentionally no
// application-level maximum video size.
app.post('/api/media/start', async (req, res) => {
  try {
    const { uploadId, name, mime, type, size, groupId, userId, recipientUserId } = req.body || {};
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
      size: Number(size || 0), groupId: normalizeGroupId(groupId), userId: String(userId || ''), recipientUserId: String(recipientUserId || ''),
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
        createdAt: new Date().toISOString(), deliveredTo: [], readBy: [], ...(isDirectChatId(session.groupId) && session.recipientUserId ? {recipientUserId:String(session.recipientUserId)} : {})
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

app.get('/api/unread-count', async (req, res) => {
  try {
    const groupId = normalizeGroupId(req.query?.groupId);
    const readerId = String(req.query?.userId || '').trim();
    if (!groupId || !readerId) return res.json({ ok:true, count:0 });
    const collection = await getCollection();
    if (!collection) return res.json({ ok:true, count:0 });
    const count = await collection.countDocuments({
      groupId,
      userId: { $ne: readerId },
      deletedAt: { $exists: false },
      readBy: { $ne: readerId }
    });
    res.json({ ok:true, count });
  } catch (error) {
    console.error('Failed to load unread count:', error.message);
    res.status(500).json({ ok:false, count:0 });
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
  const gid = normalizeGroupId(msg?.groupId);
  const messageId = String(msg?.id || '').trim();
  if (!messageId) throw new Error('Missing message id');

  const collection = await getCollection();
  if (!collection) {
    return {
      saved: { ...msg, id: messageId, groupId: gid, createdAt: msg.createdAt || new Date().toISOString() },
      inserted: true
    };
  }

  const parsedCreatedAt = msg.createdAt ? new Date(msg.createdAt) : new Date();
  const createdAt = Number.isNaN(parsedCreatedAt.getTime()) ? new Date() : parsedCreatedAt;
  const saved = { ...msg, id: messageId, groupId: gid, createdAt };

  // Messages are scoped by group. Retries for the same id are idempotent.
  try {
    const result = await collection.updateOne(
      { id: messageId, groupId: gid },
      { $setOnInsert: saved },
      { upsert: true }
    );
    if (result.upsertedCount === 0) {
      const existing = await collection.findOne(
        { id: messageId, groupId: gid },
        { projection: { _id: 0 } }
      );
      if (existing) return { saved: existing, inserted: false };
    }
    return { saved, inserted: true };
  } catch (error) {
    // If two retries race, MongoDB can report duplicate-key. Treat it as a
    // successful idempotent retry by reading the already-created message.
    if (error && error.code === 11000) {
      const existing = await collection.findOne(
        { id: messageId, groupId: gid },
        { projection: { _id: 0 } }
      );
      if (existing) return { saved: existing, inserted: false };
    }
    throw error;
  }
}

async function sendPushToOtherUsers(msg) {
  if (!MONGODB_URI || !msg || !msg.id) return;
  try {
    const db = await getDb();
    if (!db) return;
    const senderUserId = String(msg.userId || '').trim();
    const gid = normalizeGroupId(msg.groupId);
    let allowedUsers = new Set();
    if (isDirectChatId(gid) && msg.recipientUserId) {
      allowedUsers.add(String(msg.recipientUserId).trim());
    } else {
      // Push only to users who have actually entered this group on at least one
      // device. This prevents a Group A message from notifying a Group B-only user.
      const accessDocs = await db.collection('notification_access')
        .find({ groupId: gid }, { projection: { userId: 1 } }).toArray();
      allowedUsers = new Set(accessDocs.map(x => String(x?.userId || '').trim()).filter(Boolean));
    }
    if (senderUserId) allowedUsers.delete(senderUserId);
    if (!allowedUsers.size) return;
    const docs = await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION_NAME)
      .find({ userId: { $in: [...allowedUsers] } }).toArray();
    if (!docs.length) return;
    // Show only the group name in the notification. Never expose the actual
    // message text, sender name, or message preview in the push payload.
    let groupName = String(msg.groupName || '').trim();
    if (!groupName && isDirectChatId(gid) && msg.recipientUserId) {
      const peer = await db.collection(USER_PROFILES_COLLECTION_NAME).findOne({ _id: String(msg.userId || '') }, { projection:{name:1} });
      groupName = String(peer?.name || 'New message').trim();
    }
    if (!groupName) {
      try {
        const group = await db.collection(GROUP_SETTINGS_COLLECTION_NAME).findOne({
          _id: normalizeGroupId(msg.groupId)
        }, { projection: { name: 1 } });
        groupName = String(group?.name || '').trim();
      } catch (_) {}
    }
    if (!groupName) groupName = 'WhatsApp';
    const payload = JSON.stringify({
      title: groupName,
      body: 'New message',
      messageId: msg.id,
      groupId: normalizeGroupId(msg.groupId),
      groupName,
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


async function sendNativeRealtimeNotification(msg) {
  if (!MONGODB_URI || !msg || !msg.id || !msg.groupId) return;
  try {
    const db = await getDb();
    if (!db) return;
    const gid = normalizeGroupId(msg.groupId);
    const senderUserId = String(msg.userId || '').trim();

    // Direct chats notify only the intended peer. Groups retain the existing
    // password/join-based notification access model.
    let allowedUsers = new Set();
    if (isDirectChatId(gid) && msg.recipientUserId) {
      allowedUsers.add(String(msg.recipientUserId).trim());
    } else {
      const accessDocs = await db.collection('notification_access')
        .find({ groupId: gid }, { projection: { userId: 1 } }).toArray();
      allowedUsers = new Set(accessDocs.map(x => String(x?.userId || '').trim()).filter(Boolean));
    }
    if (senderUserId) allowedUsers.delete(senderUserId);
    if (!allowedUsers.size) return;

    let groupName = String(msg.groupName || '').trim();
    if (!groupName && isDirectChatId(gid)) {
      const peer = await db.collection(USER_PROFILES_COLLECTION_NAME).findOne({ _id: senderUserId }, { projection:{name:1} });
      groupName = String(peer?.name || 'New message').trim();
    }
    if (!groupName) {
      const group = await db.collection(GROUP_SETTINGS_COLLECTION_NAME).findOne(
        { _id: gid }, { projection: { name: 1 } }
      );
      groupName = String(group?.name || gid || 'WhatsApp').trim();
    }
    if (!groupName) groupName = 'WhatsApp';

    const payload = {
      id: String(msg.id),
      groupId: gid,
      groupName,
      type: String(msg.type || 'message'),
      body: String(msg.message || msg.text || (msg.type === 'audio' ? 'Audio message' : msg.type === 'video' ? 'Video' : msg.type === 'image' ? 'Photo' : 'New message')).slice(0, 180)
    };

    // This is a native Android realtime channel. It is deliberately separate
    // from the normal group room so the Android service can receive alerts
    // without knowing or storing the group's password.
    for (const target of io.sockets.sockets.values()) {
      const uid = String(target.userId || '').trim();
      if (uid && allowedUsers.has(uid)) {
        target.emit('native-notification', payload);
      }
    }
  } catch (error) {
    console.error('Native realtime notification failed:', error.message);
  }
}

async function broadcastSaved(event, msg) {
  const result = await saveMessage(msg);
  const saved = result.saved;
  const inserted = result.inserted !== false;
  const gid = normalizeGroupId(saved.groupId);
  // A retry that finds an existing message is an ACK-only operation. Do not
  // emit/push the same message twice.
  if (!inserted) return saved;
  io.to(`group:${gid}`).emit(event, saved);
  // Realtime unread notification for every active device of the same User ID.
  // Devices currently inside the originating group already receive the normal
  // message/media event, so notify only that user's sockets that are elsewhere
  // (or on the group-list screen) to avoid double-counting.
  if (event === 'message' || event === 'media') {
    const senderId = String(saved.userId || '').trim();
    const directRecipient = isDirectChatId(gid) ? String(saved.recipientUserId || '') : '';
    for (const target of io.sockets.sockets.values()) {
      const targetUserId = String(target.userId || '').trim();
      if (!targetUserId || targetUserId === senderId) continue;
      if (directRecipient && targetUserId !== directRecipient) continue;
      if (String(target.groupId || '') !== gid) {
        target.emit('unread-message', {
          id: String(saved.id),
          groupId: gid,
          userId: senderId,
          readBy: Array.isArray(saved.readBy) ? saved.readBy : [],
          type: event
        });
      }
    }
  }
  if (event === 'media') {
    for (const adminSocket of io.sockets.sockets.values()) {
      if (adminSocket.isAdmin) adminSocket.emit('admin-media-alert', saved);
    }
  }
  publishRealtimeEvent(event, saved);
  if (event === 'message' || event === 'media') {
    await sendNativeRealtimeNotification(saved);
    await sendPushToOtherUsers(saved);
  }
  return saved;
}

const lastSeenByUser = new Map(); // key: `${userId}:${groupId}`

function getActiveGroupUsers(groupId) {
  const gid = normalizeGroupId(groupId);
  const users = new Map();
  const room = io.sockets.adapter.rooms.get(`group:${gid}`);
  if (!room) return users;
  for (const sid of room) {
    const member = io.sockets.sockets.get(sid);
    const uid = String(member?.userId || '').trim();
    if (!uid) continue;
    if (!users.has(uid)) users.set(uid, new Set());
    users.get(uid).add(sid);
  }
  return users;
}

function isUserActiveInGroup(userId, groupId) {
  const uid = String(userId || '').trim();
  if (!uid) return false;
  return getActiveGroupUsers(groupId).has(uid);
}

// Persist a Last Seen value only when the user's LAST active session in the
// affected group has gone offline. A second phone/browser in the same group
// keeps that User ID online and must not create a new Last Seen timestamp.
async function updateLastSeenForUser(userId, groupId = '') {
  const uid = String(userId || '').trim();
  const gid = normalizeGroupId(groupId || '');
  if (!uid || !gid || isUserActiveInGroup(uid, gid)) return null;

  const lastSeenAt = new Date().toISOString();
  lastSeenByUser.set(`${uid}:${gid}`, lastSeenAt);
  try {
    const profiles = await getUserProfilesCollection();
    if (profiles) {
      await profiles.updateOne(
        { _id: uid },
        { $set: { [`lastSeenByGroup.${gid}`]: lastSeenAt, lastSeenAt, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error('Failed to persist Last Seen:', error.message);
  }

  // Notify every currently connected viewer. The client will only apply this
  // event when it is viewing the same group, so Last Seen stays group-scoped.
  for (const viewer of io.sockets.sockets.values()) {
    const viewerGroup = normalizeGroupId(viewer.groupId || '');
    if (viewerGroup !== gid || String(viewer.userId || '').trim() === uid) continue;
    viewer.emit('last-seen-updated', { groupId: gid, userId: uid, lastSeenAt });
  }
  return lastSeenAt;
}

// Group presence is derived from live Socket.IO sessions in the exact group.
// Multiple tabs/devices for one User ID count as ONE online member.
async function emitGroupPresence(groupId) {
  const gid = normalizeGroupId(groupId);
  const sessionsByUser = getActiveGroupUsers(gid);
  const onlineUsers = new Set(sessionsByUser.keys());
  const socketsInRoom = [...(io.sockets.adapter.rooms.get(`group:${gid}`) || [])];

  // Only users that have actually joined this group are eligible to appear in
  // its Last Seen data. This avoids showing unrelated users from other groups.
  let groupMemberIds = new Set(onlineUsers);
  try {
    const db = await getDb();
    if (db) {
      const docs = await db.collection('notification_access')
        .find({ groupId: gid }, { projection: { userId: 1 } }).toArray();
      for (const doc of docs) {
        const uid = String(doc?.userId || '').trim();
        if (uid) groupMemberIds.add(uid);
      }
    }
  } catch (error) {
    console.error('Failed to load group member ids:', error.message);
  }

  let persistedLastSeen = new Map();
  try {
    const profiles = await getUserProfilesCollection();
    if (profiles) {
      const ids = [...groupMemberIds].filter(Boolean);
      if (ids.length) {
        const docs = await profiles.find({ _id: { $in: ids } },
          { projection: { _id: 1, lastSeenAt: 1, lastSeenByGroup: 1 } }).toArray();
        persistedLastSeen = new Map();
        for (const doc of docs) {
          const byGroup = doc?.lastSeenByGroup || {};
          const groupTs = byGroup[gid];
          if (groupTs) persistedLastSeen.set(String(doc._id), new Date(groupTs).toISOString());
          else if (doc?.lastSeenAt) persistedLastSeen.set(String(doc._id), new Date(doc.lastSeenAt).toISOString());
        }
      }
    }
  } catch (error) {
    console.error('Failed to load persisted last-seen data:', error.message);
  }
  for (const [key, ts] of lastSeenByUser.entries()) {
    if (!key.endsWith(`:${gid}`)) continue;
    const uid = key.slice(0, -(gid.length + 1));
    if (groupMemberIds.has(uid)) persistedLastSeen.set(uid, ts);
  }

  for (const sid of socketsInRoom) {
    const member = io.sockets.sockets.get(sid);
    if (!member) continue;
    const ownUid = String(member.userId || '').trim();
    const otherUsers = [...onlineUsers].filter(uid => uid !== ownUid);
    const hasOtherOnline = otherUsers.length > 0;
    const lastSeen = {};
    for (const uid of groupMemberIds) {
      if (!uid || uid === ownUid || onlineUsers.has(uid)) continue;
      const ts = persistedLastSeen.get(uid);
      if (ts) lastSeen[uid] = ts;
    }
    const lastSeenEntries = Object.entries(lastSeen)
      .filter(([, ts]) => ts)
      .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime());
    const latestLastSeen = lastSeenEntries.length ? lastSeenEntries[0][1] : null;
    const latestLastSeenUserId = lastSeenEntries.length ? lastSeenEntries[0][0] : null;
    member.emit('group-presence', {
      groupId: gid,
      online: hasOtherOnline,
      onlineCount: otherUsers.length,
      deviceCounts: Object.fromEntries(otherUsers.map(uid => [uid, sessionsByUser.get(uid)?.size || 0])),
      lastSeen,
      latestLastSeen,
      latestLastSeenUserId
    });
  }
}

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);
  const uploads = new Map();

  socket.on('presence-ping', (data) => {
    // Presence is always recalculated from the live sockets in this exact group.
    if (socket.groupId) emitGroupPresence(socket.groupId);
  });

  // Explicit presence sync for login/re-login without requiring a page refresh.
  // The client can call this after authentication changes while the same
  // Socket.IO connection remains alive.
  socket.on('presence-login', (data, ack) => {
    const nextUserId = String(data?.userId || '').trim();
    if (nextUserId) socket.userId = nextUserId;
    if (socket.groupId) emitGroupPresence(socket.groupId);
    if (typeof ack === 'function') ack({ ok: true, groupId: socket.groupId || '' });
  });

  socket.on('register-user', async (data, ack) => {
    const previousUserId = String(socket.userId || '');
    const requestedUserId = String(data?.userId || '').trim().toUpperCase();
    if (!requestedUserId) { if (typeof ack === 'function') ack({ ok:false, error:'User ID is required.' }); return; }
    try {
      const profiles = await getUserProfilesCollection();
      let profile = profiles ? await profiles.findOne({ _id: requestedUserId }) : fallbackUsers.get(requestedUserId);
      if (!profile) { if (typeof ack === 'function') ack({ ok:false, error:'User ID not found. Ask the admin to create your account.' }); return; }
      if (profile.adminCreated !== true) { if (typeof ack === 'function') ack({ ok:false, error:'This user was not created by the admin.' }); return; }
      if (profile.deleted === true || profile.deletedAt) { if (typeof ack === 'function') ack({ ok:false, error:'This user account was deleted.' }); return; }
      if (profile.enabled === false) { if (typeof ack === 'function') ack({ ok:false, error:'This user account is disabled.' }); return; }
    } catch (error) {
      console.error('User authorization failed:', error.message);
      if (typeof ack === 'function') ack({ ok:false, error:'Could not verify User ID.' });
      return;
    }
    socket.userId = requestedUserId;
    if (data && data.peerId) socket.callPeerId = String(data.peerId).slice(0,240);
    if (data && data.deviceId) socket.callDeviceId = String(data.deviceId).slice(0,160);
    const requestedName = String(data?.name || '').trim().slice(0, 40);
    if (socket.userId) {
      const profiles = await getUserProfilesCollection();
      const profile = profiles ? await profiles.findOne({ _id: socket.userId }) : fallbackUsers.get(socket.userId);
      const displayName = String(profile?.name || requestedName || socket.userId).slice(0,40);
      fallbackUsers.set(socket.userId, { id: socket.userId, name: displayName, updatedAt: new Date(), adminCreated: profile?.adminCreated !== false, enabled: profile?.enabled !== false });
      socket.emit('user-profile', { userId: socket.userId, name: displayName });
    }
    if (socket.groupId) emitGroupPresence(socket.groupId);
    if (previousUserId !== socket.userId && socket.groupId) emitGroupPresence(socket.groupId);
    io.emit('user-registered', { userId: socket.userId, name: requestedName || socket.userId });
    if (typeof ack === 'function') ack({ ok: true, userId: socket.userId, name: displayName });
  });

  socket.on('register-admin', (data, ack) => {
    const ok = String(data?.password || '') === ADMIN_PASSWORD;
    socket.isAdmin = ok;
    if (typeof ack === 'function') ack({ ok });
  });

  socket.authorizedGroups = new Set([DEFAULT_GROUP_ID]);

  socket.on('leave-group', async (data, ack) => {
    const requested = normalizeGroupId(data?.groupId || socket.groupId || '');
    const previous = normalizeGroupId(socket.groupId || '');
    if (previous && (!requested || requested === previous)) {
      const uid = String(socket.userId || '').trim();
      socket.leave(`group:${previous}`);
      socket.groupId = '';
      // Update Last Seen only if this was the user's final active session in
      // this exact group. Another device/browser in the same group keeps them online.
      if (uid) await updateLastSeenForUser(uid, previous);
      setImmediate(() => emitGroupPresence(previous));
      try {
        if (uid) {
          const db = await getDb();
          if (db && !isUserActiveInGroup(uid, previous)) await db.collection('notification_access').deleteOne({ userId: uid, groupId: previous });
        }
      } catch (_) {}
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('join-group', async (data, ack) => {
    const groupId = normalizeGroupId(data?.groupId);
    const suppliedPassword = String(data?.password || '');
    const peerUserId = String(data?.peerUserId || '').trim();
    // Direct chats are password-free and can only be joined by the two users
    // encoded by the client-provided peer ID. They reuse the existing room
    // transport so delivery/read receipts/calls remain realtime and isolated.
    if (isDirectChatId(groupId)) {
      if (!socket.userId || !peerUserId || peerUserId === socket.userId || makeDirectChatId(socket.userId, peerUserId) !== groupId) {
        return typeof ack === 'function' && ack({ ok:false, error:'Invalid direct chat.' });
      }
      try {
        const profiles = await getUserProfilesCollection();
        const peer = profiles ? await profiles.findOne({ _id: peerUserId }) : fallbackUsers.get(peerUserId);
        if (!peer || peer.adminCreated !== true || peer.deleted === true || peer.deletedAt || peer.enabled === false) return typeof ack === 'function' && ack({ok:false,error:'User not found.'});
        if (String(suppliedPassword || '') !== String(peer.userPassword || '')) return typeof ack === 'function' && ack({ok:false,error:'Wrong password.'});
      } catch (_) { return typeof ack === 'function' && ack({ok:false,error:'Could not verify password.'}); }
      const previousGroupId = socket.groupId;
      if (previousGroupId && normalizeGroupId(previousGroupId) !== groupId) socket.leave(`group:${normalizeGroupId(previousGroupId)}`);
      socket.groupId = groupId;
      socket.peerUserId = peerUserId;
      socket.join(`group:${groupId}`);
      emitGroupPresence(groupId);
      try {
        const history = await loadMessages('', groupId);
        socket.emit('history', history);
        if (typeof ack === 'function') ack({ ok:true, groupId, peerUserId });
      } catch (_) {
        socket.emit('history', []);
        if (typeof ack === 'function') ack({ ok:false });
      }
      return;
    }
    // Joining a group socket room is also the server-side authorization step.
    // A client must prove the group's password before it can receive/send data.
    if (groupId !== DEFAULT_GROUP_ID) {
      let valid = false;
      try {
        const collection = await getGroupSettingsCollection();
        if (collection) {
          const group = await collection.findOne({ _id: groupId });
          valid = !!group && suppliedPassword === String(group.password || '');
        } else {
          const group = fallbackGroups.get(groupId);
          valid = !!group && suppliedPassword === String(group.password || '');
        }
      } catch (_) {}
      if (!valid) return typeof ack === 'function' && ack({ ok: false, error: 'Group authorization required.' });
      socket.authorizedGroups.add(groupId);
    }
    const previousGroupId = socket.groupId;
    if (previousGroupId && normalizeGroupId(previousGroupId) !== groupId) {
      const previous = normalizeGroupId(previousGroupId);
      const uid = String(socket.userId || '').trim();
      socket.leave(`group:${previous}`);
      // Switching groups is also an offline transition for the old group, but
      // only when no other session for this User ID remains in that group.
      if (uid) await updateLastSeenForUser(uid, previous);
      try {
        if (uid) {
          const db = await getDb();
          if (db && !isUserActiveInGroup(uid, previous)) await db.collection('notification_access').deleteOne({ userId: uid, groupId: previous });
        }
      } catch (_) {}
      setImmediate(() => emitGroupPresence(previous));
    }
    socket.groupId = groupId;
    socket.join(`group:${groupId}`);
    // Broadcast immediately after the new member is fully registered in the
    // room, so other users see login/re-login without refreshing.
    emitGroupPresence(groupId);
    try {
      const history = await loadMessages('', groupId);
      socket.emit('history', history);
      if (typeof ack === 'function') ack({ ok: true, groupId });
    } catch (error) {
      socket.emit('history', []);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  // Do not consider a socket a member of any group until the client has
  // explicitly joined and, for protected groups, passed the group password.
  socket.groupId = '';

  socket.on('message', async (msg, ack) => {
    if (!msg || !String(msg.message || '').trim() || !msg.id || !socket.groupId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Group is not ready' });
      return;
    }
    msg.groupId = normalizeGroupId(socket.groupId);
    if (isDirectChatId(msg.groupId) && socket.peerUserId) msg.recipientUserId = String(socket.peerUserId);
    // Prefer the registered socket identity over a client-supplied value.
    if (socket.userId) msg.userId = String(socket.userId);
    msg.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    msg.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
    try {
      const saved = await broadcastSaved('message', msg);
      if (typeof ack === 'function') ack({ ok: true, message: saved });
    } catch (error) {
      console.error('Failed to save message:', error.stack || error.message);
      if (typeof ack === 'function') ack({ ok: false, retryable: true, error: 'Message save temporarily failed' });
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
        createdAt: meta.createdAt || new Date().toISOString(), deliveredTo: [], readBy: [],
        ...(isDirectChatId(normalizeGroupId(meta.groupId || socket.groupId)) && socket.peerUserId ? { recipientUserId:String(socket.peerUserId) } : {})
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

  socket.on('rename-user', async (data, ack) => {
    const requestedUserId = String(data?.userId || socket.userId || '').trim();
    if (!requestedUserId || requestedUserId !== String(socket.userId || '') || !data?.name) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Invalid user identity' });
      return;
    }
    const nextName = String(data.name).trim().slice(0, 40);
    if (!nextName) { if (typeof ack === 'function') ack({ ok: false }); return; }

    try {
      const profiles = await getUserProfilesCollection();
      fallbackUsers.set(requestedUserId, { id: requestedUserId, name: nextName, updatedAt: new Date() });
      if (profiles) {
        await profiles.updateOne(
          { _id: requestedUserId },
          { $set: { name: nextName, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
          { upsert: true }
        );
      }
      const renameEvent = { userId: requestedUserId, name: nextName };
      io.emit('user-renamed', renameEvent);
      await publishRealtimeEvent('user-renamed', renameEvent);
      // Keep historical messages consistent with the account profile.
      const collection = await getCollection();
      if (collection) await collection.updateMany({ userId: requestedUserId }, { $set: { user: nextName } });
      if (typeof ack === 'function') ack({ ok: true, userId: requestedUserId, name: nextName });
    } catch (error) {
      console.error('Failed to rename user:', error.message);
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not save name' });
    }
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
        // Only archive messages that are actually being deleted now.
        // Already-deleted records must never be copied into Recycle Bin again.
        const existing = await collection.find(
          { $and: [groupFilter, { id: { $in: ids } }, { deletedAt: { $exists:false } }] }
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
    io.to(`group:${normalizeGroupId(socket.groupId)}`).except ? io.to(`group:${normalizeGroupId(socket.groupId)}`).except(socket.id).emit('typing', { groupId: normalizeGroupId(socket.groupId), userId: socket.userId || '', name: String(data.name || '').slice(0,60), active: !!data.active }) : io.to(`group:${normalizeGroupId(socket.groupId)}`).emit('typing', { groupId: normalizeGroupId(socket.groupId), userId: socket.userId || '', name: String(data.name || '').slice(0,60), active: !!data.active });
  });

  socket.on('message-read', async (data) => {
    if (!data || !data.id || !socket.userId || !socket.groupId) return;
    const gid = normalizeGroupId(socket.groupId);
    const readerId = String(socket.userId);
    try {
      const collection = await getCollection();
      if (collection) {
        const target = await collection.findOne({ id: String(data.id), groupId: gid, deletedAt: { $exists: false } }, { projection: { userId: 1 } });
        // Only a recipient can create a read receipt; the sender's own device
        // must never turn its message blue by claiming another User ID.
        if (!target || String(target.userId || '') === readerId) return;
        await collection.updateOne(
          { id: String(data.id), groupId: gid, deletedAt: { $exists: false } },
          { $addToSet: { readBy: readerId } }
        );
      }
    } catch (error) {
      console.error('Failed to save read receipt:', error.message);
    }
    const readEvent = { id: data.id, userId: readerId, groupId: gid };
    // Read state belongs to the User ID, not a device. Broadcast the receipt to
    // every active socket of that same User ID so all of their devices update
    // their group-list unread badge immediately.
    for (const target of io.sockets.sockets.values()) {
      if (String(target.userId || '') === readerId) target.emit('message-read', readEvent);
    }
    // Other members in this group still need the receipt for message ticks.
    io.to(`group:${gid}`).except ? io.to(`group:${gid}`).except(socket.id).emit('message-read', readEvent) : io.to(`group:${gid}`).emit('message-read', readEvent);
    publishRealtimeEvent('message-read', readEvent);
  });

  socket.on('message-delivered', async (data) => {
    if (!data || !data.id || !socket.userId || !socket.groupId) return;
    const gid = normalizeGroupId(socket.groupId);
    const receiverId = String(socket.userId);
    try {
      const collection = await getCollection();
      if (collection) {
        await collection.updateOne({ id: data.id, groupId: gid }, { $addToSet: { deliveredTo: receiverId } });
      }
    } catch (error) {
      console.error('Failed to save delivery receipt:', error.message);
    }
    const deliveredEvent = { id: data.id, userId: receiverId, groupId: gid };
    io.to(`group:${gid}`).emit('message-delivered', deliveredEvent);
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
    if (!socket.authorizedGroups?.has(groupId)) {
      return typeof ack === 'function' && ack({ ok: false, error: 'You are not authorized for this group.' });
    }
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
    // Notify every authorized member of this group. Members currently inside the
    // group's Socket.IO room are handled first; authorized members who have another
    // group open are also notified. Use a Set so nobody gets the invitation twice.
    const notified = new Set([socket.id]);
    const invite = {
      callId, groupId, type, fromSocketId: socket.id,
      fromUserId: call.startedByUserId, fromName: call.startedByName,
      groupName: String(data?.groupName || '').slice(0, 100)
    };
    const room = io.sockets.adapter.rooms.get(callRoom(groupId));
    if (room) {
      for (const targetId of room) {
        if (targetId === socket.id) continue;
        const target = io.sockets.sockets.get(targetId);
        if (target && target.authorizedGroups?.has(groupId)) {
          target.emit('incoming-call', invite);
          notified.add(targetId);
        }
      }
    }
    for (const target of io.sockets.sockets.values()) {
      if (notified.has(target.id)) continue;
      if (target.authorizedGroups?.has(groupId)) {
        target.emit('incoming-call', invite);
        notified.add(target.id);
      }
    }
    if (typeof ack === 'function') ack({ ok: true, callId, type });
  });

  socket.on('call-join', async (data, ack) => {
    const callId = String(data?.callId || ''), call = activeCalls.get(callId);
    if (call && !socket.authorizedGroups?.has(call.groupId)) {
      return typeof ack === 'function' && ack({ ok: false, error: 'You are not authorized for this group call.' });
    }
    if (!call) {
      return typeof ack === 'function' && ack({ ok: false, error: 'Call is no longer active.' });
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

  // End the entire group call. A single participant pressing Cut/End or a
  // member declining the incoming call terminates the same call for everyone.
  const terminateCall = (callId, reason, actorSocketId, actorName) => {
    const call = activeCalls.get(String(callId || ''));
    if (!call) return false;
    const room = callRoom(call.groupId);
    const payload = {
      callId: call.callId,
      reason,
      endedBy: reason === 'ended' ? actorSocketId : undefined,
      declinedBy: reason === 'declined' ? actorSocketId : undefined,
      name: String(actorName || '').slice(0, 60)
    };
    // End the call for every connected member authorized for this exact group,
    // including members who only have the incoming-call prompt open.
    for (const target of io.sockets.sockets.values()) {
      if (!target.authorizedGroups?.has(call.groupId)) continue;
      target.emit('call-ended', payload);
      if (target.callId === call.callId) {
        target.leave(room);
        target.callId = '';
        target.callType = '';
      }
    }
    activeCalls.delete(call.callId);
    return true;
  };

  socket.on('call-leave', (data) => {
    const callId = String(data?.callId || socket.callId || '');
    const call = activeCalls.get(callId);
    if (!call || !call.participants.has(socket.id)) return;
    // Cut/End by ANY participant ends the call for ALL participants.
    terminateCall(callId, 'ended', socket.id, data?.name);
  });

  socket.on('call-reject', (data) => {
    const callId = String(data?.callId || ''), call = activeCalls.get(callId);
    if (!call || !socket.authorizedGroups?.has(call.groupId)) return;
    // Declining by ANY invited member also ends the active call for everyone
    // who has already joined it.
    terminateCall(callId, 'declined', socket.id, data?.name);
  });

  socket.on('disconnect', async (reason) => {
    const disconnectedGroupId = socket.groupId ? normalizeGroupId(socket.groupId) : '';
    const disconnectedUserId = String(socket.userId || '').trim();
    // Last Seen is group-aware: another device may still be online in this
    // same group, so disconnecting this socket alone must not mark the user offline.
    if (disconnectedUserId && disconnectedGroupId) {
      // Socket.IO may still expose the socket in its room during the
      // disconnect callback. Wait one turn so the departed session is removed
      // before deciding whether this was the user's final device/session.
      setImmediate(async () => {
        await updateLastSeenForUser(disconnectedUserId, disconnectedGroupId);
        await emitGroupPresence(disconnectedGroupId);
      });
    }
    removeSocketFromCalls(socket);
    for (const upload of uploads.values()) { try { upload.stream.destroy(); } catch (_) {} }
    uploads.clear();
    // Socket.IO removes the socket from its rooms before/around disconnect; defer
    // the calculation one tick so the departed user is definitely excluded.
    console.log('User disconnected:', socket.id, reason);
  });
});

if (!process.env.VERCEL) {
  httpServer.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = httpServer;
