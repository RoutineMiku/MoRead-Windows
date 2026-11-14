/* 墨读网页版 Service Worker：只缓存应用外壳（同源静态文件）。
 * 书源/代理请求是跨域的，fetch 拦截里直接放行，绝不缓存、绝不转发。
 * CACHE 里的版本号由 build/gen-web.js 注入，发新版自动作废旧缓存。 */
const CACHE = 'moread-web-0.6.13-202611140845';
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
  './icon-512.png',
  './gzh-qr.jpg',
  './douyin-qr.png',
  './logo.png'
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

/* 网络优先：服务器更新了前端，用户刷新就必须拿到新文件。
   以前是 cache-first，只要缓存版本号没变（或手工部署漏了重新构建），
   旧 app.js 会一直被返回，修过的代码在用户浏览器里根本不生效；断网时才回落缓存。 */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;   // 跨域（书源、代理）直接走网络，不经 SW
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const cl = res.clone();
        caches.open(CACHE).then(c => c.put(req, cl)).catch(() => { });
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
