const CACHE = 'whatsapp-pwa-v18-working-push';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

async function chatIsOpenAndVisible() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.some((client) => {
    try {
      const visible = client.visibilityState === 'visible' || client.focused === true;
      const url = new URL(client.url);
      return visible && url.hash === '#chat';
    } catch (_) { return false; }
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  event.waitUntil((async () => {
    // Keep message pushes visible just like the known-working reference ZIP.
    // Incoming calls remain high-priority and interactive.
    const isCall = data.kind === 'incoming-call';
    const groupName = String(data.groupName || data.title || 'WhatsApp').trim() || 'WhatsApp';
    const messageId = String(data.messageId || '');
    const callId = String(data.callId || '');
    const title = isCall
      ? String(data.title || 'Incoming call')
      : groupName;
    const body = isCall
      ? String(data.body || 'Incoming group call')
      : 'New message';

    const options = {
      body,
      icon: data.icon || '/icon.svg',
      badge: data.badge || '/icon.svg',
      tag: isCall ? `wa-call-${callId}` : (messageId ? `wa-${messageId}` : 'wa-message'),
      renotify: isCall,
      requireInteraction: isCall,
      silent: false,
      vibrate: isCall ? [400, 150, 400, 150, 700] : [150, 80, 150],
      data: {
        url: data.url || '/#chat',
        messageId,
        callId,
        groupId: data.groupId || '',
        kind: data.kind || 'message'
      },
      ...(isCall ? { actions: [
        { action: 'open-call', title: 'Open call' },
        { action: 'dismiss-call', title: 'Dismiss' }
      ] } : {})
    };

    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss-call') return;
  const target = new URL((event.notification.data && event.notification.data.url) || '/#chat', self.location.origin).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        try { await client.navigate(target); } catch (_) {}
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
