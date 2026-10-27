/**
 * B 站站内热度：给「重点游戏」和「选题」补一个平台侧的量级参考——这游戏在 B 站到底有没有人拍、拍的人多不多。
 *
 * 为什么需要：模型只读得到文章正文。一篇稿子说「某作口碑崩了」和说「某作口碑崩了，但站内二创已经爆了」，
 * 在它眼里长得一样；可对编辑来说这差着一整个选题判断——前者可以直接绕过，后者是现成的流量窗口。
 * 所以要把「站内搜索该关键词后头部视频的播放量」查出来，塞进打分输入。
 *
 * 只做三件事：拿游客 cookie → 拿 wbi 签名密钥（30 分钟缓存）→ 签名后调站内搜索。
 * 任何一步失败都返回 null，调用方按「无数据」处理；本模块不抛异常、日志里也不打印 cookie/token。
 */
import { createHash } from 'node:crypto';

export interface BiliHit {
  title: string;
  plays: number;
  url: string;
  author: string;
}

export interface BiliHeat {
  totalPlays: number;
  top: BiliHit[];
  vids: number;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';

/** 同域礼貌间隔：两次请求至少隔 800ms，宁可慢一点也别被风控。 */
const GAP_MS = 800;
/** 单次请求超时 15 秒，失败重试 1 次。 */
const TIMEOUT_MS = 15_000;
const RETRIES = 1;
/** wbi 密钥有效期：官方每天轮换，这里按 30 分钟刷新一次足够稳。 */
const WBI_TTL_MS = 30 * 60 * 1000;
/** 单页取 20 条，够算头部热度了。 */
const PAGE_SIZE = 20;
/** wbi 混淆表，官方前端硬编码的那张，照抄即可。 */
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

/** 游客 cookie：长期复用；真失效了由 -352 分支重新取密钥兜底。 */
let cookieCache: string | null = null;
let cookieInflight: Promise<string | null> | null = null;
/** wbi 混淆后的密钥（32 位），带取到的时间戳。 */
let wbiCache: { mixin: string; at: number } | null = null;
let wbiInflight: Promise<string | null> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 同域串行 + 固定间隔（和 fetch.ts 的 polite 一个思路，这里独立实现是为了不受全局抓取配置影响）。 */
let gate: Promise<void> = Promise.resolve();
let lastAt = 0;

async function polite(): Promise<void> {
  const next = gate.then(async () => {
    const gap = Date.now() - lastAt;
    if (gap < GAP_MS) await sleep(GAP_MS - gap);
    lastAt = Date.now();
  });
  gate = next.catch(() => undefined);
  await next;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 统一请求入口：浏览器头 + 超时 + 重试 1 次，返回解析后的 JSON 对象。
 * 拿不到可解析的 JSON 就当这次失败，交给上面的重试或调用方按「无数据」处理。
 */
async function api(url: string, cookie: string | null): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: REFERER,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (cookie) headers.Cookie = cookie;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    await polite();
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      // 接口的失败码（-352/-403 等）多半还是 HTTP 200，所以不看 res.ok，能解析出对象就交上层判断。
      const json = obj(JSON.parse(text) as unknown);
      if (json) return json;
    } catch {
      /* 网络异常/超时/非 JSON 正文：下面退避重试 */
    }
    if (attempt < RETRIES) await sleep(600 * (attempt + 1));
  }
  return null;
}

/** 取游客 cookie（buvid3/buvid4）。并发调用共享同一次请求。 */
async function getCookie(force = false): Promise<string | null> {
  if (!force && cookieCache) return cookieCache;
  if (!cookieInflight) {
    cookieInflight = (async () => {
      const j = await api(SPI_URL, null);
      const d = obj(j?.data);
      const b3 = str(d?.b_3);
      const b4 = str(d?.b_4);
      if (!b3) return null;
      return `buvid3=${b3}; buvid4=${b4}`;
    })().finally(() => {
      cookieInflight = null;
    });
  }
  const c = await cookieInflight;
  if (c) cookieCache = c;
  return c;
}

/** 从 wbi_img 的 URL 里取文件名（去掉目录和扩展名）。 */
function fileStem(url: string): string {
  const base = (url.split('?')[0].split('/').pop() ?? '').trim();
  return base.replace(/\.[^.]+$/, '');
}

/** 按官方混淆表重排 raw 并截前 32 位，得到最终参与签名的 mixin。 */
function mixinOf(raw: string): string {
  return MIXIN.map((i) => raw[i] ?? '')
    .join('')
    .slice(0, 32);
}

/** 取 wbi 密钥，30 分钟内复用；签名失败时用 force 强刷一次。 */
async function getMixin(cookie: string, force = false): Promise<string | null> {
  if (!force && wbiCache && Date.now() - wbiCache.at < WBI_TTL_MS) return wbiCache.mixin;
  if (force) wbiCache = null;
  if (!wbiInflight) {
    wbiInflight = (async () => {
      const j = await api(NAV_URL, cookie);
      const wbi = obj(obj(j?.data)?.wbi_img);
      const raw = fileStem(str(wbi?.img_url)) + fileStem(str(wbi?.sub_url));
      if (raw.length < 64) return null;
      return mixinOf(raw);
    })().finally(() => {
      wbiInflight = null;
    });
  }
  const m = await wbiInflight;
  if (m) wbiCache = { mixin: m, at: Date.now() };
  return m;
}

/** 按 key 字母序拼 query，md5(query + mixin) 作 w_rid 追加到末尾。 */
function signedQuery(params: Record<string, string | number>, mixin: string): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
  const wRid = createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

interface RawItem {
  play?: unknown;
  title?: unknown;
  bvid?: unknown;
  author?: unknown;
  tag?: unknown;
}

/** 调一次站内搜索。code 原样带回去，由上层决定要不要刷密钥重试。 */
async function searchRaw(
  keyword: string,
  cookie: string,
  mixin: string
): Promise<{ code: number; list: RawItem[] } | null> {
  const params: Record<string, string | number> = {
    keyword,
    page: 1,
    page_size: PAGE_SIZE,
    search_type: 'video',
    wts: Math.floor(Date.now() / 1000),
  };
  const j = await api(`${SEARCH_URL}?${signedQuery(params, mixin)}`, cookie);
  if (!j) return null;
  const code = typeof j.code === 'number' ? j.code : -1;
  const result = obj(j.data)?.result;
  const list = Array.isArray(result) ? (result as RawItem[]) : [];
  return { code, list };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 标题里带 <em class="keyword"> 高亮和 &quot; 之类的实体，展示前统一剥干净。 */
function cleanText(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
      const key = ent.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      const hex = key.startsWith('#x');
      const dec = key.startsWith('#') && !hex;
      if (!hex && !dec) return m;
      const n = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return m;
      return String.fromCodePoint(n);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 相关度核对：站内搜索会「兜底」——查一个压根不存在的名字，它也能凑出 20 条别的游戏（按分词糊出来的）。
 * 不拦的话，一个没人提过的游戏会被算出一百多万播放，直接把打分带沟里。所以取关键词里最有辨识度的
 * 那一段（最长的字母/数字/汉字串），要求它出现在标题、作者或标签里；对不上的一律不算（和 steam.ts 的
 * looksSame 是同一个思路，只不过那边核 app 名，这边核视频标题）。
 */
function keywordAnchor(keyword: string): string {
  const tokens = (keyword.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) ?? []).filter((t) => t.length >= 2);
  let best = '';
  for (const t of tokens) if (t.length > best.length) best = t;
  return best;
}

/** 压成只含字母/数字/汉字的小写串，方便做包含判断（也顺手抹掉标点差异）。 */
function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

/** 播放数可能给数字也可能给字符串，统一转 Number，非数字当 0。 */
function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * 查一个关键词在 B 站站内的热度：前 limit 条视频的播放量之和 + 头部条目。
 * 网络失败/被风控返回 null；搜到了但没一条对得上关键词，返回 0 值对象（热度确实为零）。
 * 任何情况都不给调用方抛异常。
 */
export async function searchPlays(keyword: string, opts: { limit?: number } = {}): Promise<BiliHeat | null> {
  const kw = (keyword ?? '').trim();
  if (!kw) return null;
  const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 5) || 5, 1), PAGE_SIZE);

  try {
    const cookie = await getCookie();
    if (!cookie) return null;

    let mixin = await getMixin(cookie);
    if (!mixin) return null;

    let res = await searchRaw(kw, cookie, mixin);
    // -352/-403 是 wbi 校验没过（密钥过期或被风控）：重取一次密钥，再试一次。
    if (res && (res.code === -352 || res.code === -403)) {
      mixin = await getMixin(cookie, true);
      if (!mixin) return null;
      res = await searchRaw(kw, cookie, mixin);
    }
    if (!res || res.code !== 0) return null;

    const hits: BiliHit[] = [];
    const anchor = keywordAnchor(kw);
    for (const it of res.list) {
      const bvid = str(it.bvid).trim();
      if (!bvid) continue;
      const title = cleanText(str(it.title));
      const author = cleanText(str(it.author));
      const tag = cleanText(str(it.tag));
      // 关键词太短（比如单字）时没法判断，就别拦了；否则必须对得上才计入
      if (anchor && !normText(`${title} ${tag} ${author}`).includes(anchor)) continue;
      hits.push({
        title,
        plays: toNum(it.play),
        url: `https://www.bilibili.com/video/${bvid}`,
        author,
      });
    }

    // 接口按相关度排序，热度要按播放量重排后取头部。
    hits.sort((a, b) => b.plays - a.plays);
    const top = hits.slice(0, limit);
    return {
      totalPlays: top.reduce((sum, h) => sum + h.plays, 0),
      top,
      vids: hits.length, // 对得上关键词的条目数（≤20），太少说明这个词在站内没什么声量
    };
  } catch {
    /* 任何意外都不外抛，调用方按「无数据」处理 */
    return null;
  }
}
