'use strict';
/**
 * 演示数据生成器：在指定数据目录写入一套全虚构的书架 / 书源 / 进度 / 书签 / 历史 / 统计，
 * 用于 README 截图与功能演示。所有书名、作者、正文均为虚构，不含任何真实用户数据。
 *
 * 用法：node test/demo-data.js <数据目录>
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root) { console.error('用法: node test/demo-data.js <数据目录>'); process.exit(1); }
fs.mkdirSync(path.join(root, 'books'), { recursive: true });

const now = Date.now();
const day = 86400e3;
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

/* ---- 虚构本地书正文（散文，非任何真实作品） ---- */
const txt = [
  ['第一章 入山', [
    '雨是后半夜停的。沈默推开木门时，檐角还挂着最后几滴水，落在青石板上，声音轻得像谁在远处翻书。',
    '他把行囊搁在廊下，回身望了一眼来路。山路被雾气洗得发白，看不见尽头的县城，也看不见那些催促他的电报。',
    '「就到这里吧。」他对自己说。声音在山谷里打了个转，又落回他耳朵里。',
    '老屋比记忆里矮了一截。门板上有他小时候刻下的身高线，一道一道，如今都矮到了他的腰际。',
    '他蹲下身，指尖抚过那些刻痕，忽然觉得时间并没有走远，只是换了个地方等他。',
    '灶膛里的灰还是温的。邻居阿婆昨夜又来添过柴，锅里温着一罐笋干汤。',
    '沈默就着汤吃了半碗冷饭，把床铺理好，在油灯下摊开带来的书。',
    '窗外有虫鸣，一声长，一声短，像山在均匀地呼吸。'
  ]],
  ['第二章 灯与溪', [
    '溪在屋后三十步。白日里它闪得像一条缎带，到了夜里，只剩下声音。',
    '沈默常在天擦黑时提着马灯去溪边坐一会儿。灯光落在水面上，碎成一把金箔，又被水流一片片运走。',
    '他想起城里写字楼的灯。那些灯彻夜不灭，照亮的是一摞摞等着签字、等着批复、等着被忘记的文件。',
    '而这里的灯只照亮一小块水，照亮水草摇动的方向，照亮一只夜鹭收翅时抖落的水珠。',
    '「萤火不过是夏夜的标点。」他在笔记本上写，「真正的句子，是黑暗本身。」',
    '写到这一句，他停了笔。远处传来狼嚎一般的犬吠，是护林员老周家的黑背。',
    '他笑了笑，把本子合上，提着灯往回走。山影在四周合拢，灯影在他脚下铺开。',
    '那一夜他睡得极沉，梦见自己变成了一枚被溪水磨圆的卵石。'
  ]],
  ['第三章 流萤', [
    '七月流萤最多的那晚，阿婆提着一篮新摘的黄瓜上山来看他。',
    '「城里人回来了，倒把城里人忘了。」阿婆说，「你娘要是还在，该高兴。」',
    '沈默接过篮子，没接话。他知道阿婆不是要刺他，山里人说话直，像溪里的石头，不打磨。',
    '两人坐在门槛上，看萤火虫从草丛里一盏一盏升起来，升到屋檐那么高，又斜斜地掠过去。',
    '「小时候你总捉它们装进玻璃瓶。」阿婆说，「第二天全死了，你就哭。」',
    '「现在不了。」沈默说，「现在我只看。」',
    '阿婆点点头，像是认可了这个答案。她起身要走，沈默把她送到岔路口。',
    '回程他走得很慢。萤火虫一路跟着他，像一群不肯睡的孩子。'
  ]],
  ['第四章 山雨', [
    '立秋前下了一场大雨，把后山的一截土路冲塌了。',
    '老周上山来喊他帮忙，两人扛着锄头去了塌方处。雨后的土腥气扑面而来，蚯蚓在路上乱爬。',
    '他们干了整整一个下午。挖沟，垒石，把被冲走的路面一寸一寸找回来。',
    '「城里人也干这个？」老周直起腰问，汗珠顺着他的下颌线往下滚。',
    '「城里人干别的。」沈默说，「干的也是把被冲走的东西找回来，只不过路塌在心里。」',
    '老周听不懂，但也没有追问。他拍拍沈默的肩，说晚上来家喝酒。',
    '那晚的酒是新酿的苞谷酒，辣得两人直咂嘴。窗外又下起雨，屋里却暖得像灶膛。',
    '沈默半夜醒来，听见雨声里混着溪水的声音，忽然分不清哪是哪。'
  ]],
  ['第五章 下山', [
    '霜降那天，邮递员送来一封挂号信，信封上是报社主编的字迹。',
    '信很短：版面留着，截稿月底，盼复。',
    '沈默把信看了三遍，折好，压在桌上的镇纸下面。',
    '他去溪边坐了一整天。水比夏天瘦了，石头露出青白的脊背。',
    '傍晚时他做了决定：下山一个月，写完那组关于山的报道，再回来。',
    '他给阿婆留了字条，给老周留了一袋城里的烟丝，给老屋上了锁。',
    '走出山口时他回头望了一眼。晨雾里，老屋的轮廓淡得像一句没写完的诗。',
    '「等我回来把它写完。」他说。山没有回答，只是把一阵风推到了他的背上。'
  ]]
];

const chaptersTxt = txt.map(([t, paras]) => t + '\n\n' + paras.join('\n\n')).join('\n\n\n');
fs.writeFileSync(path.join(root, 'books', 'L1.txt'), '山居笔记\n顾野 著\n\n' + chaptersTxt, 'utf8');

const mkOnline = (id, name, author, total, intro) => ({
  id, name, author, kind: 'online', total,
  bookUrl: 'http://127.0.0.1:9/book/' + id, sourceId: 'S1', sourceName: '墨读演示文库',
  groupId: 'g_default', intro, cover: '', createdAt: now - 30 * day, updatedAt: now - day
});

const state = {
  version: 2,
  books: [
    { id: 'L1', name: '山居笔记', author: '顾野', kind: 'local', total: 6, ext: '.txt', localFile: 'books/L1.txt', groupId: 'g_default', intro: '一段回到山里的日子。', createdAt: now - 40 * day, updatedAt: now },
    mkOnline('O1', '星海拾遗', '苏白', 642, '天文台守夜人捡到一本来自星海的笔记。'),
    mkOnline('O2', '云麓旧事', '林知遥', 380, '云麓镇三代人的旧账本与旧情分。'),
    mkOnline('O3', '灯下拾光集', '陈屿', 214, '夜班编辑在灯下拾起的散碎时光。'),
    mkOnline('O4', '白鹭洲志', '周洛', 156, '一座江心洲的草木、渡口与人家。'),
    mkOnline('O5', '长风渡野', '祁云', 892, '镖师、驼队与一条横穿大漠的古道。'),
    mkOnline('O6', '青瓷手记', '闻溪', 97, '修瓷匠的手记，记器也记人。'),
    mkOnline('O7', '北岭狐火', '顾寒洲', 445, '北岭雪夜里流传的一点火。')
  ],
  sources: [
    {
      id: 'S1', name: '墨读演示文库', url: 'http://127.0.0.1:9', group: '演示', enabled: true,
      type: 'legado', charset: 'auto', searchUrl: 'http://127.0.0.1:9/search?q={{key}}',
      ruleSearch: { bookList: '.item', name: 'h3 a@text', author: '.au@text', bookUrl: 'h3 a@href', intro: '.intro@text', coverUrl: 'img@src' },
      ruleBookInfo: { tocUrl: '#catalog@href' },
      ruleToc: { chapterList: '#list dd', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '#content' }, icon: '墨', quality: 'great', qualityAt: now - day,
      comment: '演示用书源，地址指向本地回环端口，不会访问任何真实站点。'
    },
    {
      id: 'S2', name: '青梧书斋', url: 'https://example.net', group: '演示', enabled: true,
      type: 'legado', charset: 'auto', searchUrl: 'https://example.net/s?q={{key}}',
      ruleSearch: { bookList: '.r li', name: 'a@text', author: 'em@text', bookUrl: 'a@href' },
      ruleBookInfo: { tocUrl: '#toc@href' },
      ruleToc: { chapterList: '#c dd', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '#tx' }, icon: '梧', quality: 'ok', qualityAt: now - day
    },
    {
      id: 'S3', name: '云上书城', url: 'https://example.org', group: '演示', enabled: false,
      type: 'legado', charset: 'auto', searchUrl: 'https://example.org/find?q={{key}}',
      ruleSearch: { bookList: '.li', name: 'a@text', bookUrl: 'a@href' },
      ruleBookInfo: { tocUrl: '#t@href' },
      ruleToc: { chapterList: '#l dd', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '#c' }, icon: '云', quality: 'poor', qualityAt: now - day
    },
    {
      id: 'S4', name: '白鹭读社', url: 'https://example.com', group: '演示', enabled: true,
      type: 'legado', charset: 'auto', searchUrl: 'https://example.com/api/s?kw={{key}}',
      ruleSearch: { bookList: '$.data.list[*]', name: '$.name', author: '$.author', bookUrl: '$.url', coverUrl: '$.cover' },
      ruleBookInfo: { tocUrl: '$.tocUrl' },
      ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.title', chapterUrl: '$.url' },
      ruleContent: { content: '$.content' }, icon: '鹭'
    },
    {
      id: 'src_demo_1', name: '示例源 · 结构参考', url: 'https://example.com', group: '示例', enabled: false,
      type: 'legado', charset: 'auto', searchUrl: 'https://example.com/search?q={{key}}',
      ruleSearch: { bookList: '.result .item', name: 'h3 a@text', author: '.author@text', bookUrl: 'h3 a@href', intro: '.intro@text', coverUrl: 'img@src' },
      ruleBookInfo: { tocUrl: '#catalog@href' },
      ruleToc: { chapterList: '#list dd', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '#content' }, icon: '示',
      comment: '把 url / searchUrl / 规则改成目标站点即可。'
    },
    {
      id: 'src_demo_2', name: '示例源 · JSON 书源', url: 'https://example.org', group: '示例', enabled: false,
      type: 'legado', charset: 'auto', searchUrl: 'https://example.org/api/search?kw={{key}}',
      ruleSearch: { bookList: '$.data.list[*]', name: '$.name', author: '$.author', bookUrl: '$.url', intro: '$.intro', coverUrl: '$.cover' },
      ruleBookInfo: { tocUrl: '$.tocUrl' },
      ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.title', chapterUrl: '$.url' },
      ruleContent: { content: '$.content' }, icon: 'JS',
      comment: '以 $ 开头的规则按 JSON 路径解析，适合接口型站点。'
    }
  ],
  groups: [
    { id: 'g_default', name: '默认分组' },
    { id: 'g_1', name: '散文随笔' },
    { id: 'g_2', name: '想读清单' }
  ],
  progress: {
    L1: { ci: 2, pct: 0.57, at: now - 3600e3 },
    O2: { ci: 18, pct: 0.23, at: now - 2 * day },
    O5: { ci: 63, pct: 0.71, at: now - 3 * day }
  },
  bookmarks: [
    { id: 'bm1', bookId: 'L1', ci: 2, pct: 0.57, name: '山居笔记', title: '第三章 流萤', text: '「萤火不过是夏夜的标点。」', at: now - 3600e3 },
    { id: 'bm2', bookId: 'O2', ci: 18, pct: 0.23, name: '云麓旧事', title: '第十九章 渡口', text: '雨停在檐角，像一句没说完的话。', at: now - 2 * day }
  ],
  history: [
    { id: 'h1', bookId: 'L1', name: '山居笔记', ci: 2, title: '第三章 流萤', at: now - 3600e3 },
    { id: 'h2', bookId: 'O2', name: '云麓旧事', ci: 18, title: '第十九章 渡口', at: now - 2 * day },
    { id: 'h3', bookId: 'O5', name: '长风渡野', ci: 63, title: '第六十四章 沙市', at: now - 3 * day }
  ],
  stats: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(i => [
    dayKey(now - i * day), { sec: [4200, 3120, 1860, 5040, 2640, 3420, 4560][i], chars: [41000, 28500, 17400, 46200, 23800, 31000, 39500][i] }
  ])),
  settings: {
    fontSize: 19, lineHeight: 2.0, fontFamily: 'serif', theme: 'paper', pageMode: 'scroll',
    paraGap: true, autoSave: true, minimizeToTray: true, closeToTray: false,
    maxConcurrent: 3, searchLimit: 40, autoCacheNext: true,
    tts: { voiceURI: '', rate: 1, pitch: 1, autoNext: true },
    webdav: { enabled: false, url: 'https://dav.jianguoyun.com/dav/', user: '', pass: '', dir: 'legado', autoBackup: false, intervalHours: 24, keep: 10, lastBackupAt: 0, lastBackupName: '', lastSyncAt: 0 },
    webSearch: { engine: 'bing', keyword: '' }
  }
};

fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify(state), 'utf8');
console.log('demo data ->', root);
console.log('books:', state.books.length, '| sources:', state.sources.length);
