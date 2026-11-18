// Weftday no longer lives at this address. This replaces the copy-keeper the app left behind here:
// it throws away the app files that were kept for offline use and then removes itself, so the page
// at this address is always the small "Weftday has moved" one. Only Weftday's own kept files are
// touched: other sites published under the same address keep theirs.
//
// planner-shell-v9999  (a copy of the old app still open in a tab looks for a name like this one
// and, seeing it differ from its own, offers "A newer Weftday is ready": its Refresh lands here)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('planner-shell-')).map(k => caches.delete(k)))).then(() => self.registration.unregister())
));
