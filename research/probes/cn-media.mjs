#!/usr/bin/env node
/**
 * cn-media —— 国内游戏垂媒信源可抓性探测
 *
 * 用法：node research/probes/cn-media.mjs
 * 产物：research/sources/cn-media.json（严格按 research/SCHEMA.md 的契约）
 *
 * 设计原则：
 *  - 只用原生 fetch，零依赖。
 *  - 同域名连续请求间隔 >= 1100ms（中间层统一排队，不靠调用方自觉）。
 *  - 单源最多 3 个候选入口，失败即记录原因，不死磕。
 *  - publishedAt 一律判断「真实发布时间」，拿不到就写 null + fields.publishedAt=false，
 *    绝不用抓取时间冒充。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.resolve(__dirname, '../sources/cn-media.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const GAP_MS = 1100; // 同域名请求间隔
const TIMEOUT_MS = 20000;
const MAX_ITEMS_KEPT = 20; // 每源最多留多少条进 sample 池（itemCount 仍报真实解析数）

/* ------------------------------------------------------------------ */
/* 礼貌抓取层                                                          */
/* ------------------------------------------------------------------ */

const lastHitByHost = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeGet(url, extraHeaders = {}) {
  const host = new URL(url).host;
  const last = lastHitByHost.get(host) || 0;
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHitByHost.set(host, Date.now());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...extraHeaders },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType: res.headers.get('content-type') || '',
      body: text,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: '',
      body: '',
      latencyMs: Date.now() - t0,
      error: err?.name === 'AbortError' ? `timeout >${TIMEOUT_MS}ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 时间归一化：全部输出 +08:00 的 ISO                                   */
/* ------------------------------------------------------------------ */

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const pad = (n) => String(n).padStart(2, '0');

/** 毫秒时间戳 -> 北京时间的 ISO 字符串 */
function toCST(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
  );
}

/** "Fri, 23 Oct 2026 11:00:00 +0800" / "+0000" -> CST ISO */
function parseRfc822(s) {
  if (!s) return null;
  const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})/.exec(s);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (mon === undefined) return null;
  const off = m[7];
  const sign = off[0] === '-' ? -1 : 1;
  const offMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
  const utcMs = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]) - offMin * 60000;
  return toCST(utcMs);
}

/** 已经是 +08:00 的 ISO（gcores API）*/
function passIso(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00` : null;
}

/** "2026-10-23 10:38" / "2026-10-23 11:40:41"（站点默认 CST） */
function parseCstLocal(s) {
  if (!s) return null;
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}T${pad(+m[4])}:${pad(+m[5])}:${pad(+(m[6] || 0))}+08:00`;
}

/**
 * "10.22" 这种只有月日的，按当年推断；若推出来比现在还晚一天以上，认为跨年。
 * 返回 { iso, yearInferred: true }
 */
function parseMonthDay(md, now = new Date()) {
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(String(md || '').trim());
  if (!m) return null;
  const nowCst = new Date(now.getTime() + 8 * 3600 * 1000);
  let year = nowCst.getUTCFullYear();
  const guess = Date.UTC(year, +m[1] - 1, +m[2]);
  if (guess > nowCst.getTime() + 36 * 3600 * 1000) year -= 1;
  return `${year}-${pad(+m[1])}-${pad(+m[2])}T00:00:00+08:00`;
}

/** "2026-10-22" -> ISO（日期精度，时分补 0） */
function parseYmdToIso(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00` : null;
}

function latestOf(items) {
  const ts = items.map((i) => i.publishedAt).filter(Boolean).sort();
  return ts.length ? ts[ts.length - 1] : null;
}

/* ------------------------------------------------------------------ */
/* 解析小工具                                                          */
/* ------------------------------------------------------------------ */

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const unwrapCdata = (s) => {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s || '');
  return m ? m[1] : s || '';
};

const firstImg = (html) => {
  const m = /<img[^>]*\bsrc="([^"]+)"/i.exec(html || '');
  return m ? decodeEntities(m[1]) : null;
};

/** 粗粒度 XML item 切分（不引依赖，够用） */
function xmlItems(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function xmlTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  return m ? unwrapCdata(m[1]) : null;
}

const dedupeByUrl = (items) => {
  const seen = new Set();
  return items.filter((i) => {
    if (!i.url || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
};

/* ------------------------------------------------------------------ */
/* 各源探测                                                            */
/* ------------------------------------------------------------------ */

const EMPTY_FIELDS = {
  title: false,
  link: false,
  publishedAt: false,
  summary: false,
  image: false,
  heat: false,
  author: false,
};

function makeSource(base, items, extra) {
  const fields = { ...EMPTY_FIELDS, ...(extra.fields || {}) };
  // itemCount 报真实解析到的条数，sample 只留前 5 条
  const kept = dedupeByUrl(items.filter((i) => i.title));
  const verified = kept.length >= 5 && base.httpStatus >= 200 && base.httpStatus < 300;
  return {
    ...base,
    verified,
    itemCount: kept.length,
    latestAt: latestOf(kept),
    fields,
    headers: extra.headers || {},
    notes: extra.notes,
    failure: verified ? null : extra.failure || '未拿到 >=5 条带标题条目',
    sample: kept.slice(0, 5).map((i) => ({
      title: i.title,
      url: i.url,
      publishedAt: i.publishedAt ?? null,
    })),
  };
}

/* ---- 1. 机核 RSS ---- */
async function probeGcoresRss() {
  const r = await politeGet('https://www.gcores.com/rss');
  const items = xmlItems(r.body).map((b) => {
    const desc = xmlTag(b, 'description') || '';
    return {
      title: stripTags(xmlTag(b, 'title')),
      url: (xmlTag(b, 'link') || '').trim(),
      publishedAt: parseRfc822(xmlTag(b, 'pubDate')),
      summary: stripTags(desc).slice(0, 160),
      image: xmlTag(b, 'thumb') ? decodeEntities(xmlTag(b, 'thumb')) : firstImg(desc),
      author: stripTags(xmlTag(b, 'author')),
      heat: null,
    };
  });
  return makeSource(
    {
      id: 'gcores',
      name: '机核',
      role: 'media',
      region: 'cn',
      type: 'rss',
      url: 'https://www.gcores.com/rss',
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: true, summary: true, image: true, author: true },
      notes:
        '标准 RSS 2.0，一次 20 条，无分页参数。pubDate 带 +0800，是真实发布时间。' +
        '带 <thumb>（封面图 URL）和 <author>（可能是多作者逗号分隔），description 为整段 HTML 需去标签。' +
        '1 次请求即拿到 20 条，适合做 15 分钟级轮询。',
      debug: { contentType: r.contentType, feedItems: xmlItems(r.body).length },
    }
  );
}

/* ---- 2. 机核 JSON:API（带热度计数）---- */
async function probeGcoresApi() {
  const url = 'https://www.gcores.com/gapi/v1/articles?page[limit]=20&sort=-published_at';
  const r = await politeGet(url, { Accept: 'application/vnd.api+json' });
  let items = [];
  let recordCount = null;
  let apiErr = null;
  try {
    const d = JSON.parse(r.body);
    recordCount = d?.meta?.['record-count'] ?? null;
    for (const row of d?.data || []) {
      const a = row.attributes || {};
      items.push({
        title: stripTags(a.title),
        url: `https://www.gcores.com/articles/${row.id}`,
        publishedAt: passIso(a['published-at']),
        summary: stripTags(a.desc || a.summary || '').slice(0, 160),
        image: a.thumb ? decodeEntities(a.thumb) : a.cover ? decodeEntities(a.cover) : null,
        author: null,
        heat: a['likes-count'] ?? a['comments-count'] ?? null,
      });
    }
  } catch {
    apiErr = 'body 不是 JSON';
  }
  const src = makeSource(
    {
      id: 'gcores-api',
      name: '机核（JSON:API 列表）',
      role: 'media',
      region: 'cn',
      type: 'json',
      url,
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.api+json' },
      fields: { title: true, link: true, publishedAt: true, summary: true, image: true, author: true, heat: true },
      failure: apiErr,
      notes:
        'JSON:API。必须带 Accept: application/vnd.api+json（否则 406），必须用 page[limit]/page[offset] 分页' +
        '（用 limit/page 会 400 Invalid Page Object）。URL 里的 [] 用 fetch 会编码成 %5B，服务端仍能解析。' +
        'sort=-published_at 才是时间倒序，不带参数返回的是 2013 年的老文章。' +
        'attributes 里带热度：likes-count / comments-count / bookmarks-count / plays，' +
        '另有 tag-data、owner-type、vol，适合做「热榜」第二路；meta.record-count 显示全站约 ' +
        `${recordCount} 篇，可按 page[offset] 深度翻页。`,
      debug: { recordCount, contentType: r.contentType },
    }
  );
  return src;
}

/* ---- 3. 游研社 RSS ---- */
async function probeYystv() {
  const r = await politeGet('https://www.yystv.cn/rss/feed');
  const items = xmlItems(r.body).map((b) => {
    const desc = xmlTag(b, 'description') || '';
    return {
      title: stripTags(xmlTag(b, 'title')),
      url: (xmlTag(b, 'link') || '').trim(),
      publishedAt: parseRfc822(xmlTag(b, 'pubDate')),
      summary: stripTags(desc).slice(0, 160),
      image: firstImg(desc),
      author: null,
      heat: null,
    };
  });
  return makeSource(
    {
      id: 'yystv',
      name: '游研社',
      role: 'media',
      region: 'cn',
      type: 'rss',
      url: 'https://www.yystv.cn/rss/feed',
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: true, summary: true, image: true },
      notes:
        '标准 RSS 2.0，一次 12 条（不是 20），无分页参数。pubDate 带 +0800 真实时间。' +
        '没有 author / dc:creator，也没有任何热度字段。description 是 HTML 全段，首图要自己取 <img>。' +
        '12 条/次意味着高频轮询才能不漏稿，建议 15 分钟一次。',
      debug: { contentType: r.contentType, feedItems: xmlItems(r.body).length },
    }
  );
}

/* ---- 4. 游民星空 HTML 列表 ---- */
async function probeGamersky() {
  const r = await politeGet('https://www.gamersky.com/news/');
  const html = r.body;
  const items = [];
  // 列表项形如：<li><div class="tit"><a class="tt" href=.. title=..></div>
  //            <div class="img">..</div><div class="con"><div class="txt">摘要</div>
  //            <div class="tem"><div class="time">2026-10-23 10:38</div><div class="pls cy_comment" data-sid=".."></div>
  const blocks = [...html.matchAll(/<li>\s*<div class="tit">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  for (const b of blocks) {
    const aTag = /<a[^>]*class="tt"[^>]*>/i.exec(b);
    if (!aTag) continue;
    const href = /\bhref="([^"]+)"/i.exec(aTag[0]);
    const titleAttr = /\btitle="([^"]*)"/i.exec(aTag[0]);
    const titleText = /<a[^>]*class="tt"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    const time = /<div class="time">([^<]*)<\/div>/i.exec(b);
    const sum = /<div class="txt">([\s\S]*?)<\/div>/i.exec(b);
    const img = /<div class="img">[\s\S]*?<img[^>]*\bsrc="([^"]+)"/i.exec(b);
    const title = stripTags(titleAttr ? titleAttr[1] : titleText ? titleText[1] : '').trim();
    if (!title || !href) continue;
    items.push({
      title,
      url: decodeEntities(href[1]),
      publishedAt: parseCstLocal(stripTags(time ? time[1] : '')),
      summary: sum ? stripTags(sum[1]).slice(0, 160) : null,
      image: img ? decodeEntities(img[1]) : null,
      author: null,
      heat: null,
    });
  }
  return makeSource(
    {
      id: 'gamersky',
      name: '游民星空',
      role: 'media',
      region: 'cn',
      type: 'html',
      url: 'https://www.gamersky.com/news/',
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: true, summary: true, image: true },
      notes:
        '服务端渲染 HTML。站内 RSS 已废弃：/rss/ 403、/rss.xml 与 /rss.aspx 404，所以只能扒页面。' +
        '单页 <li><div class="tit">..</div>..</li> 结构里能同时拿到 title / href / 摘要 / 首图 / 真实时间，' +
        '时间格式 "YYYY-MM-DD HH:mm"（CST）。' +
        '一页能解析出 ~177 条去重后的资讯（页面按「今日推荐/单机电玩/NS/手游/网游/业界/硬件/科技」' +
        '多个 tab 预渲染，223 个 tit 元素），单次抓取量是全组最大的。' +
        '注意：tab 混排导致结果【不是】严格时间倒序，必须客户端按 publishedAt 重排。' +
        '评论数是畅言（cy_comment + data-sid）JS 异步注入，HTML 里是空 div，抓不到，故 heat=false。' +
        '分页由 contentpaging 的 PageList() JS 驱动，没有干净的 ?page= 入口，靠单页 177 条已够用。',
      debug: { titBlocks: blocks.length, htmlBytes: html.length },
    }
  );
}

/* ---- 5. 3DM HTML 列表 ---- */
async function probe3dm() {
  const r = await politeGet('https://www.3dmgame.com/news/');
  const html = r.body;
  const items = [];
  const start = html.indexOf('class="Revision_list"');
  const seg = start >= 0 ? html.slice(start) : html;
  // 每条：<li class="selectpost"> ... <div class="text"><a class="bt" href=..>标题</a>
  //       <div class="bq"><a ...>游戏名</a><span class="time">2026-10-23 11:40:41</span>
  for (const part of seg.split(/<li[^>]*>/).slice(1)) {
    // 注意属性顺序是 href 在前、class="bt" 在后，所以先抓整个 <a> 标签再分别取属性
    const bt = /<a\b([^>]*\bclass="bt"[^>]*)>([\s\S]*?)<\/a>/i.exec(part);
    if (!bt) continue;
    const href = /\bhref="([^"]+)"/i.exec(bt[1]);
    if (!href) continue;
    const time = /<span class="time">([^<]+)<\/span>/i.exec(part);
    const img = /<img[^>]*(?:data-original|src)="([^"]+)"/i.exec(part);
    const title = stripTags(bt[2]).trim();
    if (!title) continue;
    items.push({
      title,
      url: decodeEntities(href[1]),
      publishedAt: parseCstLocal(stripTags(time ? time[1] : '')),
      summary: null,
      image: img ? decodeEntities(img[1]) : null,
      author: null, // 同块的 div.bq 是「所属游戏/栏目」标签，不是作者
      heat: null,
    });
  }
  return makeSource(
    {
      id: '3dmgame',
      name: '3DM 游戏网',
      role: 'media',
      region: 'cn',
      type: 'html',
      url: 'https://www.3dmgame.com/news/',
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: true, image: true },
      notes:
        '服务端渲染 HTML，无 RSS。/news/ 主列表是 <li class="selectpost"> 序列，' +
        '标题在 <a class="bt">，链接是干净的 /news/YYYYMM/ID.html，' +
        '发布时间在 <span class="time">，格式 "YYYY-MM-DD HH:mm:ss"（CST，精确到秒）——本组时间精度最高的源。' +
        '一页约 24 条；分页是纯 URL（/news_all_2/、/news_all_3/ …），可以稳定深翻。' +
        '没有摘要正文（列表只有标题+缩略图），也没有评论/点击数字。' +
        '详情页里其实有服务端渲染的评论数 <span id="Ct_total">（N人参与，M条评论），' +
        '但列表页拿不到，要 N+1 才补得出来，所以本条 heat=false。' +
        'div.bq 里的 <a> 是「所属游戏/栏目」标签，别当 author 用。' +
        '同页 sidebar 有个「近期热门」模块（div.QZ_title + div.net a），是人工排序无数字，' +
        '可当第二路信号，但拿不到量级，故未标 heat。',
      debug: { htmlBytes: html.length },
    }
  );
}

/* ---- 6. GameLook RSS（WordPress，http-only 且偶发 502）---- */
async function probeGamelook() {
  const candidates = ['http://www.gamelook.com.cn/feed/', 'http://www.gamelook.com.cn/?feed=rss2'];
  const tried = [];
  let r = null;
  for (const url of candidates) {
    const res = await politeGet(url);
    tried.push({ url, status: res.status, latencyMs: res.latencyMs });
    if (res.ok && /<item>/.test(res.body)) {
      r = res;
      break;
    }
    r = r || res;
  }
  const items = xmlItems(r ? r.body : '').map((b) => {
    const desc = xmlTag(b, 'description') || '';
    const content = xmlTag(b, 'content:encoded') || '';
    return {
      title: stripTags(xmlTag(b, 'title')),
      url: (xmlTag(b, 'link') || '').trim(),
      publishedAt: parseRfc822(xmlTag(b, 'pubDate')),
      summary: stripTags(desc).slice(0, 160),
      image: firstImg(content) || firstImg(desc),
      author: stripTags(xmlTag(b, 'dc:creator')),
      heat: null,
    };
  });
  return makeSource(
    {
      id: 'gamelook',
      name: 'GameLook / 游戏大观',
      role: 'media',
      region: 'cn',
      type: 'rss',
      url: 'http://www.gamelook.com.cn/feed/',
      httpStatus: r ? r.status : 0,
      latencyMs: r ? r.latencyMs : null,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: true, summary: true, image: true, author: true },
      notes:
        'WordPress 站，/feed/ 是标准 RSS 2.0，一次 31 条，无分页。' +
        'pubDate 是 GMT（+0000），必须换算成 +08:00，否则会整体早 8 小时。' +
        '带 dc:creator 作者、category 栏目；正文图片在 <content:encoded> 里（description 只有纯文本摘要）。' +
        '两个坑：① 只支持 http，https 的 443 直接 connection refused；' +
        '② /feed/ 偶发 502（nginx 回源失败），本次探测第一次 502、第三次才 200，' +
        '所以脚本里必须「/feed/ 失败就退到 ?feed=rss2（301 回 /feed/）」并允许重试。' +
        '另：游戏葡萄（youxiputao.com）未启用，GameLook 已满足「二选一」。',
      debug: { tried, feedItems: xmlItems(r ? r.body : '').length },
    }
  );
}

/* ---- 7. indienova RSS（注意必须带尾斜杠）---- */
async function probeIndienovaRss() {
  const r = await politeGet('https://indienova.com/feed/');
  const items = xmlItems(r.body).map((b) => {
    const desc = xmlTag(b, 'description') || '';
    const content = xmlTag(b, 'content:encoded') || '';
    return {
      title: stripTags(xmlTag(b, 'title')),
      url: (xmlTag(b, 'link') || '').trim(),
      publishedAt: parseRfc822(xmlTag(b, 'pubDate')),
      summary: stripTags(desc).slice(0, 160),
      image: firstImg(content) || firstImg(desc),
      author: stripTags(xmlTag(b, 'dc:creator')),
      heat: null,
    };
  });
  return makeSource(
    {
      id: 'indienova',
      name: 'indienova 独立游戏',
      role: 'media',
      region: 'cn',
      type: 'rss',
      url: 'https://indienova.com/feed/',
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: true, summary: true, image: true, author: true },
      notes:
        '【最重要的坑：尾斜杠】https://indienova.com/feed （无斜杠）稳定 404，' +
        'https://indienova.com/feed/ （带斜杠）才是 200 的 RSS 2.0。我一开始就是因为漏了这个斜杠，' +
        '差点误判「indienova 没有 RSS 只能扒 HTML」，翻回来救了一整条链路。' +
        '标准 RSS 2.0，一次 10 条，无分页。pubDate 带 +0800 真实发布时间，而且是整点发布（08:00 / 14:00）。' +
        '带 dc:creator 作者、category 栏目；description 是纯文本短摘要，' +
        '正文 HTML 在 <content:encoded>，首图要从那里取。' +
        '有 <slash:comments> 评论数但 10 条全是 0，没有点赞数，所以 heat=false；' +
        '要热度得走 HTML 列表（见 indienova-list）。' +
        '10 条/次偏少，若要抓全需要配合 HTML 列表分页补量。',
      debug: { contentType: r.contentType, feedItems: xmlItems(r.body).length },
    }
  );
}

/* ---- 8. indienova HTML 列表（有互动数，但没有发布时间）---- */
async function probeIndienova() {
  const r = await politeGet('https://indienova.com/indie-game-news/');
  const html = r.body;
  const items = [];
  for (const part of html.split('<div class="article-panel').slice(1)) {
    const head = /<h4>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(part);
    if (!head) continue;
    const p = /<p>([\s\S]*?)<\/p>/i.exec(part);
    const img = /<div class="article-image">[\s\S]*?<img[^>]*src="([^"]+)"/i.exec(part);
    const badge = /number-first">(\d+)<\/span>[\s\S]*?number-last">(\d+)<\/span>/i.exec(part);
    const url = head[1].startsWith('http') ? head[1] : `https://indienova.com${head[1]}`;
    items.push({
      title: stripTags(head[2]).trim(),
      url,
      publishedAt: null, // 列表页确实没有时间，见 notes
      summary: p ? stripTags(p[1]).slice(0, 160) : null,
      image: img ? decodeEntities(img[1]) : null,
      author: null,
      heat: badge ? { likes: +badge[1], comments: +badge[2] } : null,
    });
  }
  return makeSource(
    {
      id: 'indienova-list',
      name: 'indienova 独立游戏（HTML 列表 / 带互动数）',
      role: 'media',
      region: 'cn',
      type: 'html',
      url: 'https://indienova.com/indie-game-news/',
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: false, summary: true, image: true, heat: true },
      notes:
        '这是 indienova 的「有热度、没时间」变体，和上一条 indienova(RSS) 是同一家站的两个入口：' +
        'RSS 有时间没热度，HTML 列表有热度没时间，二选一得看雷达要哪一头。' +
        '列表页 .article-panel 里只有 标题(h4>a) / 摘要(p) / 封面图 / ' +
        '互动数(.views-badge: number-first=点赞, number-last=评论)，12 条/页，' +
        '分页干净（/indie-game-news/page/2/ … 共 530 页，可深翻）。' +
        '【拿不到发布时间的典型】整页没有任何发布时间字段。我进文章详情页复核过：' +
        '可见的时间只有一个藏在 HTML 注释里的「<!-- <div class="hidden"> 2026-10-23 11:42:33 -->」，' +
        '那是服务端渲染时间戳，不是发布时间；真正的发文信息在 ' +
        '<span class="header-info">作者：…<br />前天 10-21 08:00</span>，' +
        '是「相对日期 + MM-DD」、无年份，而且只在详情页 —— 列表页拿不到，要 N+1 次请求才能补。' +
        '所以要时间就走 RSS，别扒这个列表。' +
        'heat=true 但量级极小：点赞 0–5、评论 12 条全是 0，只能当弱信号。',
      debug: { htmlBytes: html.length, panels: html.split('<div class="article-panel').length - 1 },
    }
  );
}

/* ---- 8. 触乐 HTML 列表（时间只有 MM.DD）---- */
async function probeChuapp() {
  const r = await politeGet('https://www.chuapp.com/');
  const html = r.body;
  const items = [];
  const re = /<a href="\/article\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const inner = m[2];
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(inner);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    const alt = /<img[^>]*\balt="([^"]*)"/i.exec(inner);
    const img = /<img[^>]*\bsrc="([^"]+)"/i.exec(inner);
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(inner);
    const md = /<span>(\d{1,2}\.\d{1,2})<\/span>/i.exec(inner);
    const title = stripTags(h2 ? h2[1] : h3 ? h3[1] : alt ? alt[1] : '').trim();
    if (!title) continue;
    // 封面图路径里带完整日期 Picture/YYYY-MM-DD/，比 MM.DD 可靠
    const ymd = img ? /Picture\/(\d{4}-\d{2}-\d{2})\//.exec(img[1]) : null;
    const publishedAt = ymd ? parseYmdToIso(ymd[1]) : parseMonthDay(md ? md[1] : null);
    const author = h2 && h3 ? stripTags(h3[1]) : null; // 有 h2 时 h3 是作者；无 h2 时 h3 就是标题
    items.push({
      title,
      url: `https://www.chuapp.com/article/${m[1]}.html`,
      publishedAt,
      summary: p ? stripTags(p[1]).slice(0, 160) : null,
      image: img ? decodeEntities(img[1]) : null,
      author,
      heat: null,
    });
  }
  return makeSource(
    {
      id: 'chuapp',
      name: '触乐',
      role: 'media',
      region: 'cn',
      type: 'html',
      url: 'https://www.chuapp.com/',
      httpStatus: r.status,
      latencyMs: r.latencyMs,
    },
    items,
    {
      headers: { 'User-Agent': UA },
      fields: { title: true, link: true, publishedAt: true, summary: true, image: true, author: true },
      notes:
        '服务端渲染 HTML，无 RSS，无 JSON 接口（首页里没有任何 /api/ 或 ajax 路径）。' +
        '首页能抓到 25 条 /article/<id>.html，标题在 h2（有作者卡的条目）或 h3（无作者卡的条目），' +
        '别只取 h2 —— 那样会漏掉 10 条。' +
        '【时间：列表只到「天」，详情页才到「分」，且要 N+1】' +
        '列表页印的是 <span>10.22</span>，只有月.日，无年份无时分；' +
        '但每条封面的图片路径 img.chuapp.com/wp-content/Picture/YYYY-MM-DD/ 里带完整年月日，' +
        '本脚本优先用它补年份，取不到才退回 MM.DD 按当年推断。' +
        '详情页复核（实测 https://www.chuapp.com/article/291706.html）：' +
        '有 <div class="author-time"><span class="friendly_time" data-time="1792666380">2026年10月22日 18时53分</span>，' +
        'data-time 是 unix 秒，换算后精确到分，同块还有 <em>编辑</em> 作者名；' +
        '但没有 meta[property=article:published_time]、也没有 ld+json 里的 datePublished。' +
        '所以：想拿「分」级时间必须逐条进详情页（25 条 = 25 次请求，不划算），' +
        '列表页只能给到「天」级 —— 排重够用，做秒级时效排序不够。' +
        '首页另有一个「热门文章」模块（div.news > div.line 拼出「热门文章」四个 span，其后 ul li 是人工热榜），' +
        '但只有排序、没有阅读数/评论数，故 heat 仍标 false。',
      debug: { htmlBytes: html.length },
    }
  );
}

/* ---- 9. VGtime：探测失败，进 rejected ---- */
async function probeVgtime() {
  const tried = [];
  const urls = ['https://www.vgtime.com/', 'https://www.vgtime.com/news/', 'https://www.vgtime.com/rss'];
  let lastStatus = 0;
  let homeBody = '';
  for (const [i, u] of urls.entries()) {
    const r = await politeGet(u);
    tried.push({ url: u, status: r.status, bytes: r.body.length });
    lastStatus = r.status;
    // 只保留首页 body 做「是否被劫持」判断，别被后面 404 的错误页覆盖
    if (i === 0) homeBody = r.body;
  }
  const looksHijacked = /saved from url=\(0021\)https:\/\/www\.u78g\.com/.test(homeBody);
  const bytes = tried[0]?.bytes || 0;
  return {
    name: 'VGtime 游戏时光',
    reason: looksHijacked
      ? `域名已不再服务原站：首页只返回 ${bytes} 字节的 SEO 镜像壳，HTML 开头留着 ` +
        '"saved from url=(0021)https://www.u78g.com/" 注释，CSS 指向 youjiu.173183.com，' +
        '正文全是「某游戏上线/某活动开启」的软文标题，没有任何 vgtime 自有栏目或文章链接；' +
        '/news/ 返回 500，/rss 返回 404。HEAD 请求还带着空文件的 etag（da39a3ee5e6b4b0d3255bfef95601890afd80709）' +
        '和 Content-Length: 0 —— 典型的域名过期后被停放/SEO 农场接管，不是反爬。'
      : '/news/ 与 /rss 均不可用，首页内容为空壳，无稳定文章入口',
    tried: urls,
    _status: lastStatus,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const t0 = Date.now();
  const sources = [];

  const probes = [
    ['机核 RSS', probeGcoresRss],
    ['机核 JSON:API', probeGcoresApi],
    ['游研社 RSS', probeYystv],
    ['游民星空 HTML', probeGamersky],
    ['3DM HTML', probe3dm],
    ['GameLook RSS', probeGamelook],
    ['indienova RSS', probeIndienovaRss],
    ['indienova HTML 列表', probeIndienova],
    ['触乐 HTML', probeChuapp],
  ];

  for (const [label, fn] of probes) {
    process.stderr.write(`· probing ${label} ... `);
    try {
      const s = await fn();
      sources.push(s);
      process.stderr.write(
        `HTTP ${s.httpStatus} / ${s.itemCount} 条 / ${s.verified ? 'VERIFIED' : 'FAILED'} / ${s.latencyMs ?? '-'}ms\n`
      );
    } catch (err) {
      process.stderr.write(`threw: ${err?.message || err}\n`);
    }
  }

  process.stderr.write('· probing VGtime ... ');
  const vg = await probeVgtime();
  process.stderr.write(`FAILED (HTTP ${vg._status})\n`);

  const out = {
    domain: 'cn-media',
    probedAt: toCST(Date.now()),
    sources,
    rejected: [
      {
        name: vg.name,
        reason: vg.reason,
        tried: vg.tried,
      },
      {
        name: '游民星空站内 RSS',
        reason:
          '官方 RSS 入口已废弃：/rss/ 返回 403，/rss.xml 与 /rss.aspx 返回 404。' +
          '该站只能走 HTML 列表（见 gamersky 条目，实测可用且带真实时间）',
        tried: [
          'https://www.gamersky.com/rss/',
          'https://www.gamersky.com/rss.xml',
          'https://www.gamersky.com/rss.aspx',
        ],
      },
      {
        name: 'indienova /feed（无尾斜杠）',
        reason:
          'https://indienova.com/feed 返回 404，但 https://indienova.com/feed/（带尾斜杠）返回 200 —— ' +
          '这个斜杠差点让我误判该站没有 RSS，记录在此当反例',
        tried: ['https://indienova.com/feed'],
      },
      {
        name: '游戏葡萄 youxiputao.com',
        reason: '未探测：GameLook 的 /feed/ 已实测可用，按需求「二选一」只保留一个，葡萄留待后续',
        tried: [],
      },
    ],
  };

  await mkdir(path.dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(out, null, 2) + '\n', 'utf8');

  // 控制台摘要
  const ok = sources.filter((s) => s.verified);
  console.log('\n=== cn-media 探测结果 ===');
  for (const s of sources) {
    const flag = s.verified ? '✅ verified' : '❌ failed  ';
    console.log(
      `${flag}  ${s.id.padEnd(14)} ${String(s.itemCount).padStart(3)} 条  ` +
        `pubAt=${s.fields.publishedAt ? 'Y' : 'N'} heat=${s.fields.heat ? 'Y' : 'N'}  ` +
        `latest=${s.latestAt || '—'}`
    );
  }
  console.log(`\nverified ${ok.length}/${sources.length}，rejected ${out.rejected.length} 项`);
  console.log(`写作 ${OUT_JSON}`);
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
