'use strict';
/**
 * 安卓端 UI 端到端仿真的启动器。
 *
 * 直接 `electron test/android-e2e` 会被环境里的 ELECTRON_RUN_AS_NODE 干扰
 * （那个变量会把 electron.exe 变成纯 Node 来跑，require('electron') 就是空的），
 * 所以这里显式把它清掉再拉起真正的 Electron。
 *
 *   npm run android:ui
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDir = path.join(__dirname, 'android-e2e');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const r = spawnSync(exe, [appDir], { cwd: root, env, stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
