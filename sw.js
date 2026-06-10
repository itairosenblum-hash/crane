const CACHE_NAME = 'safety-v20260610033031';
const URLS = ['/crane/', '/crane/index.html'];

// Install - cache nothing, always fetch fresh
self.addEventListener('install', e => {
  self.skipWaiting();
});

// Activate - delete ALL old caches immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// Fetch - network first, no caching for HTML
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache the main HTML page
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request))
    );
    return;
  }
  // For everything else, network first
  e.respondWith(fetch(e.request, { cache: 'no-store' }));
});
