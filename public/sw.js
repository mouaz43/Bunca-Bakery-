// Offline shell with cache bust (v3)
const V = 'bakeflow-v3';
const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './logo.svg',
  './favicon.svg',
  './manifest.webmanifest',
  './offline.html'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(APP_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== V ? caches.delete(k) : null)))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Navigation requests → try network, else offline page
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch { return await caches.match('./offline.html'); }
    })());
    return;
  }

  // Stale-while-revalidate for same-origin GET
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(V);
      const cached = await cache.match(req);
      const net = fetch(req).then(res => { cache.put(req, res.clone()); return res; }).catch(()=>null);
      return cached || net || caches.match('./offline.html');
    })());
    return;
  }

  // Cross-origin: network first, fallback cache
  e.respondWith((async () => {
    try { return await fetch(req); }
    catch { return await caches.match(req); }
  })());
});
