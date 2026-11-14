/* 把 article.html 里引用的本地图片转成 base64 内联，产出自包含的 article-inline.html
   公众号编辑器粘贴这种 HTML 时会自动把 data: 图片上传到自己的图床 */
const fs = require('fs');
const path = require('path');

const here = __dirname;
const src = path.join(here, 'article.html');
const dst = path.join(here, 'article-inline.html');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

let html = fs.readFileSync(src, 'utf8');
let n = 0;
let bytes = 0;

html = html.replace(/src="([^"]+)"/g, (m, p) => {
  if (/^(data:|https?:)/.test(p)) return m;
  const file = path.resolve(here, p);
  if (!fs.existsSync(file)) {
    console.warn('MISSING', p);
    return m;
  }
  const buf = fs.readFileSync(file);
  const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
  n++;
  bytes += buf.length;
  return `src="data:${mime};base64,${buf.toString('base64')}"`;
});

fs.writeFileSync(dst, html);
console.log(`inlined ${n} images (${(bytes / 1024).toFixed(0)} KB raw) -> ${path.basename(dst)}  ${(fs.statSync(dst).size / 1024 / 1024).toFixed(2)} MB`);
