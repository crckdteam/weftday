// Weftday no longer lives at this address. This replaces the copy-keeper the app left behind here:
// it throws away the app files that were kept for offline use and then removes itself, so the page
// at this address is always the small "Weftday has moved" one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() => self.registration.unregister())
));
