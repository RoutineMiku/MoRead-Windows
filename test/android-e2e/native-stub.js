'use strict';
/**
 * 在真实 Chromium（Electron）里冒充安卓原生层。
 *
 * 与 test/android-sim.js 用的是同一套语义：把 MoBridge.kt / MoFiles.kt / MoNet.kt
 * 对外暴露的方法用 Node 自己的能力实现一遍，这样 nodebundle.js 跑的就是「安卓路径」。
 * 区别是这次页面是真的在浏览器里渲染，能测布局、能点按钮、能改窗口尺寸模拟旋转。
 *
 * 形态相关（sw / insets / 圆角）从 cfg 现场读，测试改了 cfg 下一次调用就生效，
 * 用于模拟折叠屏开合这种「最小宽度变了」的场景。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

function httpRequestSync(a) {
  const script = `
    const http=require('http'),https=require('https'),{URL}=require('url');
    const a=JSON.parse(process.argv[1]);
    const out=s=>process.stdout.write(typeof s==='string'?s:JSON.stringify(s));
    try{
      const u=new URL(a.url);
      const mod=u.protocol==='https:'?https:http;
      const req=mod.request({
        hostname:u.hostname,port:u.port,path:u.pathname+u.search,
        method:a.method||'GET',headers:a.headers||{},timeout:a.timeout||18000,
        rejectUnauthorized:!a.insecure
      },r=>{
        const c=[];let n=0;const cap=(a.maxBytes)||12e6;
        r.on('data',d=>{n+=d.length;if(n<=cap)c.push(d);});
        r.on('end',()=>{
          const h={};for(const k of Object.keys(r.headers))h[k.toLowerCase()]=r.headers[k];
          out({status:r.statusCode,headers:h,url:a.url,b64:Buffer.concat(c).toString('base64')});
        });
      });
      req.on('timeout',()=>{req.destroy();out({error:'请求超时'})});
      req.on('error',e=>out({error:e.message,code:e.code||''}));
      if(a.bodyB64)req.write(Buffer.from(a.bodyB64,'base64'));
      req.end();
    }catch(e){out({error:e.message})}
  `;
  try {
    // 在 Electron 里 process.execPath 指向 electron.exe，直接 spawn 会拉起一个 GUI
    // 而不是 Node（表现为请求挂到超时）。加上这个变量它就按 Node 跑。
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    const r = spawnSync(process.execPath, ['--no-warnings', '-e', script, JSON.stringify(a)], {
      encoding: 'utf8', timeout: (a.timeout || 18000) + 8000, env
    });
    const s = String(r.stdout || '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j < 0) return { error: '子进程没有返回结果' };
    return JSON.parse(s.slice(i, j + 1));
  } catch (e) { return { error: e.message }; }
}

module.exports = function createNative(cfg) {
  const R = obj => JSON.stringify(obj);
  const abs = p => (path.isAbsolute(p) ? p : path.join(cfg.dataDir, p));

  return {
    call(name, json) {
      const a = JSON.parse(json || '{}');

      if (name === 'env.info') {
        return R({ app: 'moread', platform: 'android', version: '2.1.0', paths: { root: cfg.dataDir } });
      }
      if (name === 'env.layout') {
        return R({ mode: cfg.mode || 'portrait', sw: cfg.sw || 360, bucket: cfg.bucket || '', widthDp: 0, heightDp: 0, density: 1 });
      }
      if (name === 'env.insets') {
        return R(cfg.insets || { top: 24, bottom: 16, left: 0, right: 0 });
      }
      if (name === 'env.corners') {
        return R(cfg.corners || { tl: 0, tr: 0, bl: 0, br: 0 });
      }

      if (name.startsWith('file.')) {
        switch (name.slice(5)) {
          case 'exists': return R({ exists: fs.existsSync(abs(a.path)) });
          case 'stat': {
            const p = abs(a.path);
            if (!fs.existsSync(p)) return R({ exists: false, size: 0, isDir: false, mtime: 0 });
            const st = fs.statSync(p);
            return R({ exists: true, size: st.size, isDir: st.isDirectory(), mtime: st.mtimeMs });
          }
          case 'mkdir': fs.mkdirSync(abs(a.path), { recursive: true }); return R({ ok: true });
          case 'list': {
            const p = abs(a.path);
            if (!fs.existsSync(p)) return R({ items: [] });
            return R({
              items: fs.readdirSync(p).map(n => {
                const st = fs.statSync(path.join(p, n));
                return { name: n, isDir: st.isDirectory(), size: st.size };
              })
            });
          }
          case 'read': {
            const p = abs(a.path);
            if (!fs.existsSync(p)) throw new Error('文件不存在: ' + p);
            const buf = fs.readFileSync(p);
            const out = { size: buf.length, abs: 'file://' + p };
            if (out.size > 512 * 1024) { out.tooBig = true; return R(out); }
            if (a.text) {
              const s = buf.toString('utf8');
              if ((s.match(/\uFFFD/g) || []).length * 3 > out.size / 4) { out.tooBig = true; return R(out); }
              out.text = s;
            } else out.b64 = buf.toString('base64');
            return R(out);
          }
          case 'write': {
            const p = abs(a.path);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            const buf = a.b64 != null ? Buffer.from(a.b64, 'base64') : Buffer.from(a.text || '', 'utf8');
            if (a.append) fs.appendFileSync(p, buf); else fs.writeFileSync(p, buf);
            return R({ ok: true, size: fs.statSync(p).size });
          }
          case 'copy':
            fs.mkdirSync(path.dirname(abs(a.to)), { recursive: true });
            fs.copyFileSync(abs(a.from), abs(a.to));
            return R({ ok: true });
          case 'rename': fs.renameSync(abs(a.from), abs(a.to)); return R({ ok: true });
          case 'remove': fs.rmSync(abs(a.path), { recursive: true, force: true }); return R({ ok: true });
          case 'abs': return R({ abs: 'file://' + abs(a.path) });
          case 'stage': {
            const dst = path.join(cfg.dataDir, 'tmp', Date.now() + '-' + path.basename(a.path));
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(a.path, dst);
            return R({ path: dst });
          }
        }
      }

      if (name.startsWith('zlib.')) {
        const buf = Buffer.from(a.b64, 'base64');
        const ops = {
          inflateRaw: () => zlib.inflateRawSync(buf), inflate: () => zlib.inflateSync(buf),
          gunzip: () => zlib.gunzipSync(buf), deflateRaw: () => zlib.deflateRawSync(buf),
          deflate: () => zlib.deflateSync(buf), gzip: () => zlib.gzipSync(buf)
        };
        const op = ops[name.slice(5)];
        if (!op) throw new Error('未知压缩操作 ' + name);
        try { return R({ b64: op().toString('base64') }); }
        catch (e) { return R({ error: e.message }); }
      }

      if (name === 'http.request') return R(httpRequestSync(a));

      if (name === 'dialog.save') {
        const dir = path.join(cfg.dataDir, 'export');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, a.name || 'out.bin');
        fs.writeFileSync(dest, a.b64 ? Buffer.from(a.b64, 'base64') : Buffer.from(a.text || '', 'utf8'));
        return R({ ok: true, path: dest, size: fs.statSync(dest).size });
      }
      if (name === 'dialog.open') return R({ ok: true, items: [] });

      if (name === 'tts.voices') return R({ voices: [{ id: 'default', name: '系统默认', lang: 'zh-CN', network: false }], ready: true });
      if (name === 'tts.state') return R({ speaking: false, ready: true, voice: 'default' });
      if (name.startsWith('tts.')) return R({ ok: true });
      if (name.startsWith('win.')) return R({ ok: true, full: false });
      if (name.startsWith('app.') || name.startsWith('ui.')) return R({ ok: true });

      throw new Error('native-stub 还没实现: ' + name);
    }
  };
};
