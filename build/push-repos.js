#!/usr/bin/env node
'use strict';
/**
 * 一次把 main 推到两个仓库：Gitee（国内）+ GitHub（origin）。
 *
 *   node build/push-repos.js                 只推 main
 *   node build/push-repos.js --tag           用 package.json 版本打 v0.6.13 并推 tag
 *   node build/push-repos.js --tag --release 顺便在 Gitee 建 Release
 *   node build/push-repos.js --tag v0.6.13 --release --notes 说明.md
 *
 * 认证：
 *   Gitee  —— GITEE_TOKEN（私人令牌，只在命令行环境里用，不写进 .git/config）
 *   GitHub —— 走 git 凭据；本机代理常对 github.com 返回 502，
 *             失败时会提示改用 build/push-via-api.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const GITEE_USER = 'daily-miku';
const GITEE_REPO = 'moread';

const val = flag => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null;
};
const has = flag => args.includes(flag);

function git(...a) {
  const r = spawnSync('git', a, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  });
  return r.status === 0;
}
function gitOut(...a) {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

function giteeUrl() {
  const t = process.env.GITEE_TOKEN;
  if (!t) return null;
  return `https://${encodeURIComponent(GITEE_USER)}:${encodeURIComponent(t)}@gitee.com/${GITEE_USER}/${GITEE_REPO}.git`;
}

/* GitHub 的凭据不在 .git/config 里，也不一定能非交互读到；
   设了 GH_TOKEN 就直接拼进 URL，没设就走 origin（可能因代理 502 失败）。 */
function ghUrl() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!t) return null;
  return `https://RoutineMiku:${encodeURIComponent(t)}@github.com/RoutineMiku/MoRead-Windows.git`;
}

function pushTo(remote, url, ref) {
  console.log(`\n▸ ${remote}  ${ref}`);
  return git('push', url || remote, ref);
}

async function createGiteeRelease(tag, notes) {
  const token = process.env.GITEE_TOKEN;
  if (!token) return console.log('跳过 Gitee Release：没设 GITEE_TOKEN');
  try {
    const lr = await fetch(`https://gitee.com/api/v5/repos/${GITEE_USER}/${GITEE_REPO}/releases/latest?access_token=${token}`);
    if (lr.ok) {
      const j = await lr.json();
      if (j && j.tag_name === tag) { console.log('Gitee Release 已存在：', tag); return true; }
    }
  } catch (e) { }
  const body = {
    access_token: token,
    tag_name: tag,
    name: `墨读 ${tag}`,
    body: notes || `墨读 ${tag}\n\n九平台同版本，安装包见 GitHub Releases 与下载页。`,
    target_commitish: 'main'
  };
  try {
    const r = await fetch(`https://gitee.com/api/v5/repos/${GITEE_USER}/${GITEE_REPO}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      console.log('Gitee Release 失败：', r.status, JSON.stringify(j).slice(0, 240));
      return false;
    }
    console.log('Gitee Release 已创建：', j.html_url || j.tag_name || tag);
    return true;
  } catch (e) {
    console.log('Gitee Release 失败：', e.message);
    return false;
  }
}

(async () => {
  const branch = gitOut('rev-parse', '--abbrev-ref', 'HEAD') || 'main';
  const head = gitOut('rev-parse', '--short', 'HEAD');
  console.log(`仓库：${ROOT}\n分支：${branch} @ ${head}   版本：${pkg.version}`);

  let tag = null;
  if (has('--tag')) {
    const v = val('--tag');
    tag = typeof v === 'string' ? v : `v${pkg.version}`;
    if (!/^v/.test(tag)) tag = 'v' + tag;
    gitOut('rev-parse', `refs/tags/${tag}`) && console.log(`tag ${tag} 已存在，直接推`);
    if (!gitOut('rev-parse', `refs/tags/${tag}`)) {
      if (!git('tag', '-a', tag, '-m', `墨读 ${tag}`)) {
        console.error('打 tag 失败');
        process.exit(1);
      }
    }
  }

  const gUrl = giteeUrl();
  if (!gUrl) console.log('提示：没设 GITEE_TOKEN，Gitee 会走 remote 里已保存的凭据');
  const okGitee = pushTo('gitee', gUrl, `${branch}:${branch}`);
  if (tag) pushTo('gitee', gUrl, tag);

  let okGh = pushTo('origin', ghUrl(), `${branch}:${branch}`);
  if (tag) okGh = pushTo('origin', ghUrl(), tag) && okGh;
  if (!okGh) {
    console.log('\nGitHub 没推上去（多半是凭据不可交互，或代理对 github.com 返回 502）。');
    console.log('改用：GH_TOKEN=... npm run push   （令牌从 git credential 或 GitHub 设置里取）');
  }

  if (tag && has('--release')) {
    let notes = '';
    const nf = val('--notes');
    if (typeof nf === 'string' && fs.existsSync(path.resolve(nf))) {
      notes = fs.readFileSync(path.resolve(nf), 'utf8');
    }
    await createGiteeRelease(tag, notes);
  }

  console.log(`\n结果：Gitee ${okGitee ? '✓' : '✗'}   GitHub ${okGh ? '✓' : '✗'}${tag ? `   tag ${tag}` : ''}`);
  process.exit(okGitee ? 0 : 1);
})();
