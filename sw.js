const CACHE_NAME = 'my-recipes-v3';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './add-recipe',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't intercept cross-origin API calls (like Fly.io or external URLs)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Handle Web Share Target POST fallback (if triggered via POST)
  if (event.request.method === 'POST' && url.pathname.includes('add-recipe')) {
    event.respondWith((async () => {
      const formData = await event.request.formData();
      const title = formData.get('title') || '';
      const text = formData.get('text') || '';
      const urlParam = formData.get('url') || '';
      const params = new URLSearchParams();
      if (title) params.set('title', title);
      if (text) params.set('text', text);
      if (urlParam) params.set('url', urlParam);
      return Response.redirect(`./index.html?${params.toString()}`, 303);
    })());
    return;
  }

  if (event.request.method !== 'GET') return;

  // Network first for HTML navigation and Web Share Target GET requests
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html') || url.pathname.includes('add-recipe')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true }) || caches.match('./index.html'))
    );
    return;
  }

  // Stale while revalidate for static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
