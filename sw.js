/* 墨读网页版 Service Worker：只缓存应用外壳（同源静态文件）。
 * 书源/代理请求是跨域的，fetch 拦截里直接放行，绝不缓存、绝不转发。
 * CACHE 里的版本号由 build/gen-web.js 注入，发新版自动作废旧缓存。 */
const CACHE = 'moread-web-2.0.0-202611010739';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './engine.js',
  './detect.js',
  './bridge.js',
  './bridge-web.js',
  './pako.min.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => { })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;   // 跨域（书源、代理）直接走网络，不经 SW
  e.respondWith(
    caches.match(req, { ignoreSearch: url.pathname === '/index.html' }).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res && res.ok) {
          const cl = res.clone();
          caches.open(CACHE).then(c => c.put(req, cl)).catch(() => { });
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
