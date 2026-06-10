const CACHE_NAME = 'safety-v20260610';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// Network first - never cache, never block
self.addEventListener('fetch', e => {
  // Let ALL requests pass through - no interception of API calls
  if (e.request.url.includes('openrouter.ai') || 
      e.request.url.includes('googleapis.com') ||
      e.request.url.includes('script.google.com') ||
      e.request.url.includes('drive.google.com')) {
    return; // Don't intercept - let browser handle directly
  }
  // For HTML - always fetch fresh
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request)));
    return;
  }
});
