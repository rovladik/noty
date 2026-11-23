// Сохраняет приложение на iPad, чтобы оно открывалось без интернета.
const CACHE = 'notes-v6';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs', 'lib/mammoth.browser.min.js', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // сначала берём свежую версию из интернета (чтобы обновления приходили сразу), без сети — из памяти
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
