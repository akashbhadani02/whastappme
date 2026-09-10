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
const fileInput = document.querySelector('#fileInput');
const sendBtn = document.querySelector('#sendBtn');
const attachBtn = document.querySelector('#attachBtn');
const emojiBtn = document.querySelector('#emojiBtn');
const emojiPanel = document.querySelector('#emojiPanel');
const clearChatBtn = document.querySelector('#clearChatBtn');
const selectionActions = document.querySelector('#selectionActions');
const selectionCount = document.querySelector('#selectionCount');
const cancelSelectionBtn = document.querySelector('#cancelSelectionBtn');
const deleteSelectedBtn = document.querySelector('#deleteSelectedBtn');
const deleteForMeBtn = document.querySelector('#deleteForMeBtn');
const recycleBinBtn = document.querySelector('#recycleBinBtn');
const recycleBinModal = document.querySelector('#recycleBinModal');
const recycleBinClose = document.querySelector('#recycleBinClose');
const recycleList = document.querySelector('#recycleList');
const recycleRestoreBtn = document.querySelector('#recycleRestoreBtn');
const recyclePermanentBtn = document.querySelector('#recyclePermanentBtn');
const recycleEmptyBtn = document.querySelector('#recycleEmptyBtn');
const recycleSelectAllBtn = document.querySelector('#recycleSelectAllBtn');
const recycleError = document.querySelector('#recycleError');
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
let recycleItems = [];
const recycleSelectedIds = new Set();
function recycleKey(groupId=currentGroupId){ return `wa_recycle_bin_${groupId || 'main'}`; }
function loadLocalRecycle(){
  try { const raw=JSON.parse(localStorage.getItem(recycleKey())||'[]'); return Array.isArray(raw)?raw:[]; } catch(_){ return []; }
}
function saveLocalRecycle(items){ try { localStorage.setItem(recycleKey(), JSON.stringify(items.slice(0,500))); } catch(_) {} }
function addLocalRecycle(msg, source='local'){
  if(!msg?.id) return;
  const items=loadLocalRecycle().filter(x=>String(x.id)!==String(msg.id));
  items.unshift({id:String(msg.id),groupId:currentGroupId,message:{...msg},deletedAt:new Date().toISOString(),source});
  saveLocalRecycle(items);
}
function removeLocalRecycle(ids){ const set=new Set(ids.map(String)); saveLocalRecycle(loadLocalRecycle().filter(x=>!set.has(String(x.id)))); }
function recyclePreview(item){ const m=item.message||{}; if(m.type==='image') return '📷 Photo'; if(m.type==='video') return '🎥 Video'; if(m.type==='audio') return '🎤 Voice message'; if(m.type==='document') return `📄 ${m.fileName||'Document'}`; return m.message||'Message'; }
function renderRecycleList(){
  if(!recycleList) return;
  recycleList.innerHTML='';
  if(!recycleItems.length){ recycleList.innerHTML='<div class="recycle-empty">♻️ Recycle Bin is empty</div>'; return; }
  recycleItems.forEach(item=>{
    const id=String(item.id||item.originalId||item.message?.id||'');
    const row=document.createElement('label'); row.className='recycle-row';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=recycleSelectedIds.has(id); cb.addEventListener('change',()=>{if(cb.checked)recycleSelectedIds.add(id);else recycleSelectedIds.delete(id);});
    const body=document.createElement('div'); body.className='recycle-body';
    const title=document.createElement('strong'); title.textContent=item.source==='server'?'Deleted for everyone':'Deleted for me';
    const text=document.createElement('span'); text.textContent=recyclePreview(item);
    const date=document.createElement('small'); date.textContent=new Date(item.deletedAt||Date.now()).toLocaleString();
    body.append(title,text,date); row.append(cb,body); recycleList.appendChild(row);
  });
}
async function loadRecycleBin(){
  recycleError.textContent=''; recycleSelectedIds.clear();
  const local=loadLocalRecycle().map(x=>({...x,source:x.source||'local'}));
  let remote=[];
  try{
    const r=await fetch(`/api/recycle-bin?groupId=${encodeURIComponent(currentGroupId)}`,{cache:'no-store'});
    if(r.ok){ const d=await r.json(); remote=(d.items||[]).map(x=>({id:String(x.originalId),groupId:x.groupId,message:x.message,deletedAt:x.deletedAt,source:'server'})); }
  }catch(_){ }
  const map=new Map(); [...local,...remote].forEach(x=>map.set(`${x.source}:${x.id}`,x));
  recycleItems=[...map.values()].sort((a,b)=>new Date(b.deletedAt||0)-new Date(a.deletedAt||0));
  renderRecycleList();
}
function openRecycleBin(){ recycleBinModal?.classList.remove('hidden'); loadRecycleBin(); }
function closeRecycleBin(){ recycleBinModal?.classList.add('hidden'); recycleSelectedIds.clear(); }
async function restoreRecycle(){
  const ids=[...recycleSelectedIds]; if(!ids.length){showToast('Select messages first');return;}
  const selected=recycleItems.filter(x=>ids.includes(String(x.id)));
  for(const item of selected){
    if(item.source==='server'){
      try{ const r=await fetch('/api/recycle-bin/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,groupId:currentGroupId})}); const d=await r.json().catch(()=>({})); if(!r.ok||!d.ok) throw new Error(d.error||'restore'); }
      catch(_){showToast(`Could not restore ${item.id}`);continue;}
    }
    const msg=item.message;
    if(msg){ removeLocalRecycle([item.id]); deletedIds.delete(String(item.id)); deletedForMeIds.delete(String(item.id)); if(!messages.has(String(item.id))) renderMessage(msg,msg.userId===userId?'outgoing':'incoming'); }
  }
  showToast(`${ids.length} message${ids.length===1?'':'s'} restored`); await loadRecycleBin(); saveMessageFlags(); saveLocalMessageHistory();
}
async function permanentDeleteRecycle(){
  const ids=[...recycleSelectedIds]; if(!ids.length){showToast('Select messages first');return;}
  const serverIds=recycleItems.filter(x=>ids.includes(String(x.id))&&x.source==='server').map(x=>String(x.id));
  if(serverIds.length){ try{ const r=await fetch('/api/recycle-bin/permanent-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:serverIds,groupId:currentGroupId})}); const d=await r.json().catch(()=>({})); if(!r.ok||!d.ok) throw new Error(); }catch(_){showToast('Permanent delete failed');return;} }
  removeLocalRecycle(ids); recycleSelectedIds.clear(); await loadRecycleBin(); showToast('Permanently deleted');
}
async function emptyRecycle(){
  if(!recycleItems.length){showToast('Recycle Bin is already empty');return;}
  if(!confirm('Permanently delete everything in this Recycle Bin?')) return;
  try{ const r=await fetch('/api/recycle-bin/empty',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:currentGroupId})}); if(!r.ok && r.status!==503) throw new Error(); }catch(_){ /* local-only recycle items can still be cleared */ }
  saveLocalRecycle([]); recycleItems=[]; recycleSelectedIds.clear(); renderRecycleList(); showToast('Recycle Bin emptied');
}
recycleBinBtn?.addEventListener('click',openRecycleBin); recycleBinClose?.addEventListener('click',closeRecycleBin); recycleBinModal?.addEventListener('click',e=>{if(e.target===recycleBinModal)closeRecycleBin();});
recycleRestoreBtn?.addEventListener('click',restoreRecycle); recyclePermanentBtn?.addEventListener('click',permanentDeleteRecycle); recycleEmptyBtn?.addEventListener('click',emptyRecycle);
recycleSelectAllBtn?.addEventListener('click',()=>{ if(recycleSelectedIds.size===recycleItems.length) recycleSelectedIds.clear(); else recycleItems.forEach(x=>recycleSelectedIds.add(String(x.id))); renderRecycleList(); });


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
  closePassword();
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
deleteForMeBtn?.addEventListener('click', () => {
  if (!selectedMessageIds.size) return;
  const ids=[...selectedMessageIds];
  requestPassword('Delete for me', `Remove ${ids.length} selected message${ids.length===1?'':'s'} from this device?`, () => deleteForMe(ids));
});
deleteSelectedBtn?.addEventListener('click', () => {
  if (!selectedMessageIds.size) return;
  const ids = Array.from(selectedMessageIds);
  requestPassword('Delete for everyone', `Permanently delete ${ids.length} selected message${ids.length === 1 ? '' : 's'} for everyone?`, () => deleteMessages(ids));
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
      const audio=document.createElement('audio'); audio.controls=true; audio.preload='metadata'; audio.src=mediaUrl; wrap.appendChild(audio);
    } else {
      const doc=document.createElement('div'); doc.className='document-bubble'; doc.innerHTML='<span class="doc-icon">📄</span><span class="doc-name"></span>'; doc.querySelector('.doc-name').textContent=msg.fileName || 'Document'; wrap.appendChild(doc);
    }
    const actions=document.createElement('div'); actions.className='media-actions';
    const download=document.createElement('button'); download.className='mini-btn'; download.textContent='⬇ Download';
    download.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); requestPassword('Download protected file','Enter password to download this photo/video.', () => downloadMedia(msg), 'download'); });
    actions.appendChild(download);
    content.appendChild(wrap); content.appendChild(actions);
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

  const del=document.createElement('button'); del.textContent='Delete message';
  del.addEventListener('click', () => {
    menu.classList.remove('open');
    requestPassword('Delete message','Enter password to delete this message.', () => deleteMessage(msg.id));
  });
  menu.appendChild(del); el.appendChild(menu);
  more.addEventListener('click', e => { e.stopPropagation(); document.querySelectorAll('.message-menu.open').forEach(x=>x.classList.remove('open')); menu.classList.toggle('open'); });
  el.appendChild(more);

  messageArea.appendChild(el);
  saveLocalMessageHistory();
  scrollToBottom();
}

document.addEventListener('click', () => document.querySelectorAll('.message-menu.open').forEach(x=>x.classList.remove('open')));

function toggleStar(msg){ const id=String(msg.id); const next=!starredIds.has(id); if(next) starredIds.add(id); else starredIds.delete(id); saveMessageFlags(); msg.starred=next; updateMessageElement(msg); emitAck('update-message',{id,starred:next},10000,1); }
function togglePin(msg){ const id=String(msg.id); const next=!pinnedIds.has(id); if(next) pinnedIds.add(id); else pinnedIds.delete(id); saveMessageFlags(); msg.pinned=next; updateMessageElement(msg); emitAck('update-message',{id,pinned:next},10000,1); showToast(next?'Message pinned':'Message unpinned'); }
function editMessage(msg){ const next=prompt('Edit message',msg.message||''); if(next===null || !next.trim() || next.trim()===msg.message) return; msg.message=next.trim().slice(0,5000); msg.edited=true; updateMessageElement(msg); saveLocalMessageHistory(); emitAck('update-message',{id:msg.id,message:msg.message},10000,1); }
function deleteForMe(ids){ const backup=ids.map(id=>messages.get(id)).filter(Boolean); backup.forEach(msg=>addLocalRecycle(msg,'local')); lastDeleteBackup={groupId:currentGroupId,messages:backup,expires:Date.now()+5000}; ids.forEach(id=>{const el=document.querySelector(`.message[data-id="${CSS.escape(String(id))}"]`);if(el)el.remove();messages.delete(String(id));deletedIds.add(String(id)); deletedForMeIds.add(String(id));}); saveMessageFlags(); saveLocalMessageHistory(); exitSelectionMode(); updatePreview(`${ids.length} message${ids.length===1?'':'s'} deleted`); showUndoToast('Deleted for me'); }
function showUndoToast(text){ toast.innerHTML=''; const span=document.createElement('span');span.textContent=text;const b=document.createElement('button');b.textContent='UNDO';b.className='toast-undo';b.onclick=undoLastDelete;toast.append(span,b);toast.classList.add('show');clearTimeout(showToast.t);showToast.t=setTimeout(()=>{toast.classList.remove('show');lastDeleteBackup=null;},5000); }
function undoLastDelete(){ const backup=lastDeleteBackup; if(!backup || backup.groupId!==currentGroupId || backup.expires<Date.now()){showToast('Undo expired');return;} backup.messages.forEach(msg=>{removeLocalRecycle([msg.id]); deletedIds.delete(String(msg.id)); deletedForMeIds.delete(String(msg.id)); renderMessage(msg,msg.userId===userId?'outgoing':'incoming');}); saveMessageFlags(); saveLocalMessageHistory(); lastDeleteBackup=null; toast.classList.remove('show'); showToast('Messages restored'); }
function openForward(msg){ forwardMessage=msg; if(!forwardGroups) return; forwardGroups.innerHTML=''; groups.forEach(g=>{const b=document.createElement('button');b.className='chat-item';b.innerHTML=`<div class="avatar group-avatar">${(g.name||'G').slice(0,1).toUpperCase()}</div><div class="chat-summary"><strong>${g.name||'Group'}</strong></div>`;b.onclick=()=>forwardToGroup(g);forwardGroups.appendChild(b);}); forwardModal?.classList.remove('hidden'); }
async function forwardToGroup(group){ if(!forwardMessage) return; const target=group.id; const msg={id:id(),groupId:target,senderId:socketId,userId,user:name,message:forwardMessage.message||'',time:now(),type:forwardMessage.type||'text',createdAt:new Date().toISOString(),deliveredTo:[],readBy:[],forwarded:true,...(forwardMessage.mediaId?{mediaId:forwardMessage.mediaId,mime:forwardMessage.mime,fileName:forwardMessage.fileName}:{}),...(forwardMessage.data?{data:forwardMessage.data}: {})}; if(target===currentGroupId) renderMessage(msg,'outgoing'); try{const r=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg),cache:'no-store'}); if(!r.ok) throw new Error(); showToast(`Forwarded to ${group.name}`);}catch(_){showToast('Forward failed');} forwardModal?.classList.add('hidden');forwardMessage=null; }
forwardClose?.addEventListener('click',()=>forwardModal?.classList.add('hidden'));
forwardModal?.addEventListener('click',e=>{if(e.target===forwardModal)forwardModal.classList.add('hidden');});
chatSearchBtn?.addEventListener('click',()=>{const q=(prompt('Search messages in this chat')||'').trim().toLowerCase();if(!q)return;const found=[...messages.values()].find(m=>(m.message||'').toLowerCase().includes(q));if(found){const el=document.querySelector(`.message[data-id="${CSS.escape(found.id)}"]`);el?.scrollIntoView({behavior:'smooth',block:'center'});el?.classList.add('search-hit');setTimeout(()=>el?.classList.remove('search-hit'),1800);}else showToast('No matching message');});

function deleteMessage(messageId, broadcast=true) {
  const id = String(messageId);
  const original = messages.get(id);
  if (broadcast && original) addLocalRecycle(original,'server');
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
    const msg=messages.get(id);
    if (broadcast && msg) addLocalRecycle(msg,'server');
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

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async e => {
  const files=[...e.target.files]; if (!files.length) return;
  for (const file of files) await uploadMedia(file);
  fileInput.value=''; return;
  if (!/^(image\/|video\/|audio\/)/i.test(file.type) && !/^(application\/pdf|application\/msword|application\/vnd\.|text\/plain|application\/zip)/i.test(file.type)) { showToast('Unsupported file type'); fileInput.value=''; return; }
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
  const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document';
  const ui = makeUploadBubble(file, type);
  try {
    const uploadId = id();
    const meta = { uploadId, groupId: currentGroupId, senderId: socketId, userId, user: name, type, mime: file.type, name: file.name, size: file.size, time: now(), createdAt: new Date().toISOString() };
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
    for (let attempt=0; attempt<3; attempt++) {
      finish = await fetch('/api/media/end', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ uploadId, user:name, time:now() }), cache:'no-store' });
      result = await finish.json().catch(() => ({}));
      if (finish.ok && result.ok) break;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!result.ok) throw new Error(result.error || 'Media upload could not finish');
    setUploadProgress(ui, 100, '✓');
    ui.el.classList.add('upload-done');
    setTimeout(() => ui.el.remove(), 450);
    renderMessage(result.message, 'outgoing');
    updatePreview(type === 'image' ? '📷 Photo' : type === 'video' ? '🎥 Video' : type === 'audio' ? '🎤 Voice message' : '📎 Document');
  } catch (error) {
    ui.el.classList.add('upload-error');
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
    groupPasswordTarget = null;
    await joinGroup(group.id, true);
  } catch (_) { groupPasswordError.textContent = 'Could not verify password'; }
}

async function joinGroup(groupId, openAfter=true) {
  const group = groups.find(g => g.id === groupId) || { id: groupId, name: 'WhatsApp' };
  currentGroupId = groupId || 'main';
  groupName = group.name || 'WhatsApp';
  localStorage.setItem('wa_group_id', currentGroupId);
  localStorage.setItem('wa_group_name', groupName);
  messages.clear(); deletedIds.clear(); readSent.clear(); lastRenderedDate = ''; lastSyncAt = '';
  messageArea.innerHTML = '';
  updateGroupNameUI(); renderGroupList();
  loadLocalMessageHistory();
  await new Promise(resolve => {
    if (!socket.connected) { resolve(); return; }
    socket.emit('join-group', { groupId: currentGroupId }, () => resolve());
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

socket.on('message-restored', data => { if(!data?.message || (data.groupId && data.groupId!==currentGroupId)) return; removeLocalRecycle([data.message.id]); deletedIds.delete(String(data.message.id)); deletedForMeIds.delete(String(data.message.id)); if(!messages.has(String(data.message.id))) renderMessage(data.message,data.message.userId===userId?'outgoing':'incoming'); showToast('Message restored'); });
socket.on('delete-message', data => { if (data && data.id && (!data.groupId || data.groupId === currentGroupId)) deleteMessage(data.id,false); });
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
  socket.emit('join-group', { groupId: currentGroupId }, () => syncMessages().finally(markVisibleMessagesRead));
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
    row.innerHTML = `<div class="admin-group-name"></div><div class="admin-password-wrap"><input type="text" class="admin-password-input" maxlength="120" autocomplete="off"><button type="button" class="mini-btn admin-copy-btn">Copy</button></div><div class="admin-row-actions"><button type="button" class="mini-btn admin-save-btn">Save</button><button type="button" class="mini-btn admin-delete-btn">Delete</button></div>`;
    row.querySelector('.admin-group-name').textContent = group.name;
    row.querySelector('.admin-password-input').value = group.password || '';
    row.querySelector('.admin-copy-btn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(row.querySelector('.admin-password-input').value); showToast('Password copied'); } catch (_) {}
    });
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
const callModal=document.querySelector('#callModal'), callClose=document.querySelector('#callClose'), endCallBtn=document.querySelector('#endCallBtn'), muteCallBtn=document.querySelector('#muteCallBtn'), speakerCallBtn=document.querySelector('#speakerCallBtn');
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
// WebRTC-ready call UI; actual media call can be wired to a signaling provider later.
function startCall(video=false){if(!currentGroupId)return; document.getElementById('callTitle').textContent=video?'Video call':'Voice call';document.getElementById('callState').textContent='Calling…';document.getElementById('callAvatar').textContent=(groupName||'W').slice(0,1).toUpperCase();callModal?.classList.remove('hidden');}
document.getElementById('callBtn')?.addEventListener('click',()=>startCall(false));document.getElementById('videoCallBtn')?.addEventListener('click',()=>startCall(true));callClose?.addEventListener('click',()=>callModal.classList.add('hidden'));endCallBtn?.addEventListener('click',()=>{callModal.classList.add('hidden');showToast('Call ended')});muteCallBtn?.addEventListener('click',()=>{muteCallBtn.textContent=muteCallBtn.textContent.includes('Mute')?'🔇 Unmute':'🎤 Mute'});speakerCallBtn?.addEventListener('click',()=>{speakerCallBtn.textContent=speakerCallBtn.textContent.includes('Speaker')?'🔈 Earpiece':'🔊 Speaker'});
// Voice recorder
let mediaRecorder=null, voiceChunks=[];
async function startVoice(){ try{const stream=await navigator.mediaDevices.getUserMedia({audio:true}); voiceChunks=[];mediaRecorder=new MediaRecorder(stream);mediaRecorder.ondataavailable=e=>{if(e.data.size)voiceChunks.push(e.data)};mediaRecorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());const blob=new Blob(voiceChunks,{type:mediaRecorder.mimeType||'audio/webm'});const file=new File([blob],`voice-${Date.now()}.webm`,{type:blob.type});await uploadMedia(file)};mediaRecorder.start();micBtn.classList.add('recording');showToast('Recording… click 🎤 again to stop');}catch(e){showToast('Microphone permission denied')}}
const micBtn=document.getElementById('micBtn'); micBtn?.addEventListener('click',()=>{if(mediaRecorder && mediaRecorder.state==='recording'){mediaRecorder.stop();micBtn.classList.remove('recording')}else startVoice()});
// Allow selecting a locked group only after PIN.
const oldOpenGroup=openGroup; openGroup=async function(group){const g=advState[group?.id||''];if(g?.locked){currentGroupId=group.id;groupName=group.name; if(!requireUnlock())return;} return oldOpenGroup(group);};
updateAdvancedTools();
