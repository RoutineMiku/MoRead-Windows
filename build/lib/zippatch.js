'use strict';
/**
 * 极简 zip 读写（只用 Node 内置 zlib），用来在 Windows 上组装 macOS .app。
 *
 * 为什么不用 Expand-Archive：
 *   Electron 的 macOS 运行时里，*.framework/Versions/Current 等是**符号链接**。
 *   PowerShell 的 Expand-Archive / Compress-Archive 不认符号链接，解压后会变成
 *   一个内容为 "A" 的普通文件，压回去的 .app 直接打不开。
 *   所以这里直接读原 zip 的中央目录，改条目名、替换文件、追加新文件，
 *   原样保留 external attributes（Unix mode，含 symlink 位）与符号链接目标。
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 读 zip → [{ name, crc, method, csize, usize, extAttr, data }]（data 为解压后内容，symlink 原样保留目标字符串） */
function readZip(buf) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏 @' + p);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');

    let data = Buffer.alloc(0);
    if (usize > 0) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + csize);
      data = method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    out.push({ name, crc, method, csize, usize, extAttr, data, isLink: ((extAttr >>> 16) & 0xF000) === 0xA000 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 写 zip。entries: [{ name, data, mode? }]，mode 缺省 0o100644；符号链接用 mode 0o120777 + data=目标路径 */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const utf8Flag = /[^\x00-\x7F]/.test(e.name) ? 0x800 : 0;
    const mode = e.mode || (e.name.endsWith('/') ? 0o40755 : 0o100644);
    const extAttr = ((mode & 0xFFFF) << 16) >>> 0;
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(utf8Flag, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);            // time
    lh.writeUInt16LE(0x21, 12);         // date = 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031E, 4);        // made by: unix, spec 3.0（让 unix mode 生效）
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(utf8Flag, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(extAttr, 38);
    ch.writeUInt32LE(offset, 42);

    locals.push(lh, nameBuf, body);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

module.exports = { readZip, writeZip, crc32 };
