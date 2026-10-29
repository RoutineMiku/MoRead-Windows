'use strict';
/**
 * 通用探针：把任意 JS 片段放进真实应用里跑（已导入备份），打印返回值
 * 用法：node test/probe.js <脚本文件> [备份zip]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SCRIPT = process.argv[2];
const ZIP = process.argv[3] || process.env.E2E_ZIP || 'D:\\backup2026-10-29-PLK110.zip';
const PROFILE = path.join(ROOT, '.tmp-probe', 'profile');
const SHOT = path.join(ROOT, '.tmp-probe', 'shot.png');
const LOG = path.join(PROFILE, 'renderer.log');

if (!SCRIPT || !fs.existsSync(SCRIPT)) { console.error('缺少脚本文件'); process.exit(1); }
const body = fs.readFileSync(SCRIPT, 'utf8');

const js = `
(async () => {
  try {
    const imp = await mo.testImportZip(${JSON.stringify(ZIP)});
    if (imp.ok) __t.applyLegado(imp.legado || {}, 'replace');
    ${body}
  } catch (e) { return { fatal: e.message, stack: (e.stack || '').split('\\n').slice(0, 5) }; }
})()
`;

try { fs.rmSync(path.join(ROOT, '.tmp-probe'), { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(PROFILE, { recursive: true });

const env = Object.assign({}, process.env, { MOREAD_SHOT: SHOT, MOREAD_SHOT_JS: js });
delete env.ELECTRON_RUN_AS_NODE;

const p = spawn(ELECTRON, ['.', '--user-data-dir=' + PROFILE], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let err = '';
p.stderr.on('data', d => { err += d.toString(); });
p.on('exit', () => {
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const m = log.match(/\[shot-js-result\] ([^\n]*)/);
  if (!m) { console.log('NO RESULT\n' + err.slice(0, 2000) + '\n' + log.split('\n').slice(-15).join('\n')); return; }
  let r; try { r = JSON.parse(m[1]); } catch (e) { r = m[1]; }
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
});
