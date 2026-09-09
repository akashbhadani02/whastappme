self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: 'WhatsApp', body: event.data ? event.data.text() : 'New message' }; }
  const title = data.title || 'WhatsApp';
  const options = {
    body: 'You have new message',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.messageId ? `wa-${data.messageId}` : 'wa-message',
    renotify: true,
    data: { url: data.url || '/#chat' },
    vibrate: [150, 80, 150]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/#chat', self.location.origin).href;
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
