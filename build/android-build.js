'use strict';
/**
 * 安卓构建入口：自动找到 JDK / Android SDK / Gradle，然后 gradle assembleDebug|assembleRelease。
 *
 * 优先用环境变量（JAVA_HOME / ANDROID_HOME / GRADLE_HOME，有 Android Studio 时直接可用）；
 * 找不到就退回 .androidenv/ 里随项目带的那套（见 build/prepare-android-env.md）。
 *
 * 用法：
 *   node build/android-build.js          调试版 APK
 *   node build/android-build.js --release 发布版 APK（需要签名配置）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const ENV_DIR = path.join(ROOT, '.androidenv');

const wantRelease = process.argv.includes('--release');
const isWin = process.platform === 'win32';

/* 构建前先把 ui/ 同步进 assets（并补 bridge.js 引用），
   否则改了前端忘记同步，装出来的包界面是新的、功能全是死的（window.mo 不存在）。 */
try {
  require('./sync-android-ui');
} catch (e) {
  console.error('同步安卓前端资源失败：' + (e && e.message));
  process.exit(1);
}

function firstExisting(list) {
  for (const p of list) if (p && existsDir(p)) return p;
  return null;
}
function existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}
function findJava() {
  if (process.env.JAVA_HOME && existsDir(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const base = path.join(ENV_DIR, 'jdk');
  if (existsDir(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d);
      if (fs.existsSync(path.join(p, 'bin', isWin ? 'java.exe' : 'java'))) return p;
    }
  }
  return null;
}
function findSdk() {
  for (const p of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(ENV_DIR, 'sdk')]) {
    if (p && existsDir(path.join(p, 'platforms'))) return p;
  }
  return null;
}
function findGradle() {
  if (process.env.GRADLE_HOME && existsDir(process.env.GRADLE_HOME)) return process.env.GRADLE_HOME;
  const base = path.join(ENV_DIR, 'gradle');
  if (existsDir(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d);
      if (fs.existsSync(path.join(p, 'bin', isWin ? 'gradle.bat' : 'gradle'))) return p;
    }
  }
  // 用系统 gradle 也行
  return null;
}

const java = findJava();
const sdk = findSdk();
const gradle = findGradle();

if (!java) { console.error('没找到 JDK：请设置 JAVA_HOME，或运行 node build/prepare-android.js 准备离线环境'); process.exit(1); }
if (!sdk) { console.error('没找到 Android SDK：请设置 ANDROID_HOME，或运行 node build/prepare-android.js'); process.exit(1); }

/* Gradle 命令：优先本地解压的，其次系统 PATH 里的 gradle */
let gradleExe = null;
let gradleArgs = [];
if (gradle) {
  gradleExe = path.join(gradle, 'bin', isWin ? 'gradle.bat' : 'gradle');
} else {
  const which = spawnSync(isWin ? 'where' : 'which', ['gradle'], { encoding: 'utf8' });
  const line = String(which.stdout || '').split(/\r?\n/).find(s => s.trim());
  if (!line) { console.error('没找到 Gradle：请设置 GRADLE_HOME 或安装 Gradle 8.x'); process.exit(1); }
  gradleExe = line.trim();
}

// Android Gradle Plugin 需要知道 SDK 位置
fs.writeFileSync(path.join(ANDROID, 'local.properties'),
  'sdk.dir=' + sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:') + '\n', 'utf8');

console.log('JDK     ' + java);
console.log('SDK     ' + sdk);
console.log('Gradle  ' + gradleExe);
console.log('目标    ' + (wantRelease ? 'assembleRelease' : 'assembleDebug') + '\n');

const env = Object.assign({}, process.env, {
  JAVA_HOME: java,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle')
});

const task = wantRelease ? 'assembleRelease' : 'assembleDebug';
const r = spawnSync(gradleExe, ['--console=plain', '-p', ANDROID, task], {
  stdio: 'inherit', env, cwd: ANDROID, shell: isWin
});

if (r.status !== 0) {
  console.error('\n构建失败（退出码 ' + r.status + '）');
  process.exit(r.status || 1);
}

const apkDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', wantRelease ? 'release' : 'debug');
if (!existsDir(apkDir)) {
  console.error('没找到产物目录 ' + apkDir);
  process.exit(1);
}
const apks = fs.readdirSync(apkDir).filter(f => f.endsWith('.apk'));
for (const f of apks) {
  const p = path.join(apkDir, f);
  const size = (fs.statSync(p).size / 1048576).toFixed(1);
  console.log('\nAPK  ' + p + '  (' + size + ' MB)');
}
console.log('\n安装到手机： adb install -r "' + path.join(apkDir, apks[0] || '') + '"');
