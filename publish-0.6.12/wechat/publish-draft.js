'use strict';
/**
 * 把这篇更新总结发到微信公众号草稿箱（自动上传封面 + 正文图片）。
 *
 * 用法：
 *   WECHAT_APP_ID=wxXXXX WECHAT_APP_SECRET=XXXX node publish-draft.js
 *   WECHAT_APP_ID=... WECHAT_APP_SECRET=... node publish-draft.js --publish   # 顺便提交发布
 *
 * 前提（公众号后台 → 开发 → 基本配置）：
 *   1. 拿到 AppID / AppSecret
 *   2. 把本机公网 IP 加进「IP 白名单」，否则报 40164
 *   3. 账号需要有「素材管理 / 草稿箱」接口权限（认证订阅号、服务号都有；未认证订阅号没有）
 *
 * 默认只写草稿箱，不会直接群发；确认无误后在公众号后台点发布即可。
 * 「阅读原文」固定指向下载落地页，读者可以直接按设备拿安装包。
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const APPID = process.env.WECHAT_APP_ID;
const SECRET = process.env.WECHAT_APP_SECRET;
const DO_PUBLISH = process.argv.includes('--publish');
const SOURCE_URL = 'https://routinemiku.github.io/MoRead-Windows/download.html';

const META = {
  title: '十二个版本，从一屏 17 行到九个平台',
  author: 'routinemiku',
  digest: '0.6.1 只改了三件事，0.6.12 已经能跑在九个平台上。中间十二个版本，修掉了「搜不到书」「显示第 59 章点进去第 660 章」「换源卡 1.7 秒」，文末附全部安装包。'
};

if (!APPID || !SECRET) {
  console.error('缺少 WECHAT_APP_ID / WECHAT_APP_SECRET 环境变量');
  process.exit(1);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const API = 'https://api.weixin.qq.com/cgi-bin';

async function wx(pathname, res) {
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(pathname + ' 返回非 JSON: ' + text.slice(0, 300)); }
  if (j.errcode) {
    const hint = j.errcode === 40164
      ? '\n→ 把本机公网 IP 加到公众号后台「开发 → 基本配置 → IP 白名单」。'
      : j.errcode === 40001 ? '\n→ AppSecret 不对，或 token 刚生成还没生效。'
        : j.errcode === 48001 ? '\n→ 接口未授权，未认证订阅号没有草稿箱接口。' : '';
    throw new Error(pathname + ' 失败 ' + j.errcode + ': ' + j.errmsg + hint);
  }
  return j;
}

function multipart(buf, name, mime) {
  const fd = new FormData();
  fd.append('media', new Blob([buf], { type: mime }), name);
  return { method: 'POST', body: fd };
}

async function main() {
  const tok = await wx('/token', await fetch(
    `${API}/token?grant_type=client_credential&appid=${encodeURIComponent(APPID)}&secret=${encodeURIComponent(SECRET)}`
  ));
  const T = tok.access_token;
  console.log('access_token 已获取');

  /* 1. 封面：永久素材，draft/add 要的是 thumb_media_id */
  const coverPath = path.join(HERE, 'cover-900x383.png');
  const coverBuf = fs.readFileSync(coverPath);
  const cover = await wx('/material/add_material', await fetch(
    `${API}/material/add_material?access_token=${T}&type=image`,
    multipart(coverBuf, 'cover.png', 'image/png')
  ));
  console.log('封面素材', cover.media_id);

  /* 2. 只取 <section id="wx"> 内部正文，本地图片逐张上传到微信图床 */
  const html = fs.readFileSync(path.join(HERE, 'article.html'), 'utf8');
  const m = html.match(/<section id="wx"[^>]*>([\s\S]*?)<\/section>\s*<\/body>/);
  if (!m) throw new Error('article.html 里没找到 <section id="wx"> … </body> 边界');
  let content = m[1];
  const cache = new Map();
  let n = 0;
  content = await replaceAsync(content, /src="([^"]+)"/g, async (all, p) => {
    if (/^(data:|https?:)/.test(p)) return all;
    const file = path.resolve(HERE, p);
    if (!fs.existsSync(file)) throw new Error('找不到图片 ' + p);
    if (!cache.has(file)) {
      const buf = fs.readFileSync(file);
      const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
      const up = await wx('/media/uploadimg', await fetch(
        `${API}/media/uploadimg?access_token=${T}`,
        multipart(buf, path.basename(file), mime)
      ));
      cache.set(file, up.url);
      n++;
      console.log('  正文图', path.basename(file), '→', up.url.slice(0, 60) + '…');
    }
    return `src="${cache.get(file)}"`;
  });
  console.log('正文图片上传', n, '张');

  /* 3. 写草稿箱 */
  const article = {
    title: META.title,
    author: META.author,
    digest: META.digest,
    content,
    content_source_url: SOURCE_URL,
    thumb_media_id: cover.media_id,
    need_open_comment: 1,
    only_fans_can_comment: 0
  };
  const draft = await wx('/draft/add', await fetch(
    `${API}/draft/add?access_token=${T}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articles: [article] }) }
  ));
  console.log('草稿已写入，media_id =', draft.media_id);

  if (DO_PUBLISH) {
    const pub = await wx('/freepublish/submit', await fetch(
      `${API}/freepublish/submit?access_token=${T}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_id: draft.media_id }) }
    ));
    console.log('已提交发布，publish_id =', pub.publish_id, '（群发需要几分钟，到后台看状态）');
  } else {
    console.log('只写草稿，未群发。确认后到 mp.weixin.qq.com → 内容管理 → 草稿箱 发布；');
    console.log('或加 --publish 参数由接口直接提交。');
  }
  console.log('阅读原文 =', SOURCE_URL);
}

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0, match;
  while ((match = re.exec(str)) !== null) {
    parts.push(str.slice(last, match.index));
    parts.push(await fn(match[0], ...match.slice(1)));
    last = match.index + match[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}

main().catch(e => { console.error('发布失败：' + e.message); process.exit(1); });
