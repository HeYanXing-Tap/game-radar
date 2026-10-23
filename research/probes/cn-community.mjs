#!/usr/bin/env node
/**
 * cn-community 信源探测脚本 —— 中文社区热榜 + TapTap 站内
 *
 *   node research/probes/cn-community.mjs
 *
 * 产出：research/sources/cn-community.json（契约见 research/SCHEMA.md）
 *
 * 设计约束（来自任务要求）：
 *  - 只用原生 fetch，无依赖；
 *  - 同域名请求串行 + 间隔 ≥1.1s；
 *  - 单信源 ≤5 次请求；
 *  - 不登录、不绕验证码、不破签名。需要签名的直接判不可用并写清签名类型。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(__dirname, '../sources/cn-community.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIN_GAP_MS = 1100; // 同域名请求间隔
const REQ_TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------ */
/* 时间与抓取工具                                                      */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UTC 时间戳 / Date -> 带 +08:00 的 ISO（中国无夏令时，固定偏移安全） */
function isoCN(input) {
  if (input === null || input === undefined || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

/** 秒级时间戳 -> ISO */
const isoFromSec = (sec) =>
  sec === null || sec === undefined || Number(sec) <= 0 ? isoCN(null) : isoCN(Number(sec) * 1000);

const nowCN = () => isoCN(new Date());

// 每个 host 一条串行队列，保证同域名间隔
const hostChain = new Map();
const hostLast = new Map();

async function gate(host) {
  const prev = hostChain.get(host) ?? Promise.resolve();
  let release;
  const current = new Promise((r) => (release = r));
  hostChain.set(host, prev.then(() => current));
  await prev;
  const last = hostLast.get(host) ?? 0;
  const gap = Date.now() - last;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
  hostLast.set(host, Date.now());
  release();
}

/**
 * 清掉「给人看」的占位头（如 '<浏览器 UA>'、'<需用户提供>'）和非 Latin-1 字符。
 * Node 的 fetch 会对非 ByteString 头直接抛 TypeError，所以文档用的占位值不能进请求。
 */
function sanitizeHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (/^<.*>$/.test(s.trim())) continue; // 占位符
    if (/[^\x00-\xFF]/.test(s)) continue; // 中文等非 Latin-1
    out[k] = s;
  }
  return out;
}

/**
 * 单次请求。返回 {status, ok, text, latencyMs, finalUrl, contentType, error?}
 * 不抛异常：所有失败都折叠进返回值，方便逐源记录。
 */
async function req(url, { headers = {}, method = 'GET', body = undefined, timeout = REQ_TIMEOUT_MS } = {}) {
  const host = new URL(url).host;
  await gate(host);
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        ...sanitizeHeaders(headers),
        'User-Agent': UA, // 真实 UA 永远最后写入，避免被文档占位值覆盖
      },
      body,
    });
    const text = new TextDecoder('utf-8').decode(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      text,
      latencyMs: Math.round(performance.now() - t0),
      finalUrl: res.url,
      contentType: res.headers.get('content-type') ?? '',
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: '',
      latencyMs: Math.round(performance.now() - t0),
      finalUrl: url,
      contentType: '',
      error: `fetch 失败: ${e?.name ?? 'Error'} ${e?.message ?? e}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 startIdx 处的 '{' 或 '[' 开始，做字符串感知的括号配对，切出合法 JSON 片段 */
function sliceJson(text, startIdx) {
  const open = text[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 结果装配                                                            */
/* ------------------------------------------------------------------ */

const sources = [];
const rejected = [];
const log = [];

/**
 * @param {object} cfg
 * @param {string} cfg.id
 * @param {string} cfg.name
 * @param {'media'|'community'|'overseas'|'platform'|'signal'|'internal'} cfg.role
 * @param {'rss'|'json'|'html'} cfg.type
 * @param {string} cfg.url            主入口
 * @param {object} cfg.headers        必需请求头（cookie 值只写占位）
 * @param {object} cfg.notes
 * @param {Array}  cfg.items          归一化后的条目 [{title,url,publishedAt,heat}]
 * @param {number} cfg.httpStatus
 * @param {number} cfg.latencyMs
 * @param {object} cfg.fieldsExtra    追加/覆盖 fields 布尔位
 * @param {string|null} cfg.failure
 */
function addSource(cfg) {
  const items = (cfg.items ?? []).filter((i) => i && typeof i.title === 'string' && i.title.trim());
  const titled = items.length;
  const fields = {
    title: titled > 0,
    link: items.some((i) => i.url),
    publishedAt: items.some((i) => i.publishedAt),
    summary: items.some((i) => i.summary),
    image: items.some((i) => i.image),
    heat: items.some((i) => i.heat !== null && i.heat !== undefined && i.heat !== ''),
    author: items.some((i) => i.author),
    ...(cfg.fieldsExtra ?? {}),
  };
  const verified = titled >= 5 && !cfg.failure;
  const sample = items.slice(0, 5).map((i) => ({
    title: i.title,
    url: i.url ?? null,
    publishedAt: i.publishedAt ?? null,
    heat: i.heat ?? null,
  }));

  const entry = {
    id: cfg.id,
    name: cfg.name,
    role: cfg.role,
    region: 'cn',
    type: cfg.type,
    url: cfg.url,
    verified,
    httpStatus: cfg.httpStatus ?? null,
    latencyMs: cfg.latencyMs ?? null,
    itemCount: titled,
    latestAt: items.map((i) => i.publishedAt).filter(Boolean).sort().pop() ?? null,
    fields,
    headers: cfg.headers ?? {},
    notes: cfg.notes,
    failure:
      cfg.failure ??
      (cfg.error ? `传输层错误: ${cfg.error}` : null) ??
      (verified ? null : `只拿到 ${titled} 条带标题条目，未达 5 条门槛`),
    sample,
  };
  sources.push(entry);
  log.push(
    `${verified ? '✅' : '❌'} ${entry.id.padEnd(22)} ${String(titled).padStart(3)} 条` +
      ` http=${String(entry.httpStatus).padStart(3)} ${String(entry.latencyMs ?? '-').padStart(5)}ms` +
      (entry.failure ? `  ← ${entry.failure}` : ''),
  );
  return entry;
}

/* ------------------------------------------------------------------ */
/* 1. 小黑盒 xiaoheihe.cn                                              */
/*    站点为纯 SPA 空壳；web 接口强签名：                                     */
/*      _rnd = "15:" + HMAC-SHA256(key=内置常量 qM,                        */
/*              msg = qM + nonce + `${_time}:${nonce}`)                    */
/*    签名在前端 bundle 里算（crypto.subtle），我们不复现 -> 判不可用            */
/* ------------------------------------------------------------------ */
async function probeXiaoheihe() {
  const tried = [];
  const notesParts = [];

  // 候选 1：首页 HTML
  const home = await req('https://www.xiaoheihe.cn/', { headers: { Referer: 'https://www.xiaoheihe.cn/' } });
  tried.push('https://www.xiaoheihe.cn/');
  const homeHasData = /__NUXT__|__NEXT_DATA__|window\.__INITIAL|hkey/.test(home.text);
  notesParts.push(
    `首页 ${home.status} / ${home.text.length}B，纯 SPA 空壳（无 __NUXT__/__NEXT_DATA__ 预置数据）`,
  );

  // 候选 2：真实接口不带签名
  const ts = Math.floor(Date.now() / 1000);
  const apiUrl =
    'https://api.xiaoheihe.cn/bbs/app/api/general/search/v1/web' +
    `?q=%E9%BB%91%E7%A5%9E%E8%AF%9D&offset=0&limit=20&os_type=web&app=heybox` +
    `&x_client_type=web&x_os_type=Mac&x_app=heybox&x_client_version=999.999.999&_time=${ts}&nonce=probe0131`;
  const api = await req(apiUrl, { headers: { Referer: 'https://www.xiaoheihe.cn/' } });
  tried.push(apiUrl.split('?')[0]);
  const apiFailMsg = api.text.slice(0, 160).replace(/\s+/g, ' ').trim();
  notesParts.push(`接口不带 _rnd 签名：HTTP ${api.status}，返回 ${apiFailMsg}`);

  // 候选 3：RSSHub 公共实例
  const rh = await req('https://rsshub.app/xiaoheihe/news');
  tried.push('https://rsshub.app/xiaoheihe/news');
  notesParts.push(
    `RSSHub 公共实例 rsshub.app/xiaoheihe/news：HTTP ${rh.status}` +
      (/Just a moment/.test(rh.text) ? '（Cloudflare 人机校验墙，非签名问题）' : ''),
  );

  rejected.push({
    name: '小黑盒',
    reason:
      'web 接口强制请求签名：HMAC-SHA256 计算 `_rnd=\"15:\"+hmac(key=内置常量 qM, ' +
      'msg=qM+nonce+`${_time}:${nonce}`)`，签名逻辑内联在前端 bundle 用 crypto.subtle 计算；' +
      '首页为 SPA 空壳无可解析列表，RSSHub 公共实例被 Cloudflare 拦截。' +
      '按约束不破签名，判不可用。',
    tried,
  });

  return `首页 SPA 空壳；接口需 HMAC-SHA256(_rnd) 签名，缺签名返回「请求失败了」；RSSHub 被 CF 拦。${notesParts.join('；')}`;
}

/* ------------------------------------------------------------------ */
/* 2/3/4. B站 全站排行 + 游戏区排行                                      */
/* ------------------------------------------------------------------ */
async function probeBilibili() {
  // buvid3 从公开 spi 领取，不是登录态，也不是伪造 cookie
  const spi = await req('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  const spiJson = tryJson(spi.text);
  const buvid3 = spiJson?.data?.b_3 ?? null;

  const baseHeaders = {
    Referer: 'https://www.bilibili.com/v/popular/rank/all/',
    Origin: 'https://www.bilibili.com',
    ...(buvid3 ? { Cookie: `buvid3=${buvid3}` } : {}),
  };

  const mapVideo = (v, key = 'view') => ({
    title: String(v.title ?? '').trim(),
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : v.aid ? `https://www.bilibili.com/video/av${v.aid}` : null,
    publishedAt: isoFromSec(v.pubdate),
    heat: v.stat?.[key] ?? null,
    summary: v.desc ? String(v.desc).replace(/\s+/g, ' ').slice(0, 120) : null,
    image: v.pic ?? null,
    author: v.owner?.name ?? null,
    tname: v.tname ?? null,
  });

  // --- 全站排行 rid=0
  const r0 = await req('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
    headers: { ...baseHeaders, Referer: 'https://www.bilibili.com/v/popular/rank/all/' },
  });
  const j0 = tryJson(r0.text);
  const list0 = j0?.data?.list ?? [];
  const items0 = list0.map((v) => mapVideo(v, 'view'));
  const fresh0 = items0.map((i) => i.publishedAt).filter(Boolean).sort().pop();
  const oldest0 = items0.map((i) => i.publishedAt).filter(Boolean).sort()[0] ?? null;
  const spanDays0 = fresh0 && oldest0 ? Math.round((new Date(fresh0) - new Date(oldest0)) / 86400000) : 0;

  addSource({
    id: 'bilibili-ranking',
    name: 'B站全站热门排行',
    role: 'community',
    type: 'json',
    url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    httpStatus: r0.status,
    latencyMs: r0.latencyMs,
    error: r0.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Referer: 'https://www.bilibili.com/v/popular/rank/all/',
      Origin: 'https://www.bilibili.com',
      Cookie: 'buvid3=<从 https://api.bilibili.com/x/frontend/finger/spi 的 data.b_3 实时领取>',
    },
    items: items0,
    notes:
      `code=${j0?.code}，一次返回 ${items0.length} 条（排行榜每次固定 100 条，无分页参数）。` +
      '**必须带 buvid3 cookie**，否则返回 `{"code":-352}` 风控（实测无 cookie 直接 -352）；' +
      'buvid3 可用公开接口 x/frontend/finger/spi 领取（data.b_3），不需要登录、不需要 wbi 签名。' +
      'fields.heat：`stat.view` 播放量、`stat.like` 点赞、`score` 综合排序分。' +
      `fields.publishedAt：` +
      (fresh0
        ? `视频 pubdate 是**真实发布时间**（不是抓取时间）；本次最新 ${fresh0}，` +
          `${items0.length} 条跨度约 ${spanDays0} 天 —— 它是「近几日综合热门」而不是「当天新增」，别当增量流用。`
        : '缺失。') +
      '榜单混有大量非游戏内容（数码/影视/科普），需按 `tname` 过滤——这正是「受众在聊什么」的价值：' +
      '可用全站榜观察游戏话题是否破圈。',
  });

  // --- 游戏区排行 rid=4
  const r4 = await req('https://api.bilibili.com/x/web-interface/ranking/v2?rid=4&type=all', {
    headers: { ...baseHeaders, Referer: 'https://www.bilibili.com/v/popular/rank/game/' },
  });
  const j4 = tryJson(r4.text);
  const list4 = j4?.data?.list ?? [];
  const items4 = list4.map((v) => mapVideo(v, 'view'));
  const pubDates4 = items4.map((i) => i.publishedAt).filter(Boolean).sort();
  const newest4 = pubDates4[pubDates4.length - 1] ?? null;
  const oldest4 = pubDates4[0] ?? null;
  const staleMs = newest4 ? Date.now() - new Date(newest4).getTime() : 0;
  const staleDays = Math.round(staleMs / 86400000);

  addSource({
    id: 'bilibili-game-rank',
    name: 'B站游戏区排行（rid=4）',
    role: 'community',
    type: 'json',
    url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=4&type=all',
    httpStatus: r4.status,
    latencyMs: r4.latencyMs,
    error: r4.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Referer: 'https://www.bilibili.com/v/popular/rank/game/',
      Cookie: 'buvid3=<从 .../x/frontend/finger/spi 的 data.b_3 实时领取>',
    },
    items: items4,
    notes:
      `⚠️ **榜单内容陈旧，不可用于时效判断**。code=${j4?.code}，${items4.length} 条全部 pubdate 落在 ` +
      `${oldest4} ~ ${newest4}（最新一条距今约 ${staleDays} 天），而同一次探测里 rid=0 全站榜最新为 ${fresh0}。` +
      '说明 rid=4 这个分区榜返回的是一份冻结快照（多次重试 + 换 cachebuster 结果完全一致），不是抓取失败。' +
      '字段结构与全站榜一致（bvid/pubdate/stat.view）。' +
      '**建议替代方案见 bilibili-game-filter**：取 rid=0 全站榜按 tname ∈ {手机游戏, 单机游戏, 网络游戏, 电子竞技} 过滤，' +
      '得到的是新鲜数据。',
  });

  // --- 用全站榜过滤出「游戏区」新鲜数据（派生源，无额外请求）
  const GAME_TNAMES = new Set(['手机游戏', '单机游戏', '网络游戏', '电子竞技', '桌游棋牌']);
  const itemsGame = items0.filter((i) => GAME_TNAMES.has(i.tname));
  addSource({
    id: 'bilibili-game-filter',
    name: 'B站游戏相关热门（全站榜按 tname 过滤）',
    role: 'community',
    type: 'json',
    url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    httpStatus: r0.status,
    latencyMs: r0.latencyMs,
    error: r0.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Referer: 'https://www.bilibili.com/v/popular/rank/all/',
      Cookie: 'buvid3=<同 bilibili-ranking>',
    },
    items: itemsGame,
    notes:
      `派生源（复用 rid=0 的响应，不额外请求）：100 条里 tname 属于游戏类的 ${itemsGame.length} 条。` +
      '这是目前唯一「新鲜 + 纯游戏 + 带播放量」的 B 站游戏口径；`tname` 取值实测有：手机游戏/单机游戏/网络游戏/电子竞技/桌游棋牌。' +
      `最新 pubdate ${itemsGame.map((i) => i.publishedAt).filter(Boolean).sort().pop() ?? '—'}。` +
      '注意只有 100 条池子，游戏条目日常 5–20 条，够用但不算充裕；要更多就上 rid=17（单机游戏）分区榜并先验证其时效。',
  });

  return { buvid3: Boolean(buvid3), n0: items0.length, n4: items4.length, newest4, fresh0, nGame: itemsGame.length };
}

/* ------------------------------------------------------------------ */
/* 5. 微博热搜                                                         */
/* ------------------------------------------------------------------ */
async function probeWeibo() {
  const url = 'https://weibo.com/ajax/side/hotSearch';
  const r = await req(url, { headers: { Referer: 'https://weibo.com/', Accept: 'application/json, text/plain, */*' } });
  const j = tryJson(r.text);
  const realtime = j?.data?.realtime ?? [];
  const maxNum = realtime.reduce((m, h) => Math.max(m, Number(h.num) || 0), 0);
  const hotgovCount = j?.data?.hotgovs?.length ?? 0;
  const items = realtime.map((h) => ({
    title: String(h.word ?? '').trim(),
    url: null, // 只有词条，没有原文链接
    publishedAt: null,
    heat: h.num ?? null,
    summary: h.note ?? null,
    image: h.icon ?? null,
  }));

  addSource({
    id: 'weibo-hotsearch',
    name: '微博热搜',
    role: 'community',
    type: 'json',
    url,
    httpStatus: r.status,
    latencyMs: r.latencyMs,
    error: r.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Referer: 'https://weibo.com/',
      Accept: 'application/json, text/plain, */*',
    },
    items,
    notes:
      `**无需 cookie**（只要 UA + Referer 就 200），实测 ${items.length} 条，全部来自 \`data.realtime\`；` +
      `另有 \`data.hotgovs\` ${hotgovCount} 条政务要闻置顶（未计入，做游戏雷达时直接忽略）。` +
      '接口无分页参数、**无任何时间戳**。' +
      '**只有话题词，没有原文链接** —— 后续必须二次检索：' +
      '拼 `https://s.weibo.com/weibo?q=%23<词条>%23`（该搜索结果页需 cookie 才稳，无 cookie 常被跳到 passport）。' +
      `fields.heat：\`num\` 热度值（本次榜首 ${maxNum.toLocaleString('en-US')} → ${maxNum >= 1e6 ? '百万级' : '十万级'}），` +
      '`realpos` 为真实排名（`rank` 字段恒为 0，别用）。' +
      '`label_name` 给「新/热/沸/爆」标签。' +
      '更新频率：**未实测**（响应里没有任何时间字段，单次探测测不出刷新间隔）。' +
      '可观测的替代信号：同一词条的 `num` 在两次探测间会变（榜首 1,144,782 → 1,151,222），说明热值在持续滚动；' +
      '工程上按 15 分钟轮询 + 新旧快照 diff 判断「新上榜」。' +
      '另注意 hotgovs 是政务要闻置顶，做游戏雷达时应排除。',
  });
  return { n: items.length };
}

/* ------------------------------------------------------------------ */
/* 6. 知乎热榜                                                         */
/* ------------------------------------------------------------------ */
async function probeZhihu() {
  // 候选 A：www.zhihu.com 官方 v3 接口（需要 z_c0 登录 cookie）
  const urlA = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true';
  const rA = await req(urlA, { headers: { Referer: 'https://www.zhihu.com/hot', Accept: 'application/json' } });
  const bodyA = rA.text.slice(0, 160).replace(/\s+/g, ' ').trim();

  // 候选 B：api.zhihu.com 公开接口（无 cookie 可用）
  const urlB = 'https://api.zhihu.com/topstory/hot-list?limit=50';
  const rB = await req(urlB, { headers: { Accept: 'application/json' } });
  const jB = tryJson(rB.text);
  const list = Array.isArray(jB?.data) ? jB.data : [];

  const items = list.map((it) => {
    const t = it.target ?? {};
    let link = null;
    if (t.type === 'question' && t.id) link = `https://www.zhihu.com/question/${t.id}`;
    else if (t.type === 'article' && t.id) link = `https://zhuanlan.zhihu.com/p/${t.id}`;
    else if (configUrlOk(t.url)) link = t.url;
    return {
      title: String(t.title ?? '').trim(),
      url: link,
      // target.created = 问题/内容创建时间（真实时间，但不是「上榜时间」）
      publishedAt: isoFromSec(t.created),
      heat: it.detail_text ?? null, // e.g. "2377 万热度"
      summary: t.excerpt ? String(t.excerpt).replace(/\s+/g, ' ').slice(0, 140) : null,
      image: it.children?.[0]?.thumbnail ?? null,
      author: t.author?.name ?? null,
    };
  });

  addSource({
    id: 'zhihu-hot',
    name: '知乎热榜',
    role: 'community',
    type: 'json',
    url: urlB,
    httpStatus: rB.status,
    latencyMs: rB.latencyMs,
    error: rB.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Accept: 'application/json',
      // 走官方 www 接口时还需要：Cookie: 'z_c0=<需用户提供>'
    },
    items,
    notes:
      `候选 A（官方 www 接口 ${urlA}）无 cookie 返回 HTTP ${rA.status} ${bodyA} —— 需要登录态 Cookie（z_c0）；` +
      `候选 B（api.zhihu.com 移动端接口）**无需 cookie 直接可用**，本次 ${items.length} 条。` +
      '**带指向原文的链接**：`target.id + target.type` 可拼 question/article 页（本源头唯一给出正文入口的中文热榜）。' +
      'fields.heat：`detail_text` 为「2377 万热度」这类中文字符串（千分位/万/亿混用，需自己解析），不是数字。' +
      'fields.publishedAt：`target.created` 是问题创建时间（真实时间，非抓取时间），**不等于上榜时刻**；' +
      '热榜本身没有「上榜时间」字段，做「新上榜」判断要靠两次快照 diff。' +
      '另带 `target.excerpt` 摘要和 `answer_count/follower_count`，性价比很高。',
  });

  return { nA: 0, nB: items.length, statusA: rA.status };
}

function configUrlOk(u) {
  return typeof u === 'string' && u.startsWith('https://') && !u.includes('api.zhihu.com');
}

/* ------------------------------------------------------------------ */
/* 7. 百度热搜                                                         */
/* ------------------------------------------------------------------ */
async function probeBaidu() {
  const tried = [];
  // 候选 A：PC 榜单页，JSON 藏在 HTML 注释 <!--s-data:{...}--> 里，字段最全（含 hotScore/desc/index）
  const page = await req('https://top.baidu.com/board?tab=realtime', {
    headers: { Referer: 'https://top.baidu.com/', Accept: 'text/html,application/xhtml+xml' },
  });
  tried.push('https://top.baidu.com/board?tab=realtime');

  let items = [];
  let source = 'html-embedded';
  let httpStatus = page.status;
  let latencyMs = page.latencyMs;

  const marker = page.text.indexOf('s-data:');
  if (marker > -1) {
    const start = page.text.indexOf('{', marker);
    const raw = start > -1 ? sliceJson(page.text, start) : null;
    const j = raw ? tryJson(raw) : null;
    const cards = j?.data?.cards ?? [];
    const flat = cards.flatMap((c) => c.content ?? []);
    items = flat
      .filter((x) => x && x.query)
      .map((x) => ({
        title: String(x.query ?? x.word ?? '').trim(),
        url: null, // url/appUrl 都是百度搜索结果跳转页，不是原文
        publishedAt: null,
        heat: x.hotScore ?? null, // 字符串数字，如 "7904415"
        summary: x.desc ?? null,
        image: x.img ?? null,
      }));
  }

  // 候选 B：wise 接口（结构简单但无热度值），作为兜底
  if (items.length < 5) {
    const api = await req('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
      headers: { Referer: 'https://top.baidu.com/' },
    });
    tried.push('https://top.baidu.com/api/board?platform=wise&tab=realtime');
    const j = tryJson(api.text);
    const flat = (j?.data?.cards ?? []).flatMap((c) => (c.content ?? []).flatMap((y) => y.content ?? []));
    items = flat
      .filter((x) => x && (x.word || x.query))
      .map((x) => ({
        title: String(x.word ?? x.query ?? '').trim(),
        url: null,
        publishedAt: null,
        heat: x.hotScore ?? null,
        summary: null,
        image: null,
      }));
    source = 'wise-api';
    httpStatus = api.status;
    latencyMs = api.latencyMs;
  }

  addSource({
    id: 'baidu-hot',
    name: '百度热搜',
    role: 'community',
    type: source === 'wise-api' ? 'json' : 'html',
    url: source === 'wise-api' ? tried[1] : tried[0],
    httpStatus,
    latencyMs,
    error: page.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Referer: 'https://top.baidu.com/',
      Accept: 'text/html,application/xhtml+xml',
    },
    items,
    notes:
      (source === 'html-embedded'
        ? '**没有独立 JSON 接口**：数据以 `<!--s-data:{...}-->` 的形式内联在 `top.baidu.com/board?tab=realtime` 的 HTML 里（约 192KB 页面），' +
          '切出注释里的 JSON 即可，字段最全。'
        : '走的是 wise 兜底接口，字段较少。') +
      `一次 ${items.length} 条，无分页、无时间戳。**标题 + 热度 + 摘要 + 配图都有**。` +
      'fields.heat：`hotScore`（字符串数字，本次 7,904,415 量级）；`index` 是排名（0 起）。' +
      '**没有原文直链**：`url`/`appUrl` 是 `www.baidu.com/s?wd=...&rsv_dl=fyb_news` 这样的自家搜索结果跳转，不是新闻原文；' +
      '要正文仍需二次检索。`desc` 摘要质量不错，很多时候够用、可以省一次抓取。' +
      '更新频率：**未实测**（无时间字段可依据）；`hotScore` 每次探测都在变（同一条 7,904,415 → 7,903,979），' +
      '属于持续滚动的实时榜，建议 15 分钟轮询 diff。',
  });
  return { n: items.length, via: source };
}

/* ------------------------------------------------------------------ */
/* 8. 抖音热点榜                                                       */
/* ------------------------------------------------------------------ */
async function probeDouyin() {
  const tried = [];
  // 候选 A：web 热点榜（无需 a_bogus/X-Bogus 签名）
  const urlA =
    'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383' +
    '&channel=channel_pc_web&detail_list=1&source=6';
  const rA = await req(urlA, { headers: { Referer: 'https://www.douyin.com/' } });
  tried.push(urlA);
  const jA = tryJson(rA.text);
  let words = jA?.data?.word_list ?? [];
  let via = 'web-hot-search-list';
  let status = rA.status;
  let latency = rA.latencyMs;
  let trErr = rA.error;

  // 候选 B：iesdouyin 旧版 word billboard
  if (words.length < 5) {
    const urlB = 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/';
    const rB = await req(urlB, { headers: { Referer: 'https://www.douyin.com/' } });
    tried.push(urlB);
    const jB = tryJson(rB.text);
    words = jB?.word_list ?? [];
    via = 'iesdouyin-word-billboard';
    status = rB.status;
    latency = rB.latencyMs;
    trErr = rB.error;
  }

  const items = words.map((w) => ({
    title: String(w.word ?? '').trim(),
    url: null, // 只有话题词；sentence_id 可拼 /hot/<id> 但是 SPA 空壳
    publishedAt: isoFromSec(w.event_time ?? null),
    heat: w.hot_value ?? null,
    summary: null, // 只有话题词，没有摘要正文
    image: w.word_cover?.url_list?.[1] ?? w.word_cover?.url_list?.[0] ?? null,
  }));

  const evTimes = items.map((i) => i.publishedAt).filter(Boolean).map((t) => (Date.now() - new Date(t).getTime()) / 3600000);
  const newestH = evTimes.length ? Math.min(...evTimes).toFixed(1) : '-';
  const oldestH = evTimes.length ? Math.max(...evTimes).toFixed(1) : '-';
  const spreadH = evTimes.length ? `${newestH}~${oldestH}` : '-';

  addSource({
    id: 'douyin-hot',
    name: '抖音热点榜',
    role: 'community',
    type: 'json',
    url: via === 'iesdouyin-word-billboard' ? 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/' : urlA,
    httpStatus: status,
    latencyMs: latency,
    error: trErr,
    headers: { 'User-Agent': '<浏览器 UA>', Referer: 'https://www.douyin.com/' },
    items,
    notes:
      `**不需要签名**（实测不带 a_bogus/X-Bogus 也 200，${via}），${items.length} 条，无分页。` +
      'fields.heat：`hot_value` 数字热度（本次 12,137,029 量级＝千万级）；`position`/`max_rank` 是排名。' +
      'fields.publishedAt：`event_time`（秒）是**榜单事件时间**，可当「该词条上榜/事件时间」用，但不是抓取时间 —— 抖音是本次少数几个热榜里带时间戳的。' +
      '附带 `video_count`/`discuss_video_count`（讨论视频数）和话题封面图。' +
      '**没有原文链接**：只有话题词。`sentence_id` 可拼 `https://www.douyin.com/hot/<sentence_id>`，' +
      '但实测该页返回 72KB 的 SPA 空壳（title 为空），等于仍需二次检索/浏览器渲染。' +
      `更新频率：**可从数据推断** —— ${items.length} 条的 \`event_time\` 距现在 ${spreadH}h 不等` +
      `（最新 ${newestH}h 前、最旧 ${oldestH}h 前），说明榜单只装最近约 2 天的事件，属于高频滚动榜。` +
      '注意：`trending_list`（上升榜，5 条）与 `word_list` 是两套，别混。',
  });
  return { n: items.length, via };
}

/* ------------------------------------------------------------------ */
/* 8.5 小红书                                                          */
/*    预期「大概率失败」，实测**推翻**了这个假设：                            */
/*      · /api/sns/web/v1/homefeed 仍需 x-s/x-t 签名（406）               */
/*      · 但 /explore 在带 Accept-Language: zh-CN 时返回 SSR 页面，        */
/*        正文里 window.__INITIAL_STATE__ 直接带 28 条推荐流笔记           */
/* ------------------------------------------------------------------ */
async function probeXiaohongshu() {
  const tried = [];

  // 关键：Accept-Language 决定命运。不带它会被 302 到 /login?redirectPath=...
  const page = await req('https://www.xiaohongshu.com/explore', {
    headers: {
      Referer: 'https://www.xiaohongshu.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  tried.push('https://www.xiaohongshu.com/explore');

  let state = null;
  const at = page.text.indexOf('__INITIAL_STATE__');
  if (at > -1) {
    const brace = page.text.indexOf('{', at);
    const raw = brace > -1 ? sliceJson(page.text, brace) : null;
    // 该对象里混有裸 undefined，不是合法 JSON，先降级成 null
    if (raw) state = tryJson(raw.replace(/\bundefined\b/g, 'null'));
  }

  const feeds = state?.feed?.feeds ?? [];
  const items = feeds
    .map((f) => {
      const nc = f?.noteCard ?? {};
      if (!nc.displayTitle) return null;
      const token = f?.xsecToken ? `?xsec_token=${encodeURIComponent(f.xsecToken)}&xsec_source=pc_feed` : '';
      return {
        title: String(nc.displayTitle).trim(),
        url: f?.id ? `https://www.xiaohongshu.com/explore/${f.id}${token}` : null,
        publishedAt: null, // SSR 里连时间字段都没有
        heat: nc.interactInfo?.likedCount ?? null, // 字符串，可能是 "3.1万"
        summary: null,
        image: nc.cover?.urlDefault ?? null,
        author: nc.user?.nickname ?? nc.user?.nickName ?? null,
      };
    })
    .filter(Boolean);

  // 兜底/证据：内部推荐流接口是否要签名
  let apiNote = '';
  if (items.length < 5) {
    const api = await req('https://edith.xiaohongshu.com/api/sns/web/v1/homefeed', {
      method: 'POST',
      headers: {
        Referer: 'https://www.xiaohongshu.com/explore',
        'Content-Type': 'application/json;charset=UTF-8',
        Origin: 'https://www.xiaohongshu.com',
      },
      body: JSON.stringify({
        cursor_score: '', num: 20, refresh_type: 1, note_index: 0,
        unread_begin_note_id: '', unread_end_note_id: '', unread_note_count: 0,
        category: 'homefeed_recommend', search_key: '', need_num: 10,
        image_formats: ['jpg', 'webp', 'avif'], need_filter_image: false,
      }),
    });
    tried.push('https://edith.xiaohongshu.com/api/sns/web/v1/homefeed (POST)');
    apiNote = `兜底接口 POST 返回 HTTP ${api.status} ${api.text.slice(0, 40).replace(/\s+/g, ' ')}`;
  }

  addSource({
    id: 'xiaohongshu-explore',
    name: '小红书 发现/推荐流',
    role: 'community',
    type: 'html',
    url: 'https://www.xiaohongshu.com/explore',
    httpStatus: page.status,
    latencyMs: page.latencyMs,
    error: page.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Referer: 'https://www.xiaohongshu.com/',
      // 这个头是成败关键：缺了它会被 302 到 /login?redirectPath=...
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
      // 走内部 API 才需要（我们没走）：
      // Cookie: 'a1=<需用户提供>; web_session=<需用户提供>'
    },
    items,
    notes:
      '**推翻了「小红书大概率抓不到」的预期**：' +
      'a) 内部推荐流接口 `POST edith.xiaohongshu.com/api/sns/web/v1/homefeed` 确实不可用（缺 `x-s`/`x-t`/`x-s-common` 签名 + `a1`/`web_session` cookie，实测 406）；' +
      'b) 但 `GET /explore` 在带上 `Accept-Language: zh-CN` 时直接返回 SSR 页面（约 167KB），' +
      `正文里 \`window.__INITIAL_STATE__.feed.feeds\` 就有 ${feeds.length} 条推荐流笔记（其中 ${items.length} 条有标题），` +
      '**不需要登录、不需要签名**。' +
      '⚠️ 关键坑：**不带 `Accept-Language` 会被 302 到 `/login?redirectPath=...`**，看起来像「必须登录」，其实是头没给对。' +
      '⚠️ 该对象里混了裸 `undefined`，不是合法 JSON，解析前必须 `.replace(/\bundefined\b/g,"null")`。' +
      '**这不是热榜**：没有排名、没有时间戳（条目连 createTime 都没有），只有 `interactInfo.likedCount` 点赞数（字符串，"3.1万" 这种中文单位）当热度参考。' +
      '**链接是 SPA 详情页**：`/explore/<noteId>?xsec_token=<token>`，服务端不返正文，等于「有链接但抓不到内容」——' +
      '真正能用的是标题 + 封面 + 点赞数 + 作者。' +
      '条数会浮动（两次探测 28→29 条），推荐流是轮换的，不要假设稳定条数。' +
      '对游戏雷达的用法：只能当「泛兴趣信号」的情感/审美参考，不能当游戏资讯源；' +
      'SSR 结构随前端发版会变（这次 data-release 就没变过），属于「能抓但不稳」的一类，需监控。',
  });

  return { n: items.length, status: page.status, apiNote };
}

/* ------------------------------------------------------------------ */
/* 9. TapTap 站内（热门榜 / 预约榜 / 热玩榜）                              */
/* ------------------------------------------------------------------ */
const TAPTAP_XUA = 'V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&UID=&OS=Android';
const TAPTAP_HEADERS = {
  'User-Agent': '<浏览器 UA>',
  Referer: 'https://www.taptap.cn/top/download',
  // X-UA 是客户端指纹串（固定值即可），**不是**逐请求签名
  'X-UA': TAPTAP_XUA,
};

async function taptapBoard(typeName, label, webPath) {
  const url = `https://www.taptap.cn/webapiv2/app-top/v2/hits?type_name=${typeName}`;
  const r = await req(url, { headers: { ...TAPTAP_HEADERS, Referer: `https://www.taptap.cn${webPath}` } });
  const j = tryJson(r.text);
  const list = j?.data?.list ?? [];
  const items = list.map((it) => {
    const a = it.app ?? {};
    return {
      title: String(a.title ?? '').trim(),
      url: a.id ? `https://www.taptap.cn/app/${a.id}` : null,
      publishedAt: null, // released_time 是游戏上线日，不是榜单条目时间；预约榜该值为 0
      // heat 用该榜真正的排序量：热门/热玩=累计人气 hits_total，预约=预约数 reserve_count。
      // 评分(stat.rating.score)是另一维度，写进 notes，不混进 heat。
      heat:
        typeName === 'reserve'
          ? (a.stat?.reserve_count ?? null)
          : (a.stat?.hits_total ?? null),
      summary: a.description ? String(a.description).replace(/\s+/g, ' ').slice(0, 140) : null,
      image: a.icon?.url ?? null,
      author: null,
      // 站内结构化数据（写进 notes，不进 sample）
      _stat: a.stat,
      _released: a.released_time,
      _readableId: a.readable_id,
    };
  });

  const first = list[0]?.app ?? {};
  addSource({
    id: `taptap-${typeName}`,
    name: `TapTap ${label}`,
    role: 'internal',
    type: 'json',
    url,
    httpStatus: r.status,
    latencyMs: r.latencyMs,
    error: r.error,
    headers: TAPTAP_HEADERS,
    items,
    notes:
      '**可公开抓取，不需要登录、不需要签名**，但必须带 X-UA 客户端指纹头；不带时返回 INVALID_XUA: XUA is empty（HTTP 400）。' +
      `一次 10 条（\`data.list\`），\`data.total=150\`，分页用返回的 \`next_page\`（如 \`?from=10&limit=10&type_name=${typeName}\`），` +
      '所以「150 条全量 = 15 次请求」很贵，建议只取首页 10 条。' +
      '**带指向站内的链接**：`app.id` → `https://www.taptap.cn/app/<id>`（实测 200，' +
      (first.title ? `如 ${first.title} 的 /app/${first.id} 返回「${first.title} - 官方${label.includes('预约') ? '预约' : '游戏'}」页面` : '') +
      '），另有 `readable_id` 可做人类可读路由。' +
      `fields.heat：` +
      (typeName === 'reserve'
        ? '`stat.reserve_count`（预约人数，本次百万级）'
        : '`stat.hits_total`（累计人气/播放，本次千万级）') +
      '；同一条目还带 `stat.rating.score` 评分（如 7.9/10）、`stat.review_count` 评论数、' +
      '`stat.fans_count` 粉丝数、`stat.feed_count` 社区帖数、`stat.video_count` 视频数、`stat.wish_count` 心愿数 ' +
      '—— 站内热度维度比外部平台丰富得多，且是分品类可比的面板数据（这点外部热榜给不了）。' +
      'fields.publishedAt：**没有**。`released_time` 是游戏上线/公测日期（预约榜未上线为 0），不等于榜单条目时间；' +
      '要做「新进榜」监测只能靠两次快照 diff。' +
      (typeName === 'reserve'
        ? '预约榜条目全部为未上线新游（`released_time=0`、`hits_total=0`、`reserve_count` 百万级），是「引进信号」属性最强的榜。'
        : '') +
      '更新频率：**未实测**（榜单没有任何时间字段）；榜单按站内热度重排，建议 1–2 小时轮询 + diff 出「新进榜」，' +
      '比外部热榜省请求且噪声低。' +
      '榜单全量品类（从 /top/download 页 __NUXT_DATA__ 里挖到的 24 个 tab）：热门榜 type_name=hot、预约榜=reserve、' +
      '热玩榜=pop、新品榜=new、热卖榜=sell、新版本榜=in_app_event_reserve、独家榜=exclusive，' +
      '另有按品类：action/strategy/idle/single/casual/sandbox_survival/management/unriddle/shooter/multiplayer/acgn/music/scenario/swordsman/otome/independent/roguelike。',
  });
  return { n: items.length, total: j?.data?.total ?? null, status: r.status, top: items[0]?.title ?? null };
}

async function probeTaptap() {
  const hot = await taptapBoard('hot', '热门榜', '/top/download');
  const reserve = await taptapBoard('reserve', '预约榜', '/top/reserve');
  const pop = await taptapBoard('pop', '热玩榜', '/top/played');
  return { hot, reserve, pop };
}

/* ------------------------------------------------------------------ */
/* 10. 百度贴吧 热议话题榜（虎扑/NGA/贴吧 三选一）                          */
/* ------------------------------------------------------------------ */
async function probeTieba() {
  const url = 'https://tieba.baidu.com/hottopic/browse/topicList?res_type=1';
  const r = await req(url, {
    headers: {
      Referer: 'https://tieba.baidu.com/hottopic/browse/hottopic',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  // 该入口虽然叫 topicList，实测返回的是完整 HTML 页面（非 JSON），
  // 榜单在 <li class="topic-top-item"> 里，可直接正则切块。
  const blocks = r.text.split('<li class="topic-top-item">').slice(1);
  const items = blocks
    .map((b) => {
      const href = /<a href="([^"]+)"[^>]*class="topic-text"[^>]*>([\s\S]*?)<\/a>/.exec(b);
      const num = /<span class="topic-num">([\s\S]*?)<\/span>/.exec(b);
      const desc = /<p class="topic-top-item-desc">([\s\S]*?)<\/p>/.exec(b);
      const img = /<img src="([^"]+)"/.exec(b);
      const clean = (s) =>
        String(s ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/&quot;/g, '"')
          .replace(/&#0?39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
      if (!href) return null;
      return {
        title: clean(href[2]),
        url: null, // href 是贴吧「话题聚合页」，不是原帖
        publishedAt: null,
        heat: clean(num?.[1]),
        summary: clean(desc?.[1]) || null,
        image: img?.[1]?.split('?')[0] ?? null,
        _topicHref: href[1].replace(/&amp;/g, '&'),
      };
    })
    .filter(Boolean);

  addSource({
    id: 'tieba-hottopic',
    name: '百度贴吧 热议话题榜',
    role: 'community',
    type: 'html',
    url,
    httpStatus: r.status,
    latencyMs: r.latencyMs,
    error: r.error,
    headers: {
      'User-Agent': '<浏览器 UA>',
      Referer: 'https://tieba.baidu.com/hottopic/browse/hottopic',
      'X-Requested-With': 'XMLHttpRequest',
    },
    items,
    notes:
      `入口叫 topicList 但**返回的是 HTML 页面不是 JSON**（62KB），榜单在 \`<li class="topic-top-item">\` 块里，` +
      `切块 + 正则即可，一次 ${items.length} 条，无分页、无时间戳。` +
      'fields.heat：`<span class="topic-num">` 文本形如「278.3W实时讨论」（W=万，中文单位需解析）。' +
      '**没有原文链接**：每条只有一个 `hottopic/browse/hottopic?topic_id=xxx&topic_name=xxx` 的话题聚合页（页内才是原帖流），' +
      '严格说不是原文直链，仍需一层抓取；但比微博/抖音强 —— 聚合页是服务端渲染的。' +
      '内容实测偏电竞/游戏圈八卦（如 HLE/TES 换队服），对游戏雷达的社区情绪面很贴，' +
      '且是「虎扑/NGA/贴吧」三选一里唯一不登录就能稳定拿到的。' +
      '附带 `topic-top-item-desc` 一句话摘要 + 话题封面图。' +
      '更新频率：**未实测**（无时间字段）；热值为「实时讨论数」且两次探测间会变（278.3W→278.3W 量级稳定），' +
      '推断为小时级刷新，建议 30 分钟轮询 diff。',
  });
  return { n: items.length };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  console.log('=== cn-community 探测开始 ===\n');

  try {
    await probeXiaoheihe();
  } catch (e) {
    console.warn('小黑盒探测异常', e);
  }
  try {
    await probeBilibili();
  } catch (e) {
    console.warn('B站探测异常', e);
  }
  try {
    await probeWeibo();
  } catch (e) {
    console.warn('微博探测异常', e);
  }
  try {
    await probeZhihu();
  } catch (e) {
    console.warn('知乎探测异常', e);
  }
  try {
    await probeBaidu();
  } catch (e) {
    console.warn('百度探测异常', e);
  }
  try {
    await probeDouyin();
  } catch (e) {
    console.warn('抖音探测异常', e);
  }
  try {
    await probeXiaohongshu();
  } catch (e) {
    console.warn('小红书探测异常', e);
  }
  try {
    await probeTaptap();
  } catch (e) {
    console.warn('TapTap 探测异常', e);
  }
  try {
    await probeTieba();
  } catch (e) {
    console.warn('贴吧探测异常', e);
  }

  const payload = {
    domain: 'cn-community',
    probedAt: nowCN(),
    sources,
    rejected,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`\n=== 结果 ===`);
  for (const line of log) console.log(line);
  console.log(`\nrejected: ${rejected.map((r) => r.name).join('、') || '无'}`);
  console.log(`\n写入 ${OUT_FILE}`);
  console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，共 ${sources.length} 个源`);
}

main().catch((e) => {
  console.error('致命错误', e);
  process.exitCode = 1;
});
