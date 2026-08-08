const CACHE = 'jangbion-driver-v19';
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js?v=3.3.0',
  '/manifest.json',
  '/static/icon.svg',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/icon-512-maskable.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      await Promise.all(PRECACHE.map(async url => {
        try { await cache.add(url); } catch (error) { console.warn('precache skipped', url, error); }
      }));
    })
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // HTML, JavaScript, CSS는 네트워크 우선: 온라인이면 최신 파일을 받고,
  // 오프라인일 때만 마지막 캐시를 사용한다.
  if (req.mode === 'navigate' || ['document', 'script', 'style'].includes(req.destination)) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/')))
    );
    return;
  }

  // 그 외 정적 자원은 캐시 우선
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
        return res;
      })
    )
  );
});
