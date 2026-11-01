'use strict';
/* 本地预览网页版：node build/serve-web.js [端口]
 * 只用于开发/测试；线上用 GitHub Pages 之类的静态托管。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist-web');
const port = Number(process.argv[2] || 8099);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive'
};

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(dir, p.replace(/\.\./g, ''));
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 单页应用兜底
      fs.readFile(path.join(dir, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/'
    });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => {
  console.log('墨读网页版预览: http://127.0.0.1:' + port + '/');
});
