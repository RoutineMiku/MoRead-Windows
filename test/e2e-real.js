'use strict';
/**
 * 真实备份端到端验证
 *   1) 用 Electron 起真实应用，数据目录指向临时 profile
 *   2) 用原版「阅读」导出的备份 zip 导入（书源 + 书架 + 进度 + 书签 + 分组）
 *   3) 抽取多本书，真实联网拉目录、拉正文，统计成功率
 *   4) 把结果写进 renderer.log，并截图
 *
 * 用法：node test/e2e-real.js [备份zip路径]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ZIP = process.argv[2] || 'D:\\backup2026-10-29-PLK110.zip';
const PROFILE = path.join(ROOT, '.tmp-e2e', 'profile');
const SHOT = path.join(ROOT, 'shot_e2e.png');
const LOG = path.join(PROFILE, 'renderer.log');

const BOOK_LIMIT = Number(process.env.E2E_BOOKS || 10);
const PER_BOOK_MS = 45000;

const js = `
(async () => {
  const out = { steps: [] };
  const t0 = Date.now();
  const imp = await mo.testImportZip(${JSON.stringify(ZIP)});
  if (!imp.ok) return { fatal: 'import failed: ' + imp.error };
  const r = __t.applyLegado(imp.legado || {}, 'replace');
  out.summary = imp.summary;
  out.counts = r;
  out.after = {
    books: __t.state.books.length,
    sources: __t.state.sources.length,
    groups: __t.state.groups.map(g => g.name),
    bookmarks: __t.state.bookmarks.length,
    progress: Object.keys(__t.state.progress).length
  };

  const withTimeout = (p, ms, tag) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + tag)), ms))
  ]);

  // 每本书：目录 + 首章 / 中间章正文
  const pick = __t.state.books.filter(b => b.kind === 'online' && b.sourceId && b.bookUrl);
  const byHost = new Map();
  for (const b of pick) {
    let h = '';
    try { h = new URL(b.bookUrl).host; } catch (e) {}
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(b);
  }
  const chosen = [];
  const hosts = [...byHost.keys()];
  let i = 0;
  while (chosen.length < ${BOOK_LIMIT} && i < 400) {
    let added = false;
    for (const h of hosts) {
      const list = byHost.get(h);
      if (list && list[i]) { chosen.push(list[i]); added = true; if (chosen.length >= ${BOOK_LIMIT}) break; }
    }
    i++;
    if (!added) break;
  }
  out.picked = chosen.length;
  out.books = [];

  for (const b of chosen) {
    const src = __t.srcForBook(b);
    const item = { name: b.name, source: b.sourceName, srcFound: !!src, host: '' };
    try { item.host = new URL(b.bookUrl).host; } catch (e) {}
    if (!src) { item.err = 'no source'; out.books.push(item); continue; }
    try {
      const toc = await withTimeout(Engine.getToc(mo.net, src, b.bookUrl), ${PER_BOOK_MS}, 'toc');
      item.chapters = (toc.chapters || []).length;
      item.firstCh = (toc.chapters && toc.chapters[0] && toc.chapters[0].title) || '';
      if (item.chapters) {
        const ci = Math.min(3, item.chapters - 1);
        const c = await withTimeout(Engine.getContent(mo.net, src, toc.chapters[ci].url), ${PER_BOOK_MS}, 'content');
        item.contentCh = toc.chapters[ci].title;
        item.paras = (c.paras || []).length;
        item.chars = (c.paras || []).join('').length;
        item.sample = (c.paras || []).slice(0, 2).join(' ').slice(0, 60);
        if (c.error) item.contentErr = c.error;
      }
    } catch (e) { item.err = e.message; }
    out.books.push(item);
  }

  out.okToc = out.books.filter(b => b.chapters > 0).length;
  out.okRead = out.books.filter(b => b.paras > 0).length;
  out.ms = Date.now() - t0;

  // 顺带验证一次搜索（取书架里最多人用的书源）
  try {
    const used = {};
    for (const b of __t.state.books) if (b.sourceId) used[b.sourceId] = (used[b.sourceId] || 0) + 1;
    const top = Object.entries(used).sort((a, b) => b[1] - a[1])[0];
    const src = __t.state.sources.find(s => s.id === (top && top[0]));
    if (src) {
      const rs = await withTimeout(Engine.search(mo.net, src, '剑来'), 30000, 'search');
      out.search = { source: src.name, hits: rs.length, first: rs[0] && rs[0].name };
    }
  } catch (e) { out.search = { err: e.message }; }
  return out;
})()
`;

try { fs.rmSync(path.join(ROOT, '.tmp-e2e'), { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(PROFILE, { recursive: true });
if (!fs.existsSync(ZIP)) { console.error('备份不存在:', ZIP); process.exit(1); }

const env = Object.assign({}, process.env, {
  MOREAD_SHOT: SHOT,
  MOREAD_SHOT_JS: js
});
delete env.ELECTRON_RUN_AS_NODE;

const p = spawn(ELECTRON, ['.', '--user-data-dir=' + PROFILE], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
p.stdout.on('data', d => { stdout += d.toString(); });
p.stderr.on('data', d => { stderr += d.toString(); });
p.on('exit', code => {
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(no renderer.log)';
  const m = log.match(/\[shot-js-result\] (.*)/);
  let result = null;
  if (m) { try { result = JSON.parse(m[1]); } catch (e) { result = m[1]; } }
  const report = { code, stdout: stdout.trim(), stderr: stderr.trim().slice(0, 3000), result, logTail: log.split('\n').slice(-40).join('\n') };
  fs.writeFileSync(path.join(ROOT, '.tmp-e2e', 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2).slice(0, 6000));
});
