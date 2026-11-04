'use strict';
/**
 * 把 dist-web/ 发布到 GitHub Pages（gh-pages 分支）。
 *
 * 为什么不用 git push：本机网络对 git 协议端口有拦截（CONNECT 502），只能走 REST API。
 * 流程：读 dist-web → 建 blobs → 建 tree → 建 commit → 更新/创建 gh-pages ref → 开启 Pages。
 *
 * 用法：GH_TOKEN=ghp_xxx node web/deploy-pages.js
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO || 'RoutineMiku/MoRead-Windows';
const BRANCH = 'gh-pages';
const DIR = path.join(__dirname, '..', 'dist-web');

if (!TOKEN) { console.error('需要 GH_TOKEN 环境变量'); process.exit(1); }
if (!fs.existsSync(DIR)) { console.error('缺少 dist-web/，先跑 node build/gen-web.js'); process.exit(1); }

const H = {
  'Authorization': 'token ' + TOKEN,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'moread-pages-deploy',
  'Content-Type': 'application/json'
};
async function api(pathname, opt) {
  /* 本机网络走代理，api.github.com 偶发 502/500 / 连接被重置；单个 blob 失败就整次
     部署报废，等 1.5s/3s/6s 重试三次，成功率足够 */
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt - 1)));
    try {
      const res = await fetch('https://api.github.com' + pathname, Object.assign({ headers: H }, opt));
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      last = { status: res.status, json, text };
      if (res.status < 500) return last;
    } catch (e) {
      last = { status: 0, json: null, text: String(e && e.message || e) };
    }
    if (attempt < 3) console.log('  重试 ' + (attempt + 1) + '/3：' + pathname + ' (' + last.status + ')');
  }
  return last;
}

function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

(async () => {
  /* 1. 先把每个文件做成 blob（内容寻址，已存在的 GitHub 会复用） */
  const files = walk(DIR, '').map(f => ({ rel: f.rel, full: f.full })).filter(f => !/\.DS_Store$/.test(f.rel));
  files.push({ rel: '.nojekyll', virtual: '' });   // 关掉 Jekyll，静态文件原样输出
  console.log('待发布文件：' + files.length + ' 个');

  const tree = [];
  for (const f of files) {
    const content = f.virtual !== undefined ? Buffer.from(f.virtual) : fs.readFileSync(f.full);
    const r = await api('/repos/' + REPO + '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' })
    });
    if (r.status !== 201) throw new Error('blob 失败 ' + f.rel + ': ' + r.status + ' ' + r.text.slice(0, 200));
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: r.json.sha });
  }

  /* 2. 分支当前指针（有就接上，没有就建根提交） */
  let parent = null, baseTree = null;
  const ref = await api('/repos/' + REPO + '/git/ref/heads/' + BRANCH);
  if (ref.status === 200) {
    parent = ref.json.object.sha;
    const c = await api('/repos/' + REPO + '/git/commits/' + parent);
    baseTree = c.json.tree.sha;
  }

  const treeRes = await api('/repos/' + REPO + '/git/trees', {
    method: 'POST',
    body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree })
  });
  if (treeRes.status !== 201) throw new Error('tree 失败: ' + treeRes.status + ' ' + treeRes.text.slice(0, 200));

  const commitRes = await api('/repos/' + REPO + '/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: 'web: 发布网页版（本地书 + 可选书源代理，数据只存本机）\n\n由 build/gen-web.js 生成，源在 ui/ + web/ + src/',
      tree: treeRes.json.sha,
      parents: parent ? [parent] : []
    })
  });
  if (commitRes.status !== 201) throw new Error('commit 失败: ' + commitRes.status + ' ' + commitRes.text.slice(0, 200));
  const sha = commitRes.json.sha;

  if (parent) {
    const up = await api('/repos/' + REPO + '/git/refs/heads/' + BRANCH, {
      method: 'PATCH', body: JSON.stringify({ sha, force: true })
    });
    if (up.status !== 200) throw new Error('更新分支失败: ' + up.status + ' ' + up.text.slice(0, 200));
    console.log('gh-pages 更新 → ' + sha.slice(0, 7));
  } else {
    const cr = await api('/repos/' + REPO + '/git/refs', {
      method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + BRANCH, sha })
    });
    if (cr.status !== 201) throw new Error('创建分支失败: ' + cr.status + ' ' + cr.text.slice(0, 200));
    console.log('gh-pages 创建 → ' + sha.slice(0, 7));
  }

  /* 3. 开启 Pages（已开启则跳过） */
  const pg = await api('/repos/' + REPO + '/pages');
  if (pg.status === 404) {
    const on = await api('/repos/' + REPO + '/pages', {
      method: 'POST',
      body: JSON.stringify({ source: { branch: BRANCH, path: '/' } })
    });
    console.log('Pages 开启:', on.status === 201 ? 'OK · ' + on.json.html_url : on.status + ' ' + on.text.slice(0, 200));
  } else {
    console.log('Pages 已存在:', pg.json && pg.json.html_url, '状态', pg.json && pg.json.status);
    if (pg.json && pg.json.source && pg.json.source.branch !== BRANCH) {
      await api('/repos/' + REPO + '/pages', { method: 'PUT', body: JSON.stringify({ source: { branch: BRANCH, path: '/' } }) });
      console.log('Pages 源已切到 ' + BRANCH);
    }
  }

  console.log('完成。站点：https://' + REPO.split('/')[0].toLowerCase() + '.github.io/' + REPO.split('/')[1] + '/');
})().catch(e => { console.error('部署失败:', e.message); process.exit(1); });
