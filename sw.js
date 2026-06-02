const CACHE = '168hours-v3';
// Relative paths so caching works no matter what subpath the app is hosted under
// (e.g. GitHub Pages project sites served from /<repo>/).
const ASSETS = ['./', './index.html'];

self.addEventListener('install', e => {
  // .catch so a failed pre-cache can never block the worker from activating —
  // an active worker is required for Web Push.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// Web Push: show a notification when the server pushes one (works while app is closed)
self.addEventListener('push', e => {
  let data = { title: '168 Hours', body: 'What are you doing right now?', url: '/' };
  try {
    if (e.data) data = { ...data, ...e.data.json() };
  } catch (_) {
    if (e.data) data.body = e.data.text();
  }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'favicon.png',
    badge: 'favicon.png',
    tag: 'time-check',
    renotify: true,
    data: { url: data.url || '/' },
  }));
});

// Open or focus the app when a notification is clicked
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
