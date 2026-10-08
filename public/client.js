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
// Stable per-installation/device identifier. The server still uses userId for
// user-level presence, while this ID lets it distinguish multiple devices.
const deviceId = (() => {
  const key = 'wa_device_id';
  let value = localStorage.getItem(key);
  if (!value) {
    value = (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(key, value);
  }
  return value;
})();
let userId = localStorage.getItem('wa_user_id') || '';
// Register the PWA service worker immediately. This is intentionally
// independent of the currently open group: once a browser has granted
// notification permission, the same PushSubscription can receive messages
// for every group the User ID has previously joined.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js?v=29', { scope: '/' }).then(reg => reg.update().catch(() => {})).catch(() => {});
}

function syncAndroidNotificationIdentity() {
  try {
    if (window.AndroidBridge) {
      // Save the URL first so the native background listener has everything it
      // needs before it starts. This is intentionally Firebase-free.
      window.AndroidBridge.setAppUrl(window.location.origin);
      if (userId) window.AndroidBridge.setUserId(String(userId));
    }
  } catch (_) {}
}
syncAndroidNotificationIdentity();
let name = localStorage.getItem('wa_name') || '';
let groupName = localStorage.getItem('wa_group_name') || 'WhatsApp';
let currentGroupId = localStorage.getItem('wa_group_id') || '';
let groups = [];
let privateUsers = [];
let activeChatType = 'group';
let currentPrivateUser = null;
let privateLastMessages = {};
let privateUnreadCounts = {};
let groupPasswordTarget = null;
const unreadCounts = {};
function getUnreadCount(groupId){ return Math.max(0, Number(unreadCounts[String(groupId)] || 0)); }
function setUnreadCount(groupId, count){ const gid=String(groupId||''); if(!gid) return; if(Number(count)>0) unreadCounts[gid]=Math.floor(Number(count)); else delete unreadCounts[gid]; renderGroupList(); }
function incrementUnread(groupId){ const gid=String(groupId||''); if(!gid) return; setUnreadCount(gid, getUnreadCount(gid)+1); }
async function refreshUnreadCountForGroup(groupId){
  const gid=String(groupId||''); if(!gid || !userId) return;
  try {
    const r=await fetch(`/api/unread-count?groupId=${encodeURIComponent(gid)}&userId=${encodeURIComponent(userId)}`,{cache:'no-store'});
    if(!r.ok) return;
    const d=await r.json();
    setUnreadCount(gid, Number(d.count||0));
  } catch(_) {}
}
async function refreshAllUnreadCounts(){
  if(!userId || !Array.isArray(groups)) return;
  await Promise.all(groups.map(g=>refreshUnreadCountForGroup(g.id)));
}
// Group passwords are trusted only for the lifetime of this browser tab.
// sessionStorage survives normal in-tab navigation/reloads, but is cleared when
// the tab/session is closed, so a newly opened tab must ask for the password.
const GROUP_PASSWORD_SESSION_KEY = 'wa_verified_group_passwords';
function getVerifiedGroupPasswords() {
  try { return JSON.parse(sessionStorage.getItem(GROUP_PASSWORD_SESSION_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function getVerifiedGroupPassword(groupId) {
  const store = getVerifiedGroupPasswords();
  return String(store[String(groupId)] || '');
}
function setVerifiedGroupPassword(groupId, password) {
  try {
    const store = getVerifiedGroupPasswords();
    store[String(groupId)] = String(password || '');
    sessionStorage.setItem(GROUP_PASSWORD_SESSION_KEY, JSON.stringify(store));
  } catch (_) {}
}
let selectionMode = false;
const selectedMessageIds = new Set();
function generateUserId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'WA-';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

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
const newChatChoiceModal = document.querySelector('#newChatChoiceModal');
const newChatChoiceClose = document.querySelector('#newChatChoiceClose');
const newPrivateChatChoice = document.querySelector('#newPrivateChatChoice');
const joinPrivateChatChoice = document.querySelector('#joinPrivateChatChoice');
const newGroupChoice = document.querySelector('#newGroupChoice');
const privateChatModal = document.querySelector('#privateChatModal');
const privateChatClose = document.querySelector('#privateChatClose');
const privateUserCreateModal = document.querySelector('#privateUserCreateModal');
const privateUserCreateClose = document.querySelector('#privateUserCreateClose');
const privateUserCreateName = document.querySelector('#privateUserCreateName');
const privateUserCreatePassword = document.querySelector('#privateUserCreatePassword');
const privateUserCreateError = document.querySelector('#privateUserCreateError');
const privateUserCreateSave = document.querySelector('#privateUserCreateSave');
const privateUserJoinModal = document.querySelector('#privateUserJoinModal');
const privateUserJoinClose = document.querySelector('#privateUserJoinClose');
const privateUserJoinName = document.querySelector('#privateUserJoinName');
const privateUserJoinPassword = document.querySelector('#privateUserJoinPassword');
const privateUserJoinError = document.querySelector('#privateUserJoinError');
const privateUserJoinSave = document.querySelector('#privateUserJoinSave');
const privateChatSearch = document.querySelector('#privateChatSearch');
const privateUserList = document.querySelector('#privateUserList');
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
const adminMenuLocked = document.querySelector('#adminMenuLocked');
const adminMenuUnlocked = document.querySelector('#adminMenuUnlocked');
const adminMenuPanelBtn = document.querySelector('#adminMenuPanelBtn');
const adminMenuCallBtn = document.querySelector('#adminMenuCallBtn');
const adminMenuPhotosBtn = document.querySelector('#adminMenuPhotosBtn');
const adminMenuVideosBtn = document.querySelector('#adminMenuVideosBtn');
const adminMenuPrivateBtn = document.querySelector('#adminMenuPrivateBtn');
const adminMenuRecycleBtn = document.querySelector('#adminMenuRecycleBtn');
const adminMenuDeleteBtn = document.querySelector('#adminMenuDeleteBtn');
const adminMenuLogoutBtn = document.querySelector('#adminMenuLogoutBtn');
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
const adminPhotosBtn = document.querySelector('#adminPhotosBtn');
const adminVideosBtn = document.querySelector('#adminVideosBtn');
const adminPrivateChatsBtn = document.querySelector('#adminPrivateChatsBtn');
const adminAllUsersModal = document.querySelector('#adminAllUsersModal');
const adminAllUsersClose = document.querySelector('#adminAllUsersClose');
const adminAllUsersList = document.querySelector('#adminAllUsersList');
const adminAllUsersError = document.querySelector('#adminAllUsersError');
const adminAllUsersRefresh = document.querySelector('#adminAllUsersRefresh');
const adminAllUsersAddUser = document.querySelector('#adminAllUsersAddUser');
const adminAllUsersSelectAll = document.querySelector('#adminAllUsersSelectAll');
const adminAllUsersDeleteSelected = document.querySelector('#adminAllUsersDeleteSelected');
const adminAllUsersBack = document.querySelector('#adminAllUsersBack');
const adminChangeUserPasswordModal = document.querySelector('#adminChangeUserPasswordModal');
const adminChangeUserPasswordClose = document.querySelector('#adminChangeUserPasswordClose');
const adminChangeUserPasswordInput = document.querySelector('#adminChangeUserPasswordInput');
const adminChangeUserPasswordSave = document.querySelector('#adminChangeUserPasswordSave');
const adminChangeUserPasswordError = document.querySelector('#adminChangeUserPasswordError');
const adminChangeUserPasswordInfo = document.querySelector('#adminChangeUserPasswordInfo');
let adminChangePasswordUserId = '';
let adminChangePasswordUserName = '';

function openAdminChangeUserPassword(userId, userName){
  if(!adminUnlocked) return requestAdminThen(() => openAdminChangeUserPassword(userId,userName));
  adminChangePasswordUserId=String(userId||'');
  adminChangePasswordUserName=String(userName||'User');
  if(adminChangeUserPasswordInfo) adminChangeUserPasswordInfo.textContent=`Set a new password for ${adminChangePasswordUserName} (${adminChangePasswordUserId}). The old password is not required.`;
  if(adminChangeUserPasswordInput) adminChangeUserPasswordInput.value='';
  if(adminChangeUserPasswordError) adminChangeUserPasswordError.textContent='';
  adminChangeUserPasswordModal?.classList.remove('hidden');
  setTimeout(()=>adminChangeUserPasswordInput?.focus(),50);
}
function closeAdminChangeUserPassword(){ adminChangeUserPasswordModal?.classList.add('hidden'); adminChangePasswordUserId=''; adminChangePasswordUserName=''; }
async function saveAdminChangeUserPassword(){
  if(!adminChangePasswordUserId) return;
  const newPassword=String(adminChangeUserPasswordInput?.value||'');
  if(newPassword.length<4 || newPassword.length>100){ if(adminChangeUserPasswordError) adminChangeUserPasswordError.textContent='Password must be 4-100 characters.'; return; }
  adminChangeUserPasswordSave.disabled=true;
  if(adminChangeUserPasswordError) adminChangeUserPasswordError.textContent='';
  try{
    const r=await fetch('/api/admin/user/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,userId:adminChangePasswordUserId,newPassword})});
    const d=await r.json();
    if(!r.ok||!d.ok) throw new Error(d.error||'Could not change password.');
    closeAdminChangeUserPassword();
    showToast(`Password changed for ${adminChangePasswordUserName}`);
    await loadAdminAllUsers();
    await loadPrivateUsers();
  }catch(e){ if(adminChangeUserPasswordError) adminChangeUserPasswordError.textContent=e.message||'Could not change password.'; }
  finally{ adminChangeUserPasswordSave.disabled=false; }
}


const adminDeleteUserBtn = document.querySelector('#adminDeleteUserBtn');
const adminPrivateChatsModal = document.querySelector('#adminPrivateChatsModal');
const adminPrivateChatsClose = document.querySelector('#adminPrivateChatsClose');
const adminPrivateChatsList = document.querySelector('#adminPrivateChatsList');
const adminPrivateChatsError = document.querySelector('#adminPrivateChatsError');
const adminPrivateChatsRefresh = document.querySelector('#adminPrivateChatsRefresh');
const adminPrivatePassword = document.querySelector('#adminPrivatePassword');
const adminDeleteAllUsersBtn = document.querySelector('#adminDeleteAllUsersBtn');
const adminDeleteAllGroupsBtn = document.querySelector('#adminDeleteAllGroupsBtn');
const adminGroupMediaModal = document.querySelector('#adminGroupMediaModal');
const adminGroupMediaClose = document.querySelector('#adminGroupMediaClose');
const adminGroupMediaTitle = document.querySelector('#adminGroupMediaTitle');
const adminGroupMediaHelp = document.querySelector('#adminGroupMediaHelp');
const adminGroupMediaList = document.querySelector('#adminGroupMediaList');
const adminGroupMediaError = document.querySelector('#adminGroupMediaError');
const adminGroupMediaRefresh = document.querySelector('#adminGroupMediaRefresh');
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
    // Always open a mobile/desktop chat at the newest message so users do not
    // have to scroll through the whole history to reach the latest message.
    requestAnimationFrame(() => scrollToBottom());
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

async function savePushIdentityForServiceWorker(nextUserId, publicKey) {
  if (!('indexedDB' in window)) return;
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('wa-push', 1);
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore('identity'); } catch (_) {}
    };
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction('identity', 'readwrite');
        tx.objectStore('identity').put(String(nextUserId || ''), 'userId');
        tx.objectStore('identity').put(String(publicKey || ''), 'publicKey');
        tx.oncomplete = () => { try { db.close(); } catch (_) {} resolve(); };
        tx.onerror = () => { try { db.close(); } catch (_) {} reject(tx.error); };
      } catch (e) { reject(e); }
    };
    req.onerror = () => reject(req.error);
  });
}

let webPushSetupPromise = null;
async function setupWebPush() {
  // The bundled Android app has its own persistent native notification service.
  // Keep Web Push for browser/PWA, but avoid duplicate alerts inside the APK.
  if (window.AndroidBridge) return false;
  if (webPushSetupPromise) return webPushSetupPromise;
  webPushSetupPromise = (async () => {
    if (!userId) return false;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;
    try {
      const registration = await navigator.serviceWorker.register('/sw.js?v=29', { scope: '/' });
      await registration.update().catch(() => {});
      await navigator.serviceWorker.ready;
      const response = await fetch('/api/push/public-key', { cache: 'no-store' });
      if (!response.ok) return false;
      const data = await response.json().catch(() => ({}));
      if (!data.publicKey) return false;
      const applicationServerKey = urlBase64ToUint8Array(data.publicKey);
      let subscription = await registration.pushManager.getSubscription();
      // A PushSubscription is bound to the VAPID applicationServerKey that
      // created it. If the deployment's VAPID key changed, the old subscription
      // can look valid locally but every server push will fail. Recreate only
      // when the browser exposes a key and it actually differs; otherwise keep
      // the existing subscription stable.
      if (subscription) {
        try {
          const existingKey = subscription.options?.applicationServerKey;
          if (existingKey) {
            const a = new Uint8Array(existingKey);
            const b = new Uint8Array(applicationServerKey);
            if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
              await subscription.unsubscribe().catch(() => {});
              subscription = null;
            }
          }
        } catch (_) {}
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      }
      // Keep the identity in IndexedDB too. If the browser rotates the push
      // subscription while the PWA is locked/backgrounded, sw.js can renew
      // the subscription without waiting for the app page to reopen.
      try {
        await savePushIdentityForServiceWorker(String(userId), data.publicKey);
      } catch (_) {}
      let saveResponse = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, subscription })
      });
      if (!saveResponse.ok) return false;
      let saveData = await saveResponse.json().catch(() => ({}));
      if (saveData.ok !== true) return false;
      return true;
    } catch (error) {
      console.warn('Web push setup failed:', error);
      return false;
    } finally {
      webPushSetupPromise = null;
    }
  })();
  return webPushSetupPromise;
}

function notificationSetup() {
  if (!('Notification' in window)) return;
  // Push subscription creation must happen after a user gesture in browsers.
  const once = async () => {
    const granted = await enableNotifications();
    if (granted && userId) await setupWebPush().catch(() => {});
    if (granted) {
      document.removeEventListener('pointerdown', once);
      document.removeEventListener('keydown', once);
    }
  };
  document.addEventListener('pointerdown', once);
  document.addEventListener('keydown', once);
}
notificationSetup();
if ('Notification' in window && Notification.permission === 'granted' && userId) setupWebPush().catch(() => {});
window.addEventListener('online', () => {
  if ('Notification' in window && Notification.permission === 'granted' && userId) setupWebPush().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && 'Notification' in window && Notification.permission === 'granted' && userId) {
    setupWebPush().catch(() => {});
  }
});

let webNotificationCursor = localStorage.getItem('wa_notification_cursor') || '';
let webNotificationPrimed = false;
const webNotificationSeen = new Set();
async function pollWebNotifications() {
  if (!userId || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const qs = new URLSearchParams({ userId });
    if (webNotificationCursor) qs.set('after', webNotificationCursor);
    const response = await fetch(`/api/notifications/poll?${qs.toString()}`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    if (!data.ok || !Array.isArray(data.messages)) return;
    let newest = webNotificationCursor;
    for (const msg of data.messages) {
      const id = String(msg.id || '');
      const created = String(msg.createdAt || '');
      if (created && (!newest || created > newest)) newest = created;
      if (!id || webNotificationSeen.has(id)) continue;
      webNotificationSeen.add(id);
      if (!webNotificationPrimed) continue;
      const msgGroupId = String(msg.groupId || '');
      // If the user is actively viewing the same group, the incoming message
      // itself is already visible; do not create a duplicate OS alert.
      // If another group receives the message, alert even when this tab is
      // currently visible so group-to-group notifications are never missed.
      const viewingSameGroup = document.visibilityState === 'visible'
        && String(currentGroupId || '') === msgGroupId
        && activeChatType !== 'private';
      if (viewingSameGroup) continue;

      const groupTitle = String(msg.groupName || 'WhatsApp').trim() || 'WhatsApp';
      const registration = await navigator.serviceWorker?.ready;
      if (registration?.showNotification) {
        await registration.showNotification(groupTitle, {
          body: 'New message', icon: '/icon.svg', badge: '/icon.svg',
          tag: `wa-${id}`, renotify: true,
          data: { url: '/#chat', messageId: id, groupId: msgGroupId }
        });
      }
    }
    if (newest && newest !== webNotificationCursor) {
      webNotificationCursor = newest;
      localStorage.setItem('wa_notification_cursor', newest);
    }
    webNotificationPrimed = true;
  } catch (_) {}
}
// Recovery only. Instant notifications use Web Push/Socket.IO; polling is not the primary path.
setInterval(pollWebNotifications, 30000);

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

passwordSubmit.addEventListener('click', async () => {
  const supplied = passwordInput.value;
  let valid = false;
  if (pendingPasswordType === 'download') valid = supplied === DOWNLOAD_PASSWORD;
  else if (pendingPasswordType === 'admin') valid = supplied === PASSWORD;
  else if (pendingPasswordType === 'private-setup' || pendingPasswordType === 'private-verify' || pendingPasswordType === 'private-action') {
    try {
      const peerId = String(window.pendingPrivatePeerId || currentPrivateUser?.userId || '');
      const endpoint = pendingPasswordType === 'private-setup' ? '/api/private-chat/set-password' : '/api/private-chat/verify';
      const r = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId, peerId, password:supplied})});
      const d = await r.json().catch(() => ({}));
      valid = !!d.ok;
      if (!valid && d.needsSetup && pendingPasswordType === 'private-verify') {
        pendingPasswordType = 'private-setup';
        passwordTitle.textContent = 'Set personal chat password';
        passwordText.textContent = 'Set a password for this personal chat. Share it with the other person.';
        passwordInput.value = '';
        passwordError.textContent = '';
        setTimeout(() => passwordInput.focus(), 40);
        return;
      }
    } catch (_) { valid = false; }
  }
  if (!valid) { passwordError.textContent = 'Wrong password'; passwordInput.select(); return; }
  const action = pendingAction;
  const wasAdminPassword = pendingPasswordType === 'admin';
  const wasPrivatePassword = pendingPasswordType === 'private-setup' || pendingPasswordType === 'private-verify' || pendingPasswordType === 'private-action';
  if (wasPrivatePassword) { window.privatePasswordForOpen = supplied; window.privatePasswordForAction = supplied; }
  closePassword();
  if (wasAdminPassword) {
    adminUnlocked = true;
    try { socket.emit('register-admin', { password: PASSWORD }); } catch (_) {}
    try { showToast('Admin login successful'); } catch (_) {}
  }
  if (action) action();
});
passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') passwordSubmit.click(); });
passwordClose.addEventListener('click', closePassword);
passwordModal.addEventListener('click', e => { if (e.target === passwordModal) closePassword(); });

async function sendMessage(text) {
  const message = String(text || '').trim();
  if (!message) return;

  if (activeChatType === 'private') {
    const peer = currentPrivateUser;
    if (!peer?.userId) return;
    const msg = {
      id:id(), userId, peerId:peer.userId, user:name, senderId:socketId,
      message, time:now(), type:'text', conversationId:`private:${[String(userId),String(peer.userId)].sort().join(':')}`,
      createdAt:new Date().toISOString(), deliveredTo:[], readBy:[]
    };
    textarea.value = ''; autoResize();
    renderMessage(msg, 'outgoing');
    privateLastMessages[peer.userId] = msg;
    try {
      const response = await fetch('/api/private-messages', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...msg, password:String(window.privateChatPasswords?.[String(peer.userId)] || '')}), cache:'no-store', keepalive:true
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || 'save');
      const saved = result.message || msg;
      messages.set(saved.id, saved);
      const el = document.querySelector(`.message[data-id="${CSS.escape(saved.id)}"]`);
      if (el) el.dataset.synced = '1';
      updateTicks(saved);
    } catch (_) {
      const ack = await emitAck('private-message', {...msg, password:String(window.privateChatPasswords?.[String(peer.userId)] || '')}, 12000, 1);
      if (!ack?.ok) showToast('Private message is waiting for connection — please retry');
      else {
        messages.set(msg.id, ack.message || msg);
        const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
        if (el) el.dataset.synced = '1';
      }
    }
    return;
  }

  if (!currentGroupId) return;
  const msg = { id: id(), groupId: currentGroupId, senderId: socketId, userId, user: name, message, time: now(), type: 'text', createdAt: new Date().toISOString(), deliveredTo: [], readBy: [], ...(replyTo ? {replyTo} : {}) };
  textarea.value = '';
  clearReply();
  autoResize();
  updatePreview(message);
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
    const saved = result.message || msg;
    messages.set(saved.id, saved);
    const el = document.querySelector(`.message[data-id="${CSS.escape(saved.id)}"]`);
    if (el) el.dataset.synced = '1';
    updateTicks(saved);
  } catch (error) {
    const ack = await emitAck('message', msg, 12000, 1);
    if (!ack || !ack.ok) {
      const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
      if (el) { el.classList.add('send-failed'); el.title = 'Send failed. Tap Send again when the connection returns.'; }
      showToast('Message is waiting for connection — please retry');
    } else {
      messages.set(msg.id, ack.message || msg);
      const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
      if (el) { el.dataset.synced = '1'; el.classList.remove('send-failed'); }
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

// Turn shared URLs into safe, tappable links while keeping message text plain by default.
function renderMessageText(container, value) {
  const text = String(value ?? '');
  const urlRe = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/gi;
  let last = 0;
  let match;

  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > last) {
      container.appendChild(document.createTextNode(text.slice(last, match.index)));
    }

    let rawUrl = match[0];
    // Do not include common sentence punctuation in the clickable URL.
    let trailing = '';
    while (/[.,!?;:)]$/.test(rawUrl)) {
      trailing = rawUrl.slice(-1) + trailing;
      rawUrl = rawUrl.slice(0, -1);
    }

    const href = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    link.textContent = rawUrl;
    link.title = 'Open link';
    link.addEventListener('click', e => e.stopPropagation());
    container.appendChild(link);

    if (trailing) container.appendChild(document.createTextNode(trailing));
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    container.appendChild(document.createTextNode(text.slice(last)));
  }
}

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
    const text=document.createElement('div');
    text.className='message-text';
    renderMessageText(text, msg.message || '');
    content.appendChild(text);
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
    const read = isMessageRead(msg);
    const delivered = isMessageDelivered(msg);
    ticks.className='ticks' + (read ? ' read' : (delivered ? ' delivered' : ''));
    ticks.textContent = read || delivered ? '✓✓' : '✓';
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
    requestPassword('Delete for everyone', activeChatType === 'private' ? 'Enter this personal chat password. Deleted photos, videos and audio will be kept in the Admin Main Recycle Bin.' : 'Enter password to delete this message for everyone in this group.', () => deleteMessage(msg.id), activeChatType === 'private' ? 'private-action' : 'admin');
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

function privateConversationIdForClient() {
  const a=String(userId||'').trim(), b=String(currentPrivateUser?.userId||'').trim();
  if(!a || !b || a===b) return '';
  return [a,b].sort().join(':');
}
function privateChatPasswordForCurrent() {
  return String(window.privateChatPasswords?.[String(currentPrivateUser?.userId||'')] || '');
}
function deleteMessage(messageId, broadcast=true) {
  const id = String(messageId);
  const el=document.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
  if (el) el.remove();
  messages.delete(id);
  deletedIds.add(id);
  selectedMessageIds.delete(id);
  saveLocalMessageHistory();
  if (broadcast) {
    if (activeChatType === 'private') {
      const conversationId = privateConversationIdForClient();
      socket.emit('private-delete-message', {id, conversationId}, (result) => { if (!result || !result.ok) showToast('Private message could not be deleted'); });
    } else {
      socket.emit('delete-message', {id}, (result) => { if (!result || !result.ok) showToast('Delete could not be synced'); });
    }
  }
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
  if (broadcast) {
    if (activeChatType === 'private') {
      const conversationId = privateConversationIdForClient();
      socket.emit('private-delete-messages', {ids, conversationId}, (result) => { if (!result || !result.ok) showToast('Private messages could not be deleted'); });
    } else {
      socket.emit('delete-messages', {ids}, (result) => { if (!result || !result.ok) showToast('Delete could not be synced'); });
    }
  }
}

function clearChat(broadcast=true) {
  messageArea.innerHTML=''; messages.clear(); lastRenderedDate='';
  try { localStorage.removeItem(messageCacheKey()); } catch (_) {}
  updatePreview('No messages yet');
  if (broadcast) {
    if (activeChatType === 'private') {
      socket.emit('private-clear-chat', {conversationId:privateConversationIdForClient()}, (result) => { if (!result || !result.ok) showToast('Private chat could not be cleared'); });
    } else {
      socket.emit('clear-chat', {by:name});
    }
  }
}

clearChatBtn.addEventListener('click', () => requestPassword('Clear chat', activeChatType === 'private' ? 'Enter this personal chat password to clear the chat. Deleted photos, videos and audio will be kept in the Admin Main Recycle Bin.' : 'Enter password to clear this chat.', () => {
  if (activeChatType === 'private' && privateChatPasswordForCurrent()) clearChat(true); else clearChat(true);
}, activeChatType === 'private' ? 'private-action' : 'admin'));

const cameraModal = document.querySelector('#cameraModal');
const cameraPreview = document.querySelector('#cameraPreview');
const cameraCloseBtn = document.querySelector('#cameraCloseBtn');
const cameraPhotoBtn = document.querySelector('#cameraPhotoBtn');
const cameraRecordBtn = document.querySelector('#cameraRecordBtn');
const cameraSwapBtn = document.querySelector('#cameraSwapBtn');
const cameraRecordingTimer = document.querySelector('#cameraRecordingTimer');
let cameraFacingMode = 'environment', cameraRecordingStartedAt = 0, cameraRecordingTimerId = null;
const cameraPreviewModal = document.querySelector('#cameraPreviewModal');
const cameraPreviewStage = document.querySelector('#cameraPreviewStage');
const cameraPreviewCancelBtn = document.querySelector('#cameraPreviewCancelBtn');
const cameraPreviewRetakeBtn = document.querySelector('#cameraPreviewRetakeBtn');
const cameraPreviewSendBtn = document.querySelector('#cameraPreviewSendBtn');
let cameraStream = null, cameraRecorder = null, cameraChunks = [];
let pendingCameraFile = null, pendingCameraUrl = '';

function stopCameraRecordingTimer(){
  if(cameraRecordingTimerId){ clearInterval(cameraRecordingTimerId); cameraRecordingTimerId=null; }
  cameraRecordingStartedAt=0;
  cameraRecordingTimer?.classList.add('hidden');
}
function updateCameraRecordingTimer(){
  if(!cameraRecordingTimer || !cameraRecordingStartedAt) return;
  const sec=Math.floor((Date.now()-cameraRecordingStartedAt)/1000);
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  cameraRecordingTimer.textContent=`🔴 ${h?String(h).padStart(2,'0')+':':''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function startCameraRecordingTimer(){
  stopCameraRecordingTimer();
  cameraRecordingStartedAt=Date.now();
  cameraRecordingTimer?.classList.remove('hidden');
  updateCameraRecordingTimer();
  cameraRecordingTimerId=setInterval(updateCameraRecordingTimer,250);
}
function stopCameraStream(){
  cameraStream?.getTracks().forEach(t=>{try{t.stop()}catch(_){}});
  cameraStream=null;
  if(cameraPreview) cameraPreview.srcObject=null;
}
function clearCameraPreview(){
  if(pendingCameraUrl){try{URL.revokeObjectURL(pendingCameraUrl)}catch(_){} pendingCameraUrl='';}
  pendingCameraFile=null;
  if(cameraPreviewStage) cameraPreviewStage.innerHTML='';
}
function openCameraReview(file){
  clearCameraPreview();
  pendingCameraFile=file;
  pendingCameraUrl=URL.createObjectURL(file);
  if(/^video\//i.test(file.type)){
    const v=document.createElement('video'); v.src=pendingCameraUrl; v.controls=true; v.autoplay=true; v.playsInline=true;
    cameraPreviewStage.appendChild(v);
  }else{
    const img=document.createElement('img'); img.src=pendingCameraUrl; img.alt='Photo preview';
    cameraPreviewStage.appendChild(img);
  }
  stopCameraStream();
  cameraModal?.classList.add('hidden');
  cameraPreviewModal?.classList.remove('hidden');
}
function closeCameraReview(){
  cameraPreviewModal?.classList.add('hidden');
  clearCameraPreview();
}
async function sendCameraReview(){
  const file=pendingCameraFile;
  if(!file) return;
  cameraPreviewSendBtn?.setAttribute('disabled','disabled');
  try{
    await uploadMedia(file);
    closeCameraReview();
  }catch(e){
    showToast(e?.message||'Could not send media');
  }finally{ cameraPreviewSendBtn?.removeAttribute('disabled'); }
}
async function openCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) { cameraInput?.click(); return; }
    cameraFacingMode='environment';
    cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:cameraFacingMode},width:{ideal:1280},height:{ideal:720}},audio:true});
    cameraPreview.srcObject = cameraStream;
    cameraModal?.classList.remove('hidden');
  } catch (e) {
    showToast('Camera permission denied or camera unavailable');
    cameraInput?.click();
  }
}
async function swapCamera() {
  if(!cameraStream) return;
  const track=cameraStream.getVideoTracks()[0];
  if(!track) return;
  const next=cameraFacingMode==='environment'?'user':'environment';
  try {
    await track.applyConstraints({facingMode: {exact: next}});
    cameraFacingMode=next;
  } catch (_) {
    try {
      const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:next},width:{ideal:1280},height:{ideal:720}},audio:false});
      const newTrack=newStream.getVideoTracks()[0];
      if(newTrack){
        const oldTrack=cameraStream.getVideoTracks()[0];
        cameraStream.removeTrack(oldTrack); cameraStream.addTrack(newTrack);
        oldTrack?.stop(); cameraPreview.srcObject=cameraStream; cameraFacingMode=next;
      }
    } catch(e){ showToast('Could not swap camera'); return; }
  }
}
function closeCamera() {
  stopCameraRecordingTimer();
  try { if(cameraRecorder && cameraRecorder.state !== 'inactive') cameraRecorder.stop(); } catch (_) {}
  cameraRecorder = null; cameraChunks = [];
  stopCameraStream();
  cameraModal?.classList.add('hidden');
}
async function takeCameraPhoto() {
  if (!cameraStream || !cameraPreview.videoWidth) return;
  const c=document.createElement('canvas'); c.width=cameraPreview.videoWidth; c.height=cameraPreview.videoHeight;
  c.getContext('2d').drawImage(cameraPreview,0,0,c.width,c.height);
  c.toBlob(blob=>{ if(blob) openCameraReview(new File([blob],`camera-${Date.now()}.jpg`,{type:'image/jpeg'})); },'image/jpeg',0.92);
}
function toggleCameraRecording() {
  if (!cameraStream) return;
  if (cameraRecorder && cameraRecorder.state === 'recording') { cameraRecorder.stop(); return; }
  cameraChunks=[];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
  cameraRecorder=new MediaRecorder(cameraStream,{mimeType:mime});
  cameraRecorder.ondataavailable=e=>{if(e.data.size)cameraChunks.push(e.data)};
  cameraRecorder.onstop=()=>{
    stopCameraRecordingTimer();
    const blob=new Blob(cameraChunks,{type:cameraRecorder?.mimeType||'video/webm'});
    cameraChunks=[];
    cameraRecorder=null;
    if(blob.size) openCameraReview(new File([blob],`camera-${Date.now()}.webm`,{type:blob.type}));
    if(cameraRecordBtn) cameraRecordBtn.textContent='🎥';
  };
  cameraRecorder.start(1000); startCameraRecordingTimer(); cameraRecordBtn.textContent='⏹️'; showToast('Recording video… tap again to stop');
}
cameraBtn?.addEventListener('click', openCamera);
galleryBtn?.addEventListener('click', () => galleryInput?.click());
cameraCloseBtn?.addEventListener('click', closeCamera);
cameraPhotoBtn?.addEventListener('click', takeCameraPhoto);
cameraRecordBtn?.addEventListener('click', toggleCameraRecording);
cameraSwapBtn?.addEventListener('click', swapCamera);
cameraPreviewCancelBtn?.addEventListener('click', closeCameraReview);
cameraPreviewRetakeBtn?.addEventListener('click', ()=>{ closeCameraReview(); openCamera(); });
cameraPreviewSendBtn?.addEventListener('click', sendCameraReview);
cameraModal?.addEventListener('click',e=>{if(e.target===cameraModal)closeCamera();});
cameraPreviewModal?.addEventListener('click',e=>{if(e.target===cameraPreviewModal)closeCameraReview();});

async function handleMediaPicker(input) {
  const files = [...(input?.files || [])];
  if (!files.length) return;
  for (const file of files) {
    if (!/^(image\/|video\/|audio\/)/i.test(file.type)) { showToast('Only photo, video and audio are supported'); continue; }
    await uploadMedia(file);
  }
  input.value = '';
}
cameraInput?.addEventListener('change', () => { const files=[...(cameraInput?.files||[])]; if(files[0] && /^(image\/|video\/)/i.test(files[0].type)) openCameraReview(files[0]); cameraInput.value=''; });
galleryInput?.addEventListener('change', () => handleMediaPicker(galleryInput));

function makeUploadBubble(file, type) {
  const el = document.createElement('div');
  el.className = 'message outgoing upload-message';
  const content = document.createElement('div');
  const wrap = document.createElement('div');
  wrap.className = 'media-wrap upload-wrap';
  const placeholder = document.createElement(type === 'video' ? 'div' : 'div');
  placeholder.className = 'upload-placeholder';
  placeholder.innerHTML = `<div class="upload-icon">${type === 'video' ? '🎥' : type === 'audio' ? '🎵' : '📷'}</div><div class="upload-name"></div>`;
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
    const privateUpload = activeChatType === 'private' && currentPrivateUser?.userId;
    const meta = {
      uploadId, groupId: privateUpload ? '' : currentGroupId,
      conversationId: privateUpload ? `private:${[String(userId),String(currentPrivateUser.userId)].sort().join(':')}` : '',
      peerId: privateUpload ? currentPrivateUser.userId : '',
      senderId: socketId, userId, user: name, type, mime: file.type, name: file.name, size: file.size,
      time: now(), createdAt: new Date().toISOString()
    };
    if (ui.status) ui.status.textContent = type === 'video' ? '📤 Uploading video… 0%' : type === 'image' ? '📤 Uploading photo… 0%' : type === 'audio' ? '📤 Uploading audio… 0%' : '📤 Uploading… 0%';
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
    if (ui.status) ui.status.textContent = type === 'video' ? '⚙️ Upload complete — sending video…' : type === 'image' ? '⚙️ Upload complete — sending photo…' : type === 'audio' ? '⚙️ Upload complete — sending audio…' : '⚙️ Upload complete — sending…';
    for (let attempt=0; attempt<3; attempt++) {
      finish = await fetch('/api/media/end', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ uploadId, user:name, time:now() }), cache:'no-store' });
      result = await finish.json().catch(() => ({}));
      if (finish.ok && result.ok) break;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!result.ok) throw new Error(result.error || 'Media upload could not finish');
    setUploadProgress(ui, 100, '✓');
    if (ui.status) ui.status.textContent = type === 'video' ? '✅ Video sent' : type === 'image' ? '✅ Photo sent' : type === 'audio' ? '✅ Audio sent' : '✅ Sent';
    ui.el.classList.add('upload-done');
    setTimeout(() => ui.el.remove(), 2200);
    renderMessage(result.message, 'outgoing');
    if (privateUpload) {
      privateLastMessages[currentPrivateUser.userId] = result.message;
      renderGroupList();
    } else {
      updatePreview(type === 'image' ? '📷 Photo' : type === 'video' ? '🎥 Video' : type === 'audio' ? '🎤 Voice message' : '📎 Document');
    }
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
  const sender = String(msg?.userId || '');
  return Array.isArray(msg?.readBy) && msg.readBy.some(id => id && String(id) !== sender);
}

function isMessageDelivered(msg) {
  const sender = String(msg?.userId || '');
  return Array.isArray(msg?.deliveredTo) && msg.deliveredTo.some(id => id && String(id) !== sender);
}

function updateTicks(msg) {
  const el = document.querySelector(`.message[data-id="${CSS.escape(msg.id)}"]`);
  if (!el || msg.userId !== userId) return;
  const ticks = el.querySelector('.ticks');
  if (!ticks) return;
  const read = isMessageRead(msg);
  const delivered = isMessageDelivered(msg);
  ticks.textContent = read || delivered ? '✓✓' : '✓';
  ticks.classList.toggle('read', read);
  ticks.classList.toggle('delivered', delivered && !read);
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
  adminMediaPopupMeta.textContent=`${item.groupName||'Group'} • ${item.feedName||item.user||'User'} • ${isRecording?'Recording':type}`;
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
// Call recordings are saved silently; do not open a View popup when the call ends.
// Admin can still open recordings manually from the Call Recordings list.

function receivePrivateMessage(msg, options = {}) {
  if (!msg || !msg.id || !msg.conversationId) return;
  if (!options.history && messages.has(String(msg.id))) return;
  const me = String(userId || '');
  const peer = String(currentPrivateUser?.userId || '');
  const isIncoming = String(msg.userId || '') !== me;
  const expected = peer ? [me, peer].sort().join(':') : '';
  if (!expected || String(msg.conversationId) !== `private:${expected}`) return;

  if (isIncoming && !options.history && (activeChatType !== 'private' || !chatOpen)) {
    privateUnreadCounts[peer] = Number(privateUnreadCounts[peer] || 0) + 1;
    renderGroupList();
  }
  privateLastMessages[peer] = msg;
  if (activeChatType !== 'private' || String(currentPrivateUser?.userId) !== peer) {
    renderGroupList();
    return;
  }
  renderMessage(msg, isIncoming ? 'incoming' : 'outgoing');
  if (isIncoming) {
    socket.emit('private-message-delivered', { id: msg.id, conversationId: msg.conversationId, userId: me });
  }
  if (msg.userId !== me && document.visibilityState === 'visible') {
    socket.emit('private-message-read', { id: msg.id, conversationId: msg.conversationId, userId: me });
  }
  if (msg.createdAt) lastSyncAt = new Date(msg.createdAt).toISOString();
  updatePreview(msg.message || 'New message');
}

function receiveMessage(msg, options = {}) {
  if (!msg || !msg.id) return;
  const msgGroupId = msg.groupId || 'main';
  const senderId = String(msg.userId || msg.senderId || msg.fromUserId || '');
  const isIncoming = !!senderId && senderId !== String(userId || '');
  // Live socket messages for another group still count as unread.
  // Historical messages loaded on initial join must never create unread badges.
  if (isIncoming && !options.history && (msgGroupId !== currentGroupId || !chatOpen)) {
    // User-level read state is stored on the server. A message already seen on
    // any device for this User ID must never become unread again.
    if (!(Array.isArray(msg.readBy) && msg.readBy.map(String).includes(String(userId)))) incrementUnread(msgGroupId);
  }
  if (msgGroupId !== currentGroupId) return;
  renderMessage(msg, isIncoming ? 'incoming' : 'outgoing');
  if (isIncoming) {
    socket.emit('message-delivered', { id: msg.id, userId, groupId: msgGroupId });
  }
  if (msg.createdAt) lastSyncAt = lastSyncAt ? new Date(Math.max(new Date(lastSyncAt).getTime(), new Date(msg.createdAt).getTime())).toISOString() : new Date(msg.createdAt).toISOString();
  updatePreview(msg.message || (msg.type === 'image' ? '📷 Photo' : msg.type === 'video' ? '🎥 Video' : msg.type === 'audio' ? '🎤 Voice message' : msg.type === 'document' ? '📎 Document' : 'New message'));
  if (msg.userId !== userId) {
    if (document.visibilityState === 'visible') markMessageRead(msg);
  }
}


socket.on('history', history => {
  if (!Array.isArray(history)) return;
  history.forEach(msg => receiveMessage(msg, {history:true}));
  if (history.length) {
    const last = history[history.length - 1];
    if (last.createdAt) lastSyncAt = new Date(last.createdAt).toISOString();
  }
});

// If Admin deletes this account, the old local identity must be discarded.
// The next time the app is opened/continued, the user is treated as a new user
// and receives a fresh User ID after entering a new name + password.
socket.on('account-deleted', (info) => {
  try {
    localStorage.removeItem('wa_user_id');
    localStorage.removeItem('wa_name');
  } catch (_) {}
  userId = '';
  name = '';
  try { window.privateChatPasswords = {}; } catch (_) {}
  try {
    if (socket.connected) socket.disconnect();
  } catch (_) {}
  updateMyNameUI?.();
  alert('Your account was deleted by Admin. Please create a new account with a new name and password.');
  setTimeout(() => openAccountModal(true), 50);
});

socket.on('connect', () => {
  if (userId) {
    refreshAllUnreadCounts().catch(() => {});
    loadPrivateUsers().catch(() => {});
  }
});

socket.on('message', receiveMessage);
socket.on('media', receiveMessage);
socket.on('private-history', history => {
  if (!Array.isArray(history)) return;
  history.forEach(msg => receivePrivateMessage(msg, {history:true}));
  if (history.length) requestAnimationFrame(() => scrollToBottom());
});
socket.on('private-password-changed', data => { if (activeChatType === 'private' && currentPrivateUser?.userId === String(data?.userId || '')) { showToast('User password changed. Re-enter the new password.'); closeChat(); } });
socket.on('private-chat-deleted', data => {
  const conversationId = String(data?.conversationId || '');
  if (!conversationId) return;
  if (window.privateChatPasswords) {
    const current = window.privateChatPasswords;
    Object.keys(current).forEach(k => {
      if (String(current[k]?.conversationId || '') === conversationId) delete current[k];
    });
  }
  if (String(currentPrivateUser?.conversationId || '') === conversationId) {
    if (window.privateChatPasswords && currentPrivateUser?.userId) delete window.privateChatPasswords[String(currentPrivateUser.userId)];
    currentPrivateUser = null;
    activeChatType = 'group';
    messages.clear();
    deletedIds.clear();
    readSent.clear();
    lastRenderedDate = '';
    lastSyncAt = '';
    if (messageArea) messageArea.innerHTML = '';
    composer?.classList.add('hidden');
  }
  if (typeof loadPrivateUsers === 'function') loadPrivateUsers().catch(() => {});
});

socket.on('user-deleted', data => {
  const deletedId = String(data?.userId || '');
  if (!deletedId) return;

  // Remove deleted users immediately from every client-side directory/list.
  privateUsers = privateUsers.filter(u => String(u.userId) !== deletedId);
  delete privateLastMessages[deletedId];
  delete privateUnreadCounts[deletedId];
  if (window.privateChatPasswords) delete window.privateChatPasswords[deletedId];

  if (String(currentPrivateUser?.userId || '') === deletedId) {
    currentPrivateUser = null;
    activeChatType = 'group';
    messages.clear();
    deletedIds.clear();
    readSent.clear();
    lastRenderedDate = '';
    lastSyncAt = '';
    if (messageArea) messageArea.innerHTML = '';
    composer?.classList.add('hidden');
    if (groups.length) {
      currentGroupId = groups[0].id;
      updateGroupNameUI();
    }
  }
  renderGroupList();
  showToast(`${String(data?.name || 'User')} was deleted`);
});

socket.on('private-message', msg => {
  if (!msg || !msg.conversationId) return;
  const ids = String(msg.conversationId).replace(/^private:/,'').split(':');
  const peerId = ids.find(id => String(id) !== String(userId || '')) || '';
  const peer = privateUsers.find(u => String(u.userId) === String(peerId));
  if (peer) {
    privateLastMessages[peerId] = msg;
    if (String(currentPrivateUser?.userId) !== String(peerId) || activeChatType !== 'private') {
      privateUnreadCounts[peerId] = Number(privateUnreadCounts[peerId] || 0) + (String(msg.userId) === String(userId) ? 0 : 1);
      renderGroupList();
    }
  }
  receivePrivateMessage(msg);
});
socket.on('private-message-delivered', data => {
  if (!data?.id) return;
  const m = messages.get(String(data.id)); if (!m) return;
  m.deliveredTo = Array.isArray(m.deliveredTo) ? m.deliveredTo : [];
  if (!m.deliveredTo.map(String).includes(String(data.userId))) m.deliveredTo.push(String(data.userId));
  updateTicks(m);
});
socket.on('private-message-read', data => {
  if (!data?.id) return;
  const m = messages.get(String(data.id)); if (!m) return;
  m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
  if (!m.readBy.map(String).includes(String(data.userId))) m.readBy.push(String(data.userId));
  updateTicks(m);
});

// A socket is joined to only one group at a time, so messages arriving in
// other groups are delivered through this user-level event. This makes the
// group-list unread badge update instantly without a refresh.
socket.on('unread-message', data => {
  if (!data || !data.id || !data.groupId) return;
  if (String(data.userId || '') === String(userId || '')) return;
  if (Array.isArray(data.readBy) && data.readBy.map(String).includes(String(userId || ''))) return;
  // If this group is currently open, the normal message event is responsible
  // for marking it read; do not create a duplicate badge here.
  if (String(data.groupId) === String(currentGroupId || '')) return;
  incrementUnread(data.groupId);
});

// Browser realtime notification fallback. The server emits this event to every
// authorized member, while Web Push handles closed/background browsers. This
// keeps laptop/desktop notifications working even if a push subscription is
// temporarily unavailable. Never expose the message preview.
socket.on('native-notification', async data => {
  // Native Android uses NotificationPollService as its single background
  // notification path, so the WebView must not create duplicate alerts.
  if (window.AndroidBridge) return;
  if (!data?.id || !data?.groupId) return;
  if (String(data.userId || '') === String(userId || '')) return;
  // The active group is already rendered in the chat. For every other group,
  // show a notification even if the app tab itself is currently visible.
  const sameVisibleGroup = document.visibilityState === 'visible'
    && String(currentGroupId || '') === String(data.groupId || '')
    && activeChatType !== 'private';
  if (sameVisibleGroup) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (!registration?.showNotification) return;
    const groupTitle = String(data.groupName || 'WhatsApp').trim() || 'WhatsApp';
    await registration.showNotification(groupTitle, {
      body: 'New message',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: `wa-${String(data.id)}`,
      renotify: false,
      data: { url: '/#chat', messageId: String(data.id), groupId: String(data.groupId) }
    });
  } catch (_) {}
});

function markMessageRead(msg) {
  if (!msg || !msg.id || String(msg.userId || '') === String(userId || '') || readSent.has(msg.id) || !chatOpen) return;
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
  if (!msg.deliveredTo.map(String).includes(String(data.userId))) msg.deliveredTo.push(String(data.userId));
  updateTicks(msg);
});

socket.on('message-read', data => {
  if (!data || !data.id || !data.userId) return;
  // A read receipt is user-level, not device-level. Any device belonging to the
  // same User ID must learn that this message is now seen.
  const msg = messages.get(data.id);
  if (msg) {
    msg.readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    if (!msg.readBy.map(String).includes(String(data.userId))) msg.readBy.push(String(data.userId));
    updateTicks(msg);
  }
  if (String(data.userId) === String(userId) && data.groupId) {
    refreshUnreadCountForGroup(data.groupId).catch(() => {});
  }
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

    // Reconcile the badge from the server's user-level readBy state. This
    // makes read/seen status shared across every device logged into this User ID.
    await refreshUnreadCountForGroup(currentGroupId);

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
setInterval(() => {
  // Keep group unread badges reconciled even while another group is open.
  // The badge is user-level, so every group must be refreshed independently.
  if (userId && Array.isArray(groups) && groups.length) refreshAllUnreadCounts().catch(() => {});
  if (currentGroupId) syncMessages();
}, 5000);

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
    app?.classList.add('group-locked');
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
    refreshAllUnreadCounts().catch(() => {});
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

  const visiblePrivate = privateUsers.filter(u => String(u.userId) !== String(userId));
  if (!visiblePrivate.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-section-label';
    empty.textContent = 'No other users yet';
    chatList.appendChild(empty);
  }

  visiblePrivate.forEach(user => {
    const button = document.createElement('button');
    button.className = 'chat-item' + (activeChatType === 'private' && currentPrivateUser?.userId === user.userId ? ' active' : '');
    button.type = 'button';
    const avatar = document.createElement('div');
    avatar.className = 'avatar group-avatar private-avatar';
    avatar.textContent = firstCharacter(user.name);
    const summary = document.createElement('div');
    summary.className = 'chat-summary';
    const last = privateLastMessages[user.userId];
    const preview = last ? (last.message || (last.type === 'image' ? '📷 Photo' : 'New message')) : 'Tap to chat';
    summary.innerHTML = `<div class="chat-line group-title-line"><strong></strong><span class="group-unread-badge"></span></div><div class="chat-line preview"><span></span><span></span></div>`;
    summary.querySelector('strong').textContent = user.name;
    summary.querySelector('.preview span').textContent = preview;
    const badge = summary.querySelector('.group-unread-badge');
    const unread = Number(privateUnreadCounts[user.userId] || 0);
    if (unread > 0) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.classList.add('show'); }
    button.append(avatar, summary);
    button.addEventListener('click', () => openPrivateChat(user));
    chatList.appendChild(button);
  });
}

async function loadPrivateUsers() {
  if (!userId) return;
  try {
    const r = await fetch(`/api/users?userId=${encodeURIComponent(userId)}`, { cache:'no-store' });
    const d = await r.json().catch(() => ({}));
    if (d.ok) privateUsers = Array.isArray(d.users) ? d.users : [];
    renderGroupList();
  } catch (_) {}
}

function openPrivatePicker() {
  if (!privateChatModal) return;
  privateChatSearch.value = '';
  renderPrivateUserList('');
  privateChatModal.classList.remove('hidden');
  setTimeout(() => privateChatSearch.focus(), 40);
}

function renderPrivateUserList(filter='') {
  if (!privateUserList) return;
  const q = String(filter || '').trim().toLowerCase();
  privateUserList.innerHTML = '';
  const list = privateUsers.filter(u => String(u.userId) !== String(userId) && (!q || String(u.name).toLowerCase().includes(q) || String(u.userId).toLowerCase().includes(q)));
  if (!list.length) {
    privateUserList.innerHTML = '<div class="private-empty">No other users found.</div>';
    return;
  }
  list.forEach(user => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'user-row';
    row.innerHTML = `<div class="avatar group-avatar private-avatar"></div><div><strong></strong></div>`;
    row.querySelector('.avatar').textContent = firstCharacter(user.name);
    row.querySelector('strong').textContent = user.name;
    row.addEventListener('click', () => {
      privateChatModal.classList.add('hidden');
      openPrivateChat(user);
    });
    privateUserList.appendChild(row);
  });
}

function askPrivatePassword(user, mode='verify') {
  return new Promise(resolve => {
    const peerId = String(user?.userId || '');
    if (!peerId) return resolve('');
    window.pendingPrivatePeerId = peerId;
    requestPassword(
      mode === 'setup' ? 'Set your user password' : 'User password required',
      mode === 'setup'
        ? `Set the password for user ${String(user?.name || 'this person')}. Anyone who wants to chat with this user must enter this password.`
        : `Enter the password set by ${String(user?.name || 'this person')}. The chat will not open without it.`,
      () => resolve(String(window.privatePasswordForOpen || '')),
      mode === 'setup' ? 'private-setup' : 'private-verify'
    );
  });
}

async function openPrivateChat(user, providedPassword='') {
  if (!user || !user.userId || String(user.userId) === String(userId)) return;
  const peerId = String(user.userId);
  window.privateChatPasswords = window.privateChatPasswords || {};
  let password = String(providedPassword || '');

  // Every time a personal chat is opened, verify the selected user's own
  // password. It is NOT a shared conversation password.
  if (!password) {
    password = await askPrivatePassword(user, 'verify');
    if (!password) return;
  }

  try {
    const verify = await fetch('/api/private-chat/verify-user', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ userId:peerId, password })
    });
    const verifyData = await verify.json().catch(() => ({}));
    if (!verifyData.ok) { showToast('Wrong user password'); return; }
  } catch (_) { showToast('Could not verify user password'); return; }

  window.privateChatPasswords[peerId] = password;
  activeChatType = 'private';
  currentPrivateUser = user;
  privateUnreadCounts[peerId] = 0;
  composer?.classList.remove('hidden');
  app?.classList.remove('group-locked');
  messages.clear(); deletedIds.clear(); readSent.clear(); lastRenderedDate = ''; lastSyncAt = '';
  if (messageArea) messageArea.innerHTML = '';
  updatePrivateHeader();
  renderGroupList();

  let privateSocketReady = false;
  try {
    if (socket.connected) {
      await new Promise(resolve => socket.emit('join-private', { peerId, password }, result => {
        privateSocketReady = !!result?.ok;
        if (!privateSocketReady && result?.error) showToast(result.error);
        resolve();
      }));
    }
  } catch (_) {}

  if (!privateSocketReady) {
    try {
      const r = await fetch(`/api/private-messages?userId=${encodeURIComponent(userId)}&peerId=${encodeURIComponent(peerId)}&password=${encodeURIComponent(password)}`, {cache:'no-store'});
      const d = await r.json().catch(() => ({}));
      if (d.ok && Array.isArray(d.messages)) d.messages.forEach(m => receivePrivateMessage(m, {history:true}));
    } catch (_) {}
  }
  openChat();
  requestAnimationFrame(() => scrollToBottom());
}


function updatePrivateHeader() {
  if (!currentPrivateUser) return;
  groupName = currentPrivateUser.name;
  groupNameHeader.textContent = currentPrivateUser.name;
  groupAvatarHeader.textContent = firstCharacter(currentPrivateUser.name);
  if (groupNameList) groupNameList.textContent = currentPrivateUser.name;
  onlineStatus.textContent = 'personal chat';
  onlineStatus.className = 'offline';
  document.querySelector('#audioCallBtn')?.classList.add('hidden');
  document.querySelector('#videoCallBtn')?.classList.add('hidden');
}

function updateGroupHeader() {
  updateGroupNameUI();
}


async function openGroup(group) {
  if (!group) return;
  activeChatType = 'group';
  currentPrivateUser = null;

  // Do not ask repeatedly inside the same tab. Once this tab has successfully
  // verified a group's password, switching away and back can reuse that
  // verification. sessionStorage is intentionally used instead of localStorage
  // so closing the tab/browser session forces a fresh password next time.
  const cachedPassword = group.id === 'main' ? '' : getVerifiedGroupPassword(group.id);
  if (group.id === 'main' || cachedPassword) {
    await joinGroup(group.id, true);
    return;
  }

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

  // Prevent double-clicks and remove the feeling that the app is stuck.
  groupPasswordSubmit.disabled = true;
  const oldLabel = groupPasswordSubmit.textContent;
  groupPasswordSubmit.textContent = 'Opening…';
  groupPasswordError.textContent = '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch('/api/groups/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: group.id, password, userId }),
      cache: 'no-store',
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      groupPasswordError.textContent = response.status === 404 ? 'Group not found' : 'Wrong group password';
      groupPasswordInput.select();
      return;
    }

    groupPasswordModal.classList.add('hidden');
    setVerifiedGroupPassword(group.id, password);
    groupPasswordTarget = null;

    // This submit is a real user gesture. Use it to request notification
    // permission and register the device push subscription before opening the
    // group, so a default permission state can never silently skip push setup.
    if ('Notification' in window) {
      const granted = await enableNotifications();
      if (granted && userId) await setupWebPush().catch(() => {});
    }

    // Open the UI immediately. Message history loads in the background so a
    // slow MongoDB/network connection cannot make the password screen spin.
    await joinGroup(group.id, true);
  } catch (error) {
    groupPasswordError.textContent = error?.name === 'AbortError'
      ? 'Server is taking too long. Please try again.'
      : 'Could not verify password';
  } finally {
    clearTimeout(timeout);
    groupPasswordSubmit.disabled = false;
    groupPasswordSubmit.textContent = oldLabel;
  }
}

async function joinGroup(groupId, openAfter=true) {
  activeChatType = 'group';
  currentPrivateUser = null;
  document.querySelector('#audioCallBtn')?.classList.remove('hidden');
  document.querySelector('#videoCallBtn')?.classList.remove('hidden');
  const group = groups.find(g => g.id === groupId) || { id: groupId, name: 'WhatsApp' };
  currentGroupId = groupId || 'main';
  // Optimistically clear while opening, then reconcile against the persisted
  // User-ID readBy state after the history/read receipts arrive.
  setUnreadCount(currentGroupId, 0);
  otherGroupMemberOnline = false;
  setOnlineStatus('offline');
  groupName = group.name || 'WhatsApp';
  app?.classList.remove('group-locked');
  composer?.classList.remove('hidden');
  localStorage.setItem('wa_group_id', currentGroupId);
  localStorage.setItem('wa_group_name', groupName);
  messages.clear(); deletedIds.clear(); readSent.clear(); lastRenderedDate = ''; lastSyncAt = '';
  messageArea.innerHTML = '';
  updateGroupNameUI(); renderGroupList();
  loadLocalMessageHistory();
  await new Promise(resolve => {
    if (!socket.connected) { resolve(); return; }
    socket.emit('join-group', { groupId: currentGroupId, password: currentGroupId === 'main' ? '' : (getVerifiedGroupPassword(currentGroupId) || '') }, () => {
      // Persist notification authorization server-side after the password-protected
      // group join succeeds. This lets the native background service receive only
      // notifications from groups this User ID has actually entered.
      if (userId) {
        fetch('/api/notifications/access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, groupId: currentGroupId })
        }).catch(() => {});
      }
      if (Notification.permission === 'granted') setupWebPush().catch(() => {});
      socket.emit('presence-login', { userId, deviceId }, () => {
        socket.emit('presence-ping', { groupId: currentGroupId });
        resolve();
      });
    });
  });
  // Never block opening the chat on history synchronization.
  // The chat becomes usable immediately; history is reconciled in the background.
  syncMessages().catch(() => {});
  if (openAfter) openChat();
}

loadGroups();

socket.on('user-profile', data => {
  if (!data || String(data.userId || '') !== String(userId || '') || !data.name) return;
  name = String(data.name).trim().slice(0, 40);
  localStorage.setItem('wa_name', name);
  updateMyNameUI();
  renameRenderedMessages(name);
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
socket.on('message-updated', data => { if(!data?.message || (data.groupId && data.groupId!==currentGroupId)) return; const m=data.message; const existing=messages.get(m.id); if(existing){Object.assign(existing,m); updateMessageElement(existing); saveLocalMessageHistory();} });

socket.on('private-message-deleted', data => { if (activeChatType !== 'private' || !data?.id) return; deleteMessage(data.id,false); });
socket.on('private-messages-deleted', data => { if (activeChatType !== 'private' || !Array.isArray(data?.ids)) return; deleteMessages(data.ids,false); });
socket.on('private-chat-cleared', data => { if (activeChatType !== 'private') return; messageArea.innerHTML=''; messages.clear(); lastRenderedDate=''; try{localStorage.removeItem(messageCacheKey());}catch(_){} updatePreview('No messages yet'); });

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
  const online = state === 'online';
  onlineStatus.textContent = online ? 'online' : 'offline';
  onlineStatus.classList.toggle('online', online);
  onlineStatus.classList.toggle('offline', !online);
}

// IMPORTANT: this is NOT the user's own socket connection status.
// It is the presence of at least one OTHER member in the currently selected group.
let otherGroupMemberOnline = false;
let groupLastSeen = {};
let latestLastSeen = null;
let latestLastSeenUserId = null;
function setGroupPresence(online, groupId, lastSeen = {}, latest = null, latestUserId = null) {
  if (String(groupId || '') !== String(currentGroupId || '')) return;
  otherGroupMemberOnline = !!online;
  groupLastSeen = (lastSeen && typeof lastSeen === 'object') ? lastSeen : {};
  latestLastSeen = latest || null;
  latestLastSeenUserId = latestUserId || null;
  setOnlineStatus(otherGroupMemberOnline ? 'online' : 'offline');
}

function formatLastSeen(value) {
  if (!value) return 'Last seen unavailable';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Last seen unavailable';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return `last seen ${sameDay ? d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : d.toLocaleString([], {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}`;
}

// Last Seen interaction:
// Desktop: double-click the offline status.
// Mobile/touch: a single tap is used because many mobile browsers do not
// reliably fire a dblclick event for small header elements.
function showCurrentLastSeen(event) {
  event?.preventDefault?.();
  if (otherGroupMemberOnline) return;
  const entries = Object.entries(groupLastSeen || {}).filter(([, ts]) => ts);
  entries.sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime());
  const ts = latestLastSeen || (entries.length ? entries[0][1] : null);
  if (!ts) {
    showToast('Last seen unavailable');
    return;
  }
  showToast(formatLastSeen(ts));
}
onlineStatus?.addEventListener('dblclick', showCurrentLastSeen);
onlineStatus?.addEventListener('pointerup', (event) => {
  if (event.pointerType === 'touch' || event.pointerType === 'pen') showCurrentLastSeen(event);
});
onlineStatus?.addEventListener('click', (event) => {
  // Fallback for mobile WebViews that report touch as a normal click.
  if (window.matchMedia?.('(max-width: 760px)').matches) showCurrentLastSeen(event);
});

socket.on('group-presence', data => {
  if (!data || String(data.groupId || '') !== String(currentGroupId || '')) return;
  setGroupPresence(!!data.online, data.groupId, data.lastSeen, data.latestLastSeen, data.latestLastSeenUserId);
});

// Last Seen is synchronized in realtime to every active device of the same user.
socket.on('last-seen-updated', data => {
  if (!data || String(data.groupId || '') !== String(currentGroupId || '')) return;
  const uid = String(data.userId || '').trim();
  if (!uid || !data.lastSeenAt) return;
  groupLastSeen = { ...(groupLastSeen || {}), [uid]: data.lastSeenAt };
  const entries = Object.entries(groupLastSeen).filter(([, ts]) => ts);
  entries.sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime());
  latestLastSeenUserId = entries.length ? entries[0][0] : null;
  latestLastSeen = entries.length ? entries[0][1] : null;
  setOnlineStatus(false);
});

socket.on('connect', () => {
  // A reconnect may have happened before a previous read receipt reached the
  // server. Allow visible messages to be sent again so blue ticks cannot get
  // stuck after a temporary network drop.
  readSent.clear();
  // Never show online merely because THIS browser connected.
  otherGroupMemberOnline = false;
  setOnlineStatus('offline');
  socket.emit('register-user', { userId, name, deviceId }, result => {
    if (result?.ok) loadPrivateUsers().catch(() => {});
  });
  setupWebPush().catch(() => {});
  pollWebNotifications().catch(() => {});
  loadPrivateUsers().catch(() => {});
  // Reconcile all group badges immediately on every login/reconnect. Counts are
  // user-level, so the same User ID sees the same seen/unseen state on all devices.
  if (userId) {
    refreshAllUnreadCounts().catch(() => {});
    if ('Notification' in window && Notification.permission === 'granted') setupWebPush().catch(() => {});
  }
  // Do not join/poll an empty group during startup. The group is joined only
  // after its password has been successfully verified.
  if (activeChatType === 'private' && currentPrivateUser?.userId) {
    const privatePeerId = String(currentPrivateUser.userId);
    const privatePassword = String(window.privateChatPasswords?.[privatePeerId] || '');
    if (privatePassword) {
      socket.emit('join-private', { peerId: privatePeerId, password: privatePassword }, result => {
        if (!result?.ok) showToast('Personal chat needs password again');
      });
    }
  }
  if (!currentGroupId) return;
  socket.emit('join-group', {
    groupId: currentGroupId,
    password: currentGroupId === 'main' ? '' : (getVerifiedGroupPassword(currentGroupId) || '')
  }, () => {
    if (userId) {
      fetch('/api/notifications/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, groupId: currentGroupId })
      }).catch(() => {});
    }
    socket.emit('presence-login', { userId, deviceId }, () => {
      socket.emit('presence-ping', { groupId: currentGroupId });
    });
    syncMessages().finally(markVisibleMessagesRead);
  });
});
const presencePingTimer = setInterval(() => {
  if (socket.connected && currentGroupId) socket.emit('presence-ping', { groupId: currentGroupId });
}, 3000);
const pushResyncTimer = setInterval(() => {
  if (userId && 'Notification' in window && Notification.permission === 'granted') setupWebPush().catch(() => {});
}, 30000);

async function rejoinCurrentGroupAfterReconnect() {
  if (!socket.connected || !currentGroupId || !userId) return;
  const groupId = String(currentGroupId);
  const password = groupId === 'main' ? '' : (getVerifiedGroupPassword(groupId) || '');
  socket.emit('join-group', { groupId, password }, (result) => {
    if (!result?.ok) return;
    socket.emit('presence-login', { userId, deviceId }, () => {
      socket.emit('presence-ping', { groupId });
    });
    if ('Notification' in window && Notification.permission === 'granted') setupWebPush().catch(() => {});
  });
}

socket.on('disconnect', () => {
  otherGroupMemberOnline = false;
  setOnlineStatus('offline');
  // Socket.IO will reconnect automatically. Do not clear currentGroupId or
  // notification authorization: both are still valid for this authenticated user.
});
socket.on('reconnect', () => {
  rejoinCurrentGroupAfterReconnect().catch(() => {});
  pollWebNotifications().catch(() => {});
});
socket.on('connect_error', () => {
  otherGroupMemberOnline = false;
  setOnlineStatus('offline');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    markVisibleMessagesRead();
    rejoinCurrentGroupAfterReconnect().catch(() => {});
    if ('Notification' in window && Notification.permission === 'granted') {
      setupWebPush().catch(() => {});
      pollWebNotifications().catch(() => {});
    }
  }
});
window.addEventListener('focus', () => {
  rejoinCurrentGroupAfterReconnect().catch(() => {});
  pollWebNotifications().catch(() => {});
});
window.addEventListener('online', () => {
  rejoinCurrentGroupAfterReconnect().catch(() => {});
  pollWebNotifications().catch(() => {});
  if ('Notification' in window && Notification.permission === 'granted') setupWebPush().catch(() => {});
});
// Do not emit leave-group on pagehide. Mobile browsers fire pagehide during
// bfcache/background transitions; leaving the group there makes a reconnecting
// user appear offline and breaks call/notification delivery. Socket.IO disconnect
// and the server heartbeat are responsible for real disconnects.
messageArea.addEventListener('scroll', markVisibleMessagesRead);
window.addEventListener('focus', markVisibleMessagesRead);

function scrollToBottom(){ messageArea.scrollTop=messageArea.scrollHeight; }
function updatePreview(text){ listPreview.textContent=text; listTime.textContent=now(); }


document.querySelectorAll('.filter').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.filter').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); const mode=btn.textContent.trim().toLowerCase(); document.querySelectorAll('.message').forEach(el=>{const m=messages.get(el.dataset.id);let show=true;if(mode==='favourites') show=starredIds.has(el.dataset.id)||!!m?.starred;if(mode==='groups') show=true;el.style.display=show?'':'none';}); }));
function openChat(push=true){ chatOpen=true; app.classList.add('chat-open'); if(currentGroupId) setUnreadCount(currentGroupId, 0); if(push && window.innerWidth<=760) history.pushState({chat:true}, '', '#chat'); setTimeout(() => { scrollToBottom(); markVisibleMessagesRead(); }, 50); }
function closeChat(){
  chatOpen=false;
  app.classList.remove('chat-open');
  if (activeChatType === 'private') {
    if (socket.connected && currentPrivateUser?.userId) socket.emit('leave-private', {
      conversationId:`private:${[String(userId),String(currentPrivateUser.userId)].sort().join(':')}`
    });
    currentPrivateUser = null;
    activeChatType = 'group';
    renderGroupList();
  } else if (currentGroupId) {
    const leavingGroupId = currentGroupId;
    if (socket.connected) socket.emit('leave-group', { groupId: leavingGroupId });
    currentGroupId = '';
    localStorage.removeItem('wa_group_id');
    otherGroupMemberOnline = false;
    setOnlineStatus('offline');
    renderGroupList();
  }
  if(window.innerWidth<=760 && location.hash==='#chat') history.back();
}
document.querySelector('#backBtn').addEventListener('click', closeChat);
window.addEventListener('popstate', () => {
  chatOpen=false;
  app.classList.remove('chat-open');
  if (activeChatType === 'private') {
    if (socket.connected && currentPrivateUser?.userId) socket.emit('leave-private', {
      conversationId:`private:${[String(userId),String(currentPrivateUser.userId)].sort().join(':')}`
    });
    currentPrivateUser = null;
    activeChatType = 'group';
    renderGroupList();
  } else if (currentGroupId) {
    const leavingGroupId = currentGroupId;
    if (socket.connected) socket.emit('leave-group', { groupId: leavingGroupId });
    currentGroupId = '';
    localStorage.removeItem('wa_group_id');
    otherGroupMemberOnline = false;
    setOnlineStatus('offline');
    renderGroupList();
  }
});
document.querySelector('#newChatBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // The + button opens the general personal-chat user directory.
  // New accounts are created only during first-time onboarding.
  appMenu?.classList.add('hidden');
  openPrivatePicker();
});
newChatChoiceClose?.addEventListener('click', () => newChatChoiceModal?.classList.add('hidden'));
newChatChoiceModal?.addEventListener('click', e => { if (e.target === newChatChoiceModal) newChatChoiceModal.classList.add('hidden'); });
newPrivateChatChoice?.addEventListener('click', () => {
  newChatChoiceModal?.classList.add('hidden');
  openPrivatePicker();
});
joinPrivateChatChoice?.addEventListener('click', () => {
  newChatChoiceModal?.classList.add('hidden');
  openPrivatePicker();
});
newGroupChoice?.addEventListener('click', () => {
  newChatChoiceModal?.classList.add('hidden');
  showToast('Personal chat only');
});

function openPrivateUserJoinModal() {
  if (!privateUserJoinModal) return;
  privateUserJoinName.value = '';
  privateUserJoinPassword.value = '';
  privateUserJoinError.textContent = '';
  privateUserJoinModal.classList.remove('hidden');
  setTimeout(() => privateUserJoinName.focus(), 50);
}
function closePrivateUserJoinModal() {
  privateUserJoinModal?.classList.add('hidden');
  if (privateUserJoinError) privateUserJoinError.textContent = '';
}
async function joinPrivateUserAndOpen() {
  const joinId = normalizeUserId(privateUserJoinName?.value || '');
  const password = String(privateUserJoinPassword?.value || '');
  if (!joinId) { privateUserJoinError.textContent = 'Enter the user ID'; privateUserJoinName.focus(); return; }
  if (!password) { privateUserJoinError.textContent = 'Enter that user\'s password'; privateUserJoinPassword.focus(); return; }
  privateUserJoinSave.disabled = true;
  privateUserJoinError.textContent = '';
  try {
    const r = await fetch('/api/private-chat/join', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ userId:joinId, password }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok || !d.user) throw new Error(d.error || 'Could not verify user');
    closePrivateUserJoinModal();
    privateUsers = [d.user, ...privateUsers.filter(u => String(u.userId) !== String(d.user.userId))];
    await openPrivateChat(d.user, password);
    await loadPrivateUsers();
    showToast(`Chat unlocked for ${d.user.name}`);
  } catch (e) {
    privateUserJoinError.textContent = e?.message || 'Could not verify user';
  } finally { privateUserJoinSave.disabled = false; }
}
privateUserJoinSave?.addEventListener('click', joinPrivateUserAndOpen);
privateUserJoinPassword?.addEventListener('keydown', e => { if (e.key === 'Enter') joinPrivateUserAndOpen(); });
privateUserJoinClose?.addEventListener('click', closePrivateUserJoinModal);
privateUserJoinModal?.addEventListener('click', e => { if (e.target === privateUserJoinModal) closePrivateUserJoinModal(); });

function openPrivateUserCreateModal() {
  if (!privateUserCreateModal) return;
  privateUserCreateName.value = '';
  privateUserCreatePassword.value = '';
  privateUserCreateError.textContent = '';
  privateUserCreateModal.classList.remove('hidden');
  setTimeout(() => privateUserCreateName.focus(), 50);
}
function closePrivateUserCreateModal() {
  privateUserCreateModal?.classList.add('hidden');
  if (privateUserCreateError) privateUserCreateError.textContent = '';
}
async function createPrivateUserAndOpen() {
  const newName = String(privateUserCreateName?.value || '').trim().slice(0,60);
  const password = String(privateUserCreatePassword?.value || '');
  if (!newName) { privateUserCreateError.textContent = 'Enter a name'; privateUserCreateName.focus(); return; }
  if (password.length < 4 || password.length > 100) { privateUserCreateError.textContent = 'Password must be 4-100 characters'; privateUserCreatePassword.focus(); return; }
  privateUserCreateSave.disabled = true;
  privateUserCreateError.textContent = '';
  try {
    const adminMode = !!adminUnlocked;
    const endpoint = adminMode ? '/api/admin/private-user/create' : '/api/private-chat/create-user';
    const body = adminMode
      ? { password:PASSWORD, name:newName, chatPassword:password }
      : { creatorId:userId, name:newName, password };
    const r = await fetch(endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok || !d.user) throw new Error(d.error || 'Could not create user');
    const created = { userId:String(d.user.userId), name:String(d.user.name || newName) };
    privateUsers = [created, ...privateUsers.filter(u => String(u.userId) !== created.userId)];
    closePrivateUserCreateModal();
    if (adminMode) {
      // Admin-created users are credentials for the other person to use.
      alert(`User added successfully!\n\nName: ${created.name}\nLogin ID: ${created.userId}\nPassword: ${password}\n\nGive this Login ID + Password to the other person.`);
      await loadAdminAllUsers();
    } else {
      // Any normal user can create a new private-chat account from the + button.
      // The creator keeps their current identity; the new user's credentials are
      // shown immediately so they can be shared with the other person.
      alert(`New user created successfully!\n\nName: ${created.name}\nLogin ID: ${created.userId}\nPassword: ${password}\n\nShare these credentials with the person who should use this account.`);
      await openPrivateChat(created, password);
      showToast(`User created: ${created.name}`);
    }
  } catch (e) {
    privateUserCreateError.textContent = e?.message || 'Could not create user';
  } finally { privateUserCreateSave.disabled = false; }
}
privateUserCreateSave?.addEventListener('click', createPrivateUserAndOpen);
privateUserCreatePassword?.addEventListener('keydown', e => { if (e.key === 'Enter') createPrivateUserAndOpen(); });
privateUserCreateClose?.addEventListener('click', closePrivateUserCreateModal);
privateUserCreateModal?.addEventListener('click', e => { if (e.target === privateUserCreateModal) closePrivateUserCreateModal(); });
newGroupChoice?.addEventListener('click', () => {
  newChatChoiceModal?.classList.add('hidden');
  requestAdminThen(() => openGroupEditor());
});
privateChatClose?.addEventListener('click', () => privateChatModal?.classList.add('hidden'));
privateChatModal?.addEventListener('click', e => { if (e.target === privateChatModal) privateChatModal.classList.add('hidden'); });
privateChatSearch?.addEventListener('input', () => renderPrivateUserList(privateChatSearch.value));
newGroupBtn?.addEventListener('click', () => requestAdminThen(() => openGroupEditor()));
document.querySelector('#statusBtn').addEventListener('click', () => showToast('Status')); 
async function requestAdminThen(action) {
  requestPassword('Admin password', 'Enter the admin password to manage groups and passwords.', async () => {
    try { await action(); } catch (_) { showToast('Admin action failed'); }
  });
}



const safeText=(v,n=80)=>String(v??'').slice(0,n);

let adminGroupMediaType = 'image';

function closeAdminGroupMedia(){
  adminGroupMediaModal?.classList.add('hidden');
}
adminGroupMediaClose?.addEventListener('click', closeAdminGroupMedia);
adminGroupMediaModal?.addEventListener('click', e => { if(e.target === adminGroupMediaModal) closeAdminGroupMedia(); });

async function loadAdminGroupMedia(type = adminGroupMediaType, groupId = ''){
  if(!adminUnlocked) return;
  adminGroupMediaType = type;
  const isPhoto = type === 'image';
  adminGroupMediaTitle.textContent = isPhoto ? '📷 Group Photos' : '🎥 Group Videos';
  adminGroupMediaHelp.textContent = isPhoto
    ? 'All photos received in groups, arranged inside each group folder.'
    : 'All videos received in groups, arranged inside each group folder.';
  adminGroupMediaError.textContent = '';
  adminGroupMediaList.innerHTML = '<div class="admin-group-row">Loading media folders…</div>';
  try{
    const r = await fetch('/api/admin/group-media', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:PASSWORD, type, groupId})
    });
    const data = await r.json();
    if(!data.ok) throw new Error(data.error || 'Unauthorized');
    const list = Array.isArray(data.media) ? data.media : [];
    if(!list.length){
      adminGroupMediaList.innerHTML = `<div class="admin-group-row">No ${isPhoto?'photos':'videos'} found.</div>`;
      return;
    }

    const byGroup = new Map();
    list.forEach(item => {
      const key = item.groupId || 'main';
      if(!byGroup.has(key)) byGroup.set(key, {name:item.groupName || key, items:[]});
      byGroup.get(key).items.push(item);
    });

    adminGroupMediaList.innerHTML = '';
    byGroup.forEach(group => {
      const section = document.createElement('section');
      section.className = 'admin-media-folder-section';

      const head = document.createElement('div');
      head.className = 'admin-media-folder-head';
      const count = group.items.length;
      head.innerHTML = `<strong>📁 ${safeText(group.name)}</strong><small>${count} ${isPhoto?'photo':'video'}${count===1?'':'s'}</small>`;
      section.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'admin-media-folder-grid';

      group.items.forEach(item => {
        const card = document.createElement('article');
        card.className = 'admin-media-folder-card-item';
        const url = `/api/media/${encodeURIComponent(item.mediaId)}`;
        const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : item.time || '';
        const size = item.fileSize ? `${Math.max(.1,item.fileSize/1024/1024).toFixed(1)} MB` : '';
        const thumb = isPhoto
          ? `<img class="admin-media-folder-thumb" src="${url}" alt="Photo" loading="lazy">`
          : `<video class="admin-media-folder-thumb" src="${url}" muted playsinline preload="metadata"></video>`;

        card.innerHTML = `${thumb}
          <div class="admin-media-folder-info">
            <b>${safeText(item.user || 'User')}</b>
            <small>${safeText(when)}${size ? ` • ${safeText(size)}` : ''}</small>
          </div>
          <div class="admin-media-folder-actions">
            <button class="mini-btn view-folder-media">▶ View</button>
            <a class="mini-btn" href="${url}" target="_blank" rel="noopener" download="${safeText(item.fileName || (isPhoto?'photo':'video'))}">⬇ Save</a>
            <button class="mini-btn admin-delete-btn delete-folder-media">🗑 Delete</button>
          </div>`;
        const mediaEl = card.querySelector('img,video');
        card.querySelector('.view-folder-media').onclick = () => {
          if(mediaEl?.requestFullscreen) mediaEl.requestFullscreen().catch(()=>{});
          else window.open(url,'_blank','noopener');
        };
        card.querySelector('.delete-folder-media').onclick = () => {
          requestPassword('Delete media', 'Enter admin password to permanently delete this photo/video.', async () => {
            try {
              const r = await fetch('/api/admin/group-media/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:PASSWORD, mediaId:item.mediaId, messageId:item.id})});
              const data = await r.json();
              if(!r.ok || !data.ok) throw new Error(data.error || 'Delete failed');
              card.remove();
              showToast('Media deleted');
            } catch (e) { showToast(e.message || 'Delete failed'); }
          }, 'delete');
        };
        grid.appendChild(card);
      });
      section.appendChild(grid);
      adminGroupMediaList.appendChild(section);
    });
  }catch(error){
    adminGroupMediaError.textContent = error.message || 'Could not load media.';
    adminGroupMediaList.innerHTML = '';
  }
}

function openAdminGroupMedia(type){
  if(!adminUnlocked) return requestAdminThen(() => openAdminGroupMedia(type));
  adminGroupMediaModal?.classList.remove('hidden');
  loadAdminGroupMedia(type);
}
adminPhotosBtn?.addEventListener('click', () => openAdminGroupMedia('image'));
adminVideosBtn?.addEventListener('click', () => openAdminGroupMedia('video'));
adminPrivateChatsBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); requestAdminThen(openAdminPrivateChats); });
adminDeleteUserBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); requestAdminThen(openAdminDeleteUser); });
adminPrivateChatsClose?.addEventListener('click', () => adminPrivateChatsModal?.classList.add('hidden'));
adminAllUsersClose?.addEventListener('click', () => adminAllUsersModal?.classList.add('hidden'));
adminAllUsersModal?.addEventListener('click', e => { if(e.target===adminAllUsersModal) adminAllUsersModal.classList.add('hidden'); });
adminAllUsersRefresh?.addEventListener('click', loadAdminAllUsers);
adminChangeUserPasswordClose?.addEventListener('click', closeAdminChangeUserPassword);
adminChangeUserPasswordSave?.addEventListener('click', saveAdminChangeUserPassword);
adminChangeUserPasswordInput?.addEventListener('keydown', e => { if(e.key==='Enter') saveAdminChangeUserPassword(); });
adminChangeUserPasswordModal?.addEventListener('click', e => { if(e.target===adminChangeUserPasswordModal) closeAdminChangeUserPassword(); });
adminAllUsersAddUser?.addEventListener('click', () => { if (!adminUnlocked) return requestAdminThen(openPrivateUserCreateModal); openPrivateUserCreateModal(); });
adminAllUsersBack?.addEventListener('click', () => {
  adminAllUsersModal?.classList.add('hidden');
  if (adminUnlocked) { adminGroupsModal?.classList.remove('hidden'); loadAdminGroups?.(); }
});
adminAllUsersSelectAll?.addEventListener('change', () => {
  adminAllUsersList?.querySelectorAll('.admin-user-select').forEach(cb => { cb.checked = adminAllUsersSelectAll.checked; });
});
adminAllUsersDeleteSelected?.addEventListener('click', async () => {
  if (!adminUnlocked) return requestAdminThen(() => adminAllUsersDeleteSelected?.click());
  const selected = [...(adminAllUsersList?.querySelectorAll('.admin-user-select:checked') || [])].map(cb => String(cb.dataset.userId || '')).filter(Boolean);
  if (!selected.length) { showToast('Select at least one user'); return; }
  if (!confirm(`Delete ${selected.length} selected user(s)? Their account and personal chat data will be deleted. Deleted messages remain in the Main Recycle Bin.`)) return;
  adminAllUsersDeleteSelected.disabled = true;
  try {
    const results = await Promise.all(selected.map(userId => fetch('/api/admin/users/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:PASSWORD,userId})}).then(async r => ({ok:r.ok, data:await r.json()}))));
    const failed = results.filter(x => !x.ok || !x.data?.ok);
    const done = results.length - failed.length;
    showToast(`${done} user(s) deleted${failed.length ? `, ${failed.length} failed` : ''}`);
    if (adminAllUsersSelectAll) adminAllUsersSelectAll.checked = false;
    await loadAdminAllUsers();
    await loadPrivateUsers();
  } catch (e) { showToast(e.message || 'Delete selected failed'); }
  finally { adminAllUsersDeleteSelected.disabled = false; }
});
adminPrivateChatsModal?.addEventListener('click', e => { if (e.target === adminPrivateChatsModal) adminPrivateChatsModal.classList.add('hidden'); });
adminPrivateChatsRefresh?.addEventListener('click', () => loadAdminPrivateChats());

async function adminDeleteAllUsers() {
  if (!adminUnlocked) return requestAdminThen(adminDeleteAllUsers);
  const ok = confirm('Delete ALL user accounts permanently? This will delete every account and personal chat data. Main Recycle Bin data will NOT be deleted. This cannot be undone.');
  if (!ok) return;
  try {
    const r = await fetch('/api/admin/delete-all-users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:PASSWORD}) });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'Delete all users failed');
    showToast(`${Number(d.deletedUsers||0)} user account(s) deleted`);
    loadAdminPrivateChats();
  } catch (e) { showToast(e.message || 'Delete all users failed'); }
}

async function adminDeleteAllGroups() {
  if (!adminUnlocked) return requestAdminThen(adminDeleteAllGroups);
  const ok = confirm('Delete ALL groups permanently? Live group messages will be preserved in Main Recycle Bin; existing Recycle Bin data will NOT be deleted. This cannot be undone.');
  if (!ok) return;
  try {
    const r = await fetch('/api/admin/delete-all-groups', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:PASSWORD}) });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'Delete all groups failed');
    groups = [];
    currentGroupId = '';
    groupName = '';
    localStorage.removeItem('wa_group_id');
    localStorage.removeItem('wa_group_name');
    renderGroupList?.();
    showToast(`${Number(d.deletedGroups||0)} group(s) deleted`);
    openAdminGroups();
  } catch (e) { showToast(e.message || 'Delete all groups failed'); }
}


adminDeleteAllUsersBtn?.addEventListener('click', adminDeleteAllUsers);
adminDeleteAllGroupsBtn?.addEventListener('click', adminDeleteAllGroups);
adminGroupMediaRefresh?.addEventListener('click', () => loadAdminGroupMedia(adminGroupMediaType));

async function loadAdminCallRecordings(groupId = '') {
  const clean = (v,n=80) => String(v ?? '').replace(/[<>]/g,'').slice(0,n);
  const formatDuration = ms => {
    const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };
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
      const section = document.createElement('section');
      section.className = 'recording-group-section';
      const head = document.createElement('div');
      head.className = 'recording-group-head';
      head.innerHTML = `<div><div class="admin-group-name">📁 ${clean(g.name,60)}</div><small>${g.items.length} recording${g.items.length===1?'':'s'}</small></div>`;
      section.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'recording-video-grid';

      g.items.forEach(item => {
        const card = document.createElement('article');
        card.className = 'recording-video-card';
        const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
        const size = item.size ? `${Math.max(1,item.size/1024/1024).toFixed(1)} MB` : '';
        const duration = formatDuration(item.durationMs);
        const url = `/api/admin/call-recordings/${encodeURIComponent(item.fileId)}?password=${encodeURIComponent(PASSWORD)}`;
        const safeName = clean(item.feedName || 'Participant', 60);

        card.innerHTML = `
          <div class="recording-thumb-wrap">
            <video class="recording-thumb" muted playsinline preload="metadata"></video>
            <button type="button" class="recording-play-overlay" aria-label="View recording">▶</button>
            ${duration !== '00:00' ? `<span class="recording-duration">${duration}</span>` : ''}
          </div>
          <div class="recording-video-info">
            <div class="recording-video-title">🎥 ${safeName}</div>
            <div class="recording-video-meta">${clean(when,80)}${size ? ` · ${size}` : ''}</div>
            <div class="recording-video-actions">
              <button type="button" class="mini-btn admin-view-recording-btn">▶ View</button>
              <a class="mini-btn" href="${url}" download>⬇ Download</a>
              <button type="button" class="mini-btn admin-delete-btn">Delete</button>
            </div>
          </div>`;

        const thumb = card.querySelector('.recording-thumb');
        thumb.src = url;
        thumb.addEventListener('loadedmetadata', () => {
          try { thumb.currentTime = 0.01; } catch (_) {}
        }, { once:true });
        thumb.addEventListener('click', () => card.querySelector('.recording-play-overlay').click());

        const openView = () => requestPassword('Admin password','Enter the admin password to view this call recording.',()=>{ adminCallRecordingsModal.classList.add('hidden'); showAdminMediaPopup(url,safeName,when); });
        card.querySelector('.recording-play-overlay').addEventListener('click', openView);
        card.querySelector('.admin-view-recording-btn').addEventListener('click', openView);
        card.querySelector('.admin-delete-btn').addEventListener('click', async()=>{
          if(!confirm('Delete this call recording?')) return;
          const rr=await fetch(`/api/admin/call-recordings/${encodeURIComponent(item.fileId)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD})});
          const dd=await rr.json(); if(dd.ok) loadAdminCallRecordings(groupId); else showToast(dd.error||'Delete failed');
        });
        grid.appendChild(card);
      });
      section.appendChild(grid);
      adminCallRecordingsList.appendChild(section);
    });
  } catch(e) { adminCallRecordingsList.innerHTML=''; adminCallRecordingsError.textContent=e.message||'Could not load recordings'; }
}
function showAdminMediaPopup(url,title,meta=''){
  adminCallRecordingsModal?.classList.add('hidden');
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
  const wasOpen = !adminMediaViewModal.classList.contains('hidden');
  adminMediaViewBody.innerHTML='';
  adminMediaViewModal.classList.add('hidden');
  if (wasOpen) adminCallRecordingsModal?.classList.remove('hidden');
}

function openAdminCallRecordings() { adminCallRecordingsModal.classList.remove('hidden'); loadAdminCallRecordings(); }
async function loadAdminAllUsers(){
  if(!adminAllUsersList) return;
  adminAllUsersError.textContent='';
  if (adminAllUsersSelectAll) adminAllUsersSelectAll.checked = false;
  adminAllUsersList.innerHTML='<div class="admin-group-row">Loading all users…</div>';
  try{
    const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD})});
    const d=await r.json();
    if(!r.ok || !d.ok) throw new Error(d.error||'Unauthorized');
    const users=Array.isArray(d.users)?d.users:[];
    adminAllUsersList.innerHTML='';
    if(!users.length){ adminAllUsersList.innerHTML='<div class="admin-group-row">No users found.</div>'; return; }
    const heading=document.createElement('div'); heading.className='admin-group-row'; heading.textContent=`👥 All registered users (${users.length})`; adminAllUsersList.appendChild(heading);
    users.forEach(user=>{
      const row=document.createElement('div'); row.className='admin-private-chat-row admin-user-row';
      const created=user.createdAt?new Date(user.createdAt).toLocaleString():'';
      const kind='User';
      row.innerHTML='<label class="admin-user-check"><input type="checkbox" class="admin-user-select"><span class="admin-private-chat-info"><span class="admin-private-chat-users"></span><span class="admin-private-chat-meta"></span></span></label><div class="admin-user-row-actions"><button type="button" class="mini-btn admin-password-btn single-user-password">🔑 Change Password</button><button type="button" class="mini-btn admin-delete-btn single-user-delete">🗑 Delete User</button></div>';
      const cb=row.querySelector('.admin-user-select'); cb.dataset.userId=String(user.userId||'');
      row.querySelector('.admin-private-chat-users').textContent=String(user.name||'User');
      row.querySelector('.admin-private-chat-meta').textContent=`${kind}${created?' • Created '+created:''} • Login ID: ${String(user.userId||'-')} • Password: ${String(user.shareablePassword||'-')}`;
      row.querySelector('.single-user-password')?.addEventListener('click',()=>{
        openAdminChangeUserPassword(user.userId,user.name);
      });
      row.querySelector('.single-user-delete').addEventListener('click', async()=>{
        if (!confirm(`Delete ${String(user.name||'User')}? Their account and personal chat data will be deleted. Deleted messages remain in the Main Recycle Bin.`)) return;
        try{
          const rr=await fetch('/api/admin/users/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,userId:user.userId})});
          const dd=await rr.json(); if(!rr.ok||!dd.ok) throw new Error(dd.error||'Delete failed');
          showToast(`${String(user.name||'User')} deleted`); await loadAdminAllUsers(); await loadPrivateUsers();
        }catch(e){showToast(e.message||'Delete failed');}
      });
      adminAllUsersList.appendChild(row);
    });
  }catch(e){adminAllUsersList.innerHTML='';adminAllUsersError.textContent=e.message||'Could not load users.';}
}

function openAdminAllUsers(){
  if(!adminUnlocked) return requestAdminThen(openAdminAllUsers);
  appMenu?.classList.add('hidden');
  adminGroupsModal?.classList.add('hidden');
  adminPrivateChatsModal?.classList.add('hidden');
  adminAllUsersModal?.classList.remove('hidden');
  loadAdminAllUsers();
}

function openAdminDeleteUser() {
  adminGroupsModal?.classList.add('hidden');
  adminPrivateChatsModal?.classList.remove('hidden');
  const title = adminPrivateChatsModal?.querySelector('h3');
  if (title) title.textContent = '🗑 Delete User';
  loadAdminPrivateChats(true);
}

function openAdminPrivateChats() {
  adminGroupsModal?.classList.add('hidden');
  adminPrivateChatsModal?.classList.remove('hidden');
  const title = adminPrivateChatsModal?.querySelector('h3');
  if (title) title.textContent = 'Personal Chats';
  loadAdminPrivateChats(false);
}

async function loadAdminPrivateChats(deleteMode = false) {
  if (!adminPrivateChatsList) return;
  adminPrivateChatsError.textContent = '';
  adminPrivateChatsList.innerHTML = '<div class="admin-group-row">Loading users…</div>';
  try {
    let privatePasswordSettings = [];
    if (adminPrivatePassword) {
      const pr = await fetch('/api/admin/private-password', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:PASSWORD})});
      const pd = await pr.json().catch(() => ({}));
      privatePasswordSettings = Array.isArray(pd.passwords) ? pd.passwords : [];
      adminPrivatePassword.textContent = privatePasswordSettings.length
        ? privatePasswordSettings.map(x => `${x.userAName || x.userA} ↔ ${x.userBName || x.userB}: ${x.password}`).join('  •  ')
        : 'No personal chat passwords set';
    }
    const r = await fetch('/api/admin/private-chats', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:PASSWORD})
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'Unauthorized');
    const users = Array.isArray(d.users) ? d.users : [];
    const chats = Array.isArray(d.chats) ? d.chats : privatePasswordSettings;
    if (!users.length && !chats.length) {
      adminPrivateChatsList.innerHTML = '<div class="admin-group-row">No users found.</div>';
      return;
    }
    adminPrivateChatsList.innerHTML = '';
    if (chats.length && !deleteMode) {
      const heading = document.createElement('div');
      heading.className = 'admin-group-row';
      heading.textContent = `🔐 Private chat passwords (${chats.length})`;
      adminPrivateChatsList.appendChild(heading);
      chats.forEach(chat => {
        const row = document.createElement('div');
        row.className = 'admin-private-chat-row';
        row.innerHTML = '<div class="admin-private-chat-info"><div class="admin-private-chat-users"></div><div class="admin-private-chat-meta"></div><div class="admin-private-chat-password"></div></div><button type="button" class="mini-btn admin-delete-btn">🗑 Delete Chat</button>';
        row.querySelector('.admin-private-chat-users').textContent = `${chat.userAName || chat.userA || 'User'} ↔ ${chat.userBName || chat.userB || 'User'}`;
        row.querySelector('.admin-private-chat-meta').textContent = chat.createdAt ? `Created ${new Date(chat.createdAt).toLocaleString()}` : 'Private chat';
        row.querySelector('.admin-private-chat-password').textContent = `🔑 ${String(chat.password || '')}`;
        row.querySelector('.admin-delete-btn').addEventListener('click', () => {
          requestPassword('Delete personal chat', `Delete this personal chat and move its messages/photos/videos/audio to the Main Recycle Bin? The users will NOT be deleted. Only Admin can permanently delete those recycle-bin items.`, async () => {
            try {
              const rr = await fetch('/api/admin/private-chats/delete', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({password:PASSWORD, conversationId:chat.conversationId})
              });
              const dd = await rr.json().catch(() => ({}));
              if (!rr.ok || !dd.ok) throw new Error(dd.error || 'Delete failed');
              await loadAdminPrivateChats();
              showToast('Private chat deleted');
            } catch (e) { showToast(e.message || 'Delete failed'); }
          }, 'admin');
        });
        adminPrivateChatsList.appendChild(row);
      });
    }
    if (users.length) {
      const heading = document.createElement('div');
      heading.className = 'admin-group-row';
      heading.textContent = deleteMode ? '🗑 Select a user to delete' : '👤 Users';
      adminPrivateChatsList.appendChild(heading);
    }
    users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'admin-private-chat-row';
      const when = user.lastActivity ? new Date(user.lastActivity).toLocaleString() : '';
      row.innerHTML = `<div class="admin-private-chat-info"><div class="admin-private-chat-users"></div><div class="admin-private-chat-meta"></div><div class="admin-private-chat-password"></div></div><button type="button" class="mini-btn admin-delete-btn">🗑 Delete Account</button>`;
      row.querySelector('.admin-private-chat-users').textContent = String(user.name || user.userId || 'User');
      row.querySelector('.admin-private-chat-meta').textContent = `${Number(user.privateChatCount || 0)} private message(s)${when ? ` • Last activity ${when}` : ''}`;
      const passwordsForUser = privatePasswordSettings.filter(x => String(x.userA) === String(user.userId) || String(x.userB) === String(user.userId));
      row.querySelector('.admin-private-chat-password').textContent = passwordsForUser.length ? passwordsForUser.map(x => `🔑 ${x.password}`).join('  •  ') : '🔑 No password set';
      row.querySelector('.admin-delete-btn').addEventListener('click', () => {
        requestPassword('Delete user permanently', `Delete ${String(user.name || user.userId || 'this user')} account and move their private photos/videos/audio/messages to the Main Recycle Bin? Enter the Admin password. Only Admin can permanently delete recycle-bin items.`, async () => {
          try {
            const rr = await fetch('/api/admin/users/delete', {
              method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:PASSWORD, userId:user.userId})
            });
            const dd = await rr.json();
            if (!rr.ok || !dd.ok) throw new Error(dd.error || 'Delete failed');
            // Re-fetch the active list/passwords so deleted users and their
            // password records disappear immediately without a browser refresh.
            await loadPrivateUsers();
            await loadAdminPrivateChats();
            showToast(`${String(user.name || 'User')} account deleted`);
          } catch (e) { showToast(e.message || 'Delete failed'); }
        }, 'delete');
      });
      adminPrivateChatsList.appendChild(row);
    });
  } catch (e) {
    adminPrivateChatsList.innerHTML = '';
    adminPrivateChatsError.textContent = e.message || 'Could not load users.';
  }
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


let adminRecycleFilterGroup = 'all';

async function renderAdminRecycleGroupFilters(items) {
  const box = document.querySelector('#adminRecycleGroupFilters');
  if (!box) return;
  box.innerHTML = '';
  if (adminRecycleGroupId !== 'main') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  // Main Recycle must show EVERY admin group, not only groups that currently
  // have deleted messages. Deleted-message counts are calculated separately.
  const groupsMap = new Map();
  try {
    const r = await fetch('/api/admin/groups', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:PASSWORD}), cache:'no-store'
    });
    const d = await r.json();
    if (d.ok && Array.isArray(d.groups)) {
      d.groups.forEach(g => groupsMap.set(String(g.id), String(g.name || g.id)));
    }
  } catch (_) {}

  // Also retain groups represented by legacy/deleted records.
  items.forEach(item => {
    const id = String(item.deletedGroupId || item.message?.groupId || 'main');
    const name = String(item.deletedGroupName || item.message?.groupName || id);
    if (!groupsMap.has(id)) groupsMap.set(id, name);
  });

  const countFor = id => items.filter(x => String(x.deletedGroupId || x.message?.groupId || 'main') === id).length;
  const make = (id, label, count, openChat=false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini-btn recycle-filter-btn' + (adminRecycleFilterGroup === id ? ' active' : '');
    b.textContent = `${label}${count ? ` (${count})` : ''}`;
    b.title = count ? `View ${count} deleted item${count === 1 ? '' : 's'} from ${label}` : `No deleted messages in ${label}`;
    b.onclick = () => {
      adminRecycleFilterGroup = id;
      if (openChat) {
        const groupItems = items.filter(x => recycleItemGroupId(x) === id);
        openRecycleChatView(groupItems, label);
      } else {
        loadAdminRecycle();
      }
    };
    box.appendChild(b);
  };

  make('all', 'All groups', items.length, false);
  [...groupsMap.entries()]
    .sort((a,b)=>a[1].localeCompare(b[1]))
    .forEach(([id,name]) => make(id, name, countFor(id), true));
}


function recycleItemGroupId(item){ return item?.recycleType === 'private' ? `private:${String(item?.privateConversationId || item?.message?.conversationId || 'unknown')}` : String(item?.deletedGroupId || item?.message?.groupId || 'main'); }
function recycleItemGroupName(item){ return item?.recycleType === 'private' ? `Personal Chat • ${String(item?.privateConversationId || item?.message?.conversationId || 'Private')}` : String(item?.deletedGroupName || item?.message?.groupName || recycleItemGroupId(item)); }

function openRecycleChatView(items, groupName, targetId='') {
  const view = document.querySelector('#adminRecycleChatView');
  const list = document.querySelector('#adminRecycleList');
  if (!view || !list) return;
  view.classList.remove('hidden');
  list.classList.add('hidden');
  view.innerHTML='';

  const head=document.createElement('div'); head.className='recycle-chat-head';
  const title=document.createElement('div'); title.className='recycle-chat-title'; title.textContent=`♻️ ${groupName} — Deleted messages`;
  const back=document.createElement('button'); back.className='mini-btn'; back.textContent='← Back';
  back.onclick=()=>{ view.classList.add('hidden'); list.classList.remove('hidden'); };
  head.append(title,back); view.appendChild(head);

  const body=document.createElement('div'); body.className='recycle-chat-body'; view.appendChild(body);
  const ordered=[...items].sort((a,b)=>new Date(a.deletedAt||a.message?.createdAt||0)-new Date(b.deletedAt||b.message?.createdAt||0));
  if(!ordered.length){ body.innerHTML='<div class="recycle-chat-empty">No deleted messages in this group.</div>'; return; }
  let lastDay='';
  ordered.forEach(item=>{
    const m=item.message||{};
    const dt=new Date(item.deletedAt||m.createdAt||0);
    const day=Number.isNaN(dt.getTime())?'':dt.toLocaleDateString();
    if(day && day!==lastDay){ const sep=document.createElement('div'); sep.className='recycle-chat-date'; sep.textContent=day; body.appendChild(sep); lastDay=day; }
    const bubble=document.createElement('div');
    bubble.className='recycle-chat-bubble' + (m.userId===userId ? ' mine' : '');
    bubble.dataset.itemId=String(item.id||'');
    const sender=document.createElement('div'); sender.className='recycle-chat-sender'; sender.textContent=String(m.user||m.senderName||'Unknown user'); bubble.appendChild(sender);
    const type=String(m.type||'text').toLowerCase();
    if(type==='image'||type==='video'||type==='audio'){
      const wrap=document.createElement('div'); wrap.className='recycle-chat-media';
      const url=m.mediaId?`/api/media/${encodeURIComponent(m.mediaId)}`:m.data;
      if(type==='image'){ const el=document.createElement('img'); el.src=url||''; el.alt='Deleted photo'; el.loading='lazy'; wrap.appendChild(el); }
      else if(type==='video'){ const el=document.createElement('video'); el.controls=true; el.preload='metadata'; const src=document.createElement('source'); src.src=url||''; src.type=m.mime||'video/mp4'; el.appendChild(src); wrap.appendChild(el); }
      else { const el=document.createElement('audio'); el.controls=true; el.preload='metadata'; el.src=url||''; wrap.appendChild(el); }
      bubble.appendChild(wrap);
    } else if(type==='document'){
      const doc=document.createElement('div'); doc.className='recycle-chat-doc'; doc.textContent=`📄 ${m.fileName||'Document'}`; bubble.appendChild(doc);
    } else {
      const text=document.createElement('div'); text.className='recycle-chat-text'; text.textContent=m.message||'Deleted message'; bubble.appendChild(text);
    }
    const deleted=document.createElement('div'); deleted.className='recycle-chat-deleted'; deleted.textContent='Deleted • kept in Recycle Bin'; bubble.appendChild(deleted);
    const actions=document.createElement('div'); actions.className='recycle-chat-actions';
    if(m.mediaId){
      const dl=document.createElement('button'); dl.className='mini-btn'; dl.textContent='⬇ Download';
      dl.onclick=async()=>{ try{ const r=await fetch('/api/admin/recycle-bin/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})}); if(!r.ok){let d={};try{d=await r.json()}catch(_){} throw new Error(d.error||'Download failed');} const blob=await r.blob(); const u=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=u; a.download=m.fileName||`recycle-${item.id}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(e){showToast(e.message||'Download failed');} };
      actions.appendChild(dl);
    }
    const restore=document.createElement('button'); restore.className='mini-btn'; restore.textContent='♻️ Restore';
    restore.onclick=async()=>{ if(!confirm('Restore this deleted item to the group?')) return; try{const r=await fetch('/api/admin/recycle-bin/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})});const d=await r.json();if(!d.ok)throw new Error(d.error||'Restore failed');showToast('Item restored');loadAdminRecycle();}catch(e){showToast(e.message||'Restore failed');} };
    actions.appendChild(restore);
    const del=document.createElement('button'); del.className='mini-btn admin-delete-btn'; del.textContent='Delete permanently';
    del.onclick=async()=>{ if(!confirm('Permanently delete this item and its media? This cannot be undone.')) return; try{const r=await fetch('/api/admin/recycle-bin/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id,permanent:true})});const d=await r.json();if(!d.ok)throw new Error(d.error||'Delete failed');showToast('Permanently deleted');loadAdminRecycle();}catch(e){showToast(e.message||'Delete failed');} };
    if(adminRecycleGroupId==='main') actions.appendChild(del);
    bubble.appendChild(actions);
    body.appendChild(bubble);
  });
  if(targetId){ const target=[...body.children].find(el=>el.dataset?.itemId===targetId); if(target) target.scrollIntoView({block:'center'}); }
  const targetBubble=[...body.querySelectorAll('.recycle-chat-bubble')].find(el=>el.dataset?.itemId===targetId);
  if(targetBubble) targetBubble.scrollIntoView({block:'center'});
}

async function loadAdminRecycle() {
  adminRecycleError.textContent = '';
  adminRecycleChatView?.classList.add('hidden');
  adminRecycleList.classList.remove('hidden');
  adminRecycleList.innerHTML = '<div class="recycle-empty">Loading recycle bin…</div>';
  try {
    const response = await fetch('/api/admin/recycle-bin', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(adminRecycleGroupId === 'main' ? { password:PASSWORD } : { password:PASSWORD, groupId:adminRecycleGroupId }) });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Load failed');
    const items = Array.isArray(data.items) ? data.items : [];
    adminRecycleList.innerHTML = '';
    if (adminRecycleGroupId === 'main') {
      await renderAdminRecycleGroupFilters(items);
      adminRecycleTitle.textContent = `♻️ Main Recycle Bin (${items.length})`;
    }
    const visibleItems = adminRecycleGroupId === 'main' && adminRecycleFilterGroup !== 'all'
      ? items.filter(item => recycleItemGroupId(item) === adminRecycleFilterGroup)
      : items;
    if (!items.length) { adminRecycleList.innerHTML = '<div class="recycle-empty">Recycle bin is empty.</div>'; return; }
    if (!visibleItems.length) { adminRecycleList.innerHTML = '<div class="recycle-empty">No deleted items in this group.</div>'; return; }
    visibleItems.forEach(item => {
      const m = item.message || {};
      const row = document.createElement('div'); row.className='recycle-item';
      const kind = m.type === 'image' ? '🖼️ Image' : m.type === 'video' ? '🎥 Video' : m.type === 'audio' ? '🎤 Audio' : m.type === 'document' ? '📄 Document' : '💬 Message';
      const sender = m.user || m.senderName || 'Unknown user';
      const content = m.message || m.fileName || (m.type === 'image' ? 'Photo' : m.type === 'video' ? 'Video' : m.type === 'audio' ? 'Audio' : m.type === 'document' ? 'Document' : 'Deleted message');
      const when = item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '';
      const oldGroup = item.recycleType === 'private' ? 'Private chat' : (item.deletedGroupName ? `Deleted group: ${item.deletedGroupName}` : '');
      const isMainRecycle = adminRecycleGroupId === 'main';
      row.innerHTML = `<div class="recycle-main"><strong class="recycle-kind"></strong><span class="recycle-sender"></span><span class="recycle-name"></span><small class="recycle-meta"></small><small class="recycle-origin"></small></div><div class="recycle-actions"><button class="mini-btn recycle-view-btn">View</button><button class="mini-btn recycle-download-btn">⬇️ Download</button><button class="mini-btn recycle-restore-btn">♻️ Restore</button>${isMainRecycle ? '<button class="mini-btn admin-delete-btn recycle-delete-btn">Delete permanently</button>' : '<button class="mini-btn recycle-main-move-btn">🗑️ Delete → Main Recycle</button>'}</div>`;
      row.querySelector('.recycle-origin').textContent = oldGroup;
      row.querySelector('.recycle-kind').textContent=kind;
      row.querySelector('.recycle-sender').textContent=`Sent by: ${sender}`;
      row.querySelector('.recycle-name').textContent=content;
      row.querySelector('.recycle-meta').textContent=when;
      const view=row.querySelector('.recycle-view-btn');
      const download=row.querySelector('.recycle-download-btn');
      view.onclick=()=>{
        const groupItems=visibleItems.filter(x=>recycleItemGroupId(x)===recycleItemGroupId(item));
        openRecycleChatView(groupItems, recycleItemGroupName(item), String(item.id||''));
      };
      if (m.mediaId) {
        
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
      const restoreBtn = row.querySelector('.recycle-restore-btn');
      if (item.recycleType === 'private') {
        restoreBtn.disabled = true;
        restoreBtn.textContent = '♻️ Private restore unavailable';
        restoreBtn.title = 'Private recycle items stay in Main Recycle Bin until an Admin permanently deletes them.';
      } else {
        restoreBtn.onclick=async()=>{
          if(!confirm('Restore this deleted item to the group?')) return;
          try {
            const r=await fetch('/api/admin/recycle-bin/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})});
            const d=await r.json(); if(!d.ok) throw new Error(d.error||'Restore failed');
            showToast('Item restored'); loadAdminRecycle();
          } catch(e){ adminRecycleError.textContent=e.message||'Restore failed'; }
        };
      }
      const permanentDeleteBtn = row.querySelector('.recycle-delete-btn');
      if (permanentDeleteBtn) permanentDeleteBtn.onclick=async()=>{
        if(!confirm('Permanently delete this item and its media? This cannot be undone.')) return;
        try {
          const r=await fetch('/api/admin/recycle-bin/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id,permanent:true})});
          const d=await r.json(); if(!d.ok) throw new Error(d.error||'Delete failed');
          showToast('Permanently deleted'); loadAdminRecycle();
        } catch(e){ adminRecycleError.textContent=e.message||'Delete failed'; }
      };
      const moveBtn = row.querySelector('.recycle-main-move-btn');
      if (moveBtn) moveBtn.onclick=async()=>{
        if(!confirm('Move this item from Group Recycle to Main Recycle? It will NOT be permanently deleted.')) return;
        try {
          const r=await fetch('/api/admin/recycle-bin/move-to-main',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,id:item.id})});
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
  if (adminRecycleGroupId !== 'main') adminRecycleFilterGroup = 'all';
  adminRecycleTitle.textContent = `♻️ ${adminRecycleGroupName} Recycle Bin`;
  adminRecycleModal.classList.remove('hidden');
  loadAdminRecycle();
}

adminRecycleClose?.addEventListener('click',()=>adminRecycleModal.classList.add('hidden'));
adminMainRecycleBtn?.addEventListener('click',()=>openAdminRecycle('main','Main Recycle Bin'));

adminMainRecycleFromGroupsBtn?.addEventListener('click',()=>openAdminRecycle('main','Main Recycle Bin'));

// ABC = permanent MongoDB chat cleanup. This intentionally does NOT remove
// groups, users, passwords, call recordings or notification subscriptions.
document.querySelector('#adminAbcClearBtn')?.addEventListener('click', async () => {
  const first = prompt('ABC: Permanently delete ALL chat messages and chat media from MongoDB. Type ABC to continue:');
  if (first !== 'ABC') return;
  const second = prompt('This cannot be undone. Type DELETE again to confirm:');
  if (second !== 'DELETE') return;
  try {
    const r = await fetch('/api/admin/abc-clear-messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:PASSWORD})
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'ABC cleanup failed');
    showToast(`ABC complete: ${d.messagesDeleted || 0} messages and ${d.mediaDeleted || 0} media deleted`);
    if (typeof loadAdminRecycle === 'function' && adminRecycleModal && !adminRecycleModal.classList.contains('hidden')) loadAdminRecycle();
  } catch (e) {
    showToast(e.message || 'ABC cleanup failed');
  }
});

adminRecycleModal?.addEventListener('click',e=>{if(e.target===adminRecycleModal)adminRecycleModal.classList.add('hidden');});
adminRecycleRefresh?.addEventListener('click',loadAdminRecycle);
adminRecycleEmpty?.addEventListener('click',async()=>{
  if(!confirm(adminRecycleGroupId === 'main' ? `Empty Main Recycle Bin for "${adminRecycleGroupName}"? This PERMANENTLY deletes all messages, media and recycle records. This cannot be undone.` : `Empty Group Recycle Bin for "${adminRecycleGroupName}"? All items will move to Main Recycle Bin and will NOT be permanently deleted.`)) return;
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

adminGroupsBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); requestAdminThen(() => { if (adminMenuLocked) adminMenuLocked.classList.add('hidden'); if (adminMenuUnlocked) adminMenuUnlocked.classList.remove('hidden'); appMenu?.classList.remove('hidden'); openAdminGroups(); }); });
adminMenuPanelBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); openAdminGroups(); });
adminMenuCallBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); openAdminCallRecordings(); });
adminMenuPhotosBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); openAdminGroupMedia('image'); });
adminMenuVideosBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); openAdminGroupMedia('video'); });
adminMenuPrivateBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); openAdminAllUsers(); });
adminMenuRecycleBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); openAdminRecycle(); });
adminMenuDeleteBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); adminDeleteUserBtn?.click(); });
adminMenuLogoutBtn?.addEventListener('click', () => { adminUnlocked=false; if(adminMenuUnlocked) adminMenuUnlocked.classList.add('hidden'); if(adminMenuLocked) adminMenuLocked.classList.remove('hidden'); appMenu?.classList.add('hidden'); try{socket.emit('unregister-admin');}catch(_){} showToast('Admin locked'); });
adminCallRecordingsBtn?.addEventListener('click', () => { appMenu?.classList.add('hidden'); requestAdminThen(openAdminCallRecordings); });
adminCallRecordingsClose?.addEventListener('click', () => adminCallRecordingsModal.classList.add('hidden'));
adminCallRecordingsModal?.addEventListener('click', e => { if (e.target === adminCallRecordingsModal) adminCallRecordingsModal.classList.add('hidden'); });
adminMediaViewClose?.addEventListener('click', closeAdminMediaPopup);
adminMediaViewModal?.addEventListener('click', e => { if (e.target === adminMediaViewModal) closeAdminMediaPopup(); });
adminCallRecordingsRefresh?.addEventListener('click', () => loadAdminCallRecordings());
adminCallRecordingsDownloadAll?.addEventListener('click', () => {
  const url = `/api/admin/call-recordings/download-all?password=${encodeURIComponent(PASSWORD)}`;
  window.location.href = url;
});
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
const accountModal = document.querySelector('#accountModal');
const accountNameInput = document.querySelector('#accountNameInput');
const accountPasswordInput = document.querySelector('#accountPasswordInput');
const accountContinueBtn = document.querySelector('#accountContinueBtn');
const accountError = document.querySelector('#accountError');
const accountGenerated = document.querySelector('#accountGenerated');

function normalizeUserId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
}

function openAccountModal(force = false) {
  if (!force && userId && name) return;
  accountNameInput.value = '';
  accountNameInput.placeholder = 'Your Name';
  accountNameInput.setAttribute('autocomplete','name');
  if (accountPasswordInput) {
    accountPasswordInput.value = '';
    accountPasswordInput.placeholder = 'Create Password';
    accountPasswordInput.setAttribute('autocomplete','new-password');
  }
  accountError.textContent = '';
  accountGenerated.style.display = 'none';
  accountGenerated.textContent = '';
  accountModal.classList.remove('hidden');
  setTimeout(() => accountNameInput.focus(), 50);
}

async function finishAccountLogin() {
  const enteredName = String(accountNameInput.value || '').trim().slice(0, 60);
  const loginPassword = String(accountPasswordInput?.value || '');
  if (!enteredName) { accountError.textContent = 'Enter your name'; accountNameInput.focus(); return; }
  if (loginPassword.length < 4 || loginPassword.length > 100) { accountError.textContent = 'Create a password (4-100 characters)'; accountPasswordInput?.focus(); return; }
  accountContinueBtn.disabled = true;
  accountError.textContent = 'Saving account…';
  try {
    const r = await fetch('/api/account/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:enteredName, password:loginPassword}), cache:'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok || !d.user) throw new Error(d.error || 'Could not create account');
    userId = String(d.user.userId || '');
    name = String(d.user.name || enteredName).trim().slice(0,60);
    localStorage.setItem('wa_user_id', userId);
    localStorage.setItem('wa_name', name);
    syncAndroidNotificationIdentity();
    accountGenerated.textContent = `User ID: ${userId}`;
    accountGenerated.style.display = 'block';
    accountError.textContent = 'Account saved successfully.';
    accountModal.classList.add('hidden');
    updateMyNameUI();
    updateGroupNameUI();
    socket.emit('register-user', { userId, name, password: loginPassword, deviceId }, result => {
      if (result?.ok) loadPrivateUsers().catch(() => {});
    });
    enableNotifications().then(granted => { if (granted) return setupWebPush(); }).catch(() => {});
    pollWebNotifications().catch(() => {});
    loadPrivateUsers().catch(() => {});
    socket.emit('presence-login', { userId, deviceId });
    if (currentGroupId && socket.connected) socket.emit('presence-ping', { groupId: currentGroupId });
  } catch (e) {
    accountError.textContent = e?.message || 'Could not create account';
  } finally {
    accountContinueBtn.disabled = false;
  }
}

accountContinueBtn?.addEventListener('click', finishAccountLogin);
accountPasswordInput?.addEventListener('keydown', e => { if (e.key === 'Enter') finishAccountLogin(); });
accountNameInput?.addEventListener('keydown', e => { if (e.key === 'Enter') finishAccountLogin(); });

const openChangeUserPasswordBtn = document.querySelector('#openChangeUserPasswordBtn');
const changeUserPasswordModal = document.querySelector('#changeUserPasswordModal');
const currentUserPasswordInput = document.querySelector('#currentUserPasswordInput');
const newUserPasswordInput = document.querySelector('#newUserPasswordInput');
const changeUserPasswordSave = document.querySelector('#changeUserPasswordSave');
const changeUserPasswordClose = document.querySelector('#changeUserPasswordClose');
const changeUserPasswordError = document.querySelector('#changeUserPasswordError');
function openChangeUserPassword(){
  nameModal?.classList.add('hidden');
  currentUserPasswordInput.value=''; newUserPasswordInput.value=''; changeUserPasswordError.textContent='';
  changeUserPasswordModal?.classList.remove('hidden');
  setTimeout(()=>currentUserPasswordInput?.focus(),40);
}
function closeChangeUserPassword(){ changeUserPasswordModal?.classList.add('hidden'); changeUserPasswordError.textContent=''; }
openChangeUserPasswordBtn?.addEventListener('click', openChangeUserPassword);
changeUserPasswordClose?.addEventListener('click', closeChangeUserPassword);
changeUserPasswordModal?.addEventListener('click', e=>{if(e.target===changeUserPasswordModal)closeChangeUserPassword();});
changeUserPasswordSave?.addEventListener('click', async()=>{
  const currentPassword=String(currentUserPasswordInput?.value||'');
  const newPassword=String(newUserPasswordInput?.value||'');
  if(!currentPassword){changeUserPasswordError.textContent='Enter current password';return;}
  if(newPassword.length<4||newPassword.length>100){changeUserPasswordError.textContent='New password must be 4-100 characters';return;}
  changeUserPasswordSave.disabled=true; changeUserPasswordError.textContent='';
  try{
    const r=await fetch('/api/user/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,currentPassword,newPassword})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok) throw new Error(d.error||'Could not change password');
    closeChangeUserPassword(); showToast('Your user password was changed successfully');
  }catch(e){changeUserPasswordError.textContent=e.message||'Could not change password';}
  finally{changeUserPasswordSave.disabled=false;}
});

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
    if (!result || !result.ok) { showToast('Name could not be synced'); return; }
    name = String(result.name || nextName).trim().slice(0, 40);
    localStorage.setItem('wa_name', name);
    updateMyNameUI();
    renameRenderedMessages(name);
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

async function validateLocalAccountBeforeOpening() {
  const savedId = normalizeUserId(localStorage.getItem('wa_user_id') || '');
  const savedName = String(localStorage.getItem('wa_name') || '').trim();

  // No local identity: this is a brand-new user/device.
  if (!savedId || !savedName) {
    userId = '';
    name = '';
    openAccountModal(true);
    return false;
  }

  try {
    const response = await fetch('/api/account/exists?userId=' + encodeURIComponent(savedId), { cache: 'no-store' });
    const data = await response.json();

    if (data && data.ok && data.exists) {
      // The account still exists in MongoDB, so this device can continue as
      // that user. Do not ask for Name/Password again on every app launch.
      userId = savedId;
      name = String(data.name || savedName).trim().slice(0, 60);
      localStorage.setItem('wa_user_id', userId);
      localStorage.setItem('wa_name', name);
      updateMyNameUI();
      updateGroupNameUI();
      socket.emit('register-user', { userId, name, deviceId });
      return true;
    }
  } catch (error) {
    // If the server/database is temporarily unavailable, do not destroy a
    // valid local account. Let the normal socket reconnect logic handle it.
    userId = savedId;
    name = savedName;
    updateMyNameUI();
    updateGroupNameUI();
    socket.emit('register-user', { userId, name, deviceId });
    return true;
  }

  // The User ID is no longer present in MongoDB (for example Admin deleted it).
  // Remove the old identity and force a fresh Name + Password registration.
  try {
    localStorage.removeItem('wa_user_id');
    localStorage.removeItem('wa_name');
  } catch (_) {}
  userId = '';
  name = '';
  updateMyNameUI();
  openAccountModal(true);
  return false;
}

validateLocalAccountBeforeOpening().catch(() => openAccountModal(true));
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
  const callStage=document.getElementById('callStage');
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
      const recordingCallId=activeCallId; const recordingGroupId=currentGroupId;
      const startedAtMs=Date.now();
      const rec=new MediaRecorder(stream,{mimeType:mime}); const chunks=[];
      rec.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
      rec.onstop=async()=>{
        const stoppedAtMs=Date.now();
        const durationMs=Math.max(0,stoppedAtMs-startedAtMs);
        if(!chunks.length)return;
        try{
          const blob=new Blob(chunks,{type:mime});
          await fetch('/api/call-recordings/upload',{
            method:'POST',
            headers:{
              'Content-Type':'application/octet-stream',
              'X-Call-Id':recordingCallId||feedId,
              'X-Group-Id':recordingGroupId,
              'X-Feed-Id':feedId,
              'X-Feed-Name':feedName||'Participant',
              'X-User-Id':String(userId||''),
              'X-Mime-Type':mime,
              'X-Recording-Start':new Date(startedAtMs).toISOString(),
              'X-Recording-End':new Date(stoppedAtMs).toISOString(),
              'X-Recording-Duration-Ms':String(durationMs)
            },
            body:blob
          });
        }catch(_){}
      };
      rec.start(250); recorders.set(feedId,{rec,startedAtMs});
    }catch(_){}
  }

  function stopFeedRecordings(){
    recorders.forEach(entry=>{try{const r=entry?.rec||entry;if(r.state!=='inactive')r.stop()}catch(_){} });
    recorders.clear();
  }
  const RTC_CONFIG={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}]};
  const newId=()=>((crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2))+'-'+Date.now());
  const isActive=()=>!!activeCallId;
  function status(t){if(callStatus)callStatus.textContent=t}
  function updateStatus(){const n=peers.size+1;status(`${n} participant${n===1?'':'s'} · ${activeCallType==='video'?'Video':'Audio'}`)}
  function showModal(){callTitle.textContent=groupName||'Group call';callModal.classList.remove('hidden');callModal.classList.toggle('video-call',activeCallType==='video');callModal.classList.toggle('audio-call',activeCallType==='audio')}
  function tile(id,nm,stream){let el=document.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`);if(!el){el=document.createElement('div');el.className='call-tile';el.dataset.peer=id;const v=document.createElement('video');v.autoplay=true;v.playsInline=true;const lab=document.createElement('span');lab.className='tile-name';lab.textContent=safeText(nm||'Participant',60);el.append(v,lab);callStage.appendChild(el)}const v=el.querySelector('video');if(v&&stream)v.srcObject=stream}
  function removePeer(id){const x=peers.get(id);if(x){try{x.pc.close()}catch(_){}}peers.delete(id);document.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`)?.remove();updateStatus()}
  function createPeer(id,nm,offer){let x=peers.get(id);if(x)return x.pc;const pc=new RTCPeerConnection(RTC_CONFIG);x={pc,name:safeText(nm||'Participant',60)};peers.set(id,x);if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
    pc.onicecandidate=e=>{if(e.candidate)socket.emit('call-signal',{callId:activeCallId,to:id,kind:'ice',data:e.candidate})};
    pc.ontrack=e=>{const st=e.streams?.[0]||new MediaStream([e.track]); tile(id,x.name,st); startFeedRecording('peer-'+id,x.name,st);};
    pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))removePeer(id)};
    if(offer)(async()=>{try{const o=await pc.createOffer();await pc.setLocalDescription(o);socket.emit('call-signal',{callId:activeCallId,to:id,kind:'offer',data:pc.localDescription})}catch(_){showToast('Could not connect a participant')}})();
    updateStatus();return pc}
  async function media(type){if(!navigator.mediaDevices?.getUserMedia)throw new Error('Your browser does not support microphone/camera calls.');return navigator.mediaDevices.getUserMedia({audio:true,video:type==='video'?{facingMode:{ideal:cameraFacing},width:{ideal:1280},height:{ideal:720}}:false})}
  async function start(type){if(isActive()||!currentGroupId)return;try{cameraFacing='user';localStream=await media(type);activeCallType=type;activeCallId=newId();callStartedByMe=true;cameraOff=(type==='video');if(type==='video'){const vt=localStream.getVideoTracks()[0];if(vt)vt.enabled=false;}showModal(); if(!recordingNoticeShown){showToast('Call Ended'); recordingNoticeShown=true;} startFeedRecording('local-'+socket.id,name||'You',localStream); if(type==='video'){localCallVideo.srcObject=localStream;localCallVideo.style.display='none'}if(callCameraBtn)callCameraBtn.textContent=type==='video'?'🚫':'📷'; if(callSwapCameraBtn){callSwapCameraBtn.style.display=type==='video'?'grid':'none';callSwapCameraBtn.textContent='🔄';callSwapCameraBtn.title='Swap camera';} updateStatus();socket.emit('call-start',{callId:activeCallId,type,groupId:currentGroupId,userId,name},r=>{if(!r?.ok){showToast(r?.error||'Could not start call');end(false)}})}catch(e){showToast(e?.message||'Microphone/camera permission is required')}}
  function incoming(d){if(!d?.callId||!d?.groupId||isActive()||pendingIncoming)return;const gid=String(d.groupId);const g=groups.find(x=>String(x.id)===gid)||{id:gid,name:d.groupName||'Group'};pendingIncoming=d;incomingCallName.textContent=safeText(d.fromName||'Someone',60);incomingCallType.textContent=`${d.type==='video'?'Group video':'Group audio'} call · ${safeText(g.name||'group',50)}`;incomingCallIcon.textContent=d.type==='video'?'📹':'📞';incomingCall.classList.remove('hidden')}
  async function answer(){const d=pendingIncoming;if(!d)return;incomingCall.classList.add('hidden');pendingIncoming=null;try{activeCallId=d.callId;activeCallType=d.type==='video'?'video':'audio';callStartedByMe=false;cameraFacing='user';localStream=await media(activeCallType);cameraOff=(activeCallType==='video');if(activeCallType==='video'){const vt=localStream.getVideoTracks()[0];if(vt)vt.enabled=false;}showModal(); if(!recordingNoticeShown){showToast('Call Ended'); recordingNoticeShown=true;} startFeedRecording('local-'+socket.id,name||'You',localStream); if(activeCallType==='video'){localCallVideo.srcObject=localStream;localCallVideo.style.display='none'}if(callCameraBtn)callCameraBtn.textContent=activeCallType==='video'?'🚫':'📷'; if(callSwapCameraBtn){callSwapCameraBtn.style.display=activeCallType==='video'?'grid':'none';callSwapCameraBtn.textContent='🔄';callSwapCameraBtn.title='Swap camera';} socket.emit('call-join',{callId:activeCallId,groupId:d.groupId,userId,name},r=>{if(!r?.ok){showToast(r?.error||'Call ended');end(false);return}(r.peers||[]).forEach(id=>createPeer(id,'Participant',false));updateStatus()})}catch(e){showToast(e?.message||'Could not answer call')}}
  function reject(){const d=pendingIncoming;if(!d)return;incomingCall.classList.add('hidden');pendingIncoming=null;socket.emit('call-reject',{callId:d.callId,name,userId})}
  function end(notify=true){const id=activeCallId;if(notify&&id)socket.emit('call-leave',{callId:id,name,userId});[...peers.keys()].forEach(removePeer);stopFeedRecordings(); if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}if(localCallVideo)localCallVideo.srcObject=null;activeCallId='';activeCallType='';callStartedByMe=false;callModal.classList.add('hidden');callStage.querySelectorAll('.call-tile').forEach(x=>x.remove());recordingNoticeShown=false;updateStatus()}
  audioCallBtn?.addEventListener('click',()=>start('audio'));videoCallBtn?.addEventListener('click',()=>start('video'));callEndBtn?.addEventListener('click',()=>end(true));callCloseBtn?.addEventListener('click',()=>end(true));document.querySelector('.call-card')?.addEventListener('dblclick',async()=>{try{if(!document.fullscreenElement){await callModal.requestFullscreen?.()}else{await document.exitFullscreen?.()}}catch(_){callModal.classList.toggle('call-fullscreen')}});incomingAnswerBtn?.addEventListener('click',answer);incomingRejectBtn?.addEventListener('click',reject);
  callMuteBtn?.addEventListener('click',()=>{if(!localStream)return;muted=!muted;localStream.getAudioTracks().forEach(t=>t.enabled=!muted);callMuteBtn.textContent=muted?'🔇':'🎙️'});
  callCameraBtn?.addEventListener('click',async()=>{
    if(!localStream||activeCallType!=='video'||swappingCamera)return;
    const track=localStream.getVideoTracks()[0];
    if(!cameraOff){
      if(track) track.enabled=false;
      cameraOff=true;
      if(localCallVideo){localCallVideo.srcObject=localStream;localCallVideo.style.display='none'}
      callCameraBtn.textContent='🚫';callCameraBtn.title='Turn camera on';
      return;
    }
    try{
      const cam=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:cameraFacing},width:{ideal:1280},height:{ideal:720}},audio:false});
      const newTrack=cam.getVideoTracks()[0];
      if(!newTrack)throw new Error('Camera could not be started');
      const old=localStream.getVideoTracks()[0];
      if(old){old.enabled=false;try{old.stop()}catch(_){}localStream.removeTrack(old)}
      localStream.addTrack(newTrack);
      for(const {pc} of peers.values()){
        let sender=pc.getSenders().find(x=>x.track?.kind==='video');
        if(sender) await sender.replaceTrack(newTrack);
        else { const tx=pc.addTransceiver('video',{direction:'sendrecv'}); await tx.sender.replaceTrack(newTrack); }
      }
      newTrack.enabled=true;
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
      let cam;
      try {
        cam=await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:nextFacing},width:{ideal:1280},height:{ideal:720}},audio:false});
      } catch (_) {
        // Some phones do not accept exact facingMode constraints; retry with an ideal hint.
        cam=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:nextFacing},width:{ideal:1280},height:{ideal:720}},audio:false});
      }
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
