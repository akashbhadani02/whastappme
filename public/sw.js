const CACHE = 'whatsapp-pwa-v30-group-push';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
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
    try { data = { body: event.data ? event.data.text() : '' }; } catch (_) { data = {}; }
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
      renotify: true,
      silent: false,
      requireInteraction: false,
      data: { url: data.url || '/#chat', messageId, groupId: data.groupId || '' },
      vibrate: [150, 80, 150]
    };

    await self.registration.showNotification(groupName, options);
  })());
});

async function openPushIdentityDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wa-push', 1);
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore('identity'); } catch (_) {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readPushIdentity(key) {
  const db = await openPushIdentityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('identity', 'readonly');
    const req = tx.objectStore('identity').get(key);
    req.onsuccess = () => { try { db.close(); } catch (_) {} resolve(req.result || ''); };
    req.onerror = () => { try { db.close(); } catch (_) {} reject(req.error); };
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const raw = atob((base64String + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}

self.addEventListener('pushsubscriptionchange', (event) => {
  // A browser/OS may rotate a subscription while the PWA is not open. Renew it
  // from the service worker so locked/background PWA notifications keep working.
  event.waitUntil((async () => {
    try {
      const userId = String(await readPushIdentity('userId') || '').trim();
      const publicKey = String(await readPushIdentity('publicKey') || '').trim();
      if (!userId || !publicKey) return;
      const registration = self.registration;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, subscription })
      });
    } catch (_) {}
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
