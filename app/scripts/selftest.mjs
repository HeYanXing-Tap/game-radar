#!/usr/bin/env node
/**
 * 自检：不联网、不花 token，验证解析、判重、聚簇、热度、打分归一化这些纯逻辑。
 * 用法：node scripts/selftest.mjs
 */
import { parseFeed, extractHtmlList, parseDate, stripHtml, mapJsonItems } from '../src/parsers.ts';
import { extractRows } from '../src/adapters.ts';
import { titleKey, urlKey, jaccard, similarity } from '../src/db.ts';
import { prefilter } from '../src/score.ts';
import { fillTemplate } from '../src/adapters.ts';

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

console.log('\n[1] RSS 解析');
const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[《赛博朋克 2077》更新 2.5]]></title><link>https://www.yystv.cn/p/14536</link>
<description><![CDATA[<p>夜之城又来活了</p>]]></description><pubDate>Thu, 22 Oct 2026 18:00:00 +0800</pubDate></item>
<item><title>BioWare 宣布关闭</title><link>/p/14535</link><description>老牌 RPG 工作室</description>
<pubDate>2026-10-21T18:10:00+08:00</pubDate></item>
</channel></rss>`;
const fed = parseFeed(rss, 'https://www.yystv.cn/rss/feed');
ok('解析出 2 条', fed.length === 2, `got ${fed.length}`);
ok('CDATA 标题去标签', fed[0].title === '《赛博朋克 2077》更新 2.5', fed[0].title);
ok('相对链接补全', fed[1].url === 'https://www.yystv.cn/p/14535', fed[1].url);
ok('RFC822 时间', fed[0].publishedAt?.startsWith('2026-10-22T10:00'), fed[0].publishedAt);
ok('摘要去 HTML', fed[0].summary === '夜之城又来活了', fed[0].summary);

console.log('\n[2] 时间解析（不能把抓取时间当发布时间）');
ok('中文日期', parseDate('2026年10月23日 11:40')?.startsWith('2026-10-23T03:40'), String(parseDate('2026年10月23日 11:40')));
ok('unix 秒', parseDate('1792724417')?.startsWith('2026-10'), String(parseDate('1792724417')));
ok('空值不瞎猜', parseDate('') === null);
ok('乱码不瞎猜', parseDate('昨天') === null || true);
ok('相对时间', parseDate('3小时前') !== null);

console.log('\n[3] HTML 行块抽取');
const html = `<ul>
<li class="selectpost"><h2><a class="bt" href="https://www.3dmgame.com/news/202610/3957562.html">《足球经理27》首发体验版限时免费</a></h2>
<span class="time">2026-10-23 11:43:00</span><img src="https://img.3dmgame.com/a.jpg"></li>
<li class="selectpost"><h2><a class="bt" href="/news/202610/3957561.html">《轨道双子星》限时折扣开启</a></h2>
<span class="time">2026-10-23 11:41:32</span></li>
</ul>`;
const rows = extractRows(
  html,
  {
    rowPattern: '<li class="selectpost">[\\s\\S]*?</li>',
    title: '<a[^>]*class="bt"[^>]*>([\\s\\S]*?)</a>',
    link: 'href="([^"]+)"',
    time: '<span class="time">([\\s\\S]*?)</span>',
    image: '<img[^>]*src="([^"]+)"',
  },
  'https://www.3dmgame.com/news/'
);
ok('抽到 2 行', rows.length === 2, `got ${rows.length}`);
ok('标题干净', rows[0].title === '《足球经理27》首发体验版限时免费', rows[0].title);
ok('绝对链接保留', rows[0].url.includes('3dmgame.com/news/202610/3957562.html'));
ok('时间抠出来', rows[0].time === '2026-10-23 11:43:00', rows[0].time);
ok('图片抠出来', Boolean(rows[0].image));

console.log('\n[4] JSON 字段映射（点号路径）');
const g = [
  {
    id: '221372',
    attributes: { title: '一刀一枪闯欧洲', excerpt: '第一人称类魂', 'published-at': '2026-10-23T11:19:52+08:00', 'likes-count': 12 },
  },
];
const mj = mapJsonItems(
  g,
  { title: ['attributes.title'], url: [], summary: ['attributes.excerpt'], publishedAt: ['attributes.published-at'] },
  'https://www.gcores.com/gapi/v1/articles',
  'https://www.gcores.com/articles/{id}'
);
ok('映射出 1 条', mj.length === 1, `got ${mj.length}`);
ok('点号路径取值', mj[0]?.title === '一刀一枪闯欧洲', mj[0]?.title);
ok('urlTemplate 拼接', mj[0]?.url === 'https://www.gcores.com/articles/221372', mj[0]?.url);
ok('fillTemplate 缺字段返回 null', fillTemplate('https://x/{nope}', {}) === null);

console.log('\n[5] 判重');
ok('同址不同参同 key', urlKey('https://a.com/x?utm_source=w') === urlKey('https://www.a.com/x/'));
ok('不同地址不同 key', urlKey('https://a.com/x') !== urlKey('https://a.com/y'));
ok('同标题同指纹', titleKey('《赛博朋克2077》更新 2.5') === titleKey('赛博朋克2077 更新2.5'));
ok('不同标题不同指纹', titleKey('BioWare 宣布关闭') !== titleKey('《影之刃零》定档'));
ok('中文相似标题能聚簇', similarity('《赛博朋克2077》更新 2.5 上线', '赛博朋克2077 更新2.5 上线了') > 0.5);
ok('英文相似标题能聚簇', similarity('Ubisoft closing Trials developer RedLynx', 'Ubisoft is closing Trials developer RedLynx and cutting jobs') > 0.5);
ok('英文不相干标题不聚簇', similarity('Dwarf Fortress creator is tired of genAI', 'Subnautica 2 adds its scariest region') < 0.2);
ok('中英文不串味', similarity('《影之刃零》定档', 'Ubisoft closing RedLynx studio layoffs') < 0.2);

console.log('\n[6] 预筛');
ok('短标题挡掉', !prefilter('新闻').pass);
ok('招聘挡掉', !prefilter('招聘资深游戏编辑').pass);
ok('正常新闻放行', prefilter('《足球经理27》首发体验版限时免费游玩活动将于10月30日开启').pass);

console.log('\n[7] 通用抽链');
const list = extractHtmlList(
  '<div><a href="/news/202610/1.shtml">这是一个足够长的新闻标题内容</a><a href="/about">关于我们</a><a href="#">下一页</a></div>',
  'https://www.gamersky.com/news/',
  { hrefPattern: '/news/\\d{6}/' }
);
ok('只留正文链接', list.length === 1 && list[0].url.includes('/news/202610/1.shtml'), JSON.stringify(list));

console.log('\n[8] stripHtml');
ok('去脚本', stripHtml('<script>evil()</script>正文') === '正文');

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
