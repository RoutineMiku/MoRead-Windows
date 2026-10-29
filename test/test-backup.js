/* 备份 / Legado 兼容 / WebDAV 的本地测试（node test/test-backup.js） */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const store = require('../src/store');
const legado = require('../src/legado');
const webdav = require('../src/webdav');
const { writeZip, readZip } = require('../src/zip');

const UD = path.join(__dirname, 'ud-test');
fs.rmSync(UD, { recursive: true, force: true });
store.init(UD);

const st = store.getState();
st.groups = [{ id: 'g_default', name: '默认分组' }, { id: 'g_x', name: '在追' }];
st.books = [
  { id: 'L1', name: '山居笔记', author: '顾野', kind: 'local', total: 3, ext: '.txt', localFile: 'books/L1.txt', groupId: 'g_x', createdAt: 1 },
  { id: 'O1', name: '夜航船', author: '沈砚', kind: 'online', total: 120, bookUrl: 'https://novel.example.com/book/1', sourceId: 'S1', sourceName: '示例源', groupId: 'g_default' }
];
fs.mkdirSync(path.join(UD, 'books'), { recursive: true });
fs.writeFileSync(path.join(UD, 'books', 'L1.txt'), '第一章 入山\n\n山路湿滑。\n', 'utf8');
st.sources = [{
  id: 'S1', name: '示例源', url: 'https://novel.example.com', group: '我的', enabled: true,
  searchUrl: 'https://novel.example.com/search?q={key}', charset: 'auto',
  ruleSearch: { bookList: '.list li', name: 'a@text', author: '.au@text', bookUrl: 'a@href', intro: '', coverUrl: '' },
  ruleBookInfo: { tocUrl: '#toc@href' },
  ruleToc: { chapterList: '#list dd', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '#content' }
}];
st.progress = { O1: { ci: 12, title: '第13章 江雾', pct: 0.4, at: Date.now() } };
st.bookmarks = [{ id: 'B1', bookId: 'O1', name: '夜航船', ci: 12, title: '第13章 江雾', pct: 0.4, text: '江面上起了雾', at: Date.now() }];
st.history = [{ id: 'H1', bookId: 'O1', name: '夜航船', author: '沈砚', ci: 12, title: '第13章 江雾', at: Date.now() }];
store.saveNow();

/* ---------- 1. 导出 zip ---------- */
const buf = legado.buildBackupZip(st, { includeFiles: true, readBookFile: store.readLocalFile });
const zip = readZip(buf);
console.log('[1] 导出 zip:', (buf.length / 1024).toFixed(1) + 'KB', '条目:', zip.names.join(', '));
console.assert(zip.has('moread.json'), '缺 moread.json');
console.assert(zip.has('bookSource.json'), '缺 bookSource.json');
console.assert(zip.has('bookshelf.json'), '缺 bookshelf.json');
console.assert(zip.names.includes('files/L1.txt'), '缺本地书文件');

const srcJson = JSON.parse(zip.readText('bookSource.json'));
const shelfJson = JSON.parse(zip.readText('bookshelf.json'));
console.log('    书源 → Legado:', srcJson.length, '条，首条字段:', Object.keys(srcJson[0]).slice(0, 6).join('/'));
console.log('    书架 → Legado:', shelfJson.length, '条');
console.log('    在线书进度:', shelfJson[1].durChapterIndex, shelfJson[1].durChapterTitle, '| 本地书 type:', shelfJson[0].type);
console.assert(srcJson[0].bookSourceUrl === 'https://novel.example.com', 'bookSourceUrl 不对');
console.assert(srcJson[0].ruleToc.chapterList === '#list dd', 'ruleToc 丢失');
console.assert(shelfJson[0].type === 1, '本地书 type 应为 1');

/* ---------- 2. 解析回来 ---------- */
const back = legado.parseBackupZip(buf);
console.log('[2] 解析 zip → kind:', back.kind, JSON.stringify(back.summary));
console.assert(back.kind === 'moread' && back.payload.data.books.length === 2, '墨读备份解析失败');
const restoredFiles = legado.readZipFiles(buf, back.payload.fileMap);
console.log('    还原文件:', Object.keys(restoredFiles), '内容首行:', restoredFiles.L1.toString('utf8').split('\n')[0]);

/* ---------- 3. 只有 Legado 文件的 zip ---------- */
const legadoOnly = writeZip([
  { name: 'bookSource.json', data: JSON.stringify(srcJson) },
  { name: 'bookshelf.json', data: JSON.stringify(shelfJson) },
  { name: 'bookmark.json', data: JSON.stringify(JSON.parse(zip.readText('bookmark.json'))) },
  { name: 'readRecord.json', data: JSON.stringify(JSON.parse(zip.readText('readRecord.json'))) }
]);
const p2 = legado.parseBackupZip(legadoOnly);
console.log('[3] 纯 Legado 备份 → kind:', p2.kind, JSON.stringify(p2.summary));
console.log('    书源:', p2.legado.sources.length, '书架:', p2.legado.books.length, '书签:', p2.legado.bookmarks.length);
console.log('    书架首本:', JSON.stringify(p2.legado.books[0]).slice(0, 120));
console.log('    跳过的本地书:', p2.legado.books.length > 0 ? '(见 summary.skippedLocal=' + p2.summary.skippedLocal + ')' : '无');
console.assert(p2.kind === 'legado' && p2.legado.books.length === 1, 'Legado 备份解析不对');
console.assert(p2.legado.books[0].durChapterIndex === 12, '进度没带过来');

/* ---------- 4. 单个书源 JSON ---------- */
const s3 = legado.parseSourceFile(JSON.stringify(srcJson));
console.log('[4] 单文件书源解析:', s3.ok, s3.sources.length, '条');

/* ---------- 5. WebDAV ---------- */
const PORT = 8124;
const cfg = { url: `http://127.0.0.1:${PORT}/dav/`, user: 'tester@example.com', pass: 'app-pass-123' };

function waitServer(proc) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mock dav 启动超时')), 5000);
    proc.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    proc.on('error', reject);
  });
}

(async () => {
  const proc = execFile(process.execPath, [path.join(__dirname, 'mock-dav.js'), String(PORT)]);
  proc.stdout.pipe(process.stdout);
  await waitServer(proc);

  // 错误密码
  try {
    await webdav.test({ url: cfg.url, user: cfg.user, pass: 'wrong' });
    console.log('[5] 错误密码未被拒绝 ← 有问题');
  } catch (e) {
    console.log('[5] 错误密码正确报错:', e.message);
  }

  const t = await webdav.test(cfg);
  console.log('    连接测试:', t.ok, t.ms + 'ms');

  // 建目录 + 上传
  const base = cfg.url.replace(/\/+$/, '') + '/';
  const dir = await webdav.ensureDir(cfg, base, 'MoRead');
  await webdav.put(cfg, webdav.joinUrl(dir, 'moread-20261029-2130.zip'), buf, 'application/zip');
  await webdav.put(cfg, webdav.joinUrl(dir, 'bookSource.json'), Buffer.from(JSON.stringify(srcJson)), 'application/json');
  const items = await webdav.list(cfg, dir);
  console.log('    目录列表:', items.map(i => i.name + '(' + i.size + 'B)').join(', '));

  // 下载校验
  const got = await webdav.get(cfg, webdav.joinUrl(dir, 'moread-20261029-2130.zip'));
  console.log('    下载大小一致:', got.length === buf.length, got.length + '/' + buf.length);
  const p3 = legado.parseBackupZip(got);
  console.log('    下载后解析:', p3.kind, p3.summary.books + ' 本书');

  // 再传一份，测试保留策略排序
  await webdav.put(cfg, webdav.joinUrl(dir, 'moread-20261029-2140.zip'), buf, 'application/zip');
  const items2 = await webdav.list(cfg, dir);
  const zips = items2.filter(i => /\.zip$/.test(i.name)).sort((a, b) => b.lastmod - a.lastmod);
  console.log('    按时间排序:', zips.map(z => z.name).join(' > '));

  // 删除
  await webdav.del(cfg, webdav.joinUrl(dir, 'moread-20261029-2140.zip'));
  console.log('    删除后剩余:', (await webdav.list(cfg, dir)).filter(i => /\.zip$/.test(i.name)).map(i => i.name).join(','));

  proc.kill();
  console.log('\n全部测试完成');
})();
