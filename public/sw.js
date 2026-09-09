const CACHE = 'wa-pwa-v1';
let chatState = { open: false, visible: false };

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CHAT_STATE') {
    chatState = {
      open: !!data.open,
      visible: !!data.visible
    };
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // If the user is currently looking at the open chat, do not interrupt them.
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const activeChat = clients.some(client => {
        const visible = client.visibilityState === 'visible';
        const openHash = (() => { try { return new URL(client.url).hash === '#chat'; } catch (_) { return false; } })();
        return visible && (openHash || (chatState.open && chatState.visible));
      });
      if (activeChat) return;
    } catch (_) {}

    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch (_) {
      data = { title: 'WhatsApp', body: 'You have new message' };
    }

    const messageId = data.messageId ? String(data.messageId) : '';
    const title = data.title || 'WhatsApp';
    const options = {
      body: data.body || 'You have new message',
      icon: data.icon || '/icon.svg',
      badge: data.badge || '/icon.svg',
      // Same message ID => same notification and no second alert.
      tag: messageId ? `wa-${messageId}` : 'wa-message',
      renotify: false,
      data: { url: data.url || '/#chat', messageId },
      vibrate: [150, 80, 150]
    };
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/#chat',
    self.location.origin
  ).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) {
        try { await client.navigate(target); } catch (_) {}
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
