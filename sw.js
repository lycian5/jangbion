const CACHE = 'jangbion-driver-v28';
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js?v=3.5.4',
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
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isAppShellRequest(req) {
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  if (path === '/' || path === '/index.html') return true;
  if (path === '/app.js' || path.endsWith('/app.js')) return true;
  if (path === '/sw.js') return true;
  if (path.endsWith('.js') || path.endsWith('.css')) return true;
  return false;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // HTML · JS · CSS: 네트워크 우선 (온라인이면 최신, 실패 시 캐시)
  if (req.mode === 'navigate' || req.destination === 'document' || isAppShellRequest(req)) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/index.html') || caches.match('/')))
    );
    return;
  }

  // 아이콘·기타 정적 자원: 캐시 우선
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached)
    )
  );
});
