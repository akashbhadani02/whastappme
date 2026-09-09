const CACHE = 'whatsapp-pwa-v10';

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
    } catch (_) {
      return false;
    }
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }

  event.waitUntil((async () => {
    // If the user is already looking at the chat, do not interrupt them.
    if (await chatIsOpenAndVisible()) return;

    const messageId = data.messageId || '';
    const options = {
      body: data.body || 'You have new message',
      icon: data.icon || '/icon.svg',
      badge: data.badge || '/icon.svg',
      tag: messageId ? `wa-${messageId}` : 'wa-message',
      renotify: false,
      data: { url: data.url || '/#chat', messageId },
      vibrate: [150, 80, 150]
    };

    await self.registration.showNotification(data.title || 'WhatsApp', options);
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
