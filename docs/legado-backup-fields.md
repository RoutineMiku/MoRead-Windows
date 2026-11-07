# 原版「阅读 Legado」备份字段说明书

> 依据：本机实测备份 `backup2026-10-29-PLK110.zip`（43 本书、2916 个书源、49 条阅读记录、1 条书签、6 个分组），
> 并对照 Legado 的 `Book.kt` / `BookChapter.kt` / `Bookmark.kt` / `ReadRecord.kt` / `BookGroup.kt`。
> 本文回答两个问题：**这些字段原本是什么意思**、**墨读导入时怎么用**。

---

## 一、备份 zip 里到底有什么

| 文件 | 实测大小 | 内容 | 墨读处理 |
|---|---|---|---|
| `bookSource.json` | 18 MB | 书源规则（2916 条） | ✅ 全部导入 |
| `bookshelf.json` | 59 KB | 书架（43 本） | ✅ 全部导入（本地书除外） |
| `bookmark.json` | 1.2 KB | 书签 | ✅ 导入 |
| `readRecord.json` | 6 KB | 阅读记录（只有书名+时间） | ✅ 导入统计 |
| `bookGroup.json` | 846 B | 分组定义 | ✅ 导入（负数系统组跳过） |
| `readConfig.json` | 6.7 KB | 阅读界面配置（字号/背景/翻页…） | ⛔ 不导入（我们的阅读器有自己的一套） |
| `txtTocRule.json` | 9 KB | 本地 txt 目录正则 | ⛔ 暂不需要 |
| `searchHistory.json` | 6.8 KB | 搜索历史 | ⛔ 不导入（避免把别人的搜索词带进来） |
| `rssSources.json` / `httpTTS.json` / `dictRule.json` / `keyboardAssists.json` / `shareReadConfig.json` / `themeConfig.json` / `servers.json` / `config.xml` | — | 订阅源 / 在线朗读 / 词典 / 输入法 / 分享配置 / 主题 / 同步服务 | ⛔ 不导入 |

**关键结论：备份里没有「章节列表」。** 只有 `totalChapterNum`（总章数）和
`latestChapterTitle`（最后一章标题）。目录永远要联网重新抓 —— 所以「导入后章节不对」
只能是**抓目录的姿势不对**，不是导入丢了数据。

---

## 二、`bookshelf.json` 的 Book 字段（25 个，实测覆盖率）

| 字段 | 类型 | 实测 | 原版含义 | 墨读映射 / 处理 |
|---|---|---|---|---|
| `bookUrl` | String | 43/43 | 详情页地址（本地书是文件路径） | `b.bookUrl`。**注意它常常不是目录页**，见 `tocUrl` |
| `tocUrl` | String | 43/43 | 目录页地址 | `b.tocUrl`，抓目录第一优先用它 ⭐ |
| `origin` | String | 43/43 | 书源地址（`https://www.xxx.com`） | `b.origin`（归一化）+ `b.originRaw`，用来把书绑回书源 |
| `originName` | String | 43/43 | 书源名称（带 emoji，如 `🍉 飞速小说网`） | `b.originName`，换源列表排序依据 |
| `name` | String | 43/43 | 书名 | `b.name`（个别第三方导出的叫 `bookName`，两种都认） |
| `author` | String | 43/43 | 作者 | `b.author` |
| `intro` | String | 43/43 | 简介（常有 `【…】` 前缀和截断） | `b.intro`，预览弹窗直接显示 |
| `coverUrl` | String | 41/43 | 封面 | `b.cover` |
| `customCoverUrl` | String | 28/43 | 用户手动换的封面（通常是本地路径） | 空时回退用，桌面端多为空串 |
| `kind` | String | 43/43 | 分类标签，逗号分隔（`玄幻奇幻,连载中,2023-05-14`） | `b.tags`，预览/详情当标签显示 |
| `type` | Int | 43/43 | **位标记**（BookType）：`1`=本地 `2`=音频 `4`=图片(漫画) `8`=文本 `16`=网页文件 | `b.bookType`；`type & 4` 的书默认按漫画排版 ⭐ |
| `group` | Int | 43/43 | 分组 id。负数都是系统组：`-100` 根 `-1` 全部 `-2` 本地 `-3` 音频 `-4` 网络未分组 `-5` 本地未分组 `-11` 更新出错 | 负数 → `g_default`；≥0 的按 `bookGroup.json` 的组名建组 |
| `totalChapterNum` | Int | 43/43 | **原书的总章数**（如 713） | `b.total`。抓回来的目录比它少一半 → 判定「只抓到最新章节」，继续找 ⭐ |
| `latestChapterTitle` | String | 43/43 | 最新章节标题（`完本感言`） | `b.latestChapterTitle`，书架上显示「已是最新」 |
| `latestChapterTime` | Long | 43/43 | 最新章节更新时间 | `b.latestChapterTime` |
| `lastCheckTime` | Long | 43/43 | 上次刷新书籍信息的时间 | `b.lastCheckTime`（暂只存不展示） |
| `lastCheckCount` | Int | 43/43 | 上次刷新发现的新章数 | 忽略（我们的「更新目录」自己算差集） |
| `wordCount` | String | 42/43 | 字数（31/43 是空串，说明多数源没给） | `b.wordCount` |
| `canUpdate` | Boolean | 43/43 | 刷新书架时是否更新 | `b.canUpdate`（false 的书不自动更新目录） |
| `durChapterIndex` | Int | 43/43 | **上次读到的章节索引**（相对「原书的目录」） | `st.progress[id].ci` —— **绝不能直接当我们的索引用**，见第四节 ⭐ |
| `durChapterTitle` | String | 43/43 | 上次读到的章节标题（`第59章 大哥不语…`） | `progress.title`，**跨目录定位的唯一可靠依据** ⭐ |
| `durChapterPos` | Long | 43/43 | 章节内阅读位置（字符/像素偏移） | `progress.pos`，暂不做精确还原 |
| `durChapterTime` | Long | 43/43 | 上次阅读时间 | `progress.at` |
| `originOrder` | Int | 43/43 | 书源在书源列表里的排序 | 换源列表排序用 |
| `order` | Int | 43/43 | 书架手动排序（实测都是负数，`-40`~`-1`） | `b.backupOrder` |
| `readConfig` | Object | 43/43 | 每本书的阅读配置：`{delTag, reSegment, reverseToc, splitLongChapter}` | `b.readConfig`；`reverseToc` 会真的反转目录 ⭐ |
| `variable` | String | 4/43 | 高级书源的自定义变量（JSON） | `b.variable` 存着，给将来的 JS 书源用 |

### `readConfig` 四个开关的含义

| 字段 | 含义 | 我们的处理 |
|---|---|---|
| `reverseToc` | 目录倒序显示（有的站按最新章节排） | ✅ 抓完目录后整体反转 |
| `delTag` | 删除正文里的 HTML 标签等级（0 不删） | 我们本来就只取文本，忽略 |
| `reSegment` | 重新分段（按句号重排） | 暂不实现 |
| `splitLongChapter` | 超长章节自动拆页 | 我们按屏分页，天然满足 |

---

## 三、其它文件的字段

### `bookmark.json`（书签）

| 字段 | 含义 | 墨读映射 |
|---|---|---|
| `bookName` / `bookAuthor` | 书名/作者（**没有 bookUrl，只能按书名对**） | 按书名找书 |
| `chapterIndex` / `chapterTitle` | 章节索引/标题 | 索引不可信，导入后用**标题**重新定位 |
| `chapterPos` | 章节内偏移 | `pct` 暂按 0 |
| `bookText` / `content` | 书签那段正文（100~200 字） | `bm.text`，书签列表直接显示 |
| `createTime` | 创建时间 | `bm.at` |

### `readRecord.json`（阅读记录）

实测只有 `bookName` / `deviceId` / `lastRead` / `readTime`（毫秒 + 累计阅读毫秒），
**没有章节信息**。所以阅读时长统计只能给「最后阅读时间」，章节进度一律以 `bookshelf.json` 为准。

### `bookGroup.json`（分组）

`groupId`（负数=系统组）、`groupName`、`order`、`show`、`bookSort`（0 默认/1 最新章/2 书名/3 手动/4 综合）、
`enableRefresh`。系统组（`全部`/`本地`/`音频`…）跳过，只导入 `groupId >= 0` 的自定义组。

### `bookSource.json`（书源）

`bookSourceUrl` / `bookSourceName` / `bookSourceGroup` / `bookSourceType`（0 文本 1 音频 2 图片 3 文件）/
`searchUrl` / `ruleSearch{bookList,name,author,intro,kind,lastChapter,bookUrl,coverUrl}` /
`ruleBookInfo{tocUrl,init,name,author,intro,coverUrl}` / `ruleToc{chapterList,chapterName,chapterUrl,nextTocUrl}` /
`ruleContent{content,nextContentUrl}` / `jsLib` / `enabled` / `customOrder`。

墨读全部导入，`customOrder` 还原顺序（换源列表按它排）。

---

## 四、最要命的一节：`durChapterIndex` 为什么不能用

`durChapterIndex` 是**相对于原版那本书的目录**的下标。换一份目录，同一个下标就是另一章：

```
飞速小说网《系统很抽象，还好我也是》
  bookUrl = /txtdown/389019.html   ← 下载页，页面上只有 12 条「最新章节」（倒序）
  原书目录 = 713 章，durChapterIndex = 59 → 第59章

以前的做法：拿 bookUrl 去抓目录 → 只抓到那 12 条，而且第 0 条是「第666章」
  → 59 ≥ 12 → 越界 → 落到最后一章 → 第660章   ← 用户看到的 bug
```

**现在按三级顺序定位**（`matchChapterIndex`）：

1. **标题完全一致**（去掉「第N章」前缀、空白、标点后比较）；
2. 标题包含关系（站点在标题后面加了 `（1/2）`、`（求月票）` 之类）；
3. **章节号**相同（`第59章` ↔ `第059章` ↔ `第五十九章`，支持中文数字）；
4. 还不行就按 `ci / 原总章数` 的比例落位，绝不无脑跳最后一章。

同一标题出现多次（分卷里都有「第1章」）时，取**离原位置最近**的那个。

## 五、抓目录的正确顺序（getToc）

1. `book.tocUrl`（备份里记的目录页）—— 下载页/详情页当书地址时，只有它靠谱；
2. 书源 `ruleBookInfo.tocUrl`（如「全文阅读」链接）；
3. 书地址本身解析；
4. 章节数 < 40 或 < 备份总章数 × 0.8 → 跟「目录 / 全部章节」链接；
5. 还不行 → 猜 `/book/…/index.html`；
6. 最后 → 按常见容器兜底抽取。

抓到后统一过一遍 `normalizeToc()`：**去重 + 归位排序**。很多站把「最新章节 12 条（倒序）」
贴在完整目录前面，不排序的话第 0 章是第 666 章、第 12 章才是第 1 章 —— 索引全错位。
排序规则：有序号的按序号升序；没序号的（「第一卷 风起」）跟着前一章；番外/完本感言/请假条集中放最后。

---

## 六、我们导出备份时写什么

`moread.json`（无损，含墨读全部状态）+ 上面五个 Legado 文件，原版「阅读」可以直接恢复：

- `bookshelf.json`：写 `bookUrl/tocUrl/origin/originName/name/author/intro/coverUrl/kind/type/group/`
  `totalChapterNum/latestChapterTitle/durChapterIndex/durChapterTitle/durChapterPos/durChapterTime/order`
- `bookSource.json`：书源规则全量
- `bookmark.json`：书签名、章节、正文、时间
- `readRecord.json`：书名、最后阅读时间
- `bookGroup.json`：分组名与顺序

已知差异：本地书（`file://` / `content://`）无法跨设备还原，导入时会计入「跳过」并提示。
