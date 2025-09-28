// Simple app-shell cache for offline viewing (read-only).
const V = 'bakeflow-v1';
const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './logo.svg',
  './favicon.svg',
  './manifest.webmanifest'
];

// install: pre-cache shell
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(APP_ASSETS)));
  self.skipWaiting();
});

// activate: cleanup old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== V ? caches.delete(k) : null)))
  );
  self.clients.claim();
});

// fetch: network-first for API writes; cache-first for app shell & GET reads
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isAppAsset = APP_ASSETS.some(a => url.pathname.endsWith(a.replace('./','/')));

  // Don’t intercept non-GET (writes)
  if (e.request.method !== 'GET') return;

  // For same-origin GET API calls, do a stale-while-revalidate cache
  if (url.origin === location.origin && url.pathname.startsWith('/')) {
    e.respondWith((async () => {
      try {
        const net = await fetch(e.request);
        const clone = net.clone();
        const cache = await caches.open(V);
        cache.put(e.request, clone);
        return net;
      } catch {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        // fallback to shell
        return caches.match('./index.html');
      }
    })());
    return;
  }

  // App assets: cache-first
  if (isAppAsset) {
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
  }
});
