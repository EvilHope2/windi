const CACHE = 'delirg-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/comercio.html',
  '/repartidor.html',
  '/tracking.html',
  '/styles.css',
  '/manifest.json',
  '/js/firebase.js',
  '/js/utils.js',
  '/js/comercio.js',
  '/js/repartidor.js',
  '/js/tracking.js',
  '/js/sw-register.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
