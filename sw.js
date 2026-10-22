// 하루 할 일 서비스 워커: 푸시 알림 표시, 알림 누르면 앱 열기
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: '하루 할 일', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '하루 할 일', {
    body: d.body || '',
    tag: d.tag || 'haru',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) { c.postMessage({ type: 'open-today' }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
