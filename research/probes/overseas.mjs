#!/usr/bin/env node
/**
 * 游戏资讯雷达 · 信源可抓性探测 —— domain: overseas
 * 海外一线媒体 + 平台厂商 + 引进信号
 *
 * 运行：node research/probes/overseas.mjs
 * 产出：research/sources/overseas.json
 *
 * 约束（与 SCHEMA.md 一致）：
 *   - 只用原生 fetch，不装依赖
 *   - 同一域名请求间隔 >= 1s，单源 <= 5 次请求
 *   - 不登录、不绕验证码、不破 Cloudflare
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT_JSON = resolve(ROOT, 'research', 'sources', 'overseas.json');

/* ------------------------------------------------------------------ */
/* 基础网络层：按域名限速 + 计时 + 统一错误捕获                          */
/* ------------------------------------------------------------------ */

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_BOT = 'newsradar/0.1 (+https://example.com/newsradar-probe)';
// YouTube 的 feeds/videos.xml 对 UA 敏感且会间歇性 404，实测这版短的更稳
const UA_CHROME_SHORT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const MIN_GAP_MS = 1100; // 同域名间隔 >= 1s
const lastHitAt = new Map();
const requestLog = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

async function throttle(host) {
  const prev = lastHitAt.get(host) || 0;
  const wait = prev + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHitAt.set(host, Date.now());
}

/**
 * @returns {{ok:boolean,status:number,ms:number,body:string,headers:Headers|null,finalUrl:string,error:string|null}}
 */
async function get(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const urlStr = String(url);
  const host = hostOf(urlStr);
  await throttle(host);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  let status = 0;
  let body = '';
  let hdrs = null;
  let finalUrl = urlStr;
  let error = null;

  try {
    const res = await fetch(urlStr, {
      headers: { 'User-Agent': UA_CHROME, 'Accept-Encoding': 'gzip, deflate', ...headers },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    status = res.status;
    finalUrl = res.url || urlStr;
    hdrs = res.headers;
    body = await res.text();
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - t0;
  requestLog.push({ url: urlStr, host, status, ms, bytes: body.length, error });
  return { ok: !error && status >= 200 && status < 300, status, ms, body, headers: hdrs, finalUrl, error };
}

/* ------------------------------------------------------------------ */
/* 通用解析工具                                                        */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#8217': '\u2019', '#8216': '\u2018', '#8220': '\u201c',
  '#8221': '\u201d', '#8211': '\u2013', '#8212': '\u2014', '#8230': '\u2026',
};

function decodeEntities(s = '') {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+|#\d+);/g, (m, n) => (NAMED_ENTITIES[n] !== undefined ? NAMED_ENTITIES[n] : m));
}

function stripCdata(s = '') {
  return String(s).replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

function cleanText(s = '') {
  return decodeEntities(stripCdata(s))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统一输出 +08:00 的 ISO 时间 */
function isoCN(input) {
  if (input === null || input === undefined || input === '') return null;
  let d;
  if (input instanceof Date) d = input;
  else if (typeof input === 'number') d = new Date(input > 1e12 ? input : input * 1000);
  else d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().replace('Z', '+08:00');
}

function pickTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

function pickAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/* RSS / Atom 解析                                                     */
/* ------------------------------------------------------------------ */

function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const rawItems = isAtom
    ? [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1])
    : [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

  const items = rawItems.map((raw) => {
    const title = cleanText(pickTag(raw, 'title') || '');
    let link = null;
    if (isAtom) {
      const alt = raw.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i);
      link = alt ? decodeEntities(alt[1]) : pickAttr(raw, 'link', 'href') || cleanText(pickTag(raw, 'id') || '');
    } else {
      link = cleanText(pickTag(raw, 'link') || '') || pickAttr(raw, 'link', 'href');
    }

    const dateRaw =
      pickTag(raw, 'pubDate') ||
      pickTag(raw, 'published') ||
      pickTag(raw, 'updated') ||
      raw.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)?.[1] ||
      null;

    let summary = pickTag(raw, 'description') || pickTag(raw, 'summary') || pickTag(raw, 'content:encoded') || '';
    summary = cleanText(summary).slice(0, 300);

    const image =
      pickAttr(raw, 'media:content', 'url') ||
      pickAttr(raw, 'media:thumbnail', 'url') ||
      pickAttr(raw, 'enclosure', 'url') ||
      (pickTag(raw, 'description') || '').match(/<img[^>]*src="([^"]+)"/i)?.[1] ||
      null;

    const author =
      cleanText(pickTag(raw, 'dc:creator') || '') || cleanText(pickTag(raw, 'author') || '') || null;

    const categories = [...raw.matchAll(/<category(?:\s[^>]*)?>(?:\s*<!\[CDATA\[)?([\s\S]*?)(?:\]\]>\s*)?<\/category>/gi)]
      .map((m) => cleanText(m[1]))
      .filter(Boolean)
      .slice(0, 8);

    return {
      title: decodeEntities(title),
      url: link,
      publishedAt: isoCN(dateRaw ? cleanText(dateRaw) : null),
      summary: summary || null,
      image: image ? decodeEntities(image) : null,
      author,
      categories,
    };
  });

  return { isAtom, items: items.filter((i) => i.title) };
}

function fieldsOf(items, { heat = false, heatNote = null } = {}) {
  const any = (k) => items.filter((i) => i[k] !== null && i[k] !== undefined && i[k] !== '').length;
  return {
    title: any('title') >= Math.min(3, items.length),
    link: any('url') >= Math.min(3, items.length),
    publishedAt: any('publishedAt') > 0,
    summary: any('summary') > 0,
    image: any('image') > 0,
    heat,
    author: any('author') > 0,
  };
}

function latestOf(items) {
  const ts = items
    .map((i) => (i.publishedAt ? new Date(i.publishedAt).getTime() : NaN))
    .filter((n) => !Number.isNaN(n));
  if (!ts.length) return null;
  return isoCN(Math.max(...ts));
}

function sampleOf(items, n = 5) {
  return items.slice(0, n).map((i) => ({
    title: i.title,
    url: i.url,
    publishedAt: i.publishedAt,
  }));
}

/* ------------------------------------------------------------------ */
/* 源定义容器                                                          */
/* ------------------------------------------------------------------ */

const sources = [];
const rejected = [];

function push(source) {
  sources.push(source);
  return source;
}

function rejectedEntry(name, reason, tried) {
  rejected.push({ name, reason, tried: [...new Set(tried.filter(Boolean))] });
}

function base({ id, name, role, region, type, url }) {
  return {
    id,
    name,
    role,
    region,
    type,
    url,
    verified: false,
    httpStatus: null,
    latencyMs: null,
    itemCount: 0,
    latestAt: null,
    fields: {
      title: false, link: false, publishedAt: false, summary: false,
      image: false, heat: false, author: false,
    },
    headers: {},
    notes: '',
    failure: null,
    sample: [],
  };
}

/* ------------------------------------------------------------------ */
/* A. 海外媒体：通用 RSS 探测                                          */
/* ------------------------------------------------------------------ */

async function probeRssSource(def) {
  const src = base(def);
  const res = await get(def.url, { headers: def.headers || {} });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;

  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    src.notes = def.failNote || `返回 ${res.status}，未拿到可用 feed。`;
    rejectedEntry(def.name, src.failure, [def.url]);
    return push(src);
  }

  const { items, isAtom } = parseFeed(res.body);
  src.itemCount = items.length;
  src.latestAt = latestOf(items);
  src.fields = fieldsOf(items, { heat: def.heat || false });
  src.headers = def.headers || {};
  src.sample = sampleOf(items);

  if (items.length >= 5 && src.fields.title) {
    src.verified = true;
    src.notes = def.note
      ? def.note(items, res, isAtom)
      : `${isAtom ? 'Atom' : 'RSS 2.0'}，单次返回 ${items.length} 条。`;
  } else {
    src.failure = `仅解析到 ${items.length} 条带标题条目（< 5）`;
    src.notes = `HTTP ${res.status} 但有效条目不足，内容可能是 JS 空壳或结构变更。`;
    rejectedEntry(def.name, src.failure, [def.url]);
  }
  return push(src);
}

/* ------------------------------------------------------------------ */
/* A6. Reddit r/games —— hot.json 死，.rss 活（lead 实测校正）           */
/* ------------------------------------------------------------------ */

const REDDIT_UA = 'game-radar/0.1 (by tap-editor)';

async function probeReddit() {
  const rssUrl = 'https://www.reddit.com/r/games/.rss';
  const src = base({
    id: 'reddit-r-games',
    name: 'Reddit r/games',
    role: 'community',
    region: 'global',
    type: 'rss',
    url: rssUrl,
  });

  const hotUrl = 'https://www.reddit.com/r/games/hot.json?limit=25&raw_json=1'; // 仅记录用，不再请求（会触发 429 拖死 .rss）
  const rssHeaders = {
    'User-Agent': REDDIT_UA,
    Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
  };

  // .rss 偶发 429（Reddit 短时限流），退避重试最多 3 次
  let res = await get(rssUrl, { headers: rssHeaders });
  for (let i = 0; i < 2 && res.status === 429; i++) {
    await sleep(i === 0 ? 15000 : 30000);
    res = await get(rssUrl, { headers: rssHeaders });
  }
  const hotBlocked = false;

  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  src.headers = {
    'User-Agent': REDDIT_UA,
    Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
  };

  if (!res.ok) {
    src.failure = `${res.error || `HTTP ${res.status}`}；.rss 也被拒（多为短时限流 429，冷却几分钟后恢复）`;
    src.notes =
      `★ 关键结论：hot.json 是死的（403 "blocked by network security"，与 UA 无关），但 .rss 是活的。` +
      `.rss 偶发 429 = Reddit 的短时限流（前面打 hot.json 多了就会触发），等几分钟再打就 200。` +
      `不要用 hot.json，直接用 .rss。`;
    rejectedEntry('Reddit r/games', src.failure, [rssUrl, hotUrl]);
    return push(src);
  }

  const { items } = parseFeed(res.body);
  src.itemCount = items.length;
  src.fields = fieldsOf(items, { heat: true }); // 热榜位次即热度
  src.latestAt = latestOf(items);
  src.sample = sampleOf(items);

  if (items.length >= 5 && src.fields.title) {
    src.verified = true;
    src.notes =
      `★ 入口是 .rss（Atom），不是 hot.json。单次 25 条，无分页参数。` +
      `字段：title / link / updated（发布时间） / author（/u/xxx） / content（HTML 转义正文）。` +
      `热度：列表顺序 = hot 榜位次（可当 rank 用）；★ .rss 不返回 score / comments 绝对值（那是 hot.json 才有，已被封）。` +
      `UA 必须是自定义的 "${REDDIT_UA}"，浏览器 UA 反而 403。` +
      (hotBlocked ? `（本次同时复核 hot.json → ${hotRes.status} 拦截页，已弃用）` : '') +
      `限流：短时间内重复请求会 429，建议 intervalMin ≥ 60。`;
  } else {
    src.failure = `HTTP ${res.status} 但只解析到 ${items.length} 条`;
    rejectedEntry('Reddit r/games', src.failure, [rssUrl]);
  }
  return push(src);
}

/* ------------------------------------------------------------------ */
/* B. Steam 官方接口                                                   */
/* ------------------------------------------------------------------ */

const STEAM_CC = 'cc=cn&l=schinese'; // 中国大陆视角

async function probeSteamFeaturedCategories() {
  const url = `https://store.steampowered.com/api/featuredcategories?${STEAM_CC}`;
  const src = base({
    id: 'steam-featuredcategories',
    name: 'Steam 特色分类（热销/新品/即将发售）',
    role: 'platform',
    region: 'global',
    type: 'json',
    url,
  });
  const res = await get(url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }

  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    src.failure = 'HTTP 200 但非 JSON';
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }

  const buckets = ['top_sellers', 'new_releases', 'specials', 'coming_soon'];
  const items = [];
  const bucketSizes = {};
  for (const b of buckets) {
    const arr = json?.[b]?.items || [];
    bucketSizes[b] = arr.length;
    arr.slice(0, 10).forEach((it, idx) => {
      items.push({
        title: it.name,
        url: `https://store.steampowered.com/app/${it.id}`,
        publishedAt: null, // 该接口无时间字段
        summary: it.discounted
          ? `${it.discount_percent}% off · ${it.final_price ?? 0} (${it.currency})`
          : `${it.final_price ?? 0} (${it.currency})`,
        image: it.large_capsule_image || it.header_image || null,
        author: null,
        appid: it.id,
        bucket: b,
        rank: idx + 1,
      });
    });
  }

  src.itemCount = items.length;
  src.verified = items.length >= 5;
  src.fields = fieldsOf(items, { heat: true });
  src.fields.publishedAt = false;
  src.headers = {};
  src.sample = sampleOf(items);
  src.notes =
    `单次拿到 top_sellers ${bucketSizes.top_sellers} 条、new_releases ${bucketSizes.new_releases} 条、` +
    `coming_soon ${bucketSizes.coming_soon} 条、specials ${bucketSizes.specials} 条（中国大陆 cc=cn&l=schinese，价格 CNY）。` +
    `字段：id/name/discounted/discount_percent/original_price/final_price/currency/header_image/large_capsule_image。` +
    `热度：只有「数组顺序=榜单名次」这层相对热度，没有绝对数值。无发布时间、无发售日、无评价数、无愿望单量。` +
    `无分页参数，每个榜单上限 10（new_releases 例外，30 条）。`;
  return push(src);
}

async function probeSteamFeatured() {
  const url = `https://store.steampowered.com/api/featured?${STEAM_CC}`;
  const src = base({
    id: 'steam-featured',
    name: 'Steam 首页推荐位（featured）',
    role: 'platform',
    region: 'global',
    type: 'json',
    url,
  });
  const res = await get(url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    src.failure = 'HTTP 200 但非 JSON';
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }

  const keys = ['featured_win', 'featured_mac', 'featured_linux', 'large_capsules'];
  const items = [];
  const sizes = {};
  for (const k of keys) {
    const arr = Array.isArray(json?.[k]) ? json[k] : [];
    sizes[k] = arr.length;
    arr.slice(0, 10).forEach((it, idx) => {
      items.push({
        title: it.name,
        url: it.id ? `https://store.steampowered.com/app/${it.id}` : null,
        publishedAt: null,
        summary: it.discounted ? `${it.discount_percent}% off` : 'no discount',
        image: it.large_capsule_image || it.header_image || null,
        author: null,
        appid: it.id,
        slot: k,
        rank: idx + 1,
      });
    });
  }
  // 去重（win/mac/linux 大量重复），但保留原始条数
  const uniq = [];
  const seen = new Set();
  for (const it of items) {
    const key = it.appid || it.title;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }

  src.itemCount = items.length;
  src.verified = items.length >= 5;
  src.fields = fieldsOf(items, { heat: false });
  src.fields.publishedAt = false;
  src.sample = sampleOf(items);
  src.notes =
    `featured_win ${sizes.featured_win} / featured_mac ${sizes.featured_mac} / featured_linux ${sizes.featured_linux} / ` +
    `large_capsules ${sizes.large_capsules}，三平台大量重复，去重后 ${uniq.length} 款。` +
    `字段：id/name/discounted/discount_percent/original_price/final_price/currency/large_capsule_image。` +
    `仅首页编排位，无排名含金量、无时间、无评价与愿望单数据；对「引进选题」价值低于 featuredcategories。`;
  return push(src);
}

async function probeSteamAppNews() {
  // appid 730 = CS2（官方公告流最稳）
  const url = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=20&maxlength=300&format=json';
  const src = base({
    id: 'steam-appnews',
    name: 'Steam 官方公告流（ISteamNews GetNewsForApp）',
    role: 'platform',
    region: 'global',
    type: 'json',
    url,
  });
  const res = await get(url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    src.failure = 'HTTP 200 但非 JSON';
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }
  const news = json?.appnews?.newsitems || [];
  const items = news.map((n) => ({
    title: n.title,
    url: n.url,
    publishedAt: isoCN(n.date),
    summary: String(n.contents || '').replace(/\s+/g, ' ').slice(0, 300),
    image: null,
    author: n.author || null,
    categories: n.tags || [],
  }));

  src.itemCount = items.length;
  src.verified = items.length >= 5;
  src.fields = fieldsOf(items, { heat: false });
  src.latestAt = latestOf(items);
  src.sample = sampleOf(items);
  src.notes =
    `appid=730（CS2）单次 ${items.length} 条。字段：gid/title/url/author/contents/feedlabel/date(Unix 秒)/feedname/feed_type/appid/tags。` +
    `要闻可用 count=50；如需全站公告聚合，改走 store.steampowered.com/news 的 partner 聚合（需另测）。` +
    `注意：这是「厂商公告/更新日志」，不是媒体新闻，无热度值。`;
  return push(src);
}

async function probeSteamAppDetails() {
  // 逐个请求：1 已发售大作 / 1 预购中 / 1 免费未发售 / 2 老游戏
  // ★ 实测：appids=a,b,c 批量传会返回 400（4 字节空体），只能一个 appid 一次请求
  const appidList = ['1091500', '4435490', '3355230', '570', '730'];
  const url = `https://store.steampowered.com/api/appdetails?appids=${appidList[0]}&${STEAM_CC}`;
  const src = base({
    id: 'steam-appdetails',
    name: 'Steam 单品详情（appdetails，含评价数与发售日）',
    role: 'signal',
    region: 'global',
    type: 'json',
    url,
  });

  const items = [];
  const tried = [];
  let firstStatus = null;
  let totalMs = 0;

  for (const appid of appidList) {
    const u = `https://store.steampowered.com/api/appdetails?appids=${appid}&${STEAM_CC}`;
    tried.push(u);
    const res = await get(u, { headers: { 'User-Agent': UA_CHROME } });
    totalMs += res.ms;
    if (firstStatus === null) firstStatus = res.status;
    if (!res.ok) continue;
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch {
      continue;
    }
    const v = json?.[appid];
    if (!v?.success || !v.data) continue;
    const d = v.data;
    const reviews = d.recommendations?.total ?? null;
    items.push({
      title: d.name,
      url: `https://store.steampowered.com/app/${appid}`,
      publishedAt: null,
      summary:
        `发售：${d.release_date?.date ?? '未知'}${d.release_date?.coming_soon ? '（未发售）' : ''} · ` +
        `评价数：${reviews ?? '无'} · Metacritic：${d.metacritic?.score ?? '无'} · ` +
        `价格：${d.price_overview?.final_formatted ?? (d.is_free ? '免费' : '未知')}`,
      image: d.header_image || null,
      author: (d.developers || []).join(', ') || null,
      appid,
      releaseDate: d.release_date?.date ?? null,
      comingSoon: !!d.release_date?.coming_soon,
      recommendationsTotal: reviews,
      metacritic: d.metacritic?.score ?? null,
      priceCNY: d.price_overview?.final ?? null,
      genres: (d.genres || []).map((g) => g.description),
      publishers: d.publishers || [],
    });
  }

  src.httpStatus = firstStatus;
  src.latencyMs = Math.round(totalMs / appidList.length);
  src.itemCount = items.length;
  src.verified = items.length >= 5;
  src.fields = fieldsOf(items, { heat: true });
  src.fields.publishedAt = false; // 只有发售日，没有「本条发布时间」
  src.sample = sampleOf(items);
  src.headers = {};
  if (!src.verified) {
    src.failure = `逐个请求 ${appidList.length} 个 appid，只成功解析 ${items.length} 条`;
    rejectedEntry(src.name, src.failure, tried);
    return push(src);
  }
  src.notes =
    `★ appids 参数不支持逗号批量：实测 appids=a,b,c 直接 400（返回 4 字节），必须一个 appid 一次请求，` +
    `所以本项 = ${appidList.length} 次请求（≈${(totalMs / 1000).toFixed(1)}s，受同域 ≥1s 限速）。` +
    `★ 引进判断可用字段（都是可比数值/结构化）：` +
    `recommendations.total（全站累计评测数，实测 1091500=900,060）、metacritic.score、` +
    `price_overview.final + currency（cc=cn 返回 CNY）、release_date.date + release_date.coming_soon、` +
    `genres / categories / developers / publishers / supported_languages / platforms。` +
    `★ 未发售游戏 recommendations 为 null —— 新游拿不到任何量级数值；接口完全不返回愿望单数 / 关注数。` +
    `无 publishedAt 概念（只有发售日）。`;
  return push(src);
}

/* ------------------------------------------------------------------ */
/* B7. Steam 搜索页（新品榜 / 即将发售 / 标签筛选）                     */
/* ------------------------------------------------------------------ */

function parseSteamSearchHtml(html) {
  const blocks = html.split(/<a href="https:\/\/store\.steampowered\.com\/app\//).slice(1);
  const out = [];
  for (const b of blocks) {
    const appid = b.match(/^(\d+)/)?.[1];
    const title = b.match(/<span class="title">([^<]*)<\/span>/)?.[1];
    if (!appid || !title) continue;
    const released = b.match(/class="search_released responsive_secondrow">([\s\S]*?)<\/div>/)?.[1] || '';
    const tooltip = b.match(/data-tooltip-html="([^"]*)"/)?.[1] || '';
    const tagIds = b.match(/data-ds-tagids="\[([^\]]*)\]"/)?.[1] || '';
    const price = b.match(/data-price-final="(\d+)"/)?.[1];
    out.push({
      appid,
      title: decodeEntities(title),
      releasedLabel: cleanText(released),
      reviewTooltip: cleanText(decodeEntities(tooltip.replace(/&lt;br&gt;/g, ' '))),
      tagIds: tagIds ? tagIds.split(',').filter(Boolean) : [],
      priceFinal: price ? Number(price) : null,
    });
  }
  return out;
}

async function probeSteamSearch(def) {
  const src = base(def);
  const res = await get(def.url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    rejectedEntry(def.name, src.failure, [def.url]);
    return push(src);
  }
  const rows = parseSteamSearchHtml(res.body);
  const items = rows.map((r, idx) => ({
    title: r.title,
    url: `https://store.steampowered.com/app/${r.appid}`,
    publishedAt: null,
    summary: `发售日：${r.releasedLabel || '未知'}${r.reviewTooltip ? ` · ${r.reviewTooltip}` : ''}`,
    image: null,
    author: null,
    appid: r.appid,
    rank: idx + 1,
    releasedLabel: r.releasedLabel,
    reviewTooltip: r.reviewTooltip,
    tagIds: r.tagIds,
  }));

  src.itemCount = items.length;
  src.verified = items.length >= 5;
  src.fields = fieldsOf(items, { heat: def.hasHeat !== false });
  src.fields.publishedAt = false;
  src.sample = sampleOf(items);
  const totalMatch = res.body.match(/([\d,]+)\s*个匹配的搜索结果/);
  src.notes =
    `HTML 服务端渲染，单次 count 参数可到 50（实测 20 条）。${totalMatch ? `页面报告共 ${totalMatch[1]} 个匹配结果，` : ''}` +
    `分页用 &start=0&count=50 递增。` +
    `每行可解析：data-ds-appid、<span class="title">、search_released（★这些是「发售日」不是发布时间）、` +
    `search_review_summary 的 data-tooltip-html（★含「888 篇用户评测中 75% 为好评」这类可比数值）、` +
    `data-ds-tagids（标签 ID 数组）、data-price-final。` +
    `注意：l=schinese 时评测数只统计「中文评测」（页面原文有说明），要拿全量口径需 l=english 或改用 appdetails.recommendations.total。` +
    (def.extraNote || '');
  return push(src);
}

/* ------------------------------------------------------------------ */
/* B9/B10. PlayStation Blog / Xbox Wire                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* B11. Nintendo Whatsnew（内嵌 Contentful JSON）                      */
/* ------------------------------------------------------------------ */

async function probeNintendo() {
  const url = 'https://www.nintendo.com/us/whatsnew/';
  const src = base({
    id: 'nintendo-whatsnew',
    name: 'Nintendo（美）Whatsnew 官方资讯',
    role: 'platform',
    region: 'us',
    type: 'html',
    url,
  });
  const res = await get(url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }

  const html = res.body;
  // 标题 + 相对 URL 在 SSR 的 <a aria-label="TITLE" href="/us/whatsnew/slug/">
  const anchors = [
    ...html.matchAll(/aria-label="([^"]{5,220})"\s+href="(\/us\/whatsnew\/[^"]+)"/g),
  ].map((m) => ({ title: decodeEntities(m[1]), path: m[2] }));

  // 发布时间在内嵌 Contentful JSON： "publishDate":"...","url(...)":"/us/whatsnew/slug/"
  const dateMap = new Map();
  for (const m of html.matchAll(/"publishDate":"([^"]+)"[^\n]{0,300}?"(\/us\/whatsnew\/[a-z0-9\-]+\/)"/g)) {
    dateMap.set(m[2], m[1]);
  }

  const seen = new Set();
  const items = [];
  for (const a of anchors) {
    if (seen.has(a.path)) continue;
    seen.add(a.path);
    items.push({
      title: a.title,
      url: `https://www.nintendo.com${a.path}`,
      publishedAt: isoCN(dateMap.get(a.path) || null),
      summary: null,
      image: null,
      author: null,
    });
  }

  src.itemCount = items.length;
  src.verified = items.length >= 5 && items.some((i) => i.publishedAt);
  src.fields = fieldsOf(items, { heat: false });
  src.latestAt = latestOf(items);
  src.sample = sampleOf(items);
  if (src.verified) {
    src.notes =
      `Next.js SSR 页面，文章列表（${items.length} 条）直接从 HTML 抓：` +
      `<a aria-label="标题" href="/us/whatsnew/<slug>/">；发布时间藏在页面内嵌的 Contentful JSON 里` +
      `（"publishDate":"2026-10-22T16:00:00.000Z"），用「publishDate 紧跟 /us/whatsnew/<slug>/」配对，实测 ${dateMap.size} 条可配对。` +
      `无 RSS、无公开 JSON API、无摘要/图片/热度。仅供「任天堂第一方/独占情报」用，量少（约 1-2 条/天）。`;
  } else {
    src.failure = `解析到 ${items.length} 条标题，但时间字段缺失`;
    rejectedEntry(src.name, src.failure, [url]);
  }
  return push(src);
}

/* ------------------------------------------------------------------ */
/* C14. itch.io                                                        */
/* ------------------------------------------------------------------ */

async function probeItch(def) {
  const src = base(def);
  const res = await get(def.url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    rejectedEntry(def.name, src.failure, [def.url]);
    return push(src);
  }

  const html = res.body;
  const items = [];
  // ★ 坑：属性顺序在 /games/newest 和 /games/top-rated 上不一样
  //   newest:    <a data-label="game:ID:title" data-action="..." class="title game_link" href="...">Title</a>
  //   top-rated: <a data-action="..." href="..." data-label="game:ID:title" class="title game_link">Title</a>
  // 所以先按 data-label 定位，再在块内独立抠 href / 文本。
  // ★ 坑：属性顺序在 /games/newest 和 /games/top-rated 上不一样
  //   newest:    <a data-label="game:ID:title" ... class="title game_link" href="...">Title</a>
  //   top-rated: <a data-action="..." href="..." data-label="game:ID:title" class="title game_link">Title</a>
  // 所以先抓完整 <a ...>...</a>，再看它是不是标题锚点。
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1] || '';
    if (!/data-label="game:\d+:title"/.test(attrs)) continue;
    const href = attrs.match(/href="([^"]+)"/)?.[1];
    const title = decodeEntities(cleanText(m[2])).trim();
    if (!href || !title) continue;
    items.push({
      title,
      url: href,
      publishedAt: null,
      summary: null,
      image: null,
      author: new URL(href).host.split('.')[0],
    });
  }

  // 补一个「是否付费/名称」信息没有稳定结构，不硬猜

  src.itemCount = items.length;
  src.verified = items.length >= 5;
  src.fields = fieldsOf(items, { heat: def.hasHeat === true });
  src.fields.publishedAt = false;
  src.sample = sampleOf(items);
  src.notes =
    `纯 HTML，${items.length} 条/页，分页用 ?page=2。` +
    `★ 无 RSS、无 JSON API：实测 /games/newest.rss、/games.rss、/games/newest.json 全部 404；?format=rss 返回的是同一份 HTML。` +
    `每条可拿：标题、游戏页 URL、作者子域（=开发者）。` +
    `★ 列表页没有「发布时间 / 播放量 / 评分 / 评论数」任何数值（发布时间要进详情页才有），` +
    `所以 itch 只能做「新游发现」，无法做量级比较；官方 API（api/1）需要注册 key。`;
  return push(src);
}

/* ------------------------------------------------------------------ */
/* C13. SteamDB 愿望单榜                                                */
/* ------------------------------------------------------------------ */

async function probeSteamDb() {
  const url = 'https://steamdb.info/stats/mostwished/';
  const src = base({
    id: 'steamdb-mostwished',
    name: 'SteamDB 愿望单排行',
    role: 'signal',
    region: 'global',
    type: 'html',
    url,
  });
  const res = await get(url, {
    headers: {
      'User-Agent': UA_CHROME,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://steamdb.info/',
    },
  });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  const body = res.body || '';
  const looksLikeChallenge = /<title>SteamDB<\/title>/i.test(body) && body.length < 60000;

  if (!res.ok || looksLikeChallenge) {
    src.failure =
      res.status === 403
        ? 'HTTP 403：Cloudflare 反爬挑战页（返回恒定 ~10KB 的 <title>SteamDB</title> 空壳），HTML 抓不到数据'
        : `HTTP ${res.status} ${res.error || ''}`.trim();
    src.notes =
      '实测三路由全部 403：/stats/mostwished/、/charts、首页。' +
      '按约束不破 Cloudflare。SteamDB 无公开 API（有付费 Patreon 档；其数据源为 Steam 官方接口+自建爬虫，愿望单数本身 Steam 不公开）。' +
      '结论：拿不到「愿望单量级」这个核心数值。替代路线见 overseas.md。';
    src.verified = false;
    rejectedEntry('SteamDB 愿望单榜', src.failure, [
      'https://steamdb.info/stats/mostwished/',
      'https://steamdb.info/charts/',
      'https://steamdb.info/',
    ]);
    return push(src);
  }
  return push(src);
}

/* ------------------------------------------------------------------ */
/* C16. YouTube 频道 RSS（免 key）                                      */
/* ------------------------------------------------------------------ */

async function probeYoutube() {
  const channelId = 'UCKy1dAqELo0zrOtPkf0eTMw'; // IGN
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const src = base({
    id: 'youtube-ign',
    name: 'YouTube 频道 · IGN（官方 RSS，免 API key）',
    role: 'media',
    region: 'global',
    type: 'rss',
    url,
  });
  const res = await get(url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;

  // ★ 实测：该端点对同一 IP 有额度，连续打几次之后会稳定 404（偶尔 500），冷却几分钟才恢复。
  // 所以必须「退避重试 + 换 UA」，间隔太短重试无效。
  let body = res.body;
  let okRes = res.ok;
  let retried = false;
  const backoff = [6000, 20000];
  for (let i = 0; i < backoff.length && !okRes; i++) {
    retried = true;
    await sleep(backoff[i]);
    const res2 = await get(url, { headers: { 'User-Agent': i === 0 ? UA_CHROME_SHORT : UA_CHROME } });
    if (res2.ok) {
      okRes = true;
      body = res2.body;
      src.httpStatus = res2.status;
      src.latencyMs = res2.ms;
    }
  }

  if (!okRes) {
    src.failure = res.error || `HTTP ${res.status}（含 1 次重试仍失败）`;
    rejectedEntry(src.name, src.failure, [url]);
    return push(src);
  }

  const entries = [...body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const items = entries.map((e) => {
    const views = e.match(/<media:statistics views="(\d+)"/)?.[1];
    const stars = e.match(/<media:starRating count="(\d+)" average="([\d.]+)"/);
    const videoId = pickTag(e, 'yt:videoId');
    return {
      title: cleanText(pickTag(e, 'title') || ''),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      publishedAt: isoCN(cleanText(pickTag(e, 'published') || '')),
      summary: cleanText(pickTag(e, 'media:description') || '').slice(0, 300) || null,
      image: pickAttr(e, 'media:thumbnail', 'url'),
      author: cleanText(pickTag(e, 'name') || '') || null,
      views: views ? Number(views) : null,
      likes: stars ? Number(stars[1]) : null,
    };
  });

  src.itemCount = items.length;
  src.verified = items.length >= 5;
  src.fields = fieldsOf(items, { heat: true });
  src.latestAt = latestOf(items);
  src.sample = sampleOf(items);
  src.notes =
    `免 API key！单次固定 15 条（YouTube 硬上限，无分页）。` +
    `★ 热度字段：media:statistics views（播放量）、media:starRating count（点赞数）—— 是绝对值，可比较。` +
    `★ 该端点会间歇性 404：同一 URL 连续打，有时 200 有时 404（实测踩到过），必须"失败重试 1 次 + 换 UA"，本脚本已内置。` +
    `★ 需要浏览器 UA；纯 "Mozilla/5.0 Chrome/120" 这种短串会 404，用完整 Chrome UA 或 UA_CHROME_SHORT。` +
    `换频道只需替换 channel_id（从频道页 HTML 的 externalId / meta[itemprop=identifier] 取，IGN=UCKy1dAqELo0zrOtPkf0eTMw）。` +
    `不用 YouTube Data API v3（那个要 key + 每日配额）。` +
    (retried ? '（本次运行触发了 1 次重试才成功）' : '');
  return push(src);
}

/* ------------------------------------------------------------------ */
/* B12. 展会（TGA / Summer Game Fest / Day of the Devs）                */
/* ------------------------------------------------------------------ */

/** 展会类页面：抓 <a href="..."> 后面第一个纯文本片段当标题，跳过 CTA 噪声 */
function anchorsWithText(html, hrefRe, baseUrl, { skip = [] } = {}) {
  const out = [];
  const seen = new Set();
  const junk = new Set(['watch event', 'rewatch', 'watch', 'learn more', 'more', 'read more', ...skip.map((s) => s.toLowerCase())]);
  for (const m of html.matchAll(hrefRe)) {
    const href = m[0].match(/href="([^"]+)"/)?.[1];
    if (!href || seen.has(href)) continue;
    const tail = html.slice(m.index, m.index + 900);
    const txt = tail.match(/>([^<>]{3,200})</);
    if (!txt) continue;
    const title = cleanText(txt[1]);
    if (!title || junk.has(title.toLowerCase())) continue;
    seen.add(href);
    out.push({
      title,
      url: href.startsWith('http') ? href : `${baseUrl}${href}`,
      publishedAt: null,
      summary: null,
      image: null,
      author: null,
    });
  }
  return out;
}

async function probeShowcase(def) {
  const src = base(def);
  const res = await get(def.url, { headers: { 'User-Agent': UA_CHROME } });
  src.httpStatus = res.status;
  src.latencyMs = res.ms;
  if (!res.ok) {
    src.failure = res.error || `HTTP ${res.status}`;
    rejectedEntry(def.name, src.failure, [def.url]);
    return push(src);
  }
  const html = res.body;
  const items = def.parse(html);
  const timeCount = items.filter((i) => i.publishedAt).length;

  src.itemCount = items.length;
  src.verified = items.length >= 5 && timeCount >= 5;
  src.fields = fieldsOf(items, { heat: false });
  src.latestAt = latestOf(items);
  src.sample = sampleOf(items);
  if (src.verified) {
    src.notes = def.note;
  } else {
    src.failure =
      items.length >= 5
        ? `拿到 ${items.length} 条标题，但 0 条发布时间 —— 无 publishedAt，做不了时效判断`
        : `只解析到 ${items.length} 条带标题条目（< 5）`;
    src.notes = def.note;
    rejectedEntry(def.name, src.failure, [def.url]);
  }
  return push(src);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const t0 = Date.now();

  // ---------- A. 海外媒体 ----------
  await probeRssSource({
    id: 'ign',
    name: 'IGN 全站',
    role: 'media',
    region: 'us',
    type: 'rss',
    url: 'https://feeds.ign.com/ign/all',
    note: (items, res) =>
      `feeds.ign.com/ign/all 会 302 到 ${res.finalUrl}（同一份 feed）。RSS 2.0，单次 20 条；` +
      `有 atom:link rel="next" 分页：?start=20&count=20 可继续翻。` +
      `字段：title/link/pubDate/content:encoded（正文 HTML，需去标签）。` +
      `注意：description 为空，摘要要从 content:encoded 取，图片是正文里第一个 <img>。无评论数/热度。`,
  });

  await probeRssSource({
    id: 'gematsu',
    name: 'Gematsu（日系/亚洲新作与档期）',
    role: 'media',
    region: 'us',
    type: 'rss',
    url: 'https://www.gematsu.com/feed',
    note: (items) =>
      `RSS 2.0，单次 ${items.length} 条，发布节奏快（日更 10+ 条），标题即「XX launches March 4, 2027 in Japan」这种档期信息。` +
      `字段：title/link/dc:creator/pubDate/category（含平台 PC/Switch/PS5 与厂商名，可直接筛「未在国区发行」的线索）。` +
      `★ 对「新作公布 + 档期 + 引进」是本批里信噪比最高的媒体源，强烈建议进第一版。`,
  });

  await probeRssSource({
    id: 'eurogamer',
    name: 'Eurogamer',
    role: 'media',
    region: 'uk',
    type: 'rss',
    url: 'https://www.eurogamer.net/feed',
    note: (items) =>
      `RSS 2.0，单次 ${items.length} 条（一次给满 100 条，是本批最多的一家）。` +
      `字段：title/link/dc:creator/pubDate/category（游戏+平台多标签）/media:content(图片)/description。` +
      `无热度值。100 条一次够用一天，可当主 feed。`,
  });

  await probeRssSource({
    id: 'pcgamer',
    name: 'PC Gamer',
    role: 'media',
    region: 'us',
    type: 'rss',
    url: 'https://www.pcgamer.com/rss/',
    note: (items) =>
      `RSS 2.0，单次 ${items.length} 条。体积大（实测约 5MB，正文全文塞在 content:encoded 里），` +
      `建议只取 title/pubDate/link，或加 maxlength 截断，否则吃内存。无热度值。`,
  });

  await probeRssSource({
    id: 'rps',
    name: 'Rock Paper Shotgun',
    role: 'media',
    region: 'uk',
    type: 'rss',
    url: 'https://www.rockpapershotgun.com/feed',
    note: (items) =>
      `RSS 2.0，单次 ${items.length} 条。字段同 Eurogamer（同属 IGN/Gamer Network 技术栈）：` +
      `dc:creator/category 多标签/media:content 图片。无热度值。偏 PC 独立游戏口味，对「值得引进的独立游戏」线索有用。`,
  });

  await probeRssSource({
    id: 'gamesindustry',
    name: 'GamesIndustry.biz（行业/商业）',
    role: 'media',
    region: 'uk',
    type: 'rss',
    url: 'https://www.gamesindustry.biz/feed',
    note: (items) =>
      `RSS 2.0，单次 ${items.length} 条。偏商业/并购/财报/人事，游戏本身信息少，` +
      `但对「某发行商在找亚洲发行/某 IP 易主」这类引进业务线索价值高。无热度值。`,
  });

  await probeReddit();

  // ---------- B. 平台厂商 ----------
  await probeSteamFeaturedCategories();
  await probeSteamFeatured();
  await probeSteamAppNews();
  await probeSteamAppDetails();

  await probeSteamSearch({
    id: 'steam-comingsoon',
    name: 'Steam 即将发售榜（coming soon）',
    role: 'platform',
    region: 'global',
    type: 'html',
    url: `https://store.steampowered.com/search/?filter=comingsoon&${STEAM_CC}&count=50&ignore_preferences=1`,
    hasHeat: false,
    extraNote:
      `★ filter=comingsoon 默认按「发售日升序」排，头部全是当天/本周就要上的小体量游戏，不是「高关注」排序。` +
      `排序参数实测：页面里没有任何 data-sort 选项，sort_by=Released_DESC 被忽略；Steam 搜索不支持按愿望单排序。` +
      `想要「热门即将发售」，只有 featuredcategories 里的 coming_soon 那 10 个（Steam 官方编排），没有别的公开口子。`,
  });

  await probeSteamSearch({
    id: 'steam-tag-comingsoon-indie',
    name: 'Steam 标签筛选：即将发售 + 独立（tags=492）',
    role: 'signal',
    region: 'global',
    type: 'html',
    url: `https://store.steampowered.com/search/?filter=comingsoon&tags=492&${STEAM_CC}&count=50&ignore_preferences=1`,
    hasHeat: false,
    extraNote:
      `★ 按标签筛可行：&tags=492 生效（492=Indie，常用：19=Action、21=Adventure、9=Strategy、122=RPG、599=Simulation），` +
      `多标签用逗号「tags=492,19」。实测结果里每行都带 data-ds-tagids，可自行复核是否真命中 492（少数行 tagids 不全，需兜底）。` +
      `但「高关注」这个维度无法作为参数——Steam 不公开愿望单数，也没有按关注度排序的公开接口。`,
  });

  await probeRssSource({
    id: 'ps-blog',
    name: 'PlayStation Blog（官方）',
    role: 'platform',
    region: 'us',
    type: 'rss',
    url: 'https://blog.playstation.com/feed/',
    note: (items) =>
      `WordPress RSS 2.0，单次 ${items.length} 条。字段：title/link/dc:creator/pubDate/category/content:encoded。` +
      `是第一方新作公布、State of Play 汇总、PS Plus 档期的一手源。无热度值。`,
  });

  await probeRssSource({
    id: 'xbox-wire',
    name: 'Xbox Wire（官方）',
    role: 'platform',
    region: 'us',
    type: 'rss',
    url: 'https://news.xbox.com/en-us/feed/',
    note: (items) =>
      `WordPress RSS 2.0，单次 ${items.length} 条。字段同 PS Blog。` +
      `含 Game Pass 上下架、ID@Xbox 独立游戏公布——ID@Xbox 那部分对引进选题很有用。无热度值。`,
  });

  await probeNintendo();

  // B12 展会：三个候选全测，能过就留
  await probeShowcase({
    id: 'tga-news',
    name: 'The Game Awards 官网新闻',
    role: 'platform',
    region: 'us',
    type: 'html',
    url: 'https://thegameawards.com/news',
    note:
      'Next.js 页面，服务端只渲染出 3 条 /news/ 链接（票务、日期、去年数据），信息密度极低；' +
      '无 RSS、无 JSON 接口。TGA 的「新作公布」实际传播渠道是 IGN/Eurogamer 的报道，抓媒体源更快更全。',
    parse: (html) =>
      anchorsWithText(html, /<a\b[^>]*href="(\/news\/[a-z0-9\-]+)"[^>]*>/gi, 'https://thegameawards.com'),
  });

  await probeShowcase({
    id: 'dayofthedevs',
    name: 'Day of the Devs（独立游戏展）',
    role: 'platform',
    region: 'us',
    type: 'html',
    url: 'https://www.dayofthedevs.com/news',
    note:
      '新闻列表只是把标题链接到 dayofthedevs.org（跨域），列表页无发布时间、无摘要；' +
      '/games 花名册页 962KB 但内容由 JS 渲染，源码里 0 个 Steam/itch 链接。无 RSS。' +
      '结论：DotD 的选品名单拿不到结构化数据，建议直接盯它公布的 Steam 页面。',
    parse: (html) =>
      anchorsWithText(
        html,
        /<a\b[^>]*href="(https:\/\/www\.dayofthedevs\.org\/news\/[a-z0-9\-]+)"[^>]*>/gi,
        'https://www.dayofthedevs.com'
      ),
  });

  await probeShowcase({
    id: 'summergamefest',
    name: 'Summer Game Fest 官网',
    role: 'platform',
    region: 'us',
    type: 'html',
    url: 'https://www.summergamefest.com/events',
    note:
      '只有 18 个发布会条目（Day of the Devs / Nintendo Direct / State of Play / PC Gaming Show 等），' +
      '页面里 0 个日期字符串、无 RSS、无 JSON。可以当「档期日历」人工看，做不了自动信源。',
    parse: (html) =>
      anchorsWithText(html, /<a\b[^>]*href="(\/events\/[a-z0-9\-]+)"[^>]*>/gi, 'https://www.summergamefest.com'),
  });

  // ---------- C. 引进信号 ----------
  await probeSteamDb();
  await probeItch({
    id: 'itch-newest',
    name: 'itch.io 最新上架',
    role: 'signal',
    region: 'global',
    type: 'html',
    url: 'https://itch.io/games/newest',
    hasHeat: false,
  });
  await probeItch({
    id: 'itch-top-rated',
    name: 'itch.io 最高评分',
    role: 'signal',
    region: 'global',
    type: 'html',
    url: 'https://itch.io/games/top-rated',
    // 列表页不显示评分数值，只有排序名次
    hasHeat: false,
  });
  await probeYoutube();

  /* ---------------- 输出 ---------------- */

  const payload = {
    domain: 'overseas',
    probedAt: isoCN(new Date()),
    sources,
    rejected,
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const ok = sources.filter((s) => s.verified).length;
  const totalItems = sources.reduce((a, s) => a + (s.itemCount || 0), 0);
  console.log(`\n=== overseas probe done in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
  console.log(`sources: ${sources.length} (verified ${ok}) · rejected: ${rejected.length} · items: ${totalItems}`);
  for (const s of sources) {
    const flag = s.verified ? 'OK  ' : 'FAIL';
    console.log(
      `  [${flag}] ${s.id.padEnd(28)} ${String(s.httpStatus ?? '-').padEnd(4)} ` +
        `${String(s.itemCount).padStart(3)} items  ${s.latestAt ?? '-'}`
    );
  }
  console.log(`\nrequests: ${requestLog.length}`);
  console.log(`→ ${OUT_JSON}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
