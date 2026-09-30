const CACHE = 'whatsapp-pwa-v17-single-vapid-push';

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

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }

  event.waitUntil((async () => {
    const messageId = data.messageId || '';
    const groupName = String(data.groupName || data.title || 'WhatsApp').trim() || 'WhatsApp';
    const options = {
      // Do not put the actual message text in the notification.
      body: 'New message',
      icon: data.icon || '/icon.svg',
      badge: data.badge || '/icon.svg',
      tag: messageId ? `wa-${messageId}` : 'wa-message',
      renotify: false,
      data: { url: data.url || '/#chat', messageId, groupId: data.groupId || '' },
      vibrate: [150, 80, 150]
    };

    await self.registration.showNotification(groupName, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
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
