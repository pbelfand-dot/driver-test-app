/*
 * Service worker: lets the installed phone app open without a connection.
 * App files are fetched network-first (so updates show up straight away) and
 * the last good copy is served when offline. Google Maps and routing requests
 * are never cached; they always go to the network.
 */
const CACHE = 'rally-v1';
const SHELL = [
  './',
  'index.html',
  'rally.css',
  'app.js',
  'pacenotes.js',
  'demo-stage.js',
  'voicepack.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  '../config.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== self.location.origin && !isFont) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
