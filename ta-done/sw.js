// Ta-Done! offline support: keeps a copy of the app itself so it opens with no connection.
// Your data is never stored here; it stays in the app's own on-device copy and on the server.
const CACHE = 'tadone-shell-v1';
const SHELL = ['/ta-done/', '/ta-done/manifest.webmanifest', '/ta-done/icon-180.png', '/ta-done/icon-192.png', '/ta-done/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/ta-done/')) return;
  const app = url.pathname === '/ta-done/' || url.pathname === '/ta-done/index.html' || url.pathname === '/ta-done';
  const key = app ? '/ta-done/' : url.pathname;
  // Newest version when online; the saved copy when not.
  e.respondWith(fetch(req).then(res => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(r => r || (req.mode === 'navigate' ? caches.match('/ta-done/') : undefined)).then(r => r || Response.error())));
});
