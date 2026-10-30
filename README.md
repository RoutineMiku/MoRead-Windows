# 墨读 · 开源阅读 Windows 版

![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron) ![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?logo=windows) ![License](https://img.shields.io/badge/License-MIT-green)

> 起因： <https://gedoor.github.io/download> 只有 Android 版的「开源阅读 Legado」，没有桌面端。
> 这个项目按 Legado 的使用习惯重写了一版 Windows 桌面端：**本地书 + Legado 书源 + 网页搜书 + 坚果云同步**，
> 存档格式与原版「阅读」双向兼容，可以直接导入原版「阅读」导出的 zip 备份。

**下载**：本仓库 Releases 里的 `MoRead-win32-x64.zip`，解压后双击 `墨读.exe` 即可，免安装、不写注册表、数据跟着程序走。

![书架](docs/screenshots/shot_shelf.png)

## 运行 · Windows

| 方式 | 说明 |
| --- | --- |
| 免安装使用 | 解压 `墨读-win32-x64.zip`，双击 `墨读.exe`（不写注册表，数据在程序目录 `data\`） |
| 开发调试 | `npm install` → `npm start` |
| 打包 | `npm run dist` → `dist/墨读-win32-x64/` + `dist/墨读-win32-x64.zip`（直接复用 `node_modules/electron` 运行时，不需要联网下载） |

> 小坑：如果终端里设了 `ELECTRON_RUN_AS_NODE=1`，Electron 会以纯 Node 方式启动并立刻退出，
> 用 `env -u ELECTRON_RUN_AS_NODE npm start` 即可。


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
- 仅 Windows x64

## 免责声明

软件本身不提供任何书籍内容。书源由使用者自行添加，请遵守目标站点服务条款与当地法律，仅用于个人学习与阅读。

## 截图

| 书架（演示数据，可导入原版阅读备份） | 网页搜书 |
| --- | --- |
| ![书架](docs/screenshots/shot_shelf.png) | ![网页搜书](docs/screenshots/shot_search.png) |

| 阅读器 | 打包成品实读 |
| --- | --- |
| ![阅读器](docs/screenshots/shot_read.png) | ![打包成品](docs/screenshots/shot_pack.png) |

| 书源自动检测 | 换源 / 失效提示 |
| --- | --- |
| ![书源自动检测](docs/screenshots/shot_detect.png) | ![失效与换源](docs/screenshots/shot_reader_err.png) |

## 关于安卓版

安卓版（竖屏功能切到屏幕底部 / 横屏沿用电脑版左侧栏 / 折叠屏开合适配）还在真机调试中，稳定后会单独发布。
本仓库当前只含 Windows 桌面版。

## 许可证

[MIT](LICENSE)
