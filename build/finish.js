'use strict';
/**
 * 打包收尾：裁剪多余语言包 → 写入便携标记与说明 → 压缩成 zip
 * 用法：node build/finish.js [dist 目录名]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'dist');
const NAME = process.argv[2] || '墨读-win32-x64';
const appDir = path.join(OUT, NAME);

if (!fs.existsSync(appDir)) {
  console.error('找不到打包目录：' + appDir);
  process.exit(1);
}

/* 1. 语言包瘦身：只保留中英文 */
const locales = path.join(appDir, 'locales');
if (fs.existsSync(locales)) {
  const keep = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
  let removed = 0, saved = 0;
  for (const f of fs.readdirSync(locales)) {
    if (keep.has(f)) continue;
    const p = path.join(locales, f);
    try { saved += fs.statSync(p).size; fs.unlinkSync(p); removed++; } catch (e) { /* ignore */ }
  }
  console.log(`语言包：删除 ${removed} 个，节省 ${(saved / 1024 / 1024).toFixed(0)}MB`);
}

/* 2. 便携标记：有 portable.txt 时数据写在 exe 同目录的 data/ */
fs.writeFileSync(path.join(appDir, 'portable.txt'), 'portable mode\r\n');

/* 3. 使用说明 */
fs.writeFileSync(path.join(appDir, '使用说明.txt'), [
  '墨读 · Windows 桌面阅读器',
  '',
  '【怎么开始】',
  '1. 双击 墨读.exe 启动（免安装，不用管理员权限）',
  '2. 把 .txt / .epub 拖进窗口，或点右上角「导入本地书」',
  '3. 左侧「书源」导入 Legado(阅读) 书源 JSON，就能联网搜书',
  '4. 左侧「网页」是内置浏览器：输入书名搜索，或粘贴小说网址，',
  '   点「嗅探本页」自动识别目录和正文，一键加入书架',
  '',
  '【便携模式】',
  '本目录有 portable.txt，所以书架、书源、进度都保存在同目录的 data\\ 里。',
  '换电脑时把整个文件夹拷走即可；删掉 portable.txt 则改用系统 AppData 目录。',
  '',
  '【坚果云同步（和手机上的原版「阅读」互通）】',
  '设置 → 坚果云同步：',
  '  服务器地址  https://dav.jianguoyun.com/dav/',
  '  账号        坚果云登录邮箱',
  '  应用密码    坚果云「安全选项 → 添加应用」生成，不是登录密码',
  '  远程目录    MoRead（不存在会自动创建）',
  '点「保存并测试」→「立即备份」即可上传。',
  '',
  '备份 zip 里同时包含 bookshelf.json / bookSource.json / bookmark.json 等',
  '原版「阅读」认识的字段，手机上可以直接从同一个 zip 恢复；',
  '反过来，手机备份的 zip 也能在「选择文件」里导入（本地书文件无法跨设备还原会自动跳过）。',
  '',
  '【快捷键】',
  '  ← →      上一章 / 下一章        C  目录      B  书签',
  '  + -      字号                   T  主题      Esc 退出阅读',
].join('\r\n'), 'utf8');

/* 4. 压缩 zip */
const zipPath = path.join(OUT, NAME + '.zip');
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
try {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${appDir}' -DestinationPath '${zipPath}' -CompressionLevel Optimal"`,
    { stdio: 'inherit', timeout: 600000 }
  );
  console.log(`已生成 ${zipPath}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(0)}MB）`);
} catch (e) {
  console.warn('压缩失败（不影响免安装目录）：' + e.message);
}

const total = execSync(`powershell -NoProfile -Command "(Get-ChildItem -Recurse '${appDir}' | Measure-Object Length -Sum).Sum"`)
  .toString().trim();
console.log(`目录体积：${(Number(total) / 1024 / 1024).toFixed(0)}MB`);
console.log('打包收尾完成');
