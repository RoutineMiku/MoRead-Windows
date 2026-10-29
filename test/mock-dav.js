/* 本地模拟 WebDAV 服务器（仅测试用，模拟坚果云的接口行为） */
const http = require('http');

const PORT = Number(process.argv[2] || 8124);
const USER = 'tester@example.com';
const PASS = 'app-pass-123';

/** path -> {dir:true} | {data:Buffer, mtime:number} */
const FS = new Map([['/dav', { dir: true }]]);

function norm(p) {
  let s = decodeURIComponent(p || '/');
  s = s.replace(/\/+$/, '');
  return s || '';
}
function parent(p) { return p.slice(0, p.lastIndexOf('/')) || ''; }

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function entryXml(p, node) {
  const isDir = !!node.dir;
  const href = p + (isDir ? '/' : '');
  const props = isDir
    ? '<D:resourcetype><D:collection/></D:resourcetype>'
    : `<D:resourcetype/><D:getcontentlength>${node.data.length}</D:getcontentlength>` +
      `<D:getlastmodified>${new Date(node.mtime || Date.now()).toUTCString()}</D:getlastmodified>`;
  return `<D:response><D:href>${xmlEscape(href)}</D:href>` +
    `<D:propstat><D:prop>${props}<D:displayname>${xmlEscape(p.split('/').pop() || '/')}</D:displayname></D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = norm(url.pathname);

  const auth = req.headers.authorization || '';
  const want = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
  if (auth !== want) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="mock"');
    return res.end('unauthorized');
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const method = req.method.toUpperCase();

    if (method === 'PROPFIND') {
      const node = FS.get(p);
      if (!node) { res.statusCode = 404; return res.end('not found'); }
      const depth = req.headers.depth || '1';
      const items = [entryXml(p, node)];
      if (node.dir && depth !== '0') {
        for (const [k, v] of FS) {
          if (k !== p && parent(k) === p) items.push(entryXml(k, v));
        }
      }
      res.statusCode = 207;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.end(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${items.join('')}</D:multistatus>`);
    }

    if (method === 'MKCOL') {
      if (FS.has(p)) { res.statusCode = 405; return res.end(); }
      if (!FS.has(parent(p))) { res.statusCode = 409; return res.end(); }
      FS.set(p, { dir: true });
      res.statusCode = 201;
      return res.end();
    }

    if (method === 'PUT') {
      if (!FS.has(parent(p))) { res.statusCode = 409; return res.end('parent missing'); }
      const existed = FS.has(p);
      FS.set(p, { data: body, mtime: Date.now() });
      res.statusCode = existed ? 204 : 201;
      return res.end();
    }

    if (method === 'GET') {
      const node = FS.get(p);
      if (!node || node.dir) { res.statusCode = 404; return res.end('not found'); }
      res.statusCode = 200;
      res.setHeader('Content-Length', node.data.length);
      res.setHeader('Last-Modified', new Date(node.mtime).toUTCString());
      return res.end(node.data);
    }

    if (method === 'DELETE') {
      if (!FS.has(p)) { res.statusCode = 404; return res.end(); }
      for (const k of [...FS.keys()]) if (k === p || k.startsWith(p + '/')) FS.delete(k);
      res.statusCode = 204;
      return res.end();
    }

    if (method === 'HEAD') {
      const node = FS.get(p);
      if (!node) { res.statusCode = 404; return res.end(); }
      res.statusCode = 200;
      if (!node.dir) res.setHeader('Content-Length', node.data.length);
      return res.end();
    }

    res.statusCode = 405;
    res.end('unsupported');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock dav listening ${PORT} user=${USER} pass=${PASS}`);
  if (process.send) process.send('ready');
});
