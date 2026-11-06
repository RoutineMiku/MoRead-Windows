# 自托管：把墨读网页版跑在自己的一台小机器上

网页版（GitHub Pages / 任意静态托管）把 `data.json` 存在**浏览器 IndexedDB** 里：换手机、
清「网站数据」、无痕模式都会连书架一起清掉。如果家里有一台常开的小主机（随身 WiFi 棒、
旧手机、NAS、树莓派、迷你主机），可以用仓库自带的 `server/gateway.js` 把同一份网页版
变成「家里共用的书架」：书、书源、进度、书签都存在**那台机器**上，家里任何设备打开都是同一份。

网关是**零依赖单文件**（只用 Node 内置模块，Node >= 18），不需要 Docker、不需要 npm install。

> 这套部署在一台 382MB 内存的 arm64 Debian 小设备上完整验证过：43 本书 / 2447 个书源 /
> 4.37MB 存档，冷启动 24 秒后服务可用，网关常驻内存约 12MB。

---

## 1. 快速开始

```bash
git clone https://github.com/RoutineMiku/MoRead-Windows.git
cd MoRead-Windows
node build/gen-web.js                 # 生成 dist-web/（网页版静态文件）

DATA_DIR=./data \
STATIC_DIR=./dist-web \
PORT=8080 \
node server/gateway.js
```

浏览器打开 `http://<这台机器的IP>:8080/`。设置页的「数据目录」会显示 `DATA_DIR`，
书架空状态与恢复成功提示都会写明「已保存到这台设备」。

**想保留原来的纯本地模式？** 不设 `STATIC_DIR` 就只当抓页代理用；直接把 `dist-web/`
丢到任意静态托管（含 GitHub Pages）也照常是浏览器本地存储 —— 前端会探测 `/api/fs/ping`，
探测不到就自动退回 IndexedDB，不需要切换构建或改代码。

### 环境变量（都可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `STATIC_DIR` | `./web` | 网页版静态目录（填 `./dist-web`） |
| `DATA_DIR` | `./data` | 设备端存档目录 |
| `PROXY_TOKEN` | 空 | `/fetch` 口令；**空 = 不校验**，家里自用可以留空 |
| `ALLOW_HOSTS` | 空 | 只允许抓这些域名（含子域），逗号分隔 |
| `ALLOW_PRIVATE` | `0` | 是否允许抓内网/本机地址（防 SSRF，默认拒绝） |
| `ALLOW_FAKEIP` | `0` | 机器装了 mihomo / Clash 时设 `1`，只放行 `198.18/19` fake-ip 段 |
| `TIMEOUT_MS` / `MAX_BYTES` | `12000` / 6MB | 单次抓页超时与大小上限 |
| `RATE_N` / `RATE_WINDOW_MS` | `180` / 10s | 单 IP 限流 |
| `FS_MAX_BYTES` | 64MB | `/api/fs` 单文件上限 |

---

## 2. 前端是怎么切到「设备存储」的

1. `web/bridge-web.js` 启动时请求同源 `GET /api/fs/ping`；
   只有返回 `{"ok":true,"mode":"device",...}` 才进入设备模式，否则完全按原来的浏览器模式跑。
2. 设备模式下：先把本地 IndexedDB 当缓存读出来（快），再拉服务端的 `data.json` 覆盖内存态，
   其余本地书文件后台慢拉，不挡首屏。
3. 之后每次写盘都会把「持久文件」镜像 `PUT` 到服务端；IndexedDB 只留目录当缓存。
   只同步 `data.json` 与 `books/ covers/ files/`，章节缓存和临时文件仍留在浏览器，不占服务器空间。
4. 写请求可以带 `&if=<上次拿到的 X-Fs-Version>`；服务端版本对不上会回 `409`，
   前端提示「另一台设备刚更新了书架」并重载，**不会静默覆盖别人的改动**。

### `/api/fs` 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/fs/ping` | 探活，返回 `mode` / `root` / `count` / `bytes` |
| GET | `/api/fs/list` | 列出已落盘文件（含版本与大小） |
| GET | `/api/fs?path=/moread/data.json` | 读文件，响应头带 `X-Fs-Version` |
| PUT | `/api/fs?path=...&if=<version>` | 写文件（tmp + rename 原子写），版本不符回 409 |
| DELETE | `/api/fs?path=...` | 删文件 |

路径被限制在 `/moread/` 沙箱内，且只允许 `data.json` 与 `books/ covers/ files/` 这几类，
越界路径一律拒绝；所有写入都做 `path.resolve` 后前缀校验，防目录穿越。

---

## 3. 书源代理与页面注入

浏览器不能直接抓任意站点，在线书源要经过同源转发。网关托管 `index.html` 时会自动注入：

```html
<meta name="moread-proxy" content="/fetch?format=text">
```

`web/bridge-web.js` 在 localStorage 没有手工填过代理地址时就取这个 meta，
所以**手机第一次打开就能搜书，不用填地址**。同一份 `dist-web` 放到 GitHub Pages 时没有这个 meta，
依旧保持「默认不发起任何网络请求」的行为。

`/fetch` 支持两种返回：默认 JSON（小程序 / 调试用），加 `&format=text` 直接返回解码后的正文
（网页版用）。支持 `charset=auto|gbk|utf-8`、`referer`，自动跟随重定向、解 gzip、按编码转 UTF-8。

> 机器装了 mihomo / Clash 这类透明代理时，DNS 常把书源域名解析成 `198.18.x.x` 虚拟 IP，
> 会被 SSRF 防护当成内网地址拒掉（表现为搜索一直 0 命中）。设 `ALLOW_FAKEIP=1` 只放行这一段，
> 真实私网地址照旧拒绝。

---

## 4. 为什么刷新一次就能拿到新版

早期版本给 `app.js` / `bridge.js` 返回 7 天强缓存、文件名却没有版本指纹，
结果服务端换了前端、浏览器还在跑一周前的旧脚本 —— 「修了没生效」的假 bug 很难查。现在：

- 脚本 / 样式 / JSON 一律 `Cache-Control: no-cache` + 内容 ETag，内容没变只回 `304`；
- 网关返回 `index.html` 时给所有本地资源（含动态 `load('app.js')`）加 `?v=<内容 md5>`，
  文件一换 URL 就换，用户**只需刷新一次**，不用清缓存、不用无痕模式；
- `web/sw.js` 改为网络优先，断网才回落缓存。

---

## 5. 开机自启（systemd 示例）

`/etc/systemd/system/moread.service`：

```ini
[Unit]
Description=MoRead self-hosted gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=moread
WorkingDirectory=/srv/moread
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=STATIC_DIR=/srv/moread/dist-web
Environment=DATA_DIR=/srv/moread/data
Environment=PROXY_TOKEN=
ExecStart=/usr/bin/node /srv/moread/server/gateway.js
Restart=always
RestartSec=3
MemoryMax=160M
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/moread/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now moread
systemctl status moread
curl -s localhost:8080/api/fs/ping
```

家里自用可以把 `PROXY_TOKEN` 留空；**只要服务可能暴露到局域网之外，务必设置口令**
并配 `ALLOW_HOSTS` 白名单，否则别人能拿 `/fetch` 当免费代理。

---

## 6. 边界

- `/api/fs` 单文件上限 64MB 且 PUT 会整体读进内存；小内存机器上，超过 30MB 的本地书
  建议改用「阅读」那边的书库目录，不要走网页版上传。
- 局域网 `http://` 不是安全上下文，浏览器不注册 Service Worker，
  所以自托管版没有离线缓存 —— 但书本来就在服务器上，影响很小。若要离线，给站点配 HTTPS。
- 设备存储是「单一权威副本 + 浏览器缓存」，不是多主实时协同；两台设备同时写同一份书架时，
  后写的一方会收到冲突提示并重载。
- 网关只托管墨读网页版，不包含书源内容；书源需要使用者自行导入（书源是内容清单，不是账号）。
