# 墨读 · 阅读器（Windows + Android）

![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron) ![Android](https://img.shields.io/badge/Android-8.0%2B-3DDC84?logo=android) ![License](https://img.shields.io/badge/License-MIT-green)

> 起因： <https://gedoor.github.io/download> 只有 Android 版的「开源阅读 Legado」，没有桌面端。
> 这个项目按 Legado 的使用习惯重写了一版：**本地书 + Legado 书源 + 网页搜书 + 坚果云同步**，
> 存档格式与原版「阅读」双向兼容。现在同时有 Windows 桌面版和安卓版，两边共用同一套界面与同一份书源/格式逻辑。

| 平台 | 入口 |
| --- | --- |
| Windows | `dist/墨读-win32-x64.zip` 解压后双击 `墨读.exe` |
| Android | `dist/墨读-android.apk` 直接安装（覆盖安装即可升级） |

![书架](docs/screenshots/shot_shelf.png)

## 运行 · Windows

| 方式 | 说明 |
| --- | --- |
| 免安装使用 | 解压 `墨读-win32-x64.zip`，双击 `墨读.exe`（不写注册表，数据在程序目录 `data\`） |
| 开发调试 | `npm install` → `npm start` |
| 打包 | `npm run dist` → `dist/墨读-win32-x64/` + `dist/墨读-win32-x64.zip`（直接复用 `node_modules/electron` 运行时，不需要联网下载） |

> 小坑：如果终端里设了 `ELECTRON_RUN_AS_NODE=1`，Electron 会以纯 Node 方式启动并立刻退出，
> 用 `env -u ELECTRON_RUN_AS_NODE npm start` 即可。

## 运行 · Android

| 方式 | 说明 |
| --- | --- |
| 直接用 | 手机装上 `dist/墨读-android.apk`（Android 8.0 以上，debug 签名） |
| 自己编译 | `npm run android:build` → `android/app/build/outputs/apk/debug/app-debug.apk` |
| 不带 Android Studio | 第一次跑 `node build/prepare-android.js` 会下载好 JDK / SDK / Gradle 到 `.androidenv/`（约 500MB，之后离线可用） |
| 无手机验证 | `npm run android:ui` 在电脑上用真实 Chromium 按真机尺寸跑一遍界面（157 项检查，见下文） |
| 无手机验证（逻辑层） | `npm run android:sim` 在 Node 里把安卓那条链路跑一遍（详见「安卓实现原理」） |

> 安装时若提示「未知来源」，在系统设置里允许来自此来源的安装即可（debug 包没有应用商店签名）。

### 横屏 / 竖屏 / 折叠屏

| 形态 | 布局 |
| --- | --- |
| **竖屏**（手机普通握持） | 功能切换在**屏幕底部**，七个入口横排；弹窗改成底部抽屉；书架三列；阅读器底部工具栏可横向滑动 |
| **横屏** | 沿用**电脑版的左侧功能栏**，内容区占满宽度，书源/搜索工具条横向排布 |
| **横屏 + 最小宽度 ≥ 600dp**（平板 / 折叠屏展开后横过来） | 左侧宽栏 + 更宽松的栅格，正文最大宽度放宽到 820px |
| **竖屏 + 最小宽度 ≥ 600dp**（平板 / 折叠屏展开后竖着拿） | 导航**仍在底部**（竖向握持时底部比侧边顺手），栅格放宽到 4~5 列，正文居中限宽 680px |

判定规则：**竖屏一律用底部导航，横屏一律用左侧栏**，最小宽度只影响栅格密度，不改变导航位置。
方向由页面拿 `window.innerWidth/innerHeight` 自己判——原生推送可能丢、可能慢一拍，视口尺寸不会说谎；
最小宽度（折叠屏折叠/展开会变）反过来只信原生。页面还会自己监听 `resize` / `orientationchange` / `visualViewport`，
旋转后连补三次，避免拿到旋转前的旧尺寸。

页面把结果写成 `<html data-layout="portrait|landscape|wide" data-sw="compact|medium|expanded">`，剩下的交给 CSS。
**Activity 不重建**（`configChanges` 覆盖了 `orientation`、`smallestScreenSize`、`screenLayout`），正在读的章节不会丢。
顶部/底部的安全区（刘海、手势条）通过 `env.insets` 传给页面，写成 `--sa-top` / `--sa-bottom` 等变量。

**屏幕圆角（R 角）**：Android 12 以上从 `RoundedCorner` 读出四角半径，写成 `--corner-tl/tr/bl/br` 和 `--corner`；
顶栏、竖屏底部导航、横屏侧栏、悬浮按钮、阅读区左右都会按它让开，内容不会被圆角切掉。

### 安卓上的操作逻辑

- **返回键 / 返回手势**按层级消费：弹窗 → 目录抽屉 → 全屏 → 退出阅读器 → 回到书架 → 再按一次退出应用
- 在其他 App 里用「墨读」打开 `.txt` / `.epub` 会自动导入，打开备份 `.zip` 会直接进入恢复确认
- 阅读时自动保持屏幕常亮，退出阅读恢复
- 朗读走原生 `TextToSpeech`（安卓 WebView 的 `speechSynthesis` 不出声），音色列表来自手机已装的语音引擎
- 导入/导出走系统文件管理器（SAF），不需要存储权限；数据都在应用私有目录
- 横竖屏切换、折叠屏开合不会中断阅读；全屏按钮调用系统沉浸式，状态栏/导航栏一起隐藏

## 安卓实现原理

安卓版不是把逻辑重写一遍，而是让桌面版那套**已经用真机备份验证过**的代码原样跑起来。

### 一句话：给 WebView 装一个 Node

`src/store.js` `zip.js` `net.js` `webdav.js` `legado.js` `parse.js` 加起来不到 700 行，
依赖只有 `fs` / `path` / `http` / `https` / `zlib` / `Buffer` —— 全是 Node 标准库。
所以做法是补一层最小的 Node 运行时（`android/nodepoly/runtime.js`），把这六个模块原封不动塞进 WebView：

| 需要 | 补出来的东西 |
| --- | --- |
| `Buffer` | `NodeBuffer extends Uint8Array`，够用即可（`readUInt32LE` / `toString('utf8')` / `slice` / `subarray`） |
| `fs` / `path` / `os` / `util` / `querystring` / `stream` / `events` | 同步 API 的小实现，`EventEmitter` 自己写 |
| `zlib` | 转调原生 `MoFiles.zlib`（inflateRaw / gunzip / deflate / gzip） |
| `http` / `https` | 转调 OkHttp（`MoNet`） |
| `require()` | CommonJS 外壳，模块源码内联进 `nodebundle.js` |

打包由 `build/gen-nodebundle.js` 完成：把 `runtime.js` 和六个模块源码内联成
`android/app/src/main/assets/nodebundle.js`（约 90 KB）。
页面里 `<script src="bridge.js"></script>` 在安卓上会被 `shouldInterceptRequest` 换成它，
桌面版 `ui/bridge.js` 是空文件 —— 所以同一份 `ui/` 两边都能用，**界面和书源逻辑只有一份**。

### 桥：一次调用 = 一个 JSON 字符串

`MoBridge.callSync(name, argsJson)` / `callFire(name, argsJson)`，按前缀分发：
`http.` / `zlib.` / `file.` / `dialog.` / `tts.` / `env.` / `app.` / `win.` / `ui.`，
失败统一返回 `{__error: "中文原因"}`，直接弹给使用者看。

几个专门为安卓处理的地方：

- **Binder 1MB 限制**：大文件不穿桥。`file.read` 超过 512KB（或判定为二进制）时返回
  `{tooBig:true, abs:"file://..."}`，JS 端改用同步 `XMLHttpRequest` 直接读，避开 `TransactionTooLargeException`。
- **PROPFIND / MKCOL**：`HttpURLConnection` 不支持这两个方法（坚果云要用），所以网络层用 OkHttp 4.12。
- **过期证书**：不少小说站证书过期或自签，`MoNet` 备一个宽松 `X509TrustManager` 的 client，失败时降级重试。
- **TTS**：安卓 WebView 的 `speechSynthesis` 存在但不出声，于是把 `speechSynthesis` / `SpeechSynthesisUtterance`
  polyfill 成原生 `TextToSpeech`，`ui/app.js` 里的朗读逻辑一行没改。
- **文件选择**：`ACTION_OPEN_DOCUMENT` / `ACTION_CREATE_DOCUMENT`（SAF），不申请存储权限，数据都在应用私有目录。

### 不重建 Activity

`AndroidManifest.xml` 里 `configChanges` 覆盖了
`orientation|screenSize|screenLayout|smallestScreenSize|...`，配合 `resizeableActivity=true`、
`screenOrientation="user"`：横竖屏切换、折叠屏开合都**不重建 Activity**，只在 `onConfigurationChanged`
里把新形态推给页面。正在读的章节、滚动位置、没保存的输入都不会丢。

### 没有手机也能验证

有两层，都不需要手机或模拟器：

**① 界面层 `npm run android:ui`（`test/android-e2e/`）**

Electron 里开一个**真实的 Chromium**，加载**真实的 `ui/index.html`**，用 Node 实现一份
`MoNativeBridge`（等价于 `MainActivity` 注入的原生层），然后按真机尺寸开窗口：

| 场景 | 检查内容 |
| --- | --- |
| 手机竖屏 393×873 / 360×780、手机横屏 873×393 | 形态标记、功能栏位置（底部 / 左侧）、七个入口是否齐全、触摸目标 ≥ 40px |
| 折叠屏展开竖握 717×1024 / 横握 1024×717、平板竖屏 / 横屏 | 同上，外加宽度档位 compact / medium |
| 同一个窗口里改尺寸模拟旋转 | 旋转后形态与功能栏位置是否跟着变、按钮是否仍然可点 |
| 兜底：兼容层脚本没被替换 / 完全没执行 | 布局是否仍然正确、桌面窗口按钮是否仍然被摘掉 |

每个场景都会做**命中测试**（`elementFromPoint` 打在按钮中心，看最顶层元素是不是它）
和**真点击**（点「设置」→ 视图切过去、高亮跟上 → 点回书架）。这两个检查就是为了抓
「界面画出来了但点什么都没反应」「按钮被挤出屏幕」这类问题——它们不会抛异常，只靠肉眼很难发现。

**② 逻辑层 `npm run android:sim`（`test/android-sim.js`）**

在 Node 里把原生那几个方法重新实现一遍（`fs` / `zlib` / 弹窗 / 同步 HTTP 走子进程），
再用 `vm` 跑真正的 `nodebundle.js`。33 项检查，其中包括：解析真实备份得到
**43 本书 / 2916 个书源 / 1 条书签**（与桌面版完全一致）、一次真实联网抓取。

## 功能

### 书架
- 拖入 `.txt` / `.epub` 自动导入；TXT 支持 UTF-8/GBK 探测 + 「第 X 章」分章，EPUB 走 OPF/spine + nav/ncx
- 分组、本地/在线筛选、继续阅读卡片、进度条
- 右键或「⋯」：归组、更新目录、**换源**、移出书架

### 书源（对标 Legado）
- 导入 Legado 书源 JSON（文件或粘贴），字段映射 `bookSourceName` `bookSourceUrl` `searchUrl` `ruleSearch` `ruleBookInfo` `ruleToc` `ruleContent`
- 分组、启停、单源测试（结果数/耗时/失败原因）、导出全部
- 规则支持：
  - CSS + `@text` / `@href` / `@src` / `@html`，如 `#list dd a@href`
  - Legado 旧语法 `class.item@tag.h3@tag.a@text`（自动转 `.item h3 a`），支持 `.0` / `.-1` 取位、`!0` / `!-1` / `!0:2` 剔除
  - **`text.可见文字@href`**（`text.下一页@href`、`text.点击阅读@href` 这类原版高频写法）
  - **JSON 规则 `@JSon:` / `$` 路径**，含 `..` 递归下降与 `[*]` 通配：`@JSon:$.data.volumes..chapters[*]`
  - `{{表达式}}` / 规则后接 `@js:`（如 `@JSon:$.id@js:"chapter/"+result+"/content"`）
  - 后处理 `##正则`（删除）/ `##正则##替换` / `###正则`（只取匹配）
  - `||` 备选规则、`&&` 并列取值
- 目录抓取：规则解析 → 详情页「目录/全部章节」入口跟随 → 常见目录容器兜底 → `ruleToc.nextTocUrl` 自动翻页（最多 20 页）
- 正文抓取：规则命中 + 常见容器 + 整页最长文本块，多路候选按「正文质量分」择优，自动剔除导航/广告行
- 站点证书过期/自签名时自动降级重试（不少小说站证书早过期，不降级会整站打不开）
- 打不开时会说清原因：`404 地址失效` / `403 站点拒绝访问（可能有反爬验证）` / `请求超时`，阅读页直接给「换源继续读」按钮
- 多源并发搜索（1~6 可调），先返回先显示
- **坚果云云同步**：一键上传/下载 `bookSource.json`，和手机上的原版「阅读」共用同一份书源
- **自动检测分级**：对书源批量跑真实搜索，抽样抓目录和正文，把书源分成 **优质 / 有效 / 较差 / 无用** 四类
  - 支持检测范围（当前筛选 / 已启用 / 全部）、并发数、是否深检；有进度条、可中断，中途结果实时落盘
  - 深度检测会给出每个源的章节数与正文字数；失败原因人话化（`域名解析失败` / `404 地址失效` / `403 反爬` / `请求超时`）
  - 检测完一键「按质量分组」（优质源 / 可用源 / 较差源 / 失效源，原始分组会备份、可还原），也能一键停用无用源
  - 之后搜索和「换源」会自动优先优质源、跳过无用源，换源从「逐个扫几百个源」变成只扫几十个有效源

### 网页搜书（内置浏览器）
- 左侧「网页」是一个内嵌浏览器：地址栏 / 前进后退 / 刷新 / 搜索引擎（必应、百度、搜狗、360）
- 输入书名回车 → 直接搜索；粘贴网址 → 打开站点
- **嗅探本页**：自动分析当前页面
  - 找出目录（章节链接成组识别，自动生成 CSS 规则）
  - 找出正文容器（按文本长度 + 链接密度打分）
  - 列出页面上的书籍链接，一键「加书架」
- 加入书架时会自动跟进「查看目录」链接、抓第一章嗅探正文规则；之后就是一本正常的在线书（记进度、换源、朗读都支持）
- 抓不到的站点会退回「最长文本块」兜底提取

### 阅读
- 滚动 / 分页（真实按可视高度切页，显示「第 x/y 页」）
- 字号、行距、宋体/黑体、四套主题（纸白/米黄/浅绿/夜间）
- 目录抽屉、章节跳转、进度保存、书签
- **朗读（TTS）**：Windows 系统语音，可选音色（Huihui / Kangkang / Yaoyao 等）、语速、音调、试听；逐段高亮、读完自动下一章
- **全屏**：右上角按钮或 `F11` / `F`；退出全屏再按一次，或 `Esc`
- 左上角「书架」返回：从搜索/书签/历史任意视图进阅读器，返回都会回到书架
- **换源**：按书名在书源里并发搜索（默认取 40 个，优先优质/有效源，自动跳过检测为「无用」的源），列出同名书，切换后按章节标题匹配原进度；每个源 8 秒超时，不被卡死的源拖住

### 真实备份实测（原版「阅读」导出，2916 个书源 / 43 本书）

用一份真机备份做过端到端验证：

- 导入：43 本书全部识别、2916 个书源导入去重为 2447 个、41 本阅读进度、1 条书签、分组映射正常
- 阅读：随机抽 15 本，6 本能正常拉到目录与正文（1088 章 / 104 段、1411 章 / 141 段等）；其余多数是站点已关停（域名不解析、404）或有 Cloudflare 反爬验证，这类原版「阅读」同样打不开
- 全链路：多源搜索 40 个源命中 163 条结果 → 加书架自动取到 1088 章 → 打开第一章 123 段正文；失效书「换源」能搜到同名书并定位到原章节

### 存档与备份（与原版互通）
- 进度、书签、历史、统计（时长/字数/连读天数）本地落盘，跨进程重启不丢
- **导出 zip**：内含
  - `moread.json`（墨读完整存档，无损还原）
  - `bookSource.json` / `bookshelf.json` / `bookmark.json` / `readRecord.json` / `bookGroup.json`（Legado 字段，原版「阅读」可直接导入这个 zip）
  - 可选 `files/` 里的本地书原文件
- **导入**：墨读 zip、原版「阅读」备份 zip、单个书源 JSON 都能识别；支持「合并 / 覆盖」
  - 原版备份里的手机本地书（`file:///storage/...`）无法跨设备还原，会自动跳过并提示数量
- **坚果云（WebDAV）**：
  - 服务器、账号、应用密码、远程目录（自动创建）
  - 连接测试、立即备份、云端备份列表（恢复 / 删除）
  - 自动备份：每 6/12/24/72 小时一份，只保留最近 N 份
  - 上传/下载书源
  - 兼容坚果云、Nextcloud、群晖等标准 WebDAV

## 快捷键

| 操作 | 按键 |
| --- | --- |
| 搜索 / 导入 | `Ctrl+F` / `Ctrl+O` |
| 上/下一章（分页模式为翻页） | `←` `→` `PgUp` `PgDn` |
| 滚动 | `↑` `↓` |
| 字号 | `+` `-` |
| 主题 / 目录 / 书签 / 退出 | `T` / `C` / `B` / `Esc` |

## 目录结构

```
src/main.js      Electron 主进程：窗口/托盘/IPC、便携模式、WebDAV、备份打包
src/preload.js   contextBridge 暴露的最小 API
src/store.js     存档：JSON 持久化、原子写入、备份/恢复、章节缓存
src/legado.js    Legado 备份格式互转（bookSource / bookshelf / bookmark / readRecord）
src/webdav.js    WebDAV 客户端（PROPFIND/PUT/GET/MKCOL/DELETE，Basic 认证）
src/net.js       抓网页（绕过 CORS、重定向、gzip、GBK）
src/parse.js     TXT 编码探测+分章 / EPUB 解析
src/zip.js       zip 读 + 写（备份打包用）
ui/engine.js     书源规则引擎 + 任意网页自动识别（目录/正文/书籍链接）
ui/detect.js     书源自动检测分级（优质/有效/较差/无用）
ui/app.js        界面逻辑（书架/书源/网页/阅读器/设置）
ui/style.css     样式（含阅读器四套主题）
build/gen_icon.py 纯 Python 生成图标
build/pack.js     打包：组装运行时 + 应用代码（先建英文目录再改中文名，避免编码问题）
build/finish.js   打包收尾（裁剪语言包、写便携标记与说明、压缩 zip）
test/             本地模拟站点 + 模拟 WebDAV + 备份/格式测试
test/e2e-real.js  真实备份端到端验证（导入 → 抽书 → 联网拉目录/正文 → 出报告）
test/probe.js     把任意 JS 片段放进真实应用里跑（调试规则/界面用）

android/                       安卓版（Kotlin + WebView，共用上面的 src/ 与 ui/）
├─ app/src/main/java/cn/moread/app/
│  ├─ MainActivity.kt  WebView 配置、返回键层级、横竖屏/折叠屏形态、沉浸式、SAF
│  ├─ MoBridge.kt      JS↔原生桥：callSync / callFire，按 http. zlib. file. dialog. tts. 等前缀分发
│  ├─ MoNet.kt         OkHttp 封装（PROPFIND/MKCOL、过期证书降级）
│  ├─ MoFiles.kt       私有目录文件读写 + zlib（inflate/gzip/deflate）
│  ├─ MoTts.kt         原生 TextToSpeech
│  └─ util/Ext.kt      Base64 小工具
├─ app/src/main/assets/ui/       由 build 任务从 ../ui 同步过来（同一份界面）
├─ app/src/main/assets/nodebundle.js  生成的 Node 兼容层 + 六个业务模块
├─ nodepoly/runtime.js           最小 Node 运行时（Buffer / fs / path / zlib / http / require）
└─ build/gen-nodebundle.js       打包脚本
```

## 便携模式

打包目录里有一个 `portable.txt`。存在时，数据写在 `墨读.exe` 同级的 `data\` 下（书架、书源、缓存、会话）。
换电脑时整个文件夹拷走即可。删掉 `portable.txt` 就退回 `%APPDATA%\墨读\`。

## 已知限制

- 书源规则是**常用子集**：`@xpath:`、`<js>...</js>` 老式脚本块、`@get:` / `{{book.name}}` 变量、发现页规则、需要登录/Cookie 的站点都不支持
- 站点被 Cloudflare 等反爬拦截（返回「Just a moment...」）或整页 JS 混淆时无法抓取，只能换源
- 书源是社区维护的，失效很快：实测一份备份里约 4 成站点已关停或改版，这是书源本身的问题，用「换源」或「网页」视图补新源
- 网页嗅探靠启发式规则，不是所有站点都准；个别站点需要手动在「书源」里微调生成的规则
- 分页模式按段落切页（不拆段），超长段落会整段换页
- 书源密码/坚果云密码以明文存在本地 `data.json`（与原版「阅读」一致，未做加密）
- 桌面版仅 Windows x64；安卓版要求 Android 8.0（API 26）以上
- 安卓版目前是 debug 签名，没有上架应用商店；升级直接覆盖安装即可，卸载会清掉本地书与进度（先导出 zip）

## 免责声明

软件本身不提供任何书籍内容。书源由使用者自行添加，请遵守目标站点服务条款与当地法律，仅用于个人学习与阅读。

## 截图

| 书架（导入真实 Legado 备份） | 网页搜书 |
| --- | --- |
| ![书架](docs/screenshots/shot_shelf.png) | ![网页搜书](docs/screenshots/shot_search.png) |

| 阅读器 | 打包成品实读 |
| --- | --- |
| ![阅读器](docs/screenshots/shot_read.png) | ![打包成品](docs/screenshots/shot_pack.png) |

| 书源自动检测 | 换源 / 失效提示 |
| --- | --- |
| ![书源自动检测](docs/screenshots/shot_detect.png) | ![失效与换源](docs/screenshots/shot_reader_err.png) |

## 许可证

[MIT](LICENSE)
