'use strict';
/**
 * 准备安卓构建环境（只在第一次需要，之后离线可用）。
 *
 * 会把 JDK 17、Android 命令行工具和 Gradle 8.7 下载到 .androidenv/，
 * 再用 sdkmanager 装 platform-tools / android-34 / build-tools;34.0.0。
 * 已经装好的部分会自动跳过，重复执行无副作用。
 *
 * 已经有 Android Studio 的话不必跑这个，直接 `npm run android:build` 即可。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.androidenv');
const isWin = process.platform === 'win32';

const JDK_URL = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/';
const CMDLINE = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip';
const GRADLE = 'https://services.gradle.org/distributions/gradle-8.7-bin.zip';

fs.mkdirSync(ENV, { recursive: true });

function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    console.log('已存在，跳过下载：' + label);
    return;
  }
  console.log('下载 ' + label + ' …（' + url + '）');
  const file = fs.createWriteStream(dest);
  return new Promise((resolve, reject) => {
    const go = u => {
      https.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).href);
        }
        if (res.statusCode !== 200) return reject(new Error('下载失败 ' + res.statusCode));
        const total = Number(res.headers['content-length'] || 0);
        let got = 0, last = 0;
        res.on('data', c => {
          got += c.length;
          const now = Date.now();
          if (now - last > 400) {
            last = now;
            process.stdout.write('\r  ' + (got / 1048576).toFixed(1) + ' MB' +
              (total ? ' / ' + (total / 1048576).toFixed(0) + ' MB' : '') + '   ');
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(() => { console.log('\r  完成'); resolve(); }); });
      }).on('error', reject);
    };
    go(url);
  });
}

function unzip(zip, dest, stripTopLevel) {
  // Windows 用 PowerShell 的 Expand-Archive（需要英文路径，中文路径会乱码）
  const tmp = dest + '.__tmp';
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command',
    '$ProgressPreference="SilentlyContinue"; Expand-Archive -LiteralPath ' +
    JSON.stringify(zip).replace(/(["\\])/g, '\\$1') + ' -DestinationPath ' +
    JSON.stringify(tmp).replace(/(["\\])/g, '\\$1') + ' -Force'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0 && !fs.existsSync(tmp)) throw new Error('解压失败 ' + zip + '：' + (r.stderr || ''));
  if (stripTopLevel) {
    // 压缩包里通常有一层与内容同名的目录
    const inner = fs.readdirSync(tmp).filter(n => fs.statSync(path.join(tmp, n)).isDirectory());
    if (inner.length === 1) {
      const srcDir = path.join(tmp, inner[0]);
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(srcDir, dest, { recursive: true });
    } else {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(tmp, dest, { recursive: true });
    }
  } else {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(tmp, dest, { recursive: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

(async () => {
  /* 1. JDK */
  let jdkDir = null;
  const jdkBase = path.join(ENV, 'jdk');
  if (fs.existsSync(jdkBase)) {
    for (const d of fs.readdirSync(jdkBase)) {
      const p = path.join(jdkBase, d);
      if (fs.existsSync(path.join(p, 'bin', isWin ? 'java.exe' : 'java'))) { jdkDir = p; break; }
    }
  }
  if (!jdkDir) {
    const list = await new Promise((res, rej) => {
      https.get(JDK_URL, r => {
        let s = '';
        r.on('data', d => s += d);
        r.on('end', () => res(s));
      }).on('error', rej);
    });
    const file = (list.match(/OpenJDK17U-jdk_x64_windows_hotspot_[\d.]+_\d+\.zip/g) || []).sort().pop();
    if (!file) throw new Error('没能从镜像列表里找到 JDK 安装包');
    await download(JDK_URL + file, path.join(ENV, 'jdk17.zip'), 'JDK 17');
    unzip(path.join(ENV, 'jdk17.zip'), jdkBase, false);
    jdkDir = path.join(jdkBase, fs.readdirSync(jdkBase).find(d => fs.statSync(path.join(jdkBase, d)).isDirectory()));
  }
  console.log('JDK  ' + jdkDir);

  /* 2. 命令行工具 */
  const ctBin = path.join(ENV, 'cmdline-tools', 'latest', 'bin', isWin ? 'sdkmanager.bat' : 'sdkmanager');
  if (!fs.existsSync(ctBin)) {
    await download(CMDLINE, path.join(ENV, 'cmdtools.zip'), 'Android 命令行工具');
    unzip(path.join(ENV, 'cmdtools.zip'), path.join(ENV, '_ct'), true);
    fs.mkdirSync(path.join(ENV, 'cmdline-tools'), { recursive: true });
    fs.cpSync(path.join(ENV, '_ct'), path.join(ENV, 'cmdline-tools', 'latest'), { recursive: true });
    fs.rmSync(path.join(ENV, '_ct'), { recursive: true, force: true });
  }
  console.log('SDK工具 ' + ctBin);

  /* 3. Gradle */
  let gradleDir = null;
  const gBase = path.join(ENV, 'gradle');
  if (fs.existsSync(gBase)) {
    for (const d of fs.readdirSync(gBase)) {
      if (fs.existsSync(path.join(gBase, d, 'bin', isWin ? 'gradle.bat' : 'gradle'))) { gradleDir = path.join(gBase, d); break; }
    }
  }
  if (!gradleDir) {
    await download(GRADLE, path.join(ENV, 'gradle.zip'), 'Gradle 8.7');
    unzip(path.join(ENV, 'gradle.zip'), gBase, false);
    gradleDir = path.join(gBase, fs.readdirSync(gBase).find(d => fs.statSync(path.join(gBase, d)).isDirectory()));
  }
  console.log('Gradle ' + gradleDir);

  /* 4. SDK 组件 */
  const sdkDir = path.join(ENV, 'sdk');
  const env = Object.assign({}, process.env, { JAVA_HOME: jdkDir, ANDROID_HOME: sdkDir, ANDROID_SDK_ROOT: sdkDir });
  const need = [['platforms', 'android-34'], ['build-tools', '34.0.0']];
  const missing = need.some(([dir, name]) => !fs.existsSync(path.join(sdkDir, dir, name)));
  if (missing) {
    console.log('安装 SDK 组件（platform-tools / android-34 / build-tools;34.0.0）…');
    let r = spawnSync(ctBin, ['--sdk_root', sdkDir, '--licenses'], { input: 'y\n'.repeat(20), encoding: 'utf8', env });
    if (r.status !== 0) console.log('（licenses 阶段输出）', String(r.stdout || '').slice(-300));
    r = spawnSync(ctBin, ['--sdk_root', sdkDir, 'platform-tools', 'platforms;android-34', 'build-tools;34.0.0'], {
      input: 'y\n', encoding: 'utf8', env, stdio: ['pipe', 'inherit', 'inherit']
    });
    if (r.status !== 0) throw new Error('SDK 组件安装失败');
  }
  console.log('SDK  ' + sdkDir);

  console.log('\n环境就绪，接下来：npm run android:build');
})().catch(e => {
  console.error('准备失败：' + (e && e.message || e));
  process.exit(1);
});
