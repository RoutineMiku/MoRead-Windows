'use strict';
/**
 * 极简 zip 读取器（仅解压，够解析 EPUB 用）
 * 支持 method 0(store) / 8(deflate)
 */
const zlib = require('zlib');

function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, csize, usize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const map = new Map(entries.map(e => [e.name, e]));

  return {
    names: entries.map(e => e.name),
    has: n => map.has(n),
    /** 返回 Buffer 或 null */
    read(name) {
      const e = map.get(name);
      if (!e) return null;
      const lh = e.localOff;
      if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) {
        try { return zlib.inflateRawSync(raw); } catch (err) { return null; }
      }
      return null;
    },
    readText(name) {
      const b = this.read(name);
      return b ? b.toString('utf8') : null;
    }
  };
}

/* ---------------- 写入（用于导出备份 zip） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * files: [{ name, data: Buffer|string, store?: boolean }]
 * 返回完整 zip Buffer（UTF-8 文件名，deflate 压缩）
 */
function writeZip(files) {
  const now = new Date();
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(String(f.name).replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data == null ? '' : f.data), 'utf8');
    const crc = crc32(raw);
    let body = raw, method = 0;
    if (!f.store && raw.length > 64) {
      const def = zlib.deflateRawSync(raw, { level: 6 });
      if (def.length < raw.length) { body = def; method = 8; }
    }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);       // UTF-8 flag
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { readZip, writeZip };
