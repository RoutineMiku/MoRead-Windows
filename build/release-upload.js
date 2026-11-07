#!/usr/bin/env node
'use strict';
/**
 * 把 dist/ 里的产物发到 GitHub Release（走 REST API，不依赖 git push）。
 *
 *   GH_TOKEN=xxx node build/release-upload.js v0.6.3
 *   GH_TOKEN=xxx node build/release-upload.js v0.6.3 --dry     # 只列出会传什么
 *
 * 为什么不用 gh / git：
 *   本机 git push 到 github.com 会被代理拦（CONNECT 502），所以统一走 Data API。
 *
 * 行为：
 *   · tag 不存在就按当前 main 的 HEAD 建；release 不存在就建（已存在则复用）
 *   · 同名且大小一致的资产跳过（可重复运行，断点续传）
 *   · 上传失败重试 3 次（每次重新查一遍远端资产，避免重复上传）
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO || 'RoutineMiku/MoRead-Windows';
const TAG = process.argv[2] || process.env.GH_TAG;
const DRY = process.argv.includes('--dry');
if (!TOKEN) { console.error('需要 GH_TOKEN'); process.exit(1); }
if (!TAG) { console.error('用法：node build/release-upload.js v0.6.3'); process.exit(1); }

const DIST = path.join(__dirname, '..', 'dist');
const pkg = require(path.join(__dirname, '..', 'package.json'));
const V = pkg.version;
// 和 build/version.js 一致：maj*10000 + min*100 + patch
const VCODE = (() => {
  const [a, b, c] = V.split('.').map(n => parseInt(n, 10) || 0);
  return a * 10000 + b * 100 + c;
})();

/* ---------- 要发的东西 ---------- */
/** [文件名, 说明] —— 只发存在的，名字要能一眼看出平台和架构 */
const WANTED = [
  [`MoRead-windows-${V}.zip`, 'Windows x64（免安装，解压双击 墨读.exe）'],
  [`MoRead-android-${V}.apk`, 'Android 7+'],
  [`MoRead-linux-x64-${V}.tar.gz`, 'Linux x64'],
  [`MoRead-linux-arm64-${V}.tar.gz`, 'Linux arm64（树莓派 / ARM 小主机）'],
  [`MoRead-mac-x64-${V}.zip`, 'macOS Intel'],
  [`MoRead-mac-arm64-${V}.zip`, 'macOS Apple Silicon'],
  [`MoRead-harmony-${V}.hap`, '鸿蒙（未签名）'],
  [`MoRead-harmony-${V}-signed.hap`, '鸿蒙（SDK 测试 CA 自签，可直接 hdc install）'],
  [`MoRead-${V}-unsigned.ipa`, 'iOS 15+（未签名，需自己 Apple ID 重签）'],
];

const files = WANTED
  .map(([name, note]) => ({ name, note, file: path.join(DIST, name) }))
  .filter(x => fs.existsSync(x.file))
  .map(x => Object.assign(x, { size: fs.statSync(x.file).size }));

if (!files.length) { console.error('dist/ 里没有可发的产物'); process.exit(1); }

const total = files.reduce((a, b) => a + b.size, 0);
console.log(`目标 ${REPO} → ${TAG}`);
for (const f of files) console.log(`  ${(f.size / 1048576).toFixed(1).padStart(6)}MB  ${f.name}`);
console.log(`  合计 ${(total / 1048576).toFixed(0)}MB\n`);
if (DRY) process.exit(0);

/* ---------- API ---------- */
const H = {
  'Authorization': 'token ' + TOKEN,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'moread-release-upload',
};

async function api(pathname, opt) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch('https://api.github.com' + pathname, Object.assign({ headers: H }, opt));
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { }
      last = { status: res.status, json, text };
      if (res.status < 500) return last;
    } catch (e) {
      last = { status: 0, json: null, text: String((e && e.message) || e) };
    }
    if (i < 3) console.log(`  重试 ${i + 1}/3 ${pathname}（${last.status}）`);
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  return last;
}

async function uploadAsset(releaseId, f) {
  const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(f.name)}`;
  const body = fs.readFileSync(f.file);   // 最大 140MB，一次性读入没问题
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...H,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.status === 201) {
    const mb = (body.length / 1048576 / (sec / 1)).toFixed(1);
    console.log(`  ✅ ${f.name}  ${sec}s（${mb}MB/s）`);
    return true;
  }
  console.log(`  ❌ ${f.name}  ${res.status} ${String(text).slice(0, 200)}`);
  return false;
}

const BODY = `同一份 \`ui/\`，七个平台。版本 **${V}**（Android versionCode ${VCODE}）。

| 平台 | 文件 | 怎么用 |
| --- | --- | --- |
| Windows x64 | \`MoRead-windows-${V}.zip\` | 解压，双击 \`墨读.exe\`。免安装、不写注册表，数据跟着程序走 |
| Android 7+ | \`MoRead-android-${V}.apk\` | 直接安装（与桌面共用同一套阅读与书源逻辑） |
| Linux x64 | \`MoRead-linux-x64-${V}.tar.gz\` | \`tar xzf …\` 后跑 \`./moread\`，或 \`./install.sh\` 装桌面图标 |
| Linux arm64 | \`MoRead-linux-arm64-${V}.tar.gz\` | 同上，树莓派 / ARM 小主机 |
| macOS Intel | \`MoRead-mac-x64-${V}.zip\` | 解压得到 \`MoRead.app\`。**未签名**：首次打开要右键 → 打开，或 \`xattr -dr com.apple.quarantine MoRead.app\` |
| macOS Apple Silicon | \`MoRead-mac-arm64-${V}.zip\` | 同上 |
| 鸿蒙 NEXT | \`MoRead-harmony-${V}.hap\` | 未签名，用 DevEco「自动签名」或自己的证书签 |
| 鸿蒙（自签） | \`MoRead-harmony-${V}-signed.hap\` | SDK 自带 OpenHarmony 测试 CA 签的，开发板 / 模拟器可 \`hdc install\` |
| iOS 15+ | \`MoRead-${V}-unsigned.ipa\` | 未签名，Sideloadly 填自己 Apple ID 重签（免费账号 7 天） |
| 网页 / iPad PWA | — | <https://routinemiku.github.io/MoRead-Windows/> |

iOS 另有单独说明：见 [\`v0.6.3-ios\`](https://github.com/${REPO}/releases/tag/v0.6.3-ios)。

### 说明
- **Linux / macOS / 鸿蒙 / iOS 未做真机验证**（手上只有 Windows 和安卓设备）。编译、签名、包结构都验过，实机反馈欢迎开 issue。
- Linux 包内 \`moread\` 的可执行位已写成 0755（Windows 打 tar 会按 NTFS ACL 写成 0666，脚本里重算了 tar 头校验和）；macOS 包保留了 framework 的 14 条符号链接（先解压再压缩会把 \`Versions/Current\` 变成 1 字节文件）。
- 鸿蒙零售机只认华为签发证书，唯一免费路径是 DevEco 自动签名（绑自己账号 + 设备 UDID）。
`;

(async () => {
  /* 1. tag（不存在才建，指向 main 的 HEAD） */
  let r = await api(`/repos/${REPO}/git/ref/tags/${TAG}`);
  if (r.status === 404) {
    const br = await api(`/repos/${REPO}/branches/main`);
    if (br.status !== 200) throw new Error('读 main 失败：' + br.status);
    const sha = br.json.commit.sha;
    r = await api(`/repos/${REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'refs/tags/' + TAG, sha }),
    });
    if (r.status !== 201) throw new Error('建 tag 失败：' + r.status + ' ' + String(r.text).slice(0, 200));
    console.log(`tag ${TAG} → ${sha.slice(0, 7)}`);
  } else {
    console.log(`tag ${TAG} 已存在`);
  }

  /* 2. release（不存在才建） */
  r = await api(`/repos/${REPO}/releases/tags/${TAG}`);
  let rel = r.status === 200 ? r.json : null;
  if (!rel) {
    r = await api(`/repos/${REPO}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: TAG,
        name: `墨读 ${V} · Windows / Linux / macOS / Android / 鸿蒙 / iOS`,
        body: BODY,
        draft: false,
        prerelease: false,
      }),
    });
    if (r.status !== 201) throw new Error('建 release 失败：' + r.status + ' ' + String(r.text).slice(0, 200));
    rel = r.json;
    console.log('release 已创建:', rel.html_url);
  } else {
    console.log('release 已存在:', rel.html_url);
  }

  /* 3. 逐个上传，已存在同尺寸的跳过 */
  let ok = 0, skip = 0, fail = [];
  for (const f of files) {
    const exist = (rel.assets || []).find(a => a.name === f.name && a.size === f.size);
    if (exist) { console.log(`  ⏭  ${f.name} 已存在（${(f.size / 1048576).toFixed(1)}MB）`); skip++; continue; }
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      if (attempt > 1) {
        // 重新拉一次 assets，看是不是上次其实传成功了
        const again = await api(`/repos/${REPO}/releases/${rel.id}`);
        if (again.status === 200) {
          rel = again.json;
          const hit = (rel.assets || []).find(a => a.name === f.name && a.size === f.size);
          if (hit) { console.log(`  ⏭  ${f.name} 上一次已传成功`); skip++; done = true; break; }
        }
        console.log(`  重试 ${attempt}/3 ${f.name}`);
      }
      done = await uploadAsset(rel.id, f);
    }
    if (done) ok++; else fail.push(f.name);
  }

  /* 4. 汇总 */
  r = await api(`/repos/${REPO}/releases/${rel.id}`);
  const assets = (r.json && r.json.assets) || [];
  console.log(`\n上传 ${ok} 个，跳过 ${skip} 个，失败 ${fail.length} 个`);
  if (fail.length) console.log('失败：' + fail.join(', '));
  console.log('Release:', rel.html_url);
  console.log('资产清单：');
  for (const a of assets) console.log(`  ${(a.size / 1048576).toFixed(1).padStart(7)}MB  ${a.name}`);
  if (fail.length) process.exit(1);
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
