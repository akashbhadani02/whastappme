const socket = io();

const PASSWORD = 'kmkm';
const socketId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let name = localStorage.getItem('wa_name') || '';
while (!name) {
  name = (prompt('Please enter your name:') || '').trim();
}
localStorage.setItem('wa_name', name);

document.title = 'WhatsApp';

function updateMyNameUI() {
  if (meAvatar) meAvatar.textContent = (name.trim()[0] || 'W').toUpperCase();
  if (nameInput) nameInput.value = name;
}

function openNameModal() {
  nameInput.value = name;
  nameError.textContent = '';
  nameModal.classList.remove('hidden');
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
}

function closeNameModal() {
  nameModal.classList.add('hidden');
  nameError.textContent = '';
}

function saveName() {
  const nextName = nameInput.value.trim();
  if (!nextName) {
    nameError.textContent = 'Please enter a name';
    nameInput.focus();
    return;
  }
  name = nextName;
  localStorage.setItem('wa_name', name);
  updateMyNameUI();
  closeNameModal();
  showToast(`Your name is now ${name}`);
}

updateMyNameUI();

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
const nameModal = document.querySelector('#nameModal');
const nameInput = document.querySelector('#nameInput');
const nameSave = document.querySelector('#nameSave');
const nameClose = document.querySelector('#nameClose');
const nameError = document.querySelector('#nameError');
const meAvatar = document.querySelector('.me-avatar');
const listPreview = document.querySelector('#listPreview');
const listTime = document.querySelector('#listTime');
const onlineStatus = document.querySelector('#onlineStatus');

let pendingAction = null;
const messages = new Map();
const emojis = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😎','🤩','🥳','🤔','🤗','🤭','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','🤓','😛','😜','🤪','🤑','🤠','👍','👎','👏','🙏','❤️','🔥','🎉','💯','😂','🤣','😢','😭','😡','❤️‍🔥','💔'];

function now() {
  return new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
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

function requestPassword(title, text, action) {
  pendingAction = action;
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
}

passwordSubmit.addEventListener('click', () => {
  if (passwordInput.value !== PASSWORD) {
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
nameSave.addEventListener('click', saveName);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
nameClose.addEventListener('click', closeNameModal);
nameModal.addEventListener('click', e => { if (e.target === nameModal) closeNameModal(); });

function sendMessage(text) {
  const message = text.trim();
  if (!message) return;
  const msg = { id: id(), senderId: socketId, user: name, message, time: now(), type: 'text' };
  renderMessage(msg, 'outgoing');
  socket.emit('message', msg);
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
  if (!msg || !msg.id || messages.has(msg.id)) return;
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
    if (msg.type === 'image') {
      const img=document.createElement('img'); img.src=msg.data; img.alt='Photo'; img.loading='lazy'; wrap.appendChild(img);
    } else {
      const video=document.createElement('video'); video.controls=true; video.preload='metadata';
      const source=document.createElement('source'); source.src=msg.data; source.type=msg.mime || 'video/mp4'; video.appendChild(source); wrap.appendChild(video);
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
  if (direction === 'outgoing') { const ticks=document.createElement('span'); ticks.className='ticks read'; ticks.textContent='✓✓'; meta.appendChild(ticks); }
  el.appendChild(meta);

  const more=document.createElement('button'); more.className='message-more'; more.textContent='⌄'; more.title='Message options';
  const menu=document.createElement('div'); menu.className='message-menu';
  const del=document.createElement('button'); del.textContent='Delete message';
  del.addEventListener('click', () => {
    menu.classList.remove('open');
    requestPassword('Delete message','Enter password to delete this message.', () => deleteMessage(msg.id));
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
  if (broadcast) socket.emit('delete-message', {id:messageId});
  updatePreview('Message deleted');
}

function clearChat(broadcast=true) {
  messageArea.innerHTML=''; messages.clear();
  updatePreview('No messages yet');
  if (broadcast) socket.emit('clear-chat', {by:name});
}

clearChatBtn.addEventListener('click', () => requestPassword('Clear chat','Enter password to permanently clear this chat.', () => clearChat(true)));

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  const file=e.target.files[0]; if (!file) return;
  if (!/^image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|ogg)$/.test(file.type)) { showToast('Only image and video files are allowed'); fileInput.value=''; return; }
  if (file.size > 8 * 1024 * 1024) { showToast('Please choose a file smaller than 8 MB'); fileInput.value=''; return; }
  const reader=new FileReader();
  reader.onload=() => {
    const msg={id:id(),senderId:socketId,user:name,type:file.type.startsWith('image/')?'image':'video',data:reader.result,mime:file.type,time:now()};
    renderMessage(msg,'outgoing'); socket.emit('media',msg); updatePreview(msg.type==='image'?'📷 Photo':'🎥 Video'); fileInput.value='';
  };
  reader.readAsDataURL(file);
});

function downloadMedia(msg) {
  const a=document.createElement('a'); a.href=msg.data; a.download=`whatsapp-${msg.type}-${Date.now()}.${extension(msg.mime,msg.type)}`; document.body.appendChild(a); a.click(); a.remove(); showToast('Download started');
}
function extension(mime,type) { const ext=(mime||'').split('/')[1]; return ext==='jpeg'?'jpg':(ext || type); }

socket.on('history', history => {
  if (!Array.isArray(history)) return;
  history.forEach(msg => renderMessage(msg, msg.senderId === socketId ? 'outgoing' : 'incoming'));
  if (history.length) updatePreview(history[history.length - 1].message || (history[history.length - 1].type === 'image' ? '📷 Photo' : history[history.length - 1].type === 'video' ? '🎥 Video' : 'New message'));
});

socket.on('message', msg => { renderMessage(msg,'incoming'); updatePreview(msg.message || 'New message'); });
socket.on('media', msg => { renderMessage(msg,'incoming'); updatePreview(msg.type==='image'?'📷 Photo':'🎥 Video'); });
socket.on('delete-message', data => { if (data && data.id) deleteMessage(data.id,false); });
socket.on('clear-chat', () => { clearChat(false); showToast('Chat was cleared'); });
socket.on('connect', () => { onlineStatus.textContent='online'; });
socket.on('disconnect', () => { onlineStatus.textContent='connecting…'; });

function scrollToBottom(){ messageArea.scrollTop=messageArea.scrollHeight; }
function updatePreview(text){ listPreview.textContent=text; listTime.textContent=now(); }

emojiPanel.innerHTML = emojis.map(e => `<button type="button" aria-label="${e}">${e}</button>`).join('');
emojiPanel.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { textarea.value += btn.textContent; textarea.focus(); autoResize(); }));
emojiBtn.addEventListener('click', e => { e.stopPropagation(); emojiPanel.classList.toggle('open'); });
document.addEventListener('click', e => { if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) emojiPanel.classList.remove('open'); });

document.querySelectorAll('.filter').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.filter').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }));
document.querySelector('#backBtn').addEventListener('click', () => app.classList.remove('chat-open'));
document.querySelector('.chat-item').addEventListener('click', () => app.classList.add('chat-open'));
document.querySelector('#newChatBtn').addEventListener('click', () => showToast('New chat is ready'));
document.querySelector('#statusBtn').addEventListener('click', () => showToast('Status')); 
document.querySelector('#menuBtn').addEventListener('click', openNameModal);
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

if (window.innerWidth <= 760) app.classList.remove('chat-open'); else app.classList.add('chat-open');
updatePreview('Messages are end-to-end styled for this demo');
