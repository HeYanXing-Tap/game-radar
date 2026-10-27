/**
 * Steam 发现层：媒体不会写的游戏，只能从商店自己挖出来。
 *
 * 为什么需要：编辑部 Slack 里记录的「重点游戏」，绝大多数是**没有新闻稿**的小体量作品——
 * 它们只在 Steam 有页面、有 Demo、有几千条评价。媒体 RSS 永远等不到它们，
 * 而它们恰恰是引进业务最该抢的体量（等 3DM 写了，别人已经签了）。
 *
 * 三个入口：
 *   1. 最新发售（按发售日倒序，限「支持中文」）——日常主力
 *   2. 即将发售——抢首曝和愿望单窗口
 *   3. 带 Demo 的作品——新品节期间的富矿
 *
 * 全部走 Steam 商店的公开接口，不需要 key。入库后照常走 聚簇 → 预筛 → 打分，
 * 所以它们会自然出现在「重点游戏」队列里，和媒体稿一视同仁地被评「值不值得谈」。
 */
import { politeFetch } from './fetch.ts';
import { exec, log, one, urlKey } from './db.ts';
import { saveItems } from './collector.ts';
import type { RawItem } from './types.ts';

const SOURCE_ID = 'steam_discover';
/** 商店页里「即将推出」的作品也要进库，但它们没有真实发布时间，publishedAt 留空 */
const UA = 'game-radar/0.3 (by tap-editor)';

interface Hit {
  appid: string;
  name: string;
}

interface Details {
  type: string;
  name: string;
  desc: string;
  genres: string;
  image: string;
  releaseDate: string | null;
  comingSoon: boolean;
  reviews: number | null;
  priceYuan: number | null;
  chinese: boolean;
}

function parseRelease(date: string): string | null {
  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(date);
  if (cn) {
    const d = new Date(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3]));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 解析 Steam 搜索页返回的 results_html（它是 JSON 里裹着的一段 HTML 片段） */
function parseSearchHtml(html: string): Hit[] {
  const out: Hit[] = [];
  const re = /data-ds-appid="(\d+)"[\s\S]{0,2000}?<span class="title">([^<]*)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ appid: m[1], name: m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() });
  }
  return out;
}

async function search(params: string, start: number, count: number): Promise<Hit[]> {
  const url = `https://store.steampowered.com/search/results/?query&start=${start}&count=${count}&${params}&infinite=1`;
  const r = await politeFetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  try {
    const d = JSON.parse(r.body) as { results_html?: string };
    return parseSearchHtml(d.results_html ?? '');
  } catch {
    return [];
  }
}

async function details(appid: string): Promise<Details | null> {
  const r = await politeFetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=cn&l=schinese`, {
    headers: { 'User-Agent': UA },
  });
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.body) as Record<string, { success?: boolean; data?: Record<string, unknown> }>;
    const d = parsed[appid]?.data;
    if (!d) return null;
    const rd = (d.release_date ?? {}) as { date?: string; coming_soon?: boolean };
    const langs = String(d.supported_languages ?? '');
    return {
      type: String(d.type ?? ''),
      name: String(d.name ?? ''),
      desc: String(d.short_description ?? ''),
      genres: Array.isArray(d.genres)
        ? (d.genres as Array<{ description?: string }>).map((g) => g.description).filter(Boolean).join(' / ')
        : '',
      image: String(d.header_image ?? ''),
      releaseDate: rd.date ? parseRelease(rd.date) : null,
      comingSoon: Boolean(rd.coming_soon),
      reviews: typeof (d.recommendations as { total?: number } | undefined)?.total === 'number'
        ? (d.recommendations as { total: number }).total
        : null,
      priceYuan: typeof (d.price_overview as { final?: number } | undefined)?.final === 'number'
        ? Math.round((d.price_overview as { final: number }).final / 100)
        : null,
      chinese: /schinese|简体中文/i.test(langs),
    };
  } catch {
    return null;
  }
}

function ensureSource(): void {
  exec(
    `INSERT OR IGNORE INTO sources (id, name, role, region, type, url, tier, enabled, interval_min)
     VALUES (?, ?, 'platform', 'global', 'json', ?, 2, 1, 720)`,
    SOURCE_ID,
    'Steam 新发售 / 即将发售 / Demo',
    'https://store.steampowered.com/search/'
  );
}

const SEEN = `SELECT 1 FROM items WHERE url_key = ? LIMIT 1`;

/**
 * 扫一批 Steam 列表并把「库里没有的」写进 items。
 * @param params Steam 搜索参数串
 * @param want   目标条数（内部按 25 一页翻，直到凑够或连续空页）
 */
async function scanList(params: string, want: number, tag: string): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (let start = 0; start < want * 2 && out.length < want; start += 25) {
    const hits = await search(params, start, 25);
    if (!hits.length) break;
    for (const h of hits) {
      if (out.length >= want) break;
      const url = `https://store.steampowered.com/app/${h.appid}/`;
      if (one(SEEN, urlKey(url))) continue;
      const d = await details(h.appid);
      if (!d) continue;
      if (d.type !== 'game' && d.type !== 'demo') continue;
      // 只留支持中文的：这是引进业务的实际门槛，也挡掉大量与国内受众无关的条目
      if (!d.chinese) continue;
      const released = !d.comingSoon && d.releaseDate && new Date(d.releaseDate).getTime() <= Date.now();
      const price = d.priceYuan === null ? '价格未知' : d.priceYuan === 0 ? '免费' : `国区约 ${d.priceYuan} 元`;
      out.push({
        sourceId: SOURCE_ID,
        url,
        title: d.name || h.name,
        summary: [
          `[${tag}]`,
          d.genres,
          d.desc,
          `发售：${d.comingSoon ? '尚未发售' : (d.releaseDate ?? rd(d))}`,
          d.reviews === null ? '暂无评价' : `累计评价 ${d.reviews}`,
          price,
        ]
          .filter(Boolean)
          .join('｜')
          .slice(0, 900),
        image: d.image || undefined,
        author: 'Steam',
        // 未发售作品不能把「发售日」当发布时间，否则未来的日期会排到最新第一
        publishedAt: released ? d.releaseDate : null,
        lang: 'zh',
        heat: { reviews: d.reviews ?? 0, price: d.priceYuan ?? 0 },
      });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

function rd(d: Details): string {
  if (d.comingSoon) return '尚未发售';
  return d.releaseDate ? d.releaseDate.slice(0, 10) : '未知';
}

export interface DiscoverResult {
  new: number;
  coming: number;
  demo: number;
  inserted: number;
}

export async function discoverSteam(opts: { newCount?: number; comingCount?: number; demoCount?: number } = {}): Promise<DiscoverResult> {
  ensureSource();
  const nNew = opts.newCount ?? 50;
  const nComing = opts.comingCount ?? 30;
  const nDemo = opts.demoCount ?? 30;

  const LANG = 'supportedlang=schinese&cc=cn';

  const lists: Array<[string, string, number, string]> = [
    ['new', `sort_by=Released_DESC&${LANG}`, nNew, '新发售'],
    ['coming', `filter=comingsoon&${LANG}`, nComing, '即将发售'],
    ['demo', `sort_by=Released_DESC&category1=998&${LANG}`, nDemo, '带Demo'],
  ];

  const result: DiscoverResult = { new: 0, coming: 0, demo: 0, inserted: 0 };
  const all: RawItem[] = [];
  for (const [key, params, want, tag] of lists) {
    const items = await scanList(params, want, tag);
    if (key === 'new') result.new = items.length;
    else if (key === 'coming') result.coming = items.length;
    else result.demo = items.length;
    log(`· Steam ${tag}：新增 ${items.length} 条`);
    all.push(...items);
  }

  // 同一轮里三个列表会重叠，saveItems 会按 url_key 去重，这里先合并省一次写入
  const byUrl = new Map<string, RawItem>();
  for (const it of all) byUrl.set(it.url, it);
  if (byUrl.size) {
    const saved = saveItems([...byUrl.values()]);
    result.inserted = saved.inserted;
    log(`· Steam 发现层：写入 ${saved.inserted} 条新作品（重复 ${saved.dupUrl}）`);
  }
  return result;
}

/**
 * 补录：把「已经知道但当时没抓到的作品」按 appid 拉进库。
 *
 * 用途有两个：
 *   1. 迁移历史（把编辑部 Slack 里记过的作品一次性搬进来，看看雷达会给它们打多少分）
 *   2. 校对（验证某款作品我们的判断和人工判断差多少）
 *
 * publishedAt 故意写「现在」而不是真实发售日：对我们来说它是「今天才发现的作品」，
 * 写真实发售日会让它落在时间窗之外，永远进不了队列。
 */
export async function backfillAppids(appids: string[]): Promise<{ inserted: number; skipped: number }> {
  ensureSource();
  const items: RawItem[] = [];
  let skipped = 0;
  for (const appid of appids) {
    const id = appid.trim();
    if (!/^\d+$/.test(id)) continue;
    const url = `https://store.steampowered.com/app/${id}/`;
    if (one(SEEN, urlKey(url))) { skipped++; continue; }
    const d = await details(id);
    if (!d || (d.type !== 'game' && d.type !== 'demo')) { skipped++; continue; }
    items.push({
      sourceId: SOURCE_ID,
      url,
      title: d.name,
      summary: [
        '[补录]',
        d.genres,
        d.desc,
        `发售：${rd(d)}`,
        d.reviews === null ? '暂无评价' : `累计评价 ${d.reviews}`,
        d.priceYuan === null ? '价格未知' : d.priceYuan === 0 ? '免费' : `国区约 ${d.priceYuan} 元`,
      ].filter(Boolean).join('｜').slice(0, 900),
      image: d.image || undefined,
      author: 'Steam',
      publishedAt: new Date().toISOString(),
      lang: 'zh',
      heat: { reviews: d.reviews ?? 0, price: d.priceYuan ?? 0 },
    });
    await new Promise((r) => setTimeout(r, 300));
  }
  const saved = items.length ? saveItems(items) : { inserted: 0, dupUrl: 0, dupTitle: 0 };
  return { inserted: saved.inserted, skipped: skipped + saved.dupUrl };
}
