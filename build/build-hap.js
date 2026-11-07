#!/usr/bin/env node
'use strict';
/**
 * 打鸿蒙 HAP（OpenHarmony SDK + hvigor，Windows / macOS / Linux 通用）
 *
 *   node build/build-hap.js            # 构建 + 用 SDK 自带 CA 自签（OpenHarmony 测试签名）
 *   node build/build-hap.js --no-sign  # 只出未签名 hap，交给 DevEco / 你自己的证书签
 *   node build/build-hap.js --own      # 用 harmony/signing/ 里你自己的证书签
 *
 * 产物：
 *   dist/MoRead-harmony-<ver>.hap               未签名
 *   dist/MoRead-harmony-<ver>-signed.hap        已签名（verify-app 通过才输出）
 *
 * 前置：
 *   1. 装 OpenHarmony SDK（API 12），路径写在 harmony/local.properties 的 sdk.dir，
 *      或环境变量 OHOS_SDK_HOME。目录结构需为 <sdk>/12/{ets,js,native,previewer,toolchains}
 *   2. harmony/ 下执行过一次 npm i（装 hvigor），或用 HUIGOR_DIR 指定
 *   3. 有 JDK 17：JAVA_HOME 或本仓库 .androidenv/jdk/*
 *
 * --own 需要的文件（放 harmony/signing/）：
 *   app.p12  密钥库  app.cer 证书链(pem)  app.p7b profile
 *   环境变量：KEY_ALIAS(默认 debugKey) / KEY_PWD / KS_PWD
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HARMONY = path.join(ROOT, 'harmony');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VER = pkg.version;
const [maj, min, pat] = VER.split('.').map(n => parseInt(n, 10) || 0);
const CODE = maj * 10000 + min * 100 + pat;

const args = process.argv.slice(2);
const NO_SIGN = args.includes('--no-sign');
const OWN_SIGN = args.includes('--own');

const log = (...a) => console.log(...a);
const die = (msg) => { console.error('\n✗ ' + msg); process.exit(1); };

/* ---------------- 环境探测 ---------------- */

function readLocalProp(key) {
  const p = path.join(HARMONY, 'local.properties');
  if (!fs.existsSync(p)) return '';
  const m = fs.readFileSync(p, 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':') : '';
}

function findSdk() {
  const cands = [
    process.env.OHOS_SDK_HOME,
    readLocalProp('sdk.dir'),
    'C:/ohos-sdk',
    path.join(ROOT, '.cache', 'ohos-sdk'),
    '/opt/ohos-sdk'
  ].filter(Boolean);
  for (const c of cands) {
    const api = path.join(c, '12');
    if (fs.existsSync(path.join(api, 'ets', 'oh-package.json5')) || fs.existsSync(path.join(api, 'ets', 'oh-uni-package.json'))) {
      return { root: c, api: '12' };
    }
  }
  return null;
}

function findJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const base = path.join(ROOT, '.androidenv', 'jdk');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const h = path.join(base, d);
      if (fs.existsSync(path.join(h, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) return h;
    }
  }
  // PATH 里找
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.dirname(path.dirname(dir));
  }
  return null;
}

function findHvigor() {
  const p = path.join(HARMONY, 'node_modules', '@ohos', 'hvigor', 'bin', 'hvigor.js');
  return fs.existsSync(p) ? p : null;
}

const sdk = findSdk();
if (!sdk) die('找不到 OpenHarmony SDK。请在 harmony/local.properties 写 sdk.dir=<SDK 根目录>，或设环境变量 OHOS_SDK_HOME。\n  目录结构应该是 <sdk>/12/ets、<sdk>/12/toolchains …');
const javaHome = findJavaHome();
if (!javaHome) die('找不到 JDK（需要 17+）。请设 JAVA_HOME。');
const hvigor = findHvigor();
if (!hvigor) die('找不到 hvigor。先在 harmony/ 里执行：npm i --registry=https://repo.harmonyos.com/npm/');

const JAVA = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const KEYTOOL = path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
const LIB = path.join(sdk.root, sdk.api, 'toolchains', 'lib');
const SIGN_TOOL = path.join(LIB, 'hap-sign-tool.jar');
const childEnv = Object.assign({}, process.env, {
  JAVA_HOME: javaHome,
  PATH: path.join(javaHome, 'bin') + path.delimiter + (process.env.PATH || '')
});

function run(cmd, argv, opts) {
  return execFileSync(cmd, argv, Object.assign({ stdio: 'inherit', env: childEnv, cwd: ROOT }, opts || {}));
}

/* ---------------- 1. 同步前端资源 ---------------- */

log('① 同步网页资源 → harmony/entry/src/main/resources/rawfile/web');
run(process.execPath, [path.join(__dirname, 'sync-harmony.js')], { stdio: 'inherit' });

/* ---------------- 2. hvigor 构建 ---------------- */

log('\n② hvigor assembleHap');
const localProp = path.join(HARMONY, 'local.properties');
if (!fs.existsSync(localProp) || readLocalProp('sdk.dir') !== sdk.root.replace(/\\/g, '/')) {
  fs.writeFileSync(localProp, `sdk.dir=${sdk.root.replace(/\\/g, '/')}\nnodejs.dir=${path.dirname(process.execPath).replace(/\\/g, '/')}\n`);
}
try {
  run(process.execPath, [
    hvigor,
    '--mode', 'module',
    '-p', 'product=default',
    '-p', 'module=entry@default',
    '-p', 'buildMode=release',
    'assembleHap'
  ], { cwd: HARMONY });
} catch (e) {
  die('hvigor 构建失败，详见上面的日志。');
}

const outDir = path.join(HARMONY, 'entry', 'build', 'default', 'outputs', 'default');
const unsigned = ['entry-default-unsigned.hap', 'entry-default.hap', 'entry-default-signed.hap']
  .map(f => path.join(outDir, f))
  .find(f => fs.existsSync(f));
if (!unsigned) die('没找到 hap 产物：' + outDir);

fs.mkdirSync(DIST, { recursive: true });
const unOut = path.join(DIST, `MoRead-harmony-${VER}.hap`);
fs.copyFileSync(unsigned, unOut);
log(`   ✓ ${path.relative(ROOT, unOut)}  ${(fs.statSync(unOut).size / 1048576).toFixed(1)}MB`);

if (NO_SIGN) {
  log('\n完成（未签名）。用 DevEco Studio 打开 harmony/ 做「自动签名」，或：');
  log('  java -jar hap-sign-tool.jar sign-app -keyAlias <别名> -appCertFile <证书链.pem> -profileFile <profile.p7b> \\');
  log('       -inFile ' + path.relative(ROOT, unOut) + ' -outFile MoRead-signed.hap \\');
  log('       -keystoreFile <你的.p12> -keyPwd <密码> -keystorePwd <密码>');
  process.exit(0);
}

/* ---------------- 3. 签名 ---------------- */

const signDir = path.join(HARMONY, 'build', 'sign');
fs.mkdirSync(signDir, { recursive: true });

const appJson = fs.readFileSync(path.join(HARMONY, 'AppScope', 'app.json5'), 'utf8');
const bundleName = (appJson.match(/"bundleName"\s*:\s*"([^"]+)"/) || [, 'cn.moread.harmony'])[1];

function signWithOwn() {
  const p12 = path.join(HARMONY, 'signing', 'app.p12');
  const cer = path.join(HARMONY, 'signing', 'app.cer');
  const p7b = path.join(HARMONY, 'signing', 'app.p7b');
  for (const f of [p12, cer, p7b]) {
    if (!fs.existsSync(f)) die('--own 需要 ' + path.relative(ROOT, f));
  }
  const out = path.join(DIST, `MoRead-harmony-${VER}-signed.hap`);
  run(JAVA, ['-jar', SIGN_TOOL, 'sign-app',
    '-keyAlias', process.env.KEY_ALIAS || 'debugKey',
    '-signAlg', 'SHA256withECDSA', '-mode', 'localSign',
    '-appCertFile', cer, '-profileFile', p7b,
    '-inFile', unOut, '-outFile', out,
    '-keystoreFile', p12,
    '-keyPwd', process.env.KEY_PWD || '123456',
    '-keystorePwd', process.env.KS_PWD || '123456']);
  return out;
}

function signWithSdkCa() {
  const tplPath = path.join(LIB, 'UnsgnedReleasedProfileTemplate.json');
  if (!fs.existsSync(tplPath) || !fs.existsSync(SIGN_TOOL)) {
    die('SDK 里缺签名工具（' + LIB + '）。请确认 toolchains 组件完整。');
  }
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  const leafPem = tpl['bundle-info']['distribution-certificate'];
  const now = Math.floor(Date.now() / 1000);
  tpl['bundle-info']['bundle-name'] = bundleName;
  tpl['version-name'] = VER;
  tpl['version-code'] = CODE;
  tpl['validity'] = { 'not-before': now - 86400, 'not-after': now + 10 * 365 * 86400 };
  const profJson = path.join(signDir, 'profile.json');
  fs.writeFileSync(profJson, JSON.stringify(tpl, null, 2), 'utf8');

  // 证书链：应用证书（模板里那张）+ 中间 CA + 根 CA，都从 SDK 的 p12 里导
  const chain = path.join(signDir, 'app.cer');
  fs.writeFileSync(chain, leafPem.endsWith('\n') ? leafPem : leafPem + '\n');
  for (const alias of ['openharmony application ca', 'openharmony application root ca']) {
    const tmp = path.join(signDir, 'ca-' + alias.replace(/\s+/g, '-') + '.pem');
    run(KEYTOOL, ['-exportcert', '-alias', alias, '-keystore', path.join(LIB, 'OpenHarmony.p12'),
      '-storetype', 'PKCS12', '-storepass', '123456', '-rfc', '-file', tmp], { stdio: 'pipe' });
    fs.appendFileSync(chain, fs.readFileSync(tmp));
  }

  const p7b = path.join(signDir, 'app.p7b');
  run(JAVA, ['-jar', SIGN_TOOL, 'sign-profile',
    '-keyAlias', 'openharmony application profile release',
    '-signAlg', 'SHA256withECDSA', '-mode', 'localSign',
    '-profileCertFile', path.join(LIB, 'OpenHarmonyProfileRelease.pem'),
    '-inFile', profJson, '-keystoreFile', path.join(LIB, 'OpenHarmony.p12'),
    '-outFile', p7b, '-keyPwd', '123456', '-keystorePwd', '123456']);

  const out = path.join(DIST, `MoRead-harmony-${VER}-signed.hap`);
  run(JAVA, ['-jar', SIGN_TOOL, 'sign-app',
    '-keyAlias', 'openharmony application release',
    '-signAlg', 'SHA256withECDSA', '-mode', 'localSign',
    '-appCertFile', chain, '-profileFile', p7b,
    '-inFile', unOut, '-outFile', out,
    '-keystoreFile', path.join(LIB, 'OpenHarmony.p12'),
    '-keyPwd', '123456', '-keystorePwd', '123456']);

  run(JAVA, ['-jar', SIGN_TOOL, 'verify-app', '-inFile', out,
    '-outCertChain', path.join(signDir, 'verify.cer'),
    '-outProfile', path.join(signDir, 'verify.p7b')]);
  return out;
}

log('\n③ 签名');
const signed = OWN_SIGN ? signWithOwn() : signWithSdkCa();
log(`   ✓ ${path.relative(ROOT, signed)}  ${(fs.statSync(signed).size / 1048576).toFixed(1)}MB`);

log('\n完成。安装：hdc install ' + path.relative(ROOT, signed));
log('说明：这份用的是 OpenHarmony SDK 自带的测试 CA，能装在 OpenHarmony 开发板 / 模拟器 / 允许侧载的设备上。');
log('      零售版 HarmonyOS NEXT 手机只认华为签发的证书 —— 那种情况请用 DevEco 打开 harmony/ 做「自动签名」（免费，绑你自己的设备），');
log('      或把 harmony/signing/ 换成 DevEco 导出的 p12/cer/p7b 后跑 node build/build-hap.js --own。');
