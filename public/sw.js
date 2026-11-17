// Keeps a copy of the app's own files so it still opens without a connection.
// Always asks the network for the newest copy first, so updates show up straight away.
const CACHE = 'planner-shell-v54';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'google.js', 'store.js', 'util.js', 'qr.js', 'vault.js', 'notes.js', 'ai.js', 'facts.js', 'services.js', 'recorder.js', 'claude.js', 'config.js', 'about.html', 'privacy.html', 'home.html', 'guide.html', 'guide.js', 'site.css', 'helpers/teams-to-google.gs', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Page loads are re-requested by address (a page-load request cannot be given new options); everything
  // else keeps its own headers.
  e.respondWith(
    fetch(e.request.mode === 'navigate' ? e.request.url : e.request, { cache: 'no-cache' })
      .then(res => {
        // a page opened with something after "?" (the way back from Google sign-in) is not kept under that address
        if (res.ok && !(e.request.mode === 'navigate' && url.search)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      // offline: the kept copy; only a page load may fall back to the app itself, never a file
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});

// A reminder shown on a phone: pressing it brings Weftday to the front.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
