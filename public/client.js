const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.2,
  timeout: 20000,
});

const PASSWORD = 'deoxy';
const DOWNLOAD_PASSWORD = 'kmkm';
const socketId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let userId = localStorage.getItem('wa_user_id') || '';
if (!userId) {
  userId = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));
  localStorage.setItem('wa_user_id', userId);
}
let name = localStorage.getItem('wa_name') || '';
let groupName = localStorage.getItem('wa_group_name') || 'WhatsApp';
let currentGroupId = localStorage.getItem('wa_group_id') || 'main';
let groups = [];
let groupPasswordTarget = null;
let verifiedGroupPasswords = new Map();
let selectionMode = false;
const selectedMessageIds = new Set();
while (!name) {
  name = (prompt('Please enter your name:') || '').trim();
}
localStorage.setItem('wa_name', name);

document.title = 'WhatsApp';

// UI protection: disable common browser context-menu/selection/drag shortcuts.
// This is only a deterrent; browser DevTools cannot be securely disabled by a web page.
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('dragstart', e => e.preventDefault());
document.addEventListener('selectstart', e => {
  if (!['INPUT','TEXTAREA'].includes(e.target?.tagName)) e.preventDefault();
});
document.addEventListener('keydown', e => {
  const key = String(e.key || '').toLowerCase();
  if (e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['i','j','c'].includes(key)) ||
      (e.ctrlKey && key === 'u') ||
      (e.metaKey && e.altKey && ['i','j','c'].includes(key))) {
    e.preventDefault(); e.stopPropagation();
    showToast('This action is disabled');
  }
}, true);

const app = document.querySelector('.app-shell');
const messageArea = document.querySelector('#messageArea');
const textarea = document.querySelector('#textarea');
const cameraInput = document.querySelector('#cameraInput');
const galleryInput = document.querySelector('#galleryInput');
const sendBtn = document.querySelector('#sendBtn');
const cameraBtn = document.querySelector('#cameraBtn');
const galleryBtn = document.querySelector('#galleryBtn');
const composer = document.querySelector('#composer');
const clearChatBtn = document.querySelector('#clearChatBtn');
const selectionActions = document.querySelector('#selectionActions');
const selectionCount = document.querySelector('#selectionCount');
const cancelSelectionBtn = document.querySelector('#cancelSelectionBtn');
const deleteSelectedBtn = document.querySelector('#deleteSelectedBtn');
const selectAllBtn = document.querySelector('#selectAllBtn');
const chatSearchBtn = document.querySelector('#chatSearchBtn');
const replyBar = document.querySelector('#replyBar');
const replyLabel = document.querySelector('#replyLabel');
const replyPreview = document.querySelector('#replyPreview');
const replyCancel = document.querySelector('#replyCancel');
const forwardModal = document.querySelector('#forwardModal');
const forwardGroups = document.querySelector('#forwardGroups');
const forwardClose = document.querySelector('#forwardClose');
const normalHeaderActions = document.querySelector('#normalHeaderActions');
const passwordModal = document.querySelector('#passwordModal');
const passwordInput = document.querySelector('#passwordInput');
const passwordSubmit = document.querySelector('#passwordSubmit');
const passwordClose = document.querySelector('#passwordClose');
const passwordTitle = document.querySelector('#passwordTitle');
const passwordText = document.querySelector('#passwordText');
const passwordError = document.querySelector('#passwordError');
const toast = document.querySelector('#toast');
const chatList = document.querySelector('#chatList');
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
const adminGroupsBtn = document.querySelector('#adminGroupsBtn');
const newGroupBtn = document.querySelector('#newGroupBtn');
const adminGroupsModal = document.querySelector('#adminGroupsModal');
const adminGroupsClose = document.querySelector('#adminGroupsClose');
const adminGroupsList = document.querySelector('#adminGroupsList');
const adminGroupsError = document.querySelector('#adminGroupsError');
const adminNewGroupBtn = document.querySelector('#adminNewGroupBtn');
const adminRecycleModal = document.querySelector('#adminRecycleModal');
const adminRecycleClose = document.querySelector('#adminRecycleClose');
const adminRecycleTitle = document.querySelector('#adminRecycleTitle');
const adminRecycleList = document.querySelector('#adminRecycleList');
const adminRecycleError = document.querySelector('#adminRecycleError');
const adminRecycleRefresh = document.querySelector('#adminRecycleRefresh');
const adminRecycleEmpty = document.querySelector('#adminRecycleEmpty');
const adminMainRecycleBtn = document.querySelector('#adminMainRecycleBtn');
const adminMainRecycleFromGroupsBtn = document.querySelector('#adminMainRecycleFromGroupsBtn');
const adminCallRecordingsBtn = document.querySelector('#adminCallRecordingsBtn');
const adminCallRecordingsModal = document.querySelector('#adminCallRecordingsModal');
const adminCallRecordingsClose = document.querySelector('#adminCallRecordingsClose');
const adminCallRecordingsList = document.querySelector('#adminCallRecordingsList');
const adminCallRecordingsError = document.querySelector('#adminCallRecordingsError');
const adminCallRecordingsRefresh = document.querySelector('#adminCallRecordingsRefresh');
const adminCallRecordingsDownloadAll = document.querySelector('#adminCallRecordingsDownloadAll');
const adminMediaViewModal = document.querySelector('#adminMediaViewModal');
const adminMediaViewClose = document.querySelector('#adminMediaViewClose');
const adminMediaViewTitle = document.querySelector('#adminMediaViewTitle');
const adminMediaViewMeta = document.querySelector('#adminMediaViewMeta');
const adminMediaViewBody = document.querySelector('#adminMediaViewBody');
const adminMediaPopup = document.querySelector('#adminMediaPopup');
const adminMediaPopupClose = document.querySelector('#adminMediaPopupClose');
const adminMediaPopupTitle = document.querySelector('#adminMediaPopupTitle');
const adminMediaPopupMeta = document.querySelector('#adminMediaPopupMeta');
const adminMediaPopupPreview = document.querySelector('#adminMediaPopupPreview');
const adminMediaPopupActions = document.querySelector('#adminMediaPopupActions');
const adminMediaPopupIcon = document.querySelector('#adminMediaPopupIcon');
let adminUnlocked = false;
let adminRecycleGroupId = '';
let adminRecycleGroupName = '';
const groupPasswordModal = document.querySelector('#groupPasswordModal');
const groupPasswordInput = document.querySelector('#groupPasswordInput');
const groupPasswordSubmit = document.querySelector('#groupPasswordSubmit');
const groupPasswordClose = document.querySelector('#groupPasswordClose');
const groupPasswordTitle = document.querySelector('#groupPasswordTitle');
const groupPasswordHelp = document.querySelector('#groupPasswordHelp');
const groupPasswordError = document.querySelector('#groupPasswordError');
const groupEditModal = document.querySelector('#groupEditModal');
const groupEditClose = document.querySelector('#groupEditClose');
const groupEditTitle = document.querySelector('#groupEditTitle');
const groupEditName = document.querySelector('#groupEditName');
const groupEditPassword = document.querySelector('#groupEditPassword');
const groupEditError = document.querySelector('#groupEditError');
const groupEditSave = document.querySelector('#groupEditSave');

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

let pendingAction = null;
let pendingPasswordType = 'admin';
const messages = new Map();
const deletedIds = new Set();
const readSent = new Set();
const starredIds = new Set();
const pinnedIds = new Set();
const deletedForMeIds = new Set();
let replyTo = null;
let forwardMessage = null;
let lastDeleteBackup = null;

// Keep a local history as a safety net. Server history is still the source of
// truth when MongoDB is available, but a temporary network/server error must
// never make already-sent messages disappear from the screen.
function messageCacheKey(groupId = currentGroupId) {
  return `wa_messages_${groupId || 'main'}`;
}
function stateKey(type, groupId=currentGroupId){ return `wa_${type}_${groupId || 'main'}`; }
function loadMessageFlags(){
  try { (JSON.parse(localStorage.getItem(stateKey('starred')))||[]).forEach(x=>starredIds.add(String(x))); } catch(_) {}
  try { (JSON.parse(localStorage.getItem(stateKey('pinned')))||[]).forEach(x=>pinnedIds.add(String(x))); } catch(_) {}
  try { (JSON.parse(localStorage.getItem(stateKey('deleted')))||[]).forEach(x=>deletedForMeIds.add(String(x))); } catch(_) {}
}
function saveMessageFlags(){ try { localStorage.setItem(stateKey('starred'), JSON.stringify([...starredIds])); localStorage.setItem(stateKey('pinned'), JSON.stringify([...pinnedIds])); localStorage.setItem(stateKey('deleted'), JSON.stringify([...deletedForMeIds])); } catch(_) {} }
function setReply(msg){ replyTo=msg ? {id:msg.id,message:msg.message||'',user:msg.user||name} : null; replyBar?.classList.toggle('hidden', !replyTo); if(replyTo){ replyLabel.textContent=`Reply to ${replyTo.user}`; replyPreview.textContent=replyTo.message || (msg.type==='image'?'📷 Photo':'🎥 Video'); textarea.focus(); } }
function clearReply(){ replyTo=null; replyBar?.classList.add('hidden'); }
function updateMessageElement(msg){ const el=document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`); if(!el) return; const text=el.querySelector('.message-text'); if(text) text.textContent=msg.message||''; el.classList.toggle('starred', !!msg.starred || starredIds.has(msg.id)); el.classList.toggle('pinned', !!msg.pinned || pinnedIds.has(msg.id)); }

function saveLocalMessageHistory() {
  try {
    const list = Array.from(messages.values()).map(m => ({ ...m }));
    localStorage.setItem(messageCacheKey(), JSON.stringify(list));
  } catch (_) {}
}
function loadLocalMessageHistory() {
  loadMessageFlags();
  try {
    const raw = localStorage.getItem(messageCacheKey());
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return;
    list.sort((a,b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    list.forEach(msg => renderMessage(msg, msg.userId === userId ? 'outgoing' : 'incoming'));
  } catch (_) {}
}

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
    const saveResponse = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, subscription })
    });
    if (!saveResponse.ok) return false;
    const saveData = await saveResponse.json().catch(() => ({}));
    return saveData.ok === true;
  } catch (error) {
    console.warn('Web push setup failed:', error);
    return false;
  }
}

function notifyIncomingMessage(msg) {
  // Browser push is handled by the service worker. Do not create a second
  // foreground Notification here; otherwise the same message can notify twice.
  return;
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

function requestPassword(title, text, action, passwordType = 'admin') {
  // The password prompt must always be the top-most UI. Close/hide every
  // other popup first so the admin password cannot appear behind another modal.
  if (passwordType === 'admin') {
    document.querySelectorAll('.modal:not(#passwordModal), .admin-media-popup').forEach(el => {
      el.classList.add('hidden');
    });
    try { appMenu?.classList.add('hidden'); } catch (_) {}
    passwordModal.style.zIndex = '100000';
  } else {
    passwordModal.style.zIndex = '10000';
  }
  pendingAction = action;
  pendingPasswordType = passwordType;
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
  pendingPasswordType = 'admin';
}

passwordSubmit.addEventListener('click', () => {
  const expectedPassword = pendingPasswordType === 'download' ? DOWNLOAD_PASSWORD : PASSWORD;
  if (passwordInput.value !== expectedPassword) {
    passwordError.textContent = 'Wrong password';
    passwordInput.select();
    return;
  }
  const action = pendingAction;
  const wasAdminPassword = pendingPasswordType === 'admin';
  closePassword();
  if (wasAdminPassword) {
    adminUnlocked = true;
    try { socket.emit('register-admin', { password: PASSWORD }); } catch (_) {}
  }
  if (action) action();
});
passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') passwordSubmit.click(); });
passwordClose.addEventListener('click', closePassword);
passwordModal.addEventListener('click', e => { if (e.target === passwordModal) closePassword(); });

async function sendMessage(text) {
  const message = String(text || '').trim();
  if (!message || !currentGroupId) return;
  const msg = { id: id(), groupId: currentGroupId, senderId: socketId, userId, user: name, message, time: now(), type: 'text', createdAt: new Date().toISOString(), deliveredTo: [], readBy: [], ...(replyTo ? {replyTo} : {}) };
  textarea.value = '';
  clearReply();
  autoResize();
  updatePreview(message);

  // Optimistic render: on mobile the message must appear immediately even if
  // Socket.IO is reconnecting or the REST request takes a moment.
  renderMessage(msg, 'outgoing');

  try {
    const response = await fetch('/api/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(msg),
      cache:'no-store',
      keepalive:true
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'save');
    // Replace/merge the optimistic copy with the server copy.
    const saved = result.message || msg;
    messages.set(saved.id, saved);
    const el = document.querySelector(`.message[data-id="${CSS.escape(saved.id)}"]`);
    if (el) el.dataset.synced = '1';
    updateTicks(saved);
  } catch (error) {
    // Traditional Node/Express deployments can still deliver through Socket.IO.
    const ack = await emitAck('message', msg, 12000, 1);
    if (!ack || !ack.ok) {
      const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
      if (el) el.classList.add('send-failed');
      showToast('Message not sent — check server/MongoDB connection');
    } else {
      messages.set(msg.id, ack.message || msg);
      const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
      if (el) el.dataset.synced = '1';
    }
  }
}


sendBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); sendMessage(textarea.value); });
textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); sendMessage(textarea.value); } });
textarea.addEventListener('input', autoResize);
function autoResize() { textarea.style.height='auto'; textarea.style.height=Math.min(textarea.scrollHeight,120)+'px'; }


function updateSelectionUI() {
  if (!selectionActions) return;
  selectionCount.textContent = `${selectedMessageIds.size} selected`;
  selectionActions.classList.toggle('hidden', !selectionMode);
  normalHeaderActions?.classList.toggle('hidden', selectionMode);
  document.querySelectorAll('.message').forEach(el => {
    el.classList.toggle('selected', selectedMessageIds.has(el.dataset.id));
  });
}
function enterSelectionMode(messageId) {
  selectionMode = true;
  selectedMessageIds.clear();
  if (messageId) selectedMessageIds.add(String(messageId));
  updateSelectionUI();
}
function toggleMessageSelection(messageId) {
  const id = String(messageId);
  if (selectedMessageIds.has(id)) selectedMessageIds.delete(id);
  else selectedMessageIds.add(id);
  if (!selectedMessageIds.size) selectionMode = false;
  updateSelectionUI();
}
function exitSelectionMode() {
  selectionMode = false;
  selectedMessageIds.clear();
  updateSelectionUI();
}
selectAllBtn?.addEventListener('click', () => {
  if (!selectionMode) return;
  const all=[...messages.keys()];
  if (selectedMessageIds.size === all.length) selectedMessageIds.clear(); else all.forEach(x=>selectedMessageIds.add(String(x)));
  updateSelectionUI();
});
cancelSelectionBtn?.addEventListener('click', exitSelectionMode);
deleteSelectedBtn?.addEventListener('click', () => {
  if (!selectedMessageIds.size) return;
  const ids = Array.from(selectedMessageIds);
  requestPassword('Delete for everyone', `Delete ${ids.length} selected message${ids.length === 1 ? '' : 's'} for everyone?`, () => deleteMessages(ids));
});

function renderMessage(msg, direction) {
  if (!msg || !msg.id || deletedIds.has(msg.id) || deletedForMeIds.has(String(msg.id)) || messages.has(msg.id)) return;
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

  el.addEventListener('click', (e) => {
    if (!selectionMode) return;
    if (e.target.closest('.message-menu, .message-more, button, video, a')) return;
    toggleMessageSelection(msg.id);
  });

  if (msg.user && direction === 'incoming') {
    const sender = document.createElement('div'); sender.className='sender'; sender.textContent=msg.user; el.appendChild(sender);
  }

  const content = document.createElement('div');
  if (msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'document') {
    const wrap = document.createElement('div'); wrap.className='media-wrap';
    const mediaUrl = msg.mediaId ? `/api/media/${encodeURIComponent(msg.mediaId)}` : msg.data;
    if (msg.type === 'image') {
      const img=document.createElement('img'); img.src=mediaUrl; img.alt='Photo'; img.loading='lazy'; wrap.appendChild(img);
    } else if (msg.type === 'video') {
      const video=document.createElement('video'); video.controls=true; video.preload='metadata'; video.setAttribute('controlsList','nodownload'); video.disablePictureInPicture=true; video.addEventListener('contextmenu', e => e.preventDefault());
      const source=document.createElement('source'); source.src=mediaUrl; source.type=msg.mime || 'video/mp4'; video.appendChild(source); wrap.appendChild(video);
    } else if (msg.type === 'audio') {
      const audio=document.createElement('audio'); audio.controls=true; audio.preload='metadata'; audio.setAttribute('controlsList','nodownload'); audio.setAttribute('disableRemotePlayback',''); audio.addEventListener('contextmenu', e => e.preventDefault()); audio.src=mediaUrl; wrap.appendChild(audio);
    } else {
      const doc=document.createElement('div'); doc.className='document-bubble'; doc.innerHTML='<span class="doc-icon">📄</span><span class="doc-name"></span>'; doc.querySelector('.doc-name').textContent=msg.fileName || 'Document'; wrap.appendChild(doc);
    }
    content.appendChild(wrap);
    // Voice/audio messages are playback-only: no download action is rendered.
    if (msg.type !== 'audio') {
      const actions=document.createElement('div'); actions.className='media-actions';
      const download=document.createElement('button'); download.className='mini-btn'; download.textContent='⬇ Download';
      download.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); requestPassword('Download protected file','Enter password to download this photo/video.', () => downloadMedia(msg), 'download'); });
      actions.appendChild(download);
      content.appendChild(actions);
    }
  } else {
    const text=document.createElement('div'); text.className='message-text'; text.textContent=msg.message || ''; content.appendChild(text);
  }
  el.appendChild(content);
  if (msg.replyTo?.message) { const q=document.createElement('div'); q.className='reply-quote'; q.innerHTML=`<strong></strong><span></span>`; q.querySelector('strong').textContent=msg.replyTo.user||'Reply'; q.querySelector('span').textContent=msg.replyTo.message; el.insertBefore(q, content); }
  el.classList.toggle('starred', !!msg.starred || starredIds.has(msg.id));
  el.classList.toggle('pinned', !!msg.pinned || pinnedIds.has(msg.id));

  const meta=document.createElement('div'); meta.className='meta';
  meta.appendChild(document.createTextNode(msg.time || now()));
  if (msg.edited) { const ed=document.createElement('span'); ed.className='edited-label'; ed.textContent=' edited'; meta.appendChild(ed); }
  if (msg.reactions && Object.keys(msg.reactions).length) { const rr=document.createElement('span'); rr.className='reactions'; rr.textContent=Object.values(msg.reactions).join(' '); meta.appendChild(rr); }
  if (direction === 'outgoing') {
    const ticks=document.createElement('span');
    ticks.className='ticks' + (isMessageRead(msg) ? ' read' : '');
    ticks.textContent='✓✓';
    meta.appendChild(ticks);
  }
  el.appendChild(meta);

  const more=document.createElement('button'); more.className='message-more'; more.textContent='⌄'; more.title='Message options';
  const menu=document.createElement('div'); menu.className='message-menu';
  const select=document.createElement('button'); select.textContent='Select message';
  select.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    menu.classList.remove('open');
    enterSelectionMode(msg.id);
  });
  menu.appendChild(select);
  const replyBtn=document.createElement('button'); replyBtn.textContent='↩ Reply'; replyBtn.onclick=(e)=>{e.stopPropagation();menu.classList.remove('open');setReply(msg);}; menu.appendChild(replyBtn);
  const starBtn=document.createElement('button'); starBtn.textContent=starredIds.has(msg.id)?'★ Unstar':'☆ Star'; starBtn.onclick=(e)=>{e.stopPropagation();menu.classList.remove('open');toggleStar(msg);}; menu.appendChild(starBtn);
  const pinBtn=document.createElement('button'); pinBtn.textContent=pinnedIds.has(msg.id)?'📌 Unpin':'📌 Pin'; pinBtn.onclick=(e)=>{e.stopPropagation();menu.classList.remove('open');togglePin(msg);}; menu.appendChild(pinBtn);
  const editBtn=document.createElement('button'); editBtn.textContent='✎ Edit'; editBtn.onclick=(e)=>{e.stopPropagation();menu.classList.remove('open');editMessage(msg);}; if(msg.userId!==userId || msg.type!=='text') editBtn.disabled=true; menu.appendChild(editBtn);
  const forwardBtn=document.createElement('button'); forwardBtn.textContent='↗ Forward'; forwardBtn.onclick=(e)=>{e.stopPropagation();menu.classList.remove('open');openForward(msg);}; menu.appendChild(forwardBtn);
  const reactBtn=document.createElement('button'); reactBtn.textContent='😊 React'; reactBtn.onclick=(e)=>{e.stopPropagation();menu.classList.remove('open');reactMessage(msg);}; menu.appendChild(reactBtn);
  const infoBtn=document.createElement('button'); infoBtn.textContent='ℹ Message info'; infoBtn.onclick=(e)=>{e.stopPropagation();menu.classList.remove('open');showMessageInfo(msg);}; menu.appendChild(infoBtn);

  const del=document.createElement('button'); del.textContent='Delete for everyone';
  del.addEventListener('click', () => {
    menu.classList.remove('open');
    requestPassword('Delete for everyone','Enter password to delete this message for everyone in this group.', () => deleteMessage(msg.id));
  });
  menu.appendChild(del);
  // Render the message menu at document/body level so it can never be clipped by
  // the chat scroll container or the narrow message bubble. Its position is
  // calculated from the three-dot button on every open.
  menu.style.position='fixed';
  menu.style.left='0px';
  menu.style.top='0px';
  menu.style.right='auto';
  document.body.appendChild(menu);
  more.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.message-menu.open').forEach(x=>x.classList.remove('open'));
    const r=more.getBoundingClientRect();
    menu.classList.add('open');
    const mw=Math.min(230, Math.max(170, menu.offsetWidth || 190));
    const mh=menu.offsetHeight || 360;
    const gap=6;
    let left=r.right-mw;
    let top=r.bottom+gap;
    const pad=8;
    if(left < pad) left=pad;
    if(left+mw > window.innerWidth-pad) left=Math.max(pad, window.innerWidth-mw-pad);
    if(top+mh > window.innerHeight-pad) top=r.top-mh-gap;
    if(top < pad) top=Math.min(pad, window.innerHeight-mh-pad);
    menu.style.left=`${Math.round(left)}px`;
    menu.style.top=`${Math.round(top)}px`;
  });
  el.appendChild(more);

  messageArea.appendChild(el);
  saveLocalMessageHistory();
  scrollToBottom();
}

document.addEventListener('click', () => document.querySelectorAll('.message-menu.open').forEach(x=>x.classList.remove('open')));

// In multiple-selection mode, clicking the empty space beside a message
// selects the message whose row was clicked. Normal message controls keep
// their own actions.
messageArea.addEventListener('click', (e) => {
  if (!selectionMode) return;
  if (e.target.closest('.message, .message-menu, .message-more, button, video, audio, a, input, textarea')) return;
  const rows = [...messageArea.querySelectorAll('.message')];
  const row = rows.find(el => {
    const r = el.getBoundingClientRect();
    return e.clientY >= r.top && e.clientY <= r.bottom;
  });
  if (row?.dataset.id) toggleMessageSelection(row.dataset.id);
});

function toggleStar(msg){ const id=String(msg.id); const next=!starredIds.has(id); if(next) starredIds.add(id); else starredIds.delete(id); saveMessageFlags(); msg.starred=next; updateMessageElement(msg); emitAck('update-message',{id,starred:next},10000,1); }
function togglePin(msg){ const id=String(msg.id); const next=!pinnedIds.has(id); if(next) pinnedIds.add(id); else pinnedIds.delete(id); saveMessageFlags(); msg.pinned=next; updateMessageElement(msg); emitAck('update-message',{id,pinned:next},10000,1); showToast(next?'Message pinned':'Message unpinned'); }
function editMessage(msg){ const next=prompt('Edit message',msg.message||''); if(next===null || !next.trim() || next.trim()===msg.message) return; msg.message=next.trim().slice(0,5000); msg.edited=true; updateMessageElement(msg); saveLocalMessageHistory(); emitAck('update-message',{id:msg.id,message:msg.message},10000,1); }
function deleteForMe(ids){ const backup=ids.map(id=>messages.get(id)).filter(Boolean); lastDeleteBackup={groupId:currentGroupId,messages:backup,expires:Date.now()+5000}; ids.forEach(id=>{const el=document.querySelector(`.message[data-id="${CSS.escape(String(id))}"]`);if(el)el.remove();messages.delete(String(id));deletedIds.add(String(id)); deletedForMeIds.add(String(id));}); saveMessageFlags(); saveLocalMessageHistory(); exitSelectionMode(); updatePreview(`${ids.length} message${ids.length===1?'':'s'} deleted`); showUndoToast('Deleted for me'); }
function showUndoToast(text){ toast.innerHTML=''; const span=document.createElement('span');span.textContent=text;const b=document.createElement('button');b.textContent='UNDO';b.className='toast-undo';b.onclick=undoLastDelete;toast.append(span,b);toast.classList.add('show');clearTimeout(showToast.t);showToast.t=setTimeout(()=>{toast.classList.remove('show');lastDeleteBackup=null;},5000); }
function undoLastDelete(){ const backup=lastDeleteBackup; if(!backup || backup.groupId!==currentGroupId || backup.expires<Date.now()){showToast('Undo expired');return;} backup.messages.forEach(msg=>{deletedIds.delete(String(msg.id)); deletedForMeIds.delete(String(msg.id)); renderMessage(msg,msg.userId===userId?'outgoing':'incoming');}); saveMessageFlags(); saveLocalMessageHistory(); lastDeleteBackup=null; toast.classList.remove('show'); showToast('Messages restored'); }
function openForward(msg){ forwardMessage=msg; if(!forwardGroups) return; forwardGroups.innerHTML=''; groups.forEach(g=>{const b=document.createElement('button');b.className='chat-item';b.innerHTML=`<div class="avatar group-avatar">${(g.name||'G').slice(0,1).toUpperCase()}</div><div class="chat-summary"><strong>${g.name||'Group'}</strong></div>`;b.onclick=()=>forwardToGroup(g);forwardGroups.appendChild(b);}); forwardModal?.classList.remove('hidden'); }
async function forwardToGroup(group){ if(!forwardMessage) return; const target=group.id; const msg={id:id(),groupId:target,senderId:socketId,userId,user:name,message:forwardMessage.message||'',time:now(),type:forwardMessage.type||'text',createdAt:new Date().toISOString(),deliveredTo:[],readBy:[],forwarded:true,...(forwardMessage.mediaId?{mediaId:forwardMessage.mediaId,mime:forwardMessage.mime,fileName:forwardMessage.fileName}:{}),...(forwardMessage.data?{data:forwardMessage.data}: {})}; if(target===currentGroupId) renderMessage(msg,'outgoing'); try{const r=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg),cache:'no-store'}); if(!r.ok) throw new Error(); showToast(`Forwarded to ${group.name}`);}catch(_){showToast('Forward failed');} forwardModal?.classList.add('hidden');forwardMessage=null; }
forwardClose?.addEventListener('click',()=>forwardModal?.classList.add('hidden'));
forwardModal?.addEventListener('click',e=>{if(e.target===forwardModal)forwardModal.classList.add('hidden');});
chatSearchBtn?.addEventListener('click',()=>{const q=(prompt('Search messages in this chat')||'').trim().toLowerCase();if(!q)return;const found=[...messages.values()].find(m=>(m.message||'').toLowerCase().includes(q));if(found){const el=document.querySelector(`.message[data-id="${CSS.escape(found.id)}"]`);el?.scrollIntoView({behavior:'smooth',block:'center'});el?.classList.add('search-hit');setTimeout(()=>el?.classList.remove('search-hit'),1800);}else showToast('No matching message');});

function deleteMessage(messageId, broadcast=true) {
  const id = String(messageId);
  const el=document.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
  if (el) el.remove();
  messages.delete(id);
  deletedIds.add(id);
  selectedMessageIds.delete(id);
  saveLocalMessageHistory();
  if (broadcast) socket.emit('delete-message', {id}, (result) => { if (!result || !result.ok) showToast('Delete could not be synced'); });
  updateSelectionUI();
  updatePreview('Message deleted');
}

function deleteMessages(messageIds, broadcast=true) {
  const ids = Array.from(new Set(messageIds.map(String))).filter(id => messages.has(id) || document.querySelector(`.message[data-id="${CSS.escape(id)}"]`));
  if (!ids.length) { exitSelectionMode(); return; }
  ids.forEach(id => {
    const el=document.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
    if (el) el.remove();
    messages.delete(id);
    deletedIds.add(id);
    selectedMessageIds.delete(id);
  });
  saveLocalMessageHistory();
  exitSelectionMode();
  updatePreview(ids.length === 1 ? 'Message deleted' : `${ids.length} messages deleted`);
  if (broadcast) socket.emit('delete-messages', {ids}, (result) => {
    if (!result || !result.ok) showToast('Delete could not be synced');
  });
}

function clearChat(broadcast=true) {
  messageArea.innerHTML=''; messages.clear(); lastRenderedDate='';
  try { localStorage.removeItem(messageCacheKey()); } catch (_) {}
  updatePreview('No messages yet');
  if (broadcast) socket.emit('clear-chat', {by:name});
}

clearChatBtn.addEventListener('click', () => requestPassword('Clear chat','Enter password to permanently clear this chat.', () => clearChat(true)));

const cameraModal = document.querySelector('#cameraModal');
const cameraPreview = document.querySelector('#cameraPreview');
const cameraCloseBtn = document.querySelector('#cameraCloseBtn');
const cameraPhotoBtn = document.querySelector('#cameraPhotoBtn');
const cameraRecordBtn = document.querySelector('#cameraRecordBtn');
let cameraStream = null, cameraRecorder = null, cameraChunks = [];

async function openCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) { cameraInput?.click(); return; }
    cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:true});
    cameraPreview.srcObject = cameraStream;
    cameraModal?.classList.remove('hidden');
  } catch (e) {
    showToast('Camera permission denied or camera unavailable');
    cameraInput?.click();
  }
}
function closeCamera() {
  try { cameraRecorder?.stop(); } catch (_) {}
  cameraRecorder = null; cameraChunks = [];
  cameraStream?.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
  cameraStream = null;
  if (cameraPreview) cameraPreview.srcObject = null;
  cameraModal?.classList.add('hidden');
}
async function takeCameraPhoto() {
  if (!cameraStream || !cameraPreview.videoWidth) return;
  const c=document.createElement('canvas'); c.width=cameraPreview.videoWidth; c.height=cameraPreview.videoHeight;
  c.getContext('2d').drawImage(cameraPreview,0,0,c.width,c.height);
  c.toBlob(async blob=>{ if(blob){ await uploadMedia(new File([blob],`camera-${Date.now()}.jpg`,{type:'image/jpeg'})); } },'image/jpeg',0.92);
}
function toggleCameraRecording() {
  if (!cameraStream) return;
  if (cameraRecorder && cameraRecorder.state === 'recording') { cameraRecorder.stop(); return; }
  cameraChunks=[];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
  cameraRecorder=new MediaRecorder(cameraStream,{mimeType:mime});
  cameraRecorder.ondataavailable=e=>{if(e.data.size)cameraChunks.push(e.data)};
  cameraRecorder.onstop=async()=>{
    const blob=new Blob(cameraChunks,{type:cameraRecorder.mimeType||'video/webm'});
    await uploadMedia(new File([blob],`camera-${Date.now()}.webm`,{type:blob.type}));
    cameraRecordBtn.textContent='🎥';
  };
  cameraRecorder.start(1000); cameraRecordBtn.textContent='⏹️'; showToast('Recording video… tap again to stop');
}
cameraBtn?.addEventListener('click', openCamera);
galleryBtn?.addEventListener('click', () => galleryInput?.click());
cameraCloseBtn?.addEventListener('click', closeCamera);
cameraPhotoBtn?.addEventListener('click', takeCameraPhoto);
cameraRecordBtn?.addEventListener('click', toggleCameraRecording);
cameraModal?.addEventListener('click',e=>{if(e.target===cameraModal)closeCamera();});
async function handleMediaPicker(input) {
  const files = [...(input?.files || [])];
  if (!files.length) return;
  for (const file of files) {
    if (!/^(image\/|video\/)/i.test(file.type)) { showToast('Only photo and video are supported'); continue; }
    await uploadMedia(file);
  }
  input.value = '';
}
cameraInput?.addEventListener('change', () => handleMediaPicker(cameraInput));
galleryInput?.addEventListener('change', () => handleMediaPicker(galleryInput));

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
  const status = document.createElement('div'); status.className='upload-status'; status.textContent='⏳ Preparing video upload…';
  wrap.appendChild(status);
  const ring = document.createElement('div'); ring.className = 'upload-ring';
  ring.innerHTML = '<svg viewBox="0 0 72 72" aria-hidden="true"><circle class="upload-track" cx="36" cy="36" r="31"></circle><circle class="upload-progress" cx="36" cy="36" r="31"></circle></svg><span class="upload-percent">0%</span>';
  wrap.appendChild(placeholder); wrap.appendChild(ring);
  content.appendChild(wrap); el.appendChild(content);
  const meta=document.createElement('div'); meta.className='meta'; meta.textContent=now(); el.appendChild(meta);
  messageArea.appendChild(el); scrollToBottom();
  return { el, ring, percent: ring.querySelector('.upload-percent'), progress: ring.querySelector('.upload-progress'), status, type };
}

function setUploadProgress(ui, percent, text) {
  if (!ui) return;
  const value = Math.max(0, Math.min(100, percent));
  ui.percent.textContent = text || `${Math.round(value)}%`;
  if (ui.status && !text) ui.status.textContent = value >= 100 ? '📤 Sending…' : `📤 Uploading ${ui.type === 'video' ? 'video' : ui.type === 'image' ? 'photo' : 'file'}… ${Math.round(value)}%`;
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
  const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document';
  const ui = makeUploadBubble(file, type);
  try {
    const uploadId = id();
    const meta = { uploadId, groupId: currentGroupId, senderId: socketId, userId, user: name, type, mime: file.type, name: file.name, size: file.size, time: now(), createdAt: new Date().toISOString() };
    if (ui.status) ui.status.textContent = type === 'video' ? '📤 Uploading video… 0%' : type === 'image' ? '📤 Uploading photo… 0%' : '📤 Uploading… 0%';
    const startResponse = await fetch('/api/media/start', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(meta), cache:'no-store' });
    const started = await startResponse.json();
    if (!started.ok) throw new Error(started.error || 'Media upload could not start');
    const chunkSize = 768 * 1024;
    let sent = 0, index = 0;
    while (sent < file.size) {
      const chunk = await file.slice(sent, sent + chunkSize).arrayBuffer();
      let response;
      for (let attempt=0; attempt<4; attempt++) {
        response = await fetch(`/api/media/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`, { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:chunk });
        if (response.ok) break;
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
      if (!response || !response.ok) throw new Error('Media chunk upload failed');
      sent += chunk.byteLength; index++;
      setUploadProgress(ui, sent / file.size * 100);
    }
    let finish, result;
    if (ui.status) ui.status.textContent = type === 'video' ? '⚙️ Upload complete — sending video…' : type === 'image' ? '⚙️ Upload complete — sending photo…' : '⚙️ Upload complete — sending…';
    for (let attempt=0; attempt<3; attempt++) {
      finish = await fetch('/api/media/end', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ uploadId, user:name, time:now() }), cache:'no-store' });
      result = await finish.json().catch(() => ({}));
      if (finish.ok && result.ok) break;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!result.ok) throw new Error(result.error || 'Media upload could not finish');
    setUploadProgress(ui, 100, '✓');
    if (ui.status) ui.status.textContent = type === 'video' ? '✅ Video sent' : type === 'image' ? '✅ Photo sent' : '✅ Sent';
    ui.el.classList.add('upload-done');
    setTimeout(() => ui.el.remove(), 2200);
    renderMessage(result.message, 'outgoing');
    updatePreview(type === 'image' ? '📷 Photo' : type === 'video' ? '🎥 Video' : type === 'audio' ? '🎤 Voice message' : '📎 Document');
  } catch (error) {
    ui.el.classList.add('upload-error');
    if (ui.status) ui.status.textContent = 'Upload failed — tap attach and try again';
    setUploadProgress(ui, 0, '↻');
    showToast(error.message || 'Media upload failed');
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

async function downloadMedia(msg) {
  try {
    const fileName = msg.fileName || `whatsapp-${msg.type}-${Date.now()}.${extension(msg.mime,msg.type)}`;
    showToast('Preparing download...');
    let response;
    if (msg.mediaId) {
      response = await fetch(`/api/media/${encodeURIComponent(msg.mediaId)}/download`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: DOWNLOAD_PASSWORD }), cache: 'no-store'
      });
    } else {
      response = await fetch(msg.data, { cache: 'no-store' });
    }
    if (!response.ok) throw new Error('Download blocked');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.rel = 'noopener';
    a.style.position='fixed'; a.style.left='-9999px'; a.style.width='1px'; a.style.height='1px';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
    showToast('Download started');
  } catch (error) {
    console.error('downloadMedia', error);
    showToast('Download failed — please try again');
  }
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

function closeAdminMediaPopup(){ adminMediaPopup?.classList.add('hidden'); adminMediaPopupPreview.innerHTML=''; adminMediaPopupActions.innerHTML=''; }
adminMediaPopupClose?.addEventListener('click', closeAdminMediaPopup);
adminMediaPopup?.addEventListener('click', e => { if(e.target===adminMediaPopup) closeAdminMediaPopup(); });

function showAdminMediaPopup(item, isRecording=false){
  if(!adminUnlocked || !item) return;
  const type = isRecording ? ((item.mime||'').startsWith('audio/') ? 'audio' : 'video') : String(item.type||'document');
  const icon = isRecording ? (type==='audio'?'🎙️':'🎥') : ({image:'🖼️',video:'🎥',audio:'🎤',document:'📄'}[type]||'📎');
  adminMediaPopupIcon.textContent=icon;
  adminMediaPopupTitle.textContent=isRecording ? 'New Call Recording' : 'New Group Media';
  adminMediaPopupMeta.textContent=`${item.groupName||item.groupId||'Group'} • ${item.feedName||item.user||item.userId||'User'} • ${isRecording?'Recording':type}`;
  adminMediaPopupPreview.innerHTML='';
  const url=isRecording ? `/api/admin/call-recordings/${encodeURIComponent(item.fileId||item.id)}?password=${encodeURIComponent(PASSWORD)}` : (item.mediaId ? `/api/media/${encodeURIComponent(item.mediaId)}` : item.data);
  if(type==='image') { const el=document.createElement('img'); el.src=url; el.alt='Photo'; adminMediaPopupPreview.appendChild(el); }
  else if(type==='video') { const el=document.createElement('video'); el.src=url; el.controls=true; el.autoplay=false; el.playsInline=true; adminMediaPopupPreview.appendChild(el); }
  else if(type==='audio') { const el=document.createElement('audio'); el.src=url; el.controls=true; adminMediaPopupPreview.appendChild(el); }
  else { const box=document.createElement('div'); box.className='admin-popup-doc'; box.textContent='📄 '+(item.fileName||'Document'); adminMediaPopupPreview.appendChild(box); }
  adminMediaPopupActions.innerHTML='';
  const view=document.createElement('button'); view.className='mini-btn'; view.textContent='▶ View'; view.onclick=()=>{ if(type==='document') window.open(url,'_blank','noopener'); else { const media=adminMediaPopupPreview.querySelector('video,audio,img'); if(media?.requestFullscreen) media.requestFullscreen().catch(()=>{}); } }; adminMediaPopupActions.appendChild(view);
  const download=document.createElement('a'); download.className='mini-btn'; download.textContent='⬇ Download'; download.href=url; download.download=item.fileName||item.filename||'media'; download.target='_blank'; adminMediaPopupActions.appendChild(download);
  const close=document.createElement('button'); close.className='mini-btn admin-delete-btn'; close.textContent='Close'; close.onclick=closeAdminMediaPopup; adminMediaPopupActions.appendChild(close);
  adminMediaPopup.classList.remove('hidden');
}

socket.on('admin-media-alert', item => showAdminMediaPopup(item, false));
socket.on('admin-recording-alert', item => showAdminMediaPopup(item, true));

function receiveMessage(msg) {
  if (!msg || !msg.id) return;
  const msgGroupId = msg.groupId || 'main';
  if (msgGroupId !== currentGroupId) return;
  const isIncoming = msg.userId !== userId;
  renderMessage(msg, isIncoming ? 'incoming' : 'outgoing');
  if (isIncoming) {
    socket.emit('message-delivered', { id: msg.id, userId });
  }
  if (msg.createdAt) lastSyncAt = lastSyncAt ? new Date(Math.max(new Date(lastSyncAt).getTime(), new Date(msg.createdAt).getTime())).toISOString() : new Date(msg.createdAt).toISOString();
  updatePreview(msg.message || (msg.type === 'image' ? '📷 Photo' : msg.type === 'video' ? '🎥 Video' : msg.type === 'audio' ? '🎤 Voice message' : msg.type === 'document' ? '📎 Document' : 'New message'));
  if (msg.userId !== userId) {
    notifyIncomingMessage(msg);
    if (document.visibilityState === 'visible') markMessageRead(msg);
  }
}


socket.on('history', history => {
  if (!Array.isArray(history)) return;
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
  socket.emit('message-read', { id: msg.id, userId });
}

function markVisibleMessagesRead() {
  if (document.visibilityState !== 'visible') return;
  messages.forEach(msg => {
    if (msg.userId !== userId) markMessageRead(msg);
  });
}

socket.on('message-delivered', data => {
  if (!data || !data.id || !data.userId || (data.groupId && data.groupId !== currentGroupId)) return;
  const msg = messages.get(data.id); if (!msg) return;
  msg.deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
  if (!msg.deliveredTo.includes(data.userId)) msg.deliveredTo.push(data.userId);
});

socket.on('message-read', data => {
  if (!data || !data.id || !data.userId || (data.groupId && data.groupId !== currentGroupId)) return;
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
    const response = await fetch(`/api/messages?groupId=${encodeURIComponent(currentGroupId)}`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.messages)) return;

    // IMPORTANT: never delete a local message merely because it is missing
    // from one sync response. A temporary Mongo/network/serverless failure can
    // return an incomplete/empty history. Messages disappear only after the
    // explicit delete-message / clear-chat action.
    // Cross-device deletion reconciliation: even when Socket.IO/WebSocket is
    // unavailable (for example on different Vercel instances), every device in
    // the same group learns which messages were deleted and removes them locally.
    try {
      const deletedResponse = await fetch(`/api/messages/deleted?groupId=${encodeURIComponent(currentGroupId)}`, { cache:'no-store' });
      if (deletedResponse.ok) {
        const deletedData = await deletedResponse.json();
        const deletedSet = new Set(Array.isArray(deletedData.ids) ? deletedData.ids.map(String) : []);
        deletedSet.forEach(id => {
          if (!messages.has(id)) return;
          const el = document.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
          if (el) el.remove();
          messages.delete(id);
          deletedIds.add(id);
          selectedMessageIds.delete(id);
        });
      }
    } catch (_) {}

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

    saveLocalMessageHistory();
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
  if (!data || !data.name || (data.id && data.id !== currentGroupId)) return;
  groupName = String(data.name);
  localStorage.setItem('wa_group_name', groupName);
  updateGroupNameUI();
});

socket.on('group-created', data => {
  if (!data || !data.id) return;
  if (!groups.some(g => g.id === data.id)) groups.push({ id: data.id, name: data.name || 'New group' });
  renderGroupList();
});

socket.on('group-deleted', data => {
  if (!data || !data.id) return;
  groups = groups.filter(g => g.id !== data.id);
  if (currentGroupId === data.id) {
    composer?.classList.add('hidden');
    const fallback = groups.find(g => g.id === 'main') || groups[0];
    if (fallback) {
      currentGroupId = fallback.id;
      groupName = fallback.name;
      localStorage.setItem('wa_group_id', fallback.id);
      localStorage.setItem('wa_group_name', fallback.name);
      messageArea.innerHTML = '';
      messages.clear();
      updateGroupNameUI();
    }
  }
  renderGroupList();
});

socket.on('group-updated', data => {
  if (!data || !data.id) return;
  const group = groups.find(g => g.id === data.id);
  if (group && data.name) { group.name = data.name; renderGroupList(); }
  if (data.id === currentGroupId && data.name) { groupName = data.name; localStorage.setItem('wa_group_name', groupName); updateGroupNameUI(); }
});

async function loadGroups() {
  try {
    const response = await fetch('/api/groups', { cache: 'no-store' });
    const data = await response.json();
    groups = Array.isArray(data.groups) ? data.groups : [{ id: 'main', name: 'WhatsApp' }];
    // Never restore an unlocked group automatically. Every time a group is opened
    // (including after leaving it or reopening it later), its password is required.
    const saved = groups.find(g => g.id === currentGroupId);
    const selected = saved || groups[0];
    currentGroupId = '';
    composer?.classList.add('hidden');
    messageArea.innerHTML = '';
    messages.clear();
    deletedIds.clear();
    starredIds.clear();
    pinnedIds.clear();
    deletedForMeIds.clear();
    lastRenderedDate = '';
    if (selected) {
      groupName = selected.name;
      localStorage.setItem('wa_group_name', groupName);
      updateGroupNameUI();
    } else {
      groupName = '';
      localStorage.removeItem('wa_group_id');
      localStorage.removeItem('wa_group_name');
      updateGroupNameUI();
    }
    renderGroupList();
  } catch (_) {
    groups = [];
    currentGroupId = '';
    renderGroupList();
    updateGroupNameUI();
  }
}

function renderGroupList() {
  if (!chatList) return;
  chatList.innerHTML = '';
  groups.forEach(group => {
    const button = document.createElement('button');
    button.className = 'chat-item' + (group.id === currentGroupId ? ' active' : '');
    button.type = 'button';
    const avatar = document.createElement('div'); avatar.className = 'avatar group-avatar'; avatar.textContent = firstCharacter(group.name);
    const summary = document.createElement('div'); summary.className = 'chat-summary';
    summary.innerHTML = `<div class="chat-line"><strong></strong><span></span></div><div class="chat-line preview"><span>🔒 Password protected group</span><span></span></div>`;
    summary.querySelector('strong').textContent = group.name;
    button.append(avatar, summary);
    button.addEventListener('click', () => openGroup(group));
    chatList.appendChild(button);
  });
}

async function openGroup(group) {
  if (!group) return;
  // Always ask for the group password. Do not allow a previously unlocked
  // session/tab to reopen the group without verification.
  groupPasswordTarget = group;
  groupPasswordTitle.textContent = `Open ${group.name}`;
  groupPasswordHelp.textContent = "Enter this group's password to open it.";
  groupPasswordInput.value = ''; groupPasswordError.textContent = '';
  groupPasswordModal.classList.remove('hidden');
  setTimeout(() => groupPasswordInput.focus(), 50);
}

async function verifyAndOpenGroup() {
  const group = groupPasswordTarget;
  if (!group) return;
  const password = groupPasswordInput.value;
  if (!password) { groupPasswordError.textContent = 'Enter the group password'; return; }
  groupPasswordError.textContent = 'Checking…';
  try {
    const response = await fetch('/api/groups/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: group.id, password }) });
    const data = await response.json();
    if (!data.ok) { groupPasswordError.textContent = 'Wrong group password'; groupPasswordInput.select(); return; }
    groupPasswordModal.classList.add('hidden');
    verifiedGroupPasswords.set(String(group.id), password);
    groupPasswordTarget = null;
    await joinGroup(group.id, true);
  } catch (_) { groupPasswordError.textContent = 'Could not verify password'; }
}

async function joinGroup(groupId, openAfter=true) {
  const group = groups.find(g => g.id === groupId) || { id: groupId, name: 'WhatsApp' };
  currentGroupId = groupId || 'main';
  groupName = group.name || 'WhatsApp';
  composer?.classList.remove('hidden');
  localStorage.setItem('wa_group_id', currentGroupId);
  localStorage.setItem('wa_group_name', groupName);
  messages.clear(); deletedIds.clear(); readSent.clear(); lastRenderedDate = ''; lastSyncAt = '';
  messageArea.innerHTML = '';
  updateGroupNameUI(); renderGroupList();
  loadLocalMessageHistory();
  await new Promise(resolve => {
    if (!socket.connected) { resolve(); return; }
    socket.emit('join-group', { groupId: currentGroupId, password: currentGroupId === 'main' ? '' : (verifiedGroupPasswords.get(String(currentGroupId)) || '') }, () => resolve());
  });
  await syncMessages();
  if (openAfter) openChat();
}

loadGroups();

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
socket.on('message-updated', data => { if(!data?.message || (data.groupId && data.groupId!==currentGroupId)) return; const m=data.message; const existing=messages.get(m.id); if(existing){Object.assign(existing,m); updateMessageElement(existing); saveLocalMessageHistory();} });

socket.on('delete-message', data => { if (data && data.id && (!data.groupId || data.groupId === currentGroupId)) deleteMessage(data.id,false); });
socket.on('restore-message', data => { if (!data || !data.message) return; if (data.groupId !== currentGroupId) return; const msg=data.message; deletedIds.delete(String(msg.id)); messages.set(String(msg.id),msg); const old=document.querySelector(`.message[data-id="${CSS.escape(String(msg.id))}"]`); if(old) old.remove(); renderMessage(msg,msg.userId===userId?'outgoing':'incoming'); saveLocalMessageHistory(); updatePreview('Message restored'); });
socket.on('delete-messages', data => {
  if (!data || !Array.isArray(data.ids) || (data.groupId && data.groupId !== currentGroupId)) return;
  deleteMessages(data.ids, false);
});
socket.on('clear-chat', data => { if (data && data.groupId && data.groupId !== currentGroupId) return; clearChat(false); showToast('Chat was cleared'); });
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
  socket.emit('join-group', { groupId: currentGroupId, password: currentGroupId === 'main' ? '' : (verifiedGroupPasswords.get(String(currentGroupId)) || '') }, () => syncMessages().finally(markVisibleMessagesRead));
});
socket.on('disconnect', () => setOnlineStatus('connecting'));
socket.on('reconnect', () => setOnlineStatus('online'));
socket.on('connect_error', () => setOnlineStatus('connecting'));

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markVisibleMessagesRead(); });
messageArea.addEventListener('scroll', markVisibleMessagesRead);
window.addEventListener('focus', markVisibleMessagesRead);

function scrollToBottom(){ messageArea.scrollTop=messageArea.scrollHeight; }
function updatePreview(text){ listPreview.textContent=text; listTime.textContent=now(); }


document.querySelectorAll('.filter').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.filter').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); const mode=btn.textContent.trim().toLowerCase(); document.querySelectorAll('.message').forEach(el=>{const m=messages.get(el.dataset.id);let show=true;if(mode==='favourites') show=starredIds.has(el.dataset.id)||!!m?.starred;if(mode==='groups') show=true;el.style.display=show?'':'none';}); }));
function openChat(push=true){ chatOpen=true; app.classList.add('chat-open'); if(push && window.innerWidth<=760) history.pushState({chat:true}, '', '#chat'); setTimeout(markVisibleMessagesRead, 50); }
function closeChat(){
  chatOpen=false;
  app.classList.remove('chat-open');
  // Leaving a group locks it again. The next entry must verify the group password.
  if (currentGroupId) {
    currentGroupId = '';
    localStorage.removeItem('wa_group_id');
    renderGroupList();
  }
  if(window.innerWidth<=760 && location.hash==='#chat') history.back();
}
document.querySelector('#backBtn').addEventListener('click', closeChat);
window.addEventListener('popstate', () => {
  chatOpen=false;
  app.classList.remove('chat-open');
  if (currentGroupId) {
    currentGroupId = '';
    localStorage.removeItem('wa_group_id');
    renderGroupList();
  }
});
document.querySelector('#newChatBtn').addEventListener('click', () => showToast('Use + New group to create a group'));
newGroupBtn?.addEventListener('click', () => requestAdminThen(() => openGroupEditor()));
document.querySelector('#statusBtn').addEventListener('click', () => showToast('Status')); 
async function requestAdminThen(action) {
  requestPassword('Admin password', 'Enter the admin password to manage groups and passwords.', async () => {
    try { await action(); } catch (_) { showToast('Admin action failed'); }
  });
}


async function loadAdminCallRecordings(groupId = '') {
  const clean = (v,n=80) => String(v ?? '').replace(/[<>]/g,'').slice(0,n);
  adminCallRecordingsError.textContent = '';
  adminCallRecordingsList.innerHTML = '<div class="admin-group-row">Loading recordings…</div>';
  try {
    const r = await fetch('/api/admin/call-recordings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ password:PASSWORD, groupId }) });
    const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Unauthorized');
    const list = d.recordings || [];
    if (!list.length) { adminCallRecordingsList.innerHTML = '<div class="admin-group-row">No call recordings found.</div>'; return; }
    const byGroup = new Map();
    list.forEach(x => { const key = x.groupId || 'main'; if (!byGroup.has(key)) byGroup.set(key, {name:x.groupName || key, items:[]}); byGroup.get(key).items.push(x); });
    adminCallRecordingsList.innerHTML = '';
    byGroup.forEach(g => {
      const head = document.createElement('div'); head.className='admin-group-row';
      head.innerHTML = `<div class="admin-group-name">📁 ${clean(g.name,60)}</div><div class="password-error">${g.items.length} feed${g.items.length===1?'':'s'}</div>`;
      adminCallRecordingsList.appendChild(head);
      g.items.forEach(item => {
        const row=document.createElement('div'); row.className='admin-group-row';
        const when=item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
        const size=item.size ? `${Math.max(1,item.size/1024/1024).toFixed(1)} MB` : '';
        const url=`/api/admin/call-recordings/${encodeURIComponent(item.fileId)}?password=${encodeURIComponent(PASSWORD)}`;
        row.innerHTML=`<div class="admin-group-name">🎥 ${clean(item.feedName||'Participant',60)}<small style="display:block;opacity:.7">${clean(when,60)} · ${size}</small></div><div class="admin-row-actions"><button type="button" class="mini-btn admin-view-recording-btn">▶ View</button><a class="mini-btn" href="${url}" download>⬇ Download</a><button type="button" class="mini-btn admin-delete-btn">Delete</button></div>`;
        row.querySelector('.admin-view-recording-btn').addEventListener('click',()=>{
          requestPassword('Admin password','Enter the admin password to view this call recording.',()=>showAdminMediaPopup(url,item.feedName||'Call recording',when));
        });
        row.querySelector('.admin-delete-btn').addEventListener('click', async()=>{
          if(!confirm('Delete this call recording?')) return;
          const rr=await fetch(`/api/admin/call-recordings/${encodeURIComponent(item.fileId)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD})});
          const dd=await rr.json(); if(dd.ok) loadAdminCallRecordings(groupId); else showToast(dd.error||'Delete failed');
        });
        adminCallRecordingsList.appendChild(row);
      });
    });
  } catch(e) { adminCallRecordingsList.innerHTML=''; adminCallRecordingsError.textContent=e.message||'Could not load recordings'; }
}

function showAdminMediaPopup(url,title,meta=''){
  adminMediaViewTitle.textContent=title || 'Call recording';
  adminMediaViewMeta.textContent=meta || '';
  adminMediaViewBody.innerHTML='';
  const video=document.createElement('video');
  video.controls=true; video.autoplay=true; video.playsInline=true; video.preload='metadata';
  video.src=url; video.setAttribute('controlsList','nodownload');
  video.addEventListener('contextmenu',e=>e.preventDefault());
  adminMediaViewBody.appendChild(video);
  adminMediaViewModal.classList.remove('hidden');
}

function closeAdminMediaPopup(){
  adminMediaViewBody.innerHTML='';
  adminMediaViewModal.classList.add('hidden');
}

function openAdminCallRecordings() { adminCallRecordingsModal.classList.remove('hidden'); loadAdminCallRecordings(); }

async function openAdminGroups() {
  adminGroupsError.textContent = '';
  try {
    const response = await fetch('/api/admin/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'unauthorized');
    renderAdminGroups(data.groups || []);
    adminGroupsModal.classList.remove('hidden');
  } catch (_) { adminGroupsError.textContent = 'Admin access failed'; }
}

function renderAdminGroups(list) {
  adminGroupsList.innerHTML = '';
  list.forEach(group => {
    const row = document.createElement('div'); row.className = 'admin-group-row';
    const isDefault = group.id === 'main';
    row.innerHTML = `<div class="admin-group-name"></div><div class="admin-password-wrap"><input type="text" class="admin-password-input" maxlength="120" autocomplete="off"><button type="button" class="mini-btn admin-copy-btn">Copy</button></div><div class="admin-row-actions"><button type="button" class="mini-btn admin-recycle-btn">♻️ Recycle</button><button type="button" class="mini-btn admin-save-btn">Save</button><button type="button" class="mini-btn admin-delete-btn">Delete</button></div>`;
    row.querySelector('.admin-group-name').textContent = group.name;
    row.querySelector('.admin-password-input').value = group.password || '';
    row.querySelector('.admin-copy-btn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(row.querySelector('.admin-password-input').value); showToast('Password copied'); } catch (_) {}
    });
    row.querySelector('.admin-recycle-btn').addEventListener('click', () => openAdminRecycle(group.id, group.name));
    row.querySelector('.admin-save-btn').addEventListener('click', async () => {
      const password = row.querySelector('.admin-password-input').value.trim();
      if (!password) { showToast('Password is required'); return; }
      try {
        const response = await fetch(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword: PASSWORD, name: group.name, password }) });
        const data = await response.json();
        if (data.ok) { group.password = password; showToast(`${group.name} password updated`); }
        else showToast(data.error || 'Password update failed');
      } catch (_) { showToast('Password update failed'); }
    });
    row.querySelector('.admin-delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete group "${group.name}"? This cannot be undone.`)) return;
      try {
        const response = await fetch(`/api/groups/${encodeURIComponent(group.id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminPassword: PASSWORD })
        });
        const data = await response.json();
        if (!data.ok) { showToast(data.error || 'Group delete failed'); return; }
        groups = groups.filter(g => g.id !== group.id);
        if (currentGroupId === group.id) {
          const fallback = groups[0];
          currentGroupId = fallback?.id || '';
          groupName = fallback?.name || '';
          if (fallback) {
            localStorage.setItem('wa_group_id', fallback.id);
            localStorage.setItem('wa_group_name', fallback.name);
          } else {
            localStorage.removeItem('wa_group_id');
            localStorage.removeItem('wa_group_name');
          }
          messageArea.innerHTML = '';
          messages.clear();
          updateGroupNameUI();
        }
        renderGroupList();
        row.remove();
        showToast(`${group.name} deleted`);
      } catch (_) { showToast('Group delete failed'); }
    });
    adminGroupsList.appendChild(row);
  });
}


async function loadAdminRecycle() {
  adminRecycleError.textContent = '';
  adminRecycleList.innerHTML = '<div class="recycle-empty">Loading recycle bin…</div>';
  try {
    const response = await fetch('/api/admin/recycle-bin', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(adminRecycleGroupId === 'main' ? { password:PASSWORD } : { password:PASSWORD, groupId:adminRecycleGroupId }) });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Load failed');
    const items = Array.isArray(data.items) ? data.items : [];
    adminRecycleList.innerHTML = '';
    if (adminRecycleGroupId === 'main') {
      adminRecycleTitle.textContent = `♻️ Main Recycle Bin (${items.length})`;
    }
    if (!items.length) { adminRecycleList.innerHTML = '<div class="recycle-empty">Recycle bin is empty.</div>'; return; }
    items.forEach(item => {
      const m = item.message || {};
      const row = document.createElement('div'); row.className='recycle-item';
      const kind = m.type === 'image' ? '🖼️ Image' : m.type === 'video' ? '🎥 Video' : m.type === 'audio' ? '🎤 Audio' : m.type === 'document' ? '📄 Document' : '💬 Message';
      const sender = m.user || m.senderName || m.senderId || m.userId || 'Unknown user';
      const content = m.message || m.fileName || (m.type === 'image' ? 'Photo' : m.type === 'video' ? 'Video' : m.type === 'audio' ? 'Audio' : m.type === 'document' ? 'Document' : 'Deleted message');
      const when = item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '';
      const oldGroup = item.deletedGroupName ? `Deleted group: ${item.deletedGroupName}` : (item.deletedGroupId ? `Deleted group: ${item.deletedGroupId}` : '');
      const isMainRecycle = adminRecycleGroupId === 'main';
      row.innerHTML = `<div class="recycle-main"><strong class="recycle-kind"></strong><span class="recycle-sender"></span><span class="recycle-name"></span><small class="recycle-meta"></small><small class="recycle-origin"></small></div><div class="recycle-actions"><button class="mini-btn recycle-view-btn">View</button><button class="mini-btn recycle-download-btn">⬇️ Download</button><button class="mini-btn recycle-restore-btn">♻️ Restore</button>${isMainRecycle ? '<button class="mini-btn admin-delete-btn recycle-delete-btn">Delete permanently</button>' : '<button class="mini-btn recycle-main-move-btn">🗑️ Delete → Main Recycle</button>'}</div>`;
      row.querySelector('.recycle-origin').textContent = oldGroup;
      row.querySelector('.recycle-kind').textContent=kind;
      row.querySelector('.recycle-sender').textContent=`Sent by: ${sender}`;
      row.querySelector('.recycle-name').textContent=content;
      row.querySelector('.recycle-meta').textContent=when;
      const view=row.querySelector('.recycle-view-btn');
      const download=row.querySelector('.recycle-download-btn');
      if (m.mediaId) {
        view.onclick=()=>window.open(`/api/media/${encodeURIComponent(m.mediaId)}`, '_blank', 'noopener');
        download.onclick=async()=>{
          try {
            const r=await fetch('/api/admin/recycle-bin/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})});
            if(!r.ok){ let d={}; try{d=await r.json();}catch(_){} throw new Error(d.error||'Download failed'); }
            const blob=await r.blob();
            const url=URL.createObjectURL(blob); const a=document.createElement('a');
            a.href=url; a.download=m.fileName || `recycle-${item.id}`; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(()=>URL.revokeObjectURL(url),1000);
          } catch(e){ showToast(e.message||'Download failed'); }
        };
      } else { view.disabled=true; download.disabled=true; }
      row.querySelector('.recycle-restore-btn').onclick=async()=>{
        if(!confirm('Restore this deleted item to the group?')) return;
        try {
          const r=await fetch('/api/admin/recycle-bin/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})});
          const d=await r.json(); if(!d.ok) throw new Error(d.error||'Restore failed');
          showToast('Item restored'); loadAdminRecycle();
        } catch(e){ adminRecycleError.textContent=e.message||'Restore failed'; }
      };
      const permanentDeleteBtn = row.querySelector('.recycle-delete-btn');
      if (permanentDeleteBtn) permanentDeleteBtn.onclick=async()=>{
        if(!confirm('Permanently delete this item and its media? This cannot be undone.')) return;
        try {
          const r=await fetch('/api/admin/recycle-bin/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})});
          const d=await r.json(); if(!d.ok) throw new Error(d.error||'Delete failed');
          showToast('Permanently deleted'); loadAdminRecycle();
        } catch(e){ adminRecycleError.textContent=e.message||'Delete failed'; }
      };
      const moveBtn = row.querySelector('.recycle-main-move-btn');
      if (moveBtn) moveBtn.onclick=async()=>{
        if(!confirm('Delete this item from Group Recycle? It will move to Main Recycle and will NOT be permanently deleted.')) return;
        try {
          const r=await fetch('/api/admin/recycle-bin/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})});
          const d=await r.json(); if(!d.ok) throw new Error(d.error||'Move failed');
          showToast('Moved to Main Recycle Bin'); loadAdminRecycle();
        } catch(e){ adminRecycleError.textContent=e.message||'Move failed'; }
      };
      adminRecycleList.appendChild(row);
    });
  } catch(e) { adminRecycleList.innerHTML=''; adminRecycleError.textContent=e.message||'Recycle bin unavailable'; }
}

function openAdminRecycle(groupId, groupName) {
  adminRecycleGroupId = String(groupId || 'main');
  adminRecycleGroupName = String(groupName || 'Group');
  adminRecycleTitle.textContent = `♻️ ${adminRecycleGroupName} Recycle Bin`;
  adminRecycleModal.classList.remove('hidden');
  loadAdminRecycle();
}

adminRecycleClose?.addEventListener('click',()=>adminRecycleModal.classList.add('hidden'));
adminMainRecycleBtn?.addEventListener('click',()=>openAdminRecycle('main','Main Recycle Bin'));
adminMainRecycleFromGroupsBtn?.addEventListener('click',()=>openAdminRecycle('main','Main Recycle Bin'));
adminRecycleModal?.addEventListener('click',e=>{if(e.target===adminRecycleModal)adminRecycleModal.classList.add('hidden');});
adminRecycleRefresh?.addEventListener('click',loadAdminRecycle);
adminRecycleEmpty?.addEventListener('click',async()=>{
  if(!confirm(adminRecycleGroupId === 'main' ? `Empty Main Recycle Bin for "${adminRecycleGroupName}"? This permanently deletes all stored data.` : `Empty Group Recycle Bin for "${adminRecycleGroupName}"? All items will move to Main Recycle Bin and will NOT be permanently deleted.`)) return;
  try {
    const r=await fetch('/api/admin/recycle-bin/empty',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(adminRecycleGroupId === 'main' ? {password:PASSWORD} : {password:PASSWORD,groupId:adminRecycleGroupId})});
    const d=await r.json(); if(!d.ok) throw new Error(d.error||'Empty failed');
    showToast(adminRecycleGroupId === 'main' ? `${d.count||0} items permanently deleted` : `${d.count||0} items moved to Main Recycle Bin`); loadAdminRecycle();
  } catch(e){ adminRecycleError.textContent=e.message||'Empty failed'; }
});

function openGroupEditor() {
  groupEditTitle.textContent = 'Add new group'; groupEditName.value = ''; groupEditPassword.value = ''; groupEditError.textContent = '';
  groupEditModal.dataset.groupId = ''; groupEditModal.classList.remove('hidden');
  setTimeout(() => groupEditName.focus(), 50);
}

async function saveNewGroup() {
  const nameValue = groupEditName.value.trim(); const passwordValue = groupEditPassword.value.trim();
  if (!nameValue || !passwordValue) { groupEditError.textContent = 'Group name and password are required'; return; }
  groupEditError.textContent = 'Saving…';
  try {
    const response = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword: PASSWORD, name: nameValue, password: passwordValue }) });
    const data = await response.json();
    if (!data.ok) { groupEditError.textContent = data.error || 'Could not create group'; return; }
    groupEditModal.classList.add('hidden');
    await loadGroups();
    showToast(`Group ${nameValue} created`);
  } catch (_) {
    groupEditError.textContent = 'Server connection failed. Please try again.';
  }
}

adminGroupsBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); requestAdminThen(openAdminGroups); });
adminCallRecordingsBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); requestAdminThen(openAdminCallRecordings); });
adminCallRecordingsClose?.addEventListener('click', () => adminCallRecordingsModal.classList.add('hidden'));
adminCallRecordingsModal?.addEventListener('click', e => { if (e.target === adminCallRecordingsModal) adminCallRecordingsModal.classList.add('hidden'); });
adminMediaViewClose?.addEventListener('click', closeAdminMediaPopup);
adminMediaViewModal?.addEventListener('click', e => { if (e.target === adminMediaViewModal) closeAdminMediaPopup(); });
adminCallRecordingsRefresh?.addEventListener('click', () => loadAdminCallRecordings());
adminCallRecordingsDownloadAll?.addEventListener('click', () => { const a=document.createElement('a'); a.href=`/api/admin/call-recordings/download-all?password=${encodeURIComponent(PASSWORD)}`; a.download='call-recordings-all-groups.zip'; document.body.appendChild(a); a.click(); a.remove(); });
adminGroupsClose?.addEventListener('click', () => adminGroupsModal.classList.add('hidden'));
adminGroupsModal?.addEventListener('click', e => { if (e.target === adminGroupsModal) adminGroupsModal.classList.add('hidden'); });
adminNewGroupBtn?.addEventListener('click', () => { adminGroupsModal.classList.add('hidden'); openGroupEditor(); });
groupPasswordSubmit?.addEventListener('click', verifyAndOpenGroup);
groupPasswordInput?.addEventListener('keydown', e => { if (e.key === 'Enter') verifyAndOpenGroup(); });
groupPasswordClose?.addEventListener('click', () => groupPasswordModal.classList.add('hidden'));
groupPasswordModal?.addEventListener('click', e => { if (e.target === groupPasswordModal) groupPasswordModal.classList.add('hidden'); });
groupEditSave?.addEventListener('click', saveNewGroup);
groupEditName?.addEventListener('keydown', e => { if (e.key === 'Enter') saveNewGroup(); });
groupEditPassword?.addEventListener('keydown', e => { if (e.key === 'Enter') saveNewGroup(); });
groupEditClose?.addEventListener('click', () => groupEditModal.classList.add('hidden'));
groupEditModal?.addEventListener('click', e => { if (e.target === groupEditModal) groupEditModal.classList.add('hidden'); });

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
  updateGroupNameUI();
  const localGroup = groups.find(g => g.id === currentGroupId); if (localGroup) localGroup.name = groupName; renderGroupList();
  socket.emit('rename-group', { groupId: currentGroupId, name: groupName }, result => {
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


/* ===== Advanced WhatsApp features ===== */
const advState = JSON.parse(localStorage.getItem('wa_adv_state') || '{}');
function saveAdv(){ localStorage.setItem('wa_adv_state', JSON.stringify(advState)); }
function groupAdv(){ advState[currentGroupId] ||= {archived:false,muted:false,unread:false,locked:false}; return advState[currentGroupId]; }
const messageInfoModal=document.querySelector('#messageInfoModal'), messageInfoBody=document.querySelector('#messageInfoBody'), messageInfoClose=document.querySelector('#messageInfoClose');
const chatTools=document.querySelector('#chatTools');
function showMessageInfo(msg){ if(!messageInfoModal) return; const delivered=Array.isArray(msg.deliveredTo)?msg.deliveredTo.length:0, read=Array.isArray(msg.readBy)?msg.readBy.length:0; messageInfoBody.innerHTML=''; [['Message',msg.message||msg.fileName||msg.type||'Media'],['Sent',msg.time||''],['Delivered',String(delivered)],['Read',String(read)],['Edited',msg.edited?'Yes':'No'],['Forwarded',msg.forwarded?'Yes':'No']].forEach(([a,b])=>{const row=document.createElement('div');row.className='info-row';row.innerHTML='<b></b><span></span>';row.children[0].textContent=a;row.children[1].textContent=b;messageInfoBody.appendChild(row)}); messageInfoModal.classList.remove('hidden');}
messageInfoClose?.addEventListener('click',()=>messageInfoModal.classList.add('hidden')); messageInfoModal?.addEventListener('click',e=>{if(e.target===messageInfoModal)messageInfoModal.classList.add('hidden')});
function reactMessage(msg){ const choices=['👍','❤️','😂','😮','😢','🙏']; const choice=prompt('React with: '+choices.join(' '), '👍'); if(!choice || !choices.includes(choice)) return; msg.reactions=msg.reactions||{}; msg.reactions[userId]=choice; updateMessageElement(msg); emitAck('update-message',{id:msg.id,reactions:msg.reactions},10000,1); }
function updateAdvancedTools(){ const g=groupAdv(); if(!chatTools)return; chatTools.classList.toggle('hidden',!currentGroupId); const map={lockChatBtn:`🔐 ${g.locked?'Unlock':'Lock'}`,archiveChatBtn:`📥 ${g.archived?'Unarchive':'Archive'}`,muteChatBtn:`🔕 ${g.muted?'Unmute':'Mute'}`,unreadChatBtn:`🔵 ${g.unread?'Read':'Unread'}`}; Object.entries(map).forEach(([id,t])=>{const b=document.getElementById(id);if(b)b.textContent=t;}); }
function requireUnlock(){ const g=groupAdv(); if(!g.locked)return true; const pin=prompt('Enter chat lock PIN'); if(pin===null)return false; const saved=g.pin||'1234'; if(pin!==saved){showToast('Wrong chat PIN');return false;} g.locked=false; saveAdv(); updateAdvancedTools(); return true; }
document.getElementById('lockChatBtn')?.addEventListener('click',()=>{const g=groupAdv(); if(g.locked){requireUnlock();return;} const pin=prompt('Set a 4+ digit chat PIN','1234'); if(!pin || pin.length<4)return; g.pin=pin;g.locked=true;saveAdv();updateAdvancedTools();showToast('Chat locked');closeChat();});
document.getElementById('archiveChatBtn')?.addEventListener('click',()=>{const g=groupAdv();g.archived=!g.archived;saveAdv();updateAdvancedTools();renderGroupList();showToast(g.archived?'Chat archived':'Chat unarchived')});
document.getElementById('muteChatBtn')?.addEventListener('click',()=>{const g=groupAdv();g.muted=!g.muted;saveAdv();updateAdvancedTools();showToast(g.muted?'Notifications muted':'Notifications unmuted')});
document.getElementById('unreadChatBtn')?.addEventListener('click',()=>{const g=groupAdv();g.unread=!g.unread;saveAdv();updateAdvancedTools();showToast(g.unread?'Marked unread':'Marked read')});
document.getElementById('themeBtn')?.addEventListener('click',()=>{document.body.classList.toggle('dark-mode');localStorage.setItem('wa_theme',document.body.classList.contains('dark-mode')?'dark':'light')}); if(localStorage.getItem('wa_theme')==='dark')document.body.classList.add('dark-mode');
// Typing indicator (debounced)
let typingTimer=null, typingActive=false;
function sendTyping(active){ if(!socket.connected)return; socket.emit('typing',{groupId:currentGroupId,userId,name,active}); }
textarea?.addEventListener('input',()=>{if(!typingActive){typingActive=true;sendTyping(true)};clearTimeout(typingTimer);typingTimer=setTimeout(()=>{typingActive=false;sendTyping(false)},900)});
socket.on('typing',d=>{if(!d || d.groupId!==currentGroupId || d.userId===userId)return; if(d.active){typingBar.textContent=`${d.name||'Someone'} is typing…`;typingBar.classList.add('show')}else typingBar.classList.remove('show')});
// Voice recorder
let mediaRecorder=null, voiceChunks=[];
async function startVoice(){ try{const stream=await navigator.mediaDevices.getUserMedia({audio:true}); voiceChunks=[];mediaRecorder=new MediaRecorder(stream);mediaRecorder.ondataavailable=e=>{if(e.data.size)voiceChunks.push(e.data)};mediaRecorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());const blob=new Blob(voiceChunks,{type:mediaRecorder.mimeType||'audio/webm'});const file=new File([blob],`voice-${Date.now()}.webm`,{type:blob.type});await uploadMedia(file)};mediaRecorder.start();micBtn.classList.add('recording');showToast('Recording… click 🎤 again to stop');}catch(e){showToast('Microphone permission denied')}}
const micBtn=document.getElementById('micBtn'); micBtn?.addEventListener('click',()=>{if(mediaRecorder && mediaRecorder.state==='recording'){mediaRecorder.stop();micBtn.classList.remove('recording')}else startVoice()});
// Allow selecting a locked group only after PIN.
const oldOpenGroup=openGroup; openGroup=async function(group){const g=advState[group?.id||''];if(g?.locked){currentGroupId=group.id;groupName=group.name; if(!requireUnlock())return;} return oldOpenGroup(group);};
updateAdvancedTools();

/* ===== WebRTC group audio/video calling ===== */
(() => {
  const audioCallBtn=document.getElementById('audioCallBtn'), videoCallBtn=document.getElementById('videoCallBtn');
  const callModal=document.getElementById('callModal'), callTitle=document.getElementById('callTitle'), callStatus=document.getElementById('callStatus');
  const callStage=document.getElementById('callStage'), callEmpty=document.getElementById('callEmpty'), callAvatar=document.getElementById('callAvatar'), callEmptyText=document.getElementById('callEmptyText');
  const localCallVideo=document.getElementById('localCallVideo'), callMuteBtn=document.getElementById('callMuteBtn'), callCameraBtn=document.getElementById('callCameraBtn'), callSwapCameraBtn=document.getElementById('callSwapCameraBtn'), callEndBtn=document.getElementById('callEndBtn'), callCloseBtn=document.getElementById('callCloseBtn');
  const incomingCall=document.getElementById('incomingCall'), incomingCallName=document.getElementById('incomingCallName'), incomingCallType=document.getElementById('incomingCallType'), incomingCallIcon=document.getElementById('incomingCallIcon');
  const incomingAnswerBtn=document.getElementById('incomingAnswerBtn'), incomingRejectBtn=document.getElementById('incomingRejectBtn');
  let activeCallId='',activeCallType='',localStream=null,pendingIncoming=null,muted=false,cameraOff=true,callStartedByMe=false,cameraFacing='user',swappingCamera=false;
  const peers=new Map();
  const recorders=new Map();
  let recordingNoticeShown=false;
  const recordingMime=()=>['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','audio/webm;codecs=opus','video/webm'].find(x=>window.MediaRecorder?.isTypeSupported?.(x))||'';
  function startFeedRecording(feedId,feedName,stream){
    if(!stream||recorders.has(feedId)||!window.MediaRecorder)return;
    const mime=recordingMime(); if(!mime)return;
    try{
      const recordingCallId=activeCallId; const recordingGroupId=currentGroupId; const rec=new MediaRecorder(stream,{mimeType:mime}); const chunks=[];
      rec.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
      rec.onstop=async()=>{
        if(!chunks.length)return;
        try{const blob=new Blob(chunks,{type:mime}); await fetch('/api/call-recordings/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Call-Id':recordingCallId||feedId,'X-Group-Id':recordingGroupId,'X-Feed-Id':feedId,'X-Feed-Name':feedName||'Participant','X-User-Id':String(userId||''),'X-Mime-Type':mime},body:blob});}catch(_){}
      };
      rec.start(1000); recorders.set(feedId,rec);
    }catch(_){}
  }
  function stopFeedRecordings(){recorders.forEach(r=>{try{if(r.state!=='inactive')r.stop()}catch(_){}});recorders.clear()}
  const RTC_CONFIG={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}]};
  const safeText=(v,n=80)=>String(v||'').slice(0,n), newId=()=>((crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2))+'-'+Date.now());
  const isActive=()=>!!activeCallId;
  function status(t){if(callStatus)callStatus.textContent=t}
  function updateStatus(){const n=peers.size+1;status(`${n} participant${n===1?'':'s'} · ${activeCallType==='video'?'Video':'Audio'}`);if(callEmptyText)callEmptyText.textContent=peers.size?`${n} people in call`:'Waiting for participants…';if(callEmpty)callEmpty.style.display=peers.size?'none':'flex'}
  function showModal(){callTitle.textContent=groupName||'Group call';callAvatar.textContent=(groupName||'W').trim().charAt(0).toUpperCase();callModal.classList.remove('hidden');callModal.classList.toggle('video-call',activeCallType==='video');callModal.classList.toggle('audio-call',activeCallType==='audio')}
  function tile(id,nm,stream){let el=document.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`);if(!el){el=document.createElement('div');el.className='call-tile';el.dataset.peer=id;const v=document.createElement('video');v.autoplay=true;v.playsInline=true;const lab=document.createElement('span');lab.className='tile-name';lab.textContent=safeText(nm||'Participant',60);el.append(v,lab);callStage.appendChild(el)}const v=el.querySelector('video');if(v&&stream)v.srcObject=stream}
  function removePeer(id){const x=peers.get(id);if(x){try{x.pc.close()}catch(_){}}peers.delete(id);document.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`)?.remove();updateStatus()}
  function createPeer(id,nm,offer){let x=peers.get(id);if(x)return x.pc;const pc=new RTCPeerConnection(RTC_CONFIG);x={pc,name:safeText(nm||'Participant',60)};peers.set(id,x);if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
    pc.onicecandidate=e=>{if(e.candidate)socket.emit('call-signal',{callId:activeCallId,to:id,kind:'ice',data:e.candidate})};
    pc.ontrack=e=>{const st=e.streams?.[0]||new MediaStream([e.track]); tile(id,x.name,st); startFeedRecording('peer-'+id,x.name,st);};
    pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))removePeer(id)};
    if(offer)(async()=>{try{const o=await pc.createOffer();await pc.setLocalDescription(o);socket.emit('call-signal',{callId:activeCallId,to:id,kind:'offer',data:pc.localDescription})}catch(_){showToast('Could not connect a participant')}})();
    updateStatus();return pc}
  async function media(type){if(!navigator.mediaDevices?.getUserMedia)throw new Error('Your browser does not support microphone/camera calls.');return navigator.mediaDevices.getUserMedia({audio:true,video:false})}
  async function start(type){if(isActive()||!currentGroupId)return;try{localStream=await media(type);cameraFacing='user';activeCallType=type;activeCallId=newId();callStartedByMe=true;cameraOff=(type==='video');showModal(); if(!recordingNoticeShown){showToast('🔴 This call is being recorded for the group admin.'); recordingNoticeShown=true;} startFeedRecording('local-'+socket.id,name||'You',localStream); if(type==='video'){localCallVideo.srcObject=localStream;localCallVideo.style.display='none'}if(callCameraBtn)callCameraBtn.textContent=type==='video'?'🚫':'📷';updateStatus();socket.emit('call-start',{callId:activeCallId,type,groupId:currentGroupId,userId,name},r=>{if(!r?.ok){showToast(r?.error||'Could not start call');end(false)}})}catch(e){showToast(e?.message||'Microphone/camera permission is required')}}
  function incoming(d){if(!d?.callId||!d?.groupId||isActive()||pendingIncoming)return;const gid=String(d.groupId);if(gid!=='main'&&!verifiedGroupPasswords.has(gid))return;const g=groups.find(x=>String(x.id)===gid);if(!g)return;pendingIncoming=d;incomingCallName.textContent=safeText(d.fromName||'Someone',60);incomingCallType.textContent=`${d.type==='video'?'Group video':'Group audio'} call · ${safeText(g.name||'group',50)}`;incomingCallIcon.textContent=d.type==='video'?'📹':'📞';incomingCall.classList.remove('hidden')}
  async function answer(){const d=pendingIncoming;if(!d)return;incomingCall.classList.add('hidden');pendingIncoming=null;try{activeCallId=d.callId;activeCallType=d.type==='video'?'video':'audio';callStartedByMe=false;localStream=await media(activeCallType);cameraFacing='user';cameraOff=(activeCallType==='video');showModal(); if(!recordingNoticeShown){showToast('🔴 This call is being recorded for the group admin.'); recordingNoticeShown=true;} startFeedRecording('local-'+socket.id,name||'You',localStream); if(activeCallType==='video'){localCallVideo.srcObject=localStream;localCallVideo.style.display='none'}if(callCameraBtn)callCameraBtn.textContent=activeCallType==='video'?'🚫':'📷';socket.emit('call-join',{callId:activeCallId,groupId:d.groupId,userId,name},r=>{if(!r?.ok){showToast(r?.error||'Call ended');end(false);return}(r.peers||[]).forEach(id=>createPeer(id,'Participant',false));updateStatus()})}catch(e){showToast(e?.message||'Could not answer call')}}
  function reject(){const d=pendingIncoming;if(!d)return;incomingCall.classList.add('hidden');pendingIncoming=null;socket.emit('call-reject',{callId:d.callId,name,userId})}
  function end(notify=true){const id=activeCallId;if(notify&&id)socket.emit('call-leave',{callId:id,name,userId});[...peers.keys()].forEach(removePeer);stopFeedRecordings(); if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}if(localCallVideo)localCallVideo.srcObject=null;activeCallId='';activeCallType='';callStartedByMe=false;callModal.classList.add('hidden');callStage.querySelectorAll('.call-tile').forEach(x=>x.remove());callEmpty.style.display='flex';recordingNoticeShown=false;updateStatus()}
  audioCallBtn?.addEventListener('click',()=>start('audio'));videoCallBtn?.addEventListener('click',()=>start('video'));callEndBtn?.addEventListener('click',()=>end(true));callCloseBtn?.addEventListener('click',()=>end(true));document.querySelector('.call-card')?.addEventListener('dblclick',async()=>{try{if(!document.fullscreenElement){await callModal.requestFullscreen?.()}else{await document.exitFullscreen?.()}}catch(_){callModal.classList.toggle('call-fullscreen')}});incomingAnswerBtn?.addEventListener('click',answer);incomingRejectBtn?.addEventListener('click',reject);
  callMuteBtn?.addEventListener('click',()=>{if(!localStream)return;muted=!muted;localStream.getAudioTracks().forEach(t=>t.enabled=!muted);callMuteBtn.textContent=muted?'🔇':'🎙️'});
  callCameraBtn?.addEventListener('click',async()=>{
    if(!localStream||activeCallType!=='video'||swappingCamera)return;
    if(!cameraOff){
      const track=localStream.getVideoTracks()[0];
      if(track){
        for(const {pc} of peers.values()){const sender=pc.getSenders().find(x=>x.track?.kind==='video');if(sender)await sender.replaceTrack(null).catch(()=>{})}
        localStream.removeTrack(track);try{track.stop()}catch(_){}
      }
      cameraOff=true;
      if(localCallVideo){localCallVideo.srcObject=localStream;localCallVideo.style.display='none'}
      callCameraBtn.textContent='🚫';callCameraBtn.title='Turn camera on';
      return;
    }
    try{
      const cam=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:cameraFacing},width:{ideal:1280},height:{ideal:720}},audio:false});
      const newTrack=cam.getVideoTracks()[0];
      if(!newTrack)throw new Error('Camera could not be started');
      const old=localStream.getVideoTracks()[0];if(old){try{old.stop()}catch(_){}localStream.removeTrack(old)}
      localStream.addTrack(newTrack);
      for(const {pc} of peers.values()){
        let sender=pc.getSenders().find(x=>x.track?.kind==='video');
        if(sender) await sender.replaceTrack(newTrack);
        else pc.addTrack(newTrack,localStream);
      }
      cameraOff=false;
      if(localCallVideo){localCallVideo.srcObject=localStream;localCallVideo.style.display='block'}
      callCameraBtn.textContent='📷';callCameraBtn.title='Turn camera off';
    }catch(e){showToast(e?.message||'Camera permission is required')}
  });
  callSwapCameraBtn?.addEventListener('click',async()=>{
    if(!localStream||activeCallType!=='video'||swappingCamera)return;
    const oldTrack=localStream.getVideoTracks()[0];
    if(!oldTrack)return;
    swappingCamera=true;
    try{
      const nextFacing=cameraFacing==='user'?'environment':'user';
      const cam=await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:nextFacing},width:{ideal:1280},height:{ideal:720}},audio:false});
      const newTrack=cam.getVideoTracks()[0];
      if(!newTrack)throw new Error('Camera switch failed');
      for(const {pc} of peers.values()){
        const sender=pc.getSenders().find(s=>s.track?.kind==='video');
        if(sender)await sender.replaceTrack(newTrack);
      }
      localStream.removeTrack(oldTrack);
      localStream.addTrack(newTrack);
      try{oldTrack.stop()}catch(_){}
      cameraFacing=nextFacing;
      newTrack.enabled=!cameraOff;
      if(localCallVideo)localCallVideo.srcObject=localStream;
      if(callSwapCameraBtn){callSwapCameraBtn.textContent=cameraFacing==='user'?'🔄':'🔁';callSwapCameraBtn.title=cameraFacing==='user'?'Switch to rear camera':'Switch to front camera'}
      if(cameraOff&&localCallVideo)localCallVideo.style.display='none';
    }catch(e){showToast(e?.message||'Could not switch camera.');}
    finally{swappingCamera=false;}
  });
  socket.on('incoming-call',d=>incoming(d));
  socket.on('call-peer-joined',d=>{if(isActive()&&d?.callId===activeCallId&&d.socketId!==socket.id)createPeer(d.socketId,d.name,true)});
  socket.on('call-signal',async d=>{if(!isActive()||d?.callId!==activeCallId||!d.from)return;let x=peers.get(d.from);if(d.kind==='offer'){const pc=createPeer(d.from,'Participant',false);try{await pc.setRemoteDescription(new RTCSessionDescription(d.data));const a=await pc.createAnswer();await pc.setLocalDescription(a);socket.emit('call-signal',{callId:activeCallId,to:d.from,kind:'answer',data:pc.localDescription})}catch(_){showToast('Call connection failed')}}else if(d.kind==='answer'){if(x)try{await x.pc.setRemoteDescription(new RTCSessionDescription(d.data))}catch(_){}}else if(d.kind==='ice'){if(x)try{await x.pc.addIceCandidate(new RTCIceCandidate(d.data))}catch(_){} }});
  socket.on('call-peer-left',d=>{if(d?.callId===activeCallId)removePeer(d.socketId)});
  socket.on('call-rejected',d=>{if(d?.callId===activeCallId&&d.socketId!==socket.id)showToast(`${d.name||'Someone'} declined the call`)});
  socket.on('call-ended',d=>{
    if(!d?.callId)return;
    if(d.callId===activeCallId){
      showToast(d.reason==='declined'?`${d.name||'Someone'} declined the call`:'Call ended');
      end(false);
    }
    if(pendingIncoming?.callId===d.callId){
      incomingCall.classList.add('hidden');
      pendingIncoming=null;
      showToast(d.reason==='declined'?`${d.name||'Someone'} declined the call`:'Call ended');
    }
  });
  socket.on('disconnect',()=>{if(isActive())end(false);incomingCall?.classList.add('hidden');pendingIncoming=null});
  window.waGroupCall={start:start,end:()=>end(true),isActive};
})();
