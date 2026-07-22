const CACHE = '168hours-v35';
const CHECKIN_WINDOW_MS = 5 * 60 * 1000; // keep in sync with LOG_WINDOW_MS in index.html
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
  const req = e.request;
  // Network-first for page navigations so code updates are picked up immediately;
  // fall back to the cached page only when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }
  // Cache-first for other assets
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});

// Web Push: show a notification when the server pushes one (works while app is closed)
self.addEventListener('push', e => {
  let data = { title: '168 Hours', body: 'What are you doing right now?', url: '/' };
  try {
    if (e.data) data = { ...data, ...e.data.json() };
  } catch (_) {
    if (e.data) data.body = e.data.text();
  }
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'time-check',
      renotify: true,
      silent: false,
      requireInteraction: true, // stay on screen until acted on…
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' },
    });
    // Record receipt time on THIS device as a fallback anchor (the page prefers
    // the server send time so all devices stay in sync).
    try { const c = await caches.open('168-push'); await c.put('lastpush', new Response(String(Date.now()))); } catch (_) {}
    // Wake any already-open page so it opens its check-in window immediately,
    // in step with the server — otherwise a foregrounded device wouldn't notice
    // the new prompt until it was backgrounded and refocused.
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) c.postMessage({ type: 'checkin-fired' });
    } catch (_) {}
    // …but only until the check-in window closes, then auto-dismiss. Best-effort:
    // the browser may terminate the worker before this fires, in which case the
    // page clears it on next open (closeStaleCheckins in index.html).
    await new Promise(r => setTimeout(r, CHECKIN_WINDOW_MS));
    const notes = await self.registration.getNotifications({ tag: 'time-check' });
    notes.forEach(n => n.close());
  })());
});

// Open or focus the app when a notification is clicked.
// Use the service worker's own scope (e.g. /OneSixtyEight/) so it opens the app,
// not the origin root — works regardless of host/subpath.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = self.registration.scope;
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url.startsWith(url) && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
