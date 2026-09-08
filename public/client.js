const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.2,
  timeout: 20000,
});

let currentChatId = localStorage.getItem('wa_current_chat_id') || 'main';
let currentChatPassword = localStorage.getItem('wa_chat_password_main') || 'deoxy';
let pendingPasswordExpected = '';
const chats = new Map();
const socketId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let userId = localStorage.getItem('wa_user_id') || '';
if (!userId) {
  userId = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));
  localStorage.setItem('wa_user_id', userId);
}
try { window.AndroidWhatsApp?.setUserId(userId); } catch (_) {}
let name = localStorage.getItem('wa_name') || '';
let groupName = localStorage.getItem('wa_group_name') || 'WhatsApp';
while (!name) {
  name = (prompt('Please enter your name:') || '').trim();
}
localStorage.setItem('wa_name', name);

document.title = 'WhatsApp';

const app = document.querySelector('.app-shell');
const messageArea = document.querySelector('#messageArea');
const textarea = document.querySelector('#textarea');
const fileInput = document.querySelector('#fileInput');
const sendBtn = document.querySelector('#sendBtn');
const attachBtn = document.querySelector('#attachBtn');
const emojiBtn = document.querySelector('#emojiBtn');
const emojiPanel = document.querySelector('#emojiPanel');
const clearChatBtn = document.querySelector('#clearChatBtn');
const passwordModal = document.querySelector('#passwordModal');
const passwordInput = document.querySelector('#passwordInput');
const passwordSubmit = document.querySelector('#passwordSubmit');
const passwordClose = document.querySelector('#passwordClose');
const passwordTitle = document.querySelector('#passwordTitle');
const passwordText = document.querySelector('#passwordText');
const passwordError = document.querySelector('#passwordError');
const toast = document.querySelector('#toast');
const listPreview = document.querySelector('#listPreview');
const listTime = document.querySelector('#listTime');
const onlineStatus = document.querySelector('#onlineStatus');
const groupNameList = document.querySelector('#groupNameList');
const groupNameHeader = document.querySelector('#groupNameHeader');
const groupAvatarList = document.querySelector('#groupAvatarList');
const groupAvatarHeader = document.querySelector('#groupAvatarHeader');
const menuBtn = document.querySelector('#menuBtn');
const appMenu = document.querySelector('#appMenu');
const installAppBtn = document.querySelector('#installAppBtn');
const newChatBtn = document.querySelector('#newChatBtn');
const newChatModal = document.querySelector('#newChatModal');
const newChatNameInput = document.querySelector('#newChatNameInput');
const newChatPasswordInput = document.querySelector('#newChatPasswordInput');
const newChatSave = document.querySelector('#newChatSave');
const newChatClose = document.querySelector('#newChatClose');
const newChatError = document.querySelector('#newChatError');
const passwordsBtn = document.querySelector('#passwordsBtn');
const passwordsModal = document.querySelector('#passwordsModal');
const passwordsClose = document.querySelector('#passwordsClose');
const passwordsList = document.querySelector('#passwordsList');

menuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  appMenu?.classList.toggle('hidden');
});
document.addEventListener('click', () => appMenu?.classList.add('hidden'));
installAppBtn?.addEventListener('click', () => {
  appMenu?.classList.add('hidden');
  const isAndroid = /Android/i.test(navigator.userAgent);
  if (isAndroid) {
    window.location.href = '/whatsapp.apk';
  } else {
    showToast('Android phone પર આ shortcutથી WhatsApp APK install કરો.');
  }
});


async function loadChatPasswords() {
  if (!passwordsList) return;
  passwordsList.innerHTML = '<div class="passwords-empty">Loading…</div>';
  try {
    const res = await fetch('/api/chat-passwords', { cache: 'no-store' });
    const data = await res.json();
    const rows = Array.isArray(data.chats) ? data.chats : [];
    if (!rows.length) { passwordsList.innerHTML = '<div class="passwords-empty">No groups found</div>'; return; }
    passwordsList.innerHTML = rows.map((row, i) => {
      const id = `chat-pass-${i}`;
      const pass = String(row.password || '');
      const safeName = String(row.name || 'Chat').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
      const safePass = pass.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      return `<div class="password-row">
        <div class="password-chat-name">👥 ${safeName}</div>
        <div class="password-value-wrap"><input id="${id}" class="chat-password-value" type="password" value="${safePass}" readonly>
        <button class="password-toggle chat-password-toggle" type="button" data-target="${id}" title="Show password">👁</button></div>
        <div class="password-actions-label">Used for: Delete • Download • Clear chat</div>
        ${String(row.id) === 'main' ? '<div class="main-password-badge">MAIN PASSWORD: deoxy</div>' : `<button class="delete-group-btn" data-chat-id="${String(row.id).replace(/"/g,'&quot;')}" data-chat-name="${safeName}">🗑 Delete group</button>`}
      </div>`;
    }).join('');
    passwordsList.querySelectorAll('.chat-password-toggle').forEach(btn => btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target); if (!input) return;
      const show = input.type === 'password'; input.type = show ? 'text' : 'password'; btn.textContent = show ? '🙈' : '👁';
    }));
    passwordsList.querySelectorAll('.delete-group-btn').forEach(btn => btn.addEventListener('click', () => {
      deleteGroupWithMainPassword(btn.dataset.chatId, btn.dataset.chatName);
    }));
  } catch (_) { passwordsList.innerHTML = '<div class="passwords-empty">Could not load passwords</div>'; }
}
async function unlockPasswordsPanel() {
  const value = prompt('Enter main password to view group passwords:');
  if (value !== 'deoxy') { showToast('Wrong main password'); return; }
  passwordsModal?.classList.remove('hidden');
  loadChatPasswords();
}
passwordsBtn?.addEventListener('click', unlockPasswordsPanel);
passwordsClose?.addEventListener('click', () => passwordsModal?.classList.add('hidden'));
passwordsModal?.addEventListener('click', e => { if (e.target === passwordsModal) passwordsModal.classList.add('hidden'); });

function deleteGroupWithMainPassword(chatId, chatName) {
  if (String(chatId) === 'main') { showToast('Main group cannot be deleted'); return; }
  const pass = prompt(`Enter main password to delete “${chatName}”:`);
  if (pass !== 'deoxy') { showToast('Wrong main password'); return; }
  if (!confirm(`Delete group “${chatName}” and all its messages/media?`)) return;
  socket.emit('delete-chat', { chatId: String(chatId), mainPassword: pass }, result => {
    if (!result?.ok) { showToast(result?.error || 'Could not delete group'); return; }
    chats.delete(String(chatId));
    localStorage.removeItem(`wa_chat_password_${chatId}`);
    if (currentChatId === String(chatId)) {
      currentChatId = 'main'; currentChatPassword = 'deoxy'; groupName = 'WhatsApp';
      localStorage.setItem('wa_current_chat_id','main');
      localStorage.setItem('wa_chat_password_main','deoxy');
      renderChatList(); updateGroupNameUI();
      socket.emit('join-chat',{chatId:'main',password:'deoxy'});
    } else renderChatList();
    loadChatPasswords();
    showToast('Group deleted');
  });
}

let pendingAction = null;
const messages = new Map();
const deletedIds = new Set();
const readSent = new Set();
let lastRenderedDate = '';
let chatOpen = window.innerWidth > 760;
const emojis = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😎','🤩','🥳','🤔','🤗','🤭','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','🤓','😛','😜','🤪','🤑','🤠','👍','👎','👏','🙏','❤️','🔥','🎉','💯','😂','🤣','😢','😭','😡','❤️‍🔥','💔'];


let notificationPermissionRequested = false;

async function enableNotifications() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied' || notificationPermissionRequested) return false;
  notificationPermissionRequested = true;
  try { return (await Notification.requestPermission()) === 'granted'; } catch (_) { return false; }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const raw = atob((base64String + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}

async function setupWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const response = await fetch('/api/push/public-key', { cache: 'no-store' });
    const data = await response.json();
    if (!data.publicKey) return false;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey)
      });
    }
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, subscription })
    });
    return true;
  } catch (error) {
    console.warn('Web push setup failed:', error);
    return false;
  }
}

function notifyIncomingMessage(msg) {
  if (!msg || msg.userId === userId || !('Notification' in window) || Notification.permission !== 'granted') return;
  // Don't interrupt users who are actively looking at the open chat.
  if (document.visibilityState === 'visible' && chatOpen) return;
  const sender = msg.user || 'New message';
  let body = msg.message || '';
  if (!body) body = msg.type === 'image' ? '📷 Photo' : msg.type === 'video' ? '🎥 Video' : 'New message';
  try {
    const n = new Notification(groupName || 'WhatsApp', {
      body: `${sender}: ${body}`,
      tag: `wa-${msg.id}`,
      renotify: true,
      icon: '/icon.svg',
      badge: '/icon.svg'
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) {}
}

function notificationSetup() {
  if (!('Notification' in window)) return;
  // Browsers generally allow the permission prompt only from a user gesture.
  const once = async () => { const granted = await enableNotifications(); if (granted) await setupWebPush(); document.removeEventListener('pointerdown', once); document.removeEventListener('keydown', once); };
  document.addEventListener('pointerdown', once, { once: true });
  document.addEventListener('keydown', once, { once: true });
}
notificationSetup();
if ('Notification' in window && Notification.permission === 'granted') setupWebPush();

function now() {
  return new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function dateKey(msg) {
  const d = msg.createdAt ? new Date(msg.createdAt) : new Date();
  return d.toISOString().slice(0,10);
}
function dateLabel(key) {
  const d = new Date(key + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
  if (d.getTime() === today.getTime()) return 'TODAY';
  if (d.getTime() === yesterday.getTime()) return 'YESTERDAY';
  return d.toLocaleDateString([], {day:'numeric', month:'long', year:'numeric'});
}

function id() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function requestPassword(title, text, action, expectedPassword = currentChatPassword) {
  pendingAction = action;
  pendingPasswordExpected = String(expectedPassword || '');
  passwordTitle.textContent = title;
  passwordText.textContent = text;
  passwordInput.value = '';
  passwordError.textContent = '';
  passwordModal.classList.remove('hidden');
  setTimeout(() => passwordInput.focus(), 50);
}

function closePassword() {
  passwordModal.classList.add('hidden');
  pendingAction = null;
  pendingPasswordExpected = '';
}

passwordSubmit.addEventListener('click', () => {
  if (pendingPasswordExpected !== '__ANY__' && passwordInput.value !== pendingPasswordExpected) {
    passwordError.textContent = 'Wrong password';
    passwordInput.select();
    return;
  }
  const action = pendingAction;
  closePassword();
  if (action) action();
});
passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') passwordSubmit.click(); });
passwordClose.addEventListener('click', closePassword);
passwordModal.addEventListener('click', e => { if (e.target === passwordModal) closePassword(); });

document.querySelectorAll('.password-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});

function sendMessage(text) {
  const message = text.trim();
  if (!message) return;
  const msg = { id: id(), chatId: currentChatId, senderId: socketId, userId, user: name, message, time: now(), type: 'text', createdAt: new Date().toISOString(), deliveredTo: [] , readBy: [] };
  socket.emit('message', msg, (result) => { if (!result || !result.ok) showToast('Message could not be saved'); });
  textarea.value = '';
  autoResize();
  updatePreview(message);
}

sendBtn.addEventListener('click', () => sendMessage(textarea.value));
textarea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(textarea.value);
  }
});
textarea.addEventListener('input', autoResize);
function autoResize() { textarea.style.height='auto'; textarea.style.height=Math.min(textarea.scrollHeight,120)+'px'; }

function renderMessage(msg, direction) {
  if (!msg || !msg.id || deletedIds.has(msg.id) || messages.has(msg.id)) return;
  if (msg.createdAt) {
    const key = dateKey(msg);
    if (key !== lastRenderedDate) {
      const sep = document.createElement('div'); sep.className='date-separator'; sep.textContent=dateLabel(key);
      messageArea.appendChild(sep); lastRenderedDate = key;
    }
  }
  messages.set(msg.id, msg);

  const el = document.createElement('div');
  el.className = `message ${direction}`;
  el.dataset.id = msg.id;

  if (msg.user && direction === 'incoming') {
    const sender = document.createElement('div'); sender.className='sender'; sender.textContent=msg.user; el.appendChild(sender);
  }

  const content = document.createElement('div');
  if (msg.type === 'image' || msg.type === 'video') {
    const wrap = document.createElement('div'); wrap.className='media-wrap';
    const mediaUrl = msg.mediaId ? `/api/media/${encodeURIComponent(msg.mediaId)}` : msg.data;
    if (msg.type === 'image') {
      const img=document.createElement('img'); img.src=mediaUrl; img.alt='Photo'; img.loading='lazy'; wrap.appendChild(img);
    } else {
      const video=document.createElement('video'); video.controls=true; video.preload='metadata'; video.setAttribute('controlsList','nodownload'); video.disablePictureInPicture=true; video.addEventListener('contextmenu', e => e.preventDefault());
      const source=document.createElement('source'); source.src=mediaUrl; source.type=msg.mime || 'video/mp4'; video.appendChild(source); wrap.appendChild(video);
    }
    const actions=document.createElement('div'); actions.className='media-actions';
    const download=document.createElement('button'); download.className='mini-btn'; download.textContent='⬇ Download';
    download.addEventListener('click', () => requestPassword('Download protected file','Enter password to download this photo/video.', () => downloadMedia(msg)));
    actions.appendChild(download);
    content.appendChild(wrap); content.appendChild(actions);
  } else {
    const text=document.createElement('div'); text.className='message-text'; text.textContent=msg.message || ''; content.appendChild(text);
  }
  el.appendChild(content);

  const meta=document.createElement('div'); meta.className='meta';
  meta.appendChild(document.createTextNode(msg.time || now()));
  if (direction === 'outgoing') {
    const ticks=document.createElement('span');
    ticks.className='ticks' + (isMessageRead(msg) ? ' read' : '');
    ticks.textContent='✓✓';
    meta.appendChild(ticks);
  }
  el.appendChild(meta);

  const more=document.createElement('button'); more.className='message-more'; more.textContent='⌄'; more.title='Message options';
  const menu=document.createElement('div'); menu.className='message-menu';
  const del=document.createElement('button'); del.textContent='Delete message';
  del.addEventListener('click', () => {
    menu.classList.remove('open');
    requestPassword('Delete message','Enter this chat password to delete this message.', () => deleteMessage(msg.id));
  });
  menu.appendChild(del); el.appendChild(menu);
  more.addEventListener('click', e => { e.stopPropagation(); document.querySelectorAll('.message-menu.open').forEach(x=>x.classList.remove('open')); menu.classList.toggle('open'); });
  el.appendChild(more);

  messageArea.appendChild(el);
  scrollToBottom();
}

document.addEventListener('click', () => document.querySelectorAll('.message-menu.open').forEach(x=>x.classList.remove('open')));

function deleteMessage(messageId, broadcast=true) {
  const el=document.querySelector(`.message[data-id="${CSS.escape(messageId)}"]`);
  if (el) el.remove();
  messages.delete(messageId);
  deletedIds.add(messageId);
  if (broadcast) socket.emit('delete-message', {id:messageId, chatId:currentChatId}, (result) => { if (!result || !result.ok) showToast('Delete could not be synced'); });
  updatePreview('Message deleted');
}

function clearChat(broadcast=true) {
  messageArea.innerHTML=''; messages.clear(); lastRenderedDate='';
  updatePreview('No messages yet');
  if (broadcast) socket.emit('clear-chat', {by:name, chatId:currentChatId});
}

clearChatBtn.addEventListener('click', () => requestPassword('Clear chat','Enter password to permanently clear this chat.', () => clearChat(true)));

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  const file=e.target.files[0]; if (!file) return;
  if (!/^image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|ogg)$/.test(file.type)) { showToast('Only image and video files are allowed'); fileInput.value=''; return; }
  uploadMedia(file).finally(() => { fileInput.value=''; });
});

function makeUploadBubble(file, type) {
  const el = document.createElement('div');
  el.className = 'message outgoing upload-message';
  const content = document.createElement('div');
  const wrap = document.createElement('div');
  wrap.className = 'media-wrap upload-wrap';
  const placeholder = document.createElement(type === 'video' ? 'div' : 'div');
  placeholder.className = 'upload-placeholder';
  placeholder.innerHTML = `<div class="upload-icon">${type === 'video' ? '🎥' : '📷'}</div><div class="upload-name"></div>`;
  placeholder.querySelector('.upload-name').textContent = file.name;
  const ring = document.createElement('div'); ring.className = 'upload-ring';
  ring.innerHTML = '<svg viewBox="0 0 72 72" aria-hidden="true"><circle class="upload-track" cx="36" cy="36" r="31"></circle><circle class="upload-progress" cx="36" cy="36" r="31"></circle></svg><span class="upload-percent">0%</span>';
  wrap.appendChild(placeholder); wrap.appendChild(ring);
  content.appendChild(wrap); el.appendChild(content);
  const meta=document.createElement('div'); meta.className='meta'; meta.textContent=now(); el.appendChild(meta);
  messageArea.appendChild(el); scrollToBottom();
  return { el, ring, percent: ring.querySelector('.upload-percent'), progress: ring.querySelector('.upload-progress') };
}

function setUploadProgress(ui, percent, text) {
  if (!ui) return;
  const value = Math.max(0, Math.min(100, percent));
  ui.percent.textContent = text || `${Math.round(value)}%`;
  const circumference = 2 * Math.PI * 31;
  ui.progress.style.strokeDasharray = `${circumference}`;
  ui.progress.style.strokeDashoffset = `${circumference * (1 - value / 100)}`;
}

async function waitForSocket(timeout=20000) {
  if (socket.connected) return true;
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.off('connect', onConnect); resolve(value); };
    const onConnect = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    socket.once('connect', onConnect);
    if (!socket.connected) socket.connect();
  });
}

async function uploadMedia(file) {
  const type = file.type.startsWith('image/') ? 'image' : 'video';
  const ui = makeUploadBubble(file, type);
  try {
    if (!(await waitForSocket(20000))) throw new Error('connection');
    const uploadId = id();
    const msgId = id();
    const meta = { uploadId, id: msgId, chatId: currentChatId, senderId: socketId, userId, user: name, type, mime: file.type, name: file.name, size: file.size, time: now(), createdAt: new Date().toISOString() };
    let started = await emitAck('media-start', meta, 120000, 3);
    if (!started.ok) throw new Error('start');
    const chunkSize = 512 * 1024;
    let sent = 0;
    while (sent < file.size) {
      const chunk = await file.slice(sent, sent + chunkSize).arrayBuffer();
      let result = await emitAck('media-chunk', { uploadId, chunk }, 120000, 3);
      if (!result.ok) throw new Error('chunk');
      sent += chunk.byteLength;
      setUploadProgress(ui, sent / file.size * 100);
    }
    const result = await emitAck('media-end', { uploadId }, 120000, 3);
    if (!result.ok) throw new Error('finish');
    setUploadProgress(ui, 100, '✓');
    ui.el.classList.add('upload-done');
    setTimeout(() => ui.el.remove(), 450);
    updatePreview(type === 'image' ? '📷 Photo' : '🎥 Video');
  } catch (error) {
    ui.el.classList.add('upload-error');
    setUploadProgress(ui, 0, '↻');
    showToast('Connection lost. Please try again');
    setTimeout(() => ui.el.remove(), 2200);
  }
}

function emitAck(event, data, timeout=30000, retries=2) {
  return new Promise(resolve => {
    let attempt = 0;
    const run = async () => {
      if (!(await waitForSocket(Math.min(timeout, 20000)))) return resolve({ok:false});
      attempt++;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return; settled = true;
        if (attempt <= retries + 1) run(); else resolve({ok:false});
      }, timeout);
      try {
        socket.emit(event, data, result => {
          if (settled) return;
          settled = true; clearTimeout(timer); resolve(result || {ok:false});
        });
      } catch (_) {
        clearTimeout(timer); settled = true;
        if (attempt <= retries + 1) run(); else resolve({ok:false});
      }
    };
    run();
  });
}

function downloadMedia(msg) {
  const a=document.createElement('a');
  a.href=msg.mediaId ? `/api/media/${encodeURIComponent(msg.mediaId)}` : msg.data;
  a.download=msg.fileName || `whatsapp-${msg.type}-${Date.now()}.${extension(msg.mime,msg.type)}`;
  document.body.appendChild(a); a.click(); a.remove(); showToast('Download started');
}
function extension(mime,type) { const ext=(mime||'').split('/')[1]; return ext==='jpeg'?'jpg':(ext || type); }

let lastSyncAt = '';

function isMessageRead(msg) {
  return Array.isArray(msg.readBy) && msg.readBy.some(id => id && id !== msg.userId);
}

function updateTicks(msg) {
  const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
  if (!el || msg.userId !== userId) return;
  const ticks = el.querySelector('.ticks');
  if (!ticks) return;
  const read = isMessageRead(msg);
  ticks.textContent = '✓✓';
  ticks.classList.toggle('read', read);
}

function receiveMessage(msg) {
  if (!msg || !msg.id) return;
  const isIncoming = msg.userId !== userId;
  renderMessage(msg, isIncoming ? 'incoming' : 'outgoing');
  if (isIncoming) {
    socket.emit('message-delivered', { id: msg.id, userId, chatId: currentChatId });
  }
  if (msg.createdAt) lastSyncAt = lastSyncAt ? new Date(Math.max(new Date(lastSyncAt).getTime(), new Date(msg.createdAt).getTime())).toISOString() : new Date(msg.createdAt).toISOString();
  updatePreview(msg.message || (msg.type === 'image' ? '📷 Photo' : msg.type === 'video' ? '🎥 Video' : 'New message'));
  if (msg.userId !== userId) {
    notifyIncomingMessage(msg);
    if (document.visibilityState === 'visible') markMessageRead(msg);
  }
}


socket.on('history', payload => {
  const history = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.messages) ? payload.messages : []);
  const historyChatId = Array.isArray(payload) ? currentChatId : String(payload?.chatId || currentChatId);
  if (historyChatId !== currentChatId) return;
  messageArea.innerHTML=''; messages.clear(); deletedIds.clear(); lastRenderedDate='';
  history.forEach(receiveMessage);
  if (history.length) {
    const last = history[history.length - 1];
    if (last.createdAt) lastSyncAt = new Date(last.createdAt).toISOString();
  }
});

socket.on('message', receiveMessage);
socket.on('media', receiveMessage);

function markMessageRead(msg) {
  if (!msg || !msg.id || msg.userId === userId || readSent.has(msg.id) || !chatOpen) return;
  readSent.add(msg.id);
  socket.emit('message-read', { id: msg.id, userId, chatId: currentChatId });
}

function markVisibleMessagesRead() {
  if (document.visibilityState !== 'visible') return;
  messages.forEach(msg => {
    if (msg.userId !== userId) markMessageRead(msg);
  });
}

socket.on('message-delivered', data => {
  if (!data || !data.id || !data.userId) return;
  const msg = messages.get(data.id); if (!msg) return;
  msg.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
  if (!msg.deliveredTo.includes(data.userId)) msg.deliveredTo.push(data.userId);
});

socket.on('message-read', data => {
  if (!data || !data.id || !data.userId) return;
  const msg = messages.get(data.id);
  if (!msg) return;
  msg.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
  if (!msg.readBy.includes(data.userId)) msg.readBy.push(data.userId);
  updateTicks(msg);
});

async function syncMessages() {
  try {
    // Fetch the complete current group state so every device can recover not only
    // new messages, but also deletes, clears, renames and read receipts even when
    // Vercel routes two users to different server instances.
    const response = await fetch(`/api/messages?chatId=${encodeURIComponent(currentChatId)}`, { cache: 'no-store', headers: { 'X-Chat-Password': currentChatPassword } });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.messages)) return;

    const serverIds = new Set(data.messages.map(m => m && m.id).filter(Boolean));
    const localIds = Array.from(messages.keys());
    localIds.forEach(id => {
      if (!serverIds.has(id)) deleteMessage(id, false);
    });

    data.messages.forEach(msg => {
      if (!msg || !msg.id) return;
      const existing = messages.get(msg.id);
      if (!existing) {
        receiveMessage(msg);
        return;
      }
      // Merge persisted receipt/name changes into the already-rendered message.
      existing.user = msg.user || existing.user;
      existing.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
      existing.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
      const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
      const sender = el && el.querySelector('.sender');
      if (sender && existing.user) sender.textContent = existing.user;
      updateTicks(existing);
    });

    if (data.messages.length) {
      const last = data.messages[data.messages.length - 1];
      if (last.createdAt) lastSyncAt = new Date(last.createdAt).toISOString();
    } else {
      lastSyncAt = '';
    }
  } catch (_) {
    // Socket.IO remains the fast realtime channel; this sync is the cross-instance
    // recovery path and also keeps deletes/read receipts consistent everywhere.
  }
}

// Frequent reconciliation keeps all devices in the same group state, including
// users connected to different Vercel instances.
setInterval(syncMessages, 1000);

socket.on('group-renamed', data => {
  if (!data || !data.name || String(data.chatId || currentChatId) !== currentChatId) return;
  groupName = String(data.name);
  localStorage.setItem('wa_group_name', groupName);
  updateGroupNameUI();
});

socket.on('user-renamed', data => {
  if (!data || !data.userId || !data.name) return;
  messages.forEach(msg => {
    if (msg.userId !== data.userId) return;
    msg.user = data.name;
    const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
    const sender = el && el.querySelector('.sender');
    if (sender) sender.textContent = data.name;
  });
});
socket.on('delete-message', data => { if (data && data.id && String(data.chatId || currentChatId) === currentChatId) deleteMessage(data.id,false); });
socket.on('clear-chat', data => { if (!data || String(data.chatId || currentChatId) === currentChatId) { clearChat(false); showToast('Chat was cleared'); } });
let disconnectTimer = null;
function setOnlineStatus(state) {
  clearTimeout(disconnectTimer);
  if (state === 'online') {
    onlineStatus.textContent = 'online';
    onlineStatus.classList.remove('offline');
    onlineStatus.classList.add('online');
    return;
  }
  // Do not flash 'connecting…' for tiny transport reconnects. Show it only
  // when the connection has actually been down for a short period.
  disconnectTimer = setTimeout(() => {
    if (!socket.connected) {
      onlineStatus.textContent = 'connecting…';
      onlineStatus.classList.remove('online');
      onlineStatus.classList.add('offline');
    }
  }, 1500);
}
socket.on('connect', () => {
  setOnlineStatus('online');
  socket.emit('register-user', { userId });
  syncMessages().finally(markVisibleMessagesRead);
});
socket.on('disconnect', () => setOnlineStatus('connecting'));
socket.on('reconnect', () => setOnlineStatus('online'));
socket.on('connect_error', () => setOnlineStatus('connecting'));

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markVisibleMessagesRead(); });
messageArea.addEventListener('scroll', markVisibleMessagesRead);
window.addEventListener('focus', markVisibleMessagesRead);

function scrollToBottom(){ messageArea.scrollTop=messageArea.scrollHeight; }
function updatePreview(text){ listPreview.textContent=text; listTime.textContent=now(); }

emojiPanel.innerHTML = emojis.map(e => `<button type="button" aria-label="${e}">${e}</button>`).join('');
emojiPanel.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { textarea.value += btn.textContent; textarea.focus(); autoResize(); }));
emojiBtn.addEventListener('click', e => { e.stopPropagation(); emojiPanel.classList.toggle('open'); });
document.addEventListener('click', e => { if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) emojiPanel.classList.remove('open'); });

document.querySelectorAll('.filter').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.filter').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }));
function openChat(push=true){ chatOpen=true; app.classList.add('chat-open'); if(push && window.innerWidth<=760) history.pushState({chat:true}, '', '#chat'); setTimeout(markVisibleMessagesRead, 50); }
function closeChat(){ chatOpen=false; app.classList.remove('chat-open'); if(window.innerWidth<=760 && location.hash==='#chat') history.back(); }
document.querySelector('#backBtn').addEventListener('click', closeChat);
window.addEventListener('popstate', () => { chatOpen=false; app.classList.remove('chat-open'); });


function renderChatList() {
  const list = document.querySelector('#chatList');
  list.innerHTML = '';
  chats.forEach(chat => {
    const item = document.createElement('button');
    item.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
    item.dataset.chat = chat.id;
    item.innerHTML = `<div class="avatar group-avatar">${firstCharacter(chat.name)}</div><div class="chat-summary"><div class="chat-line"><strong></strong><span></span></div><div class="chat-line preview"><span>Tap to open this chat</span><span class="unread-dot"></span></div></div>`;
    item.querySelector('strong').textContent = chat.name;
    item.querySelector('.group-avatar').addEventListener('click', e => { e.stopPropagation(); currentChatId = chat.id; groupName = chat.name; openGroupNameModal(); });
    item.addEventListener('click', () => openStoredChat(chat));
    list.appendChild(item);
  });
}

function openStoredChat(chat) {
  const saved = localStorage.getItem(`wa_chat_password_${chat.id}`);
  const open = password => {
    currentChatId = chat.id; currentChatPassword = password;
    localStorage.setItem('wa_current_chat_id', currentChatId);
    localStorage.setItem(`wa_chat_password_${chat.id}`, password);
    groupName = chat.name; localStorage.setItem('wa_group_name', groupName); updateGroupNameUI(); renderChatList();
    waitForSocket(20000).then(ok => { if (ok) socket.emit('join-chat', { chatId: currentChatId, password: currentChatPassword }, result => { if (!result?.ok) showToast(result?.error || 'Wrong password'); }); });
    openChat();
  };
  if (saved) open(saved); else requestPassword('Chat password', `Enter password for “${chat.name}”.`, () => open(passwordInput.value), '');
  if (!saved) {
    pendingAction = () => open(passwordInput.value);
    pendingPasswordExpected = '__ANY__';
  }
}

function openNewChatModal() {
  newChatNameInput.value=''; newChatPasswordInput.value=''; newChatError.textContent=''; newChatModal.classList.remove('hidden'); setTimeout(() => newChatNameInput.focus(), 50);
}
function closeNewChatModal(){ newChatModal.classList.add('hidden'); newChatError.textContent=''; }
newChatBtn?.addEventListener('click', openNewChatModal);
newChatClose?.addEventListener('click', closeNewChatModal);
newChatModal?.addEventListener('click', e => { if (e.target === newChatModal) closeNewChatModal(); });
newChatSave?.addEventListener('click', () => {
  const chatName = newChatNameInput.value.trim(); const password = newChatPasswordInput.value;
  if (!chatName || !password) { newChatError.textContent='Chat name and password are required'; return; }
  socket.emit('create-chat', { name: chatName, password }, result => {
    if (!result?.ok) { newChatError.textContent=result?.error || 'Could not create chat'; return; }
    const chat=result.chat; chats.set(chat.id, chat); localStorage.setItem(`wa_chat_password_${chat.id}`, password); currentChatId=chat.id; currentChatPassword=password; groupName=chat.name; localStorage.setItem('wa_current_chat_id',currentChatId); localStorage.setItem('wa_group_name',groupName); renderChatList(); updateGroupNameUI(); closeNewChatModal(); openChat(); showToast('New chat created');
  });
});
newChatPasswordInput?.addEventListener('keydown', e => { if(e.key==='Enter') newChatSave.click(); });

async function loadChats() {
  try {
    const res = await fetch('/api/chats', {cache:'no-store'}); const data = await res.json();
    if (Array.isArray(data.chats)) data.chats.forEach(chat => chats.set(String(chat.id), {id:String(chat.id), name:String(chat.name || 'Chat')}));
  } catch (_) {}
  if (!chats.size) chats.set('main',{id:'main',name:'WhatsApp'});
  if (!chats.has(currentChatId)) currentChatId='main';
  const current=chats.get(currentChatId) || chats.get('main'); currentChatId=current.id; groupName=current.name;
  currentChatPassword=localStorage.getItem(`wa_chat_password_${currentChatId}`) || (currentChatId==='main' ? 'deoxy' : '');
  renderChatList(); updateGroupNameUI();
  if (currentChatPassword) socket.emit('join-chat',{chatId:currentChatId,password:currentChatPassword});
}
socket.on('chat-deleted', data => {
  const chatId = String(data?.chatId || '');
  if (!chatId) return;
  chats.delete(chatId);
  localStorage.removeItem(`wa_chat_password_${chatId}`);
  if (currentChatId === chatId) {
    currentChatId = 'main'; currentChatPassword = 'deoxy'; groupName = 'WhatsApp';
    localStorage.setItem('wa_current_chat_id','main');
    localStorage.setItem('wa_chat_password_main','deoxy');
    renderChatList(); updateGroupNameUI();
  } else renderChatList();
});
socket.on('chat-created', chat => { if (!chat?.id) return; chats.set(String(chat.id), {id:String(chat.id),name:String(chat.name||'Chat')}); renderChatList(); });
loadChats();

document.querySelector('#statusBtn').addEventListener('click', () => showToast('Status')); 
const nameModal = document.querySelector('#nameModal');
const nameInput = document.querySelector('#nameInput');
const nameSave = document.querySelector('#nameSave');
const nameClose = document.querySelector('#nameClose');
const nameError = document.querySelector('#nameError');
const nameTitle = document.querySelector('#nameTitle');
const nameHelp = document.querySelector('#nameHelp');
const meAvatar = document.querySelector('#profileAvatar');

const groupNameModal = document.querySelector('#groupNameModal');
const groupNameInput = document.querySelector('#groupNameInput');
const groupNameSave = document.querySelector('#groupNameSave');
const groupNameClose = document.querySelector('#groupNameClose');
const groupNameError = document.querySelector('#groupNameError');

function firstCharacter(value, fallback = 'W') {
  const text = String(value || '').trim();
  return text ? Array.from(text)[0].toUpperCase() : fallback;
}

function updateMyNameUI() {
  if (meAvatar) meAvatar.textContent = firstCharacter(name);
}

function updateGroupNameUI() {
  if (groupNameList) groupNameList.textContent = groupName;
  if (groupNameHeader) groupNameHeader.textContent = groupName;
  const initial = firstCharacter(groupName);
  if (groupAvatarList) groupAvatarList.textContent = initial;
  if (groupAvatarHeader) groupAvatarHeader.textContent = initial;
}

function openUserNameModal() {
  nameInput.value = name;
  nameTitle.textContent = 'Change your name';
  nameHelp.textContent = 'Choose the name other users will see.';
  nameInput.placeholder = 'Your name';
  nameError.textContent = '';
  nameModal.classList.remove('hidden');
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
}

function closeNameModal() {
  nameModal.classList.add('hidden');
  nameError.textContent = '';
}

function openGroupNameModal() {
  groupNameInput.value = groupName;
  groupNameError.textContent = '';
  groupNameModal.classList.remove('hidden');
  setTimeout(() => { groupNameInput.focus(); groupNameInput.select(); }, 50);
}

function closeGroupNameModal() {
  groupNameModal.classList.add('hidden');
  groupNameError.textContent = '';
}

function renameRenderedMessages(nextName) {
  messages.forEach(msg => {
    if (msg.userId !== userId) return;
    msg.user = nextName;
    const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
    if (!el) return;
    const sender = el.querySelector('.sender');
    if (sender) sender.textContent = nextName;
  });
}

function saveUserName() {
  const nextName = nameInput.value.trim().slice(0, 40);
  if (!nextName) {
    nameError.textContent = 'Please enter your name';
    nameInput.focus();
    return;
  }
  if (nextName === name) { closeNameModal(); return; }
  name = nextName;
  localStorage.setItem('wa_name', name);
  updateMyNameUI();
  renameRenderedMessages(name);
  socket.emit('rename-user', { userId, name }, result => {
    if (!result || !result.ok) showToast('Name sync will retry');
  });
  closeNameModal();
  showToast(`Your name is now ${name}`);
}

function saveGroupName() {
  const nextName = groupNameInput.value.trim().slice(0, 60);
  if (!nextName) {
    groupNameError.textContent = 'Please enter a group name';
    groupNameInput.focus();
    return;
  }
  if (nextName === groupName) { closeGroupNameModal(); return; }
  groupName = nextName;
  localStorage.setItem('wa_group_name', groupName);
  if (chats.has(currentChatId)) { chats.get(currentChatId).name = groupName; renderChatList(); }
  updateGroupNameUI();
  socket.emit('rename-group', { name: groupName, chatId: currentChatId }, result => {
    if (!result || !result.ok) showToast('Group name sync will retry');
  });
  closeGroupNameModal();
  showToast(`Group name is now ${groupName}`);
}

updateMyNameUI();
updateGroupNameUI();
nameSave.addEventListener('click', saveUserName);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveUserName(); });
nameClose.addEventListener('click', closeNameModal);
nameModal.addEventListener('click', e => { if (e.target === nameModal) closeNameModal(); });
groupNameSave.addEventListener('click', saveGroupName);
groupNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveGroupName(); });
groupNameClose.addEventListener('click', closeGroupNameModal);
groupNameModal.addEventListener('click', e => { if (e.target === groupNameModal) closeGroupNameModal(); });

meAvatar.addEventListener('click', openUserNameModal);
meAvatar.setAttribute('title', 'Change your name');
meAvatar.setAttribute('aria-label', 'Change your name');
meAvatar.style.cursor = 'pointer';

document.querySelectorAll('.chat-item .avatar, .chat-header .avatar').forEach(avatar => {
  avatar.addEventListener('click', openGroupNameModal);
  avatar.setAttribute('title', 'Change group name');
  avatar.setAttribute('aria-label', 'Change group name');
  avatar.style.cursor = 'pointer';
});

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    openUserNameModal();
  }
});

document.querySelector('#chatSearchBtn').addEventListener('click', () => {
  if (window.innerWidth <= 760) {
    app.classList.remove('chat-open');
    setTimeout(() => document.querySelector('#searchInput').focus(), 50);
  } else {
    document.querySelector('#searchInput').focus();
  }
});
document.querySelector('#searchInput').addEventListener('input', e => {
  const q=e.target.value.toLowerCase();
  document.querySelectorAll('.message').forEach(m => m.style.display = !q || m.textContent.toLowerCase().includes(q) ? '' : 'none');
});

if (window.innerWidth <= 760) { app.classList.remove('chat-open'); chatOpen=false; } else { app.classList.add('chat-open'); chatOpen=true; }
window.addEventListener('resize', () => { if (window.innerWidth > 760) { app.classList.add('chat-open'); chatOpen=true; } });
updatePreview('Messages are end-to-end styled for this demo');
