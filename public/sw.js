/* Service Worker - طعم زمان (المندوبين) */
const CACHE = 'tm-staff-v1';
const SHELL = ['/staff', '/offline.html', '/staff-manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // لا نخزّن بيانات الـ API أبداً

  // الصفحات: الشبكة أولاً ثم النسخة المخزنة ثم صفحة عدم الاتصال
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (url.pathname === '/staff') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/staff', copy)); }
        return res;
      }).catch(() => caches.match('/staff').then((r) => r || caches.match('/offline.html')))
    );
    return;
  }

  // باقي الملفات (أيقونات/خطوط/مكتبات): من الكاش أولاً مع تحديث بالخلفية
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});