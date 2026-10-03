/*
 * Service worker: lets the installed phone app open without a connection.
 * App files are fetched network-first (so updates show up straight away) and
 * the last good copy is served when offline. Google Maps and routing requests
 * are never cached; they always go to the network.
 */
const CACHE = 'rally-v3';
const SHELL = [
  './',
  'index.html',
  'rally.css',
  'app.js',
  'pacenotes.js',
  'demo-stage.js',
  'voicepack.js',
  'providers.js',
  'guidance.js',
  'mapview.js',
  'vendor/maplibre/maplibre-gl.js',
  'vendor/maplibre/maplibre-gl.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
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
  // Recorded voice clips never change: serve them from the cache once fetched.
  if (/\.cloudfront\.net$/.test(url.hostname) && /\.(wav|mp3)$/.test(url.pathname)) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    })));
    return;
  }
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
