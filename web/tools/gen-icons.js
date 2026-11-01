'use strict';
/* 生成网页版应用图标（纯几何绘制，4x 超采样抗锯齿，无外部依赖）。
 * 造型：墨色圆角底 + 摊开的书页 + 青色书签，与应用内 logo 的气质一致。 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---- 几何 ---- */
function inRoundedRect(x, y, r) {   // x,y ∈ [0,1]
  const cr = 0.22;
  if (x < cr && y < cr) return dist2(x, y, cr, cr) <= cr * cr;
  if (x > 1 - cr && y < cr) return dist2(x, y, 1 - cr, cr) <= cr * cr;
  if (x < cr && y > 1 - cr) return dist2(x, y, cr, 1 - cr) <= cr * cr;
  if (x > 1 - cr && y > 1 - cr) return dist2(x, y, 1 - cr, 1 - cr) <= cr * cr;
  return true;
}
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const LEFT_PAGE = [[0.16, 0.30], [0.475, 0.24], [0.475, 0.72], [0.16, 0.78]];
const RIGHT_PAGE = [[0.84, 0.30], [0.525, 0.24], [0.525, 0.72], [0.84, 0.78]];
const BOOKMARK = [[0.66, 0.27], [0.755, 0.285], [0.755, 0.50], [0.7075, 0.44], [0.66, 0.50]];
const SPINE = [[0.475, 0.24], [0.525, 0.24], [0.525, 0.72], [0.475, 0.72]];

const BG = [44, 44, 42];
const PAGE = [232, 228, 218];
const PAGE_DIM = [214, 209, 198];
const TEAL = [29, 158, 117];

function shade(px, py) {   // 返回 [r,g,b] 或 null（背景外）
  if (!inRoundedRect(px, py)) return null;
  if (inPoly(px, py, BOOKMARK)) return TEAL;
  if (inPoly(px, py, LEFT_PAGE)) return PAGE;
  if (inPoly(px, py, RIGHT_PAGE)) return PAGE;
  if (inPoly(px, py, SPINE)) return PAGE_DIM;
  return BG;
}

/* ---- PNG 编码 ---- */
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc = (() => {
    let c = 0xffffffff;
    for (const b of td) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  })();
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc);
  return Buffer.concat([len, td, crcBuf]);
}
function writePng(size, file) {
  const SS = 4;   // 超采样
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let off = 0;
  for (let py = 0; py < size; py++) {
    raw[off++] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
        if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
      }
      if (!n) { r = g = b = 255; n = 1; }   // 圆角外透明区域按白底混合（PNG 无 alpha 需求，图标本就是方形圆角）
      raw[off++] = Math.round(r / n); raw[off++] = Math.round(g / n); raw[off++] = Math.round(b / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8bit, RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  console.log(path.basename(file), size + 'x' + size, png.length + 'B');
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
writePng(512, path.join(outDir, 'icon-512.png'));
writePng(192, path.join(outDir, 'icon-192.png'));
writePng(180, path.join(outDir, 'icon-180.png'));
