const CACHE = 'delirg-v14';
const ASSETS = [
  '/',
  '/index.html',
  '/marketplace-auth',
  '/marketplace-auth.html',
  '/marketplace',
  '/cart',
  '/checkout',
  '/mi-cuenta',
  '/me/orders',
  '/comercio.html',
  '/comercio-marketplace.html',
  '/repartidor.html',
  '/tracking.html',
  '/marketplace.html',
  '/cart.html',
  '/checkout.html',
  '/mi-cuenta.html',
  '/my-orders.html',
  '/order.html',
  '/terminos.html',
  '/admin.html',
  '/aprobaciones.html',
  '/styles.css',
  '/manifest.json',
  '/favicon.ico',
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/js/firebase.js',
  '/js/utils.js',
  '/js/address-autocomplete.js',
  '/js/comercio.js',
  '/js/comercio-marketplace.js',
  '/js/repartidor.js',
  '/js/tracking.js',
  '/js/marketplace.js',
  '/js/marketplace-auth.js',
  '/js/cart.js',
  '/js/checkout.js',
  '/js/mi-cuenta.js',
  '/js/my-orders.js',
  '/js/order.js',
  '/js/marketplace-common.js',
  '/js/admin.js',
  '/js/aprobaciones.js',
  '/js/sw-register.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Network-first for app shell and JS/CSS so updates arrive fast.
  const url = new URL(request.url);
  const isAppAsset =
    request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css');

  if (isAppAsset) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
        return response;
      });
    })
  );
});
