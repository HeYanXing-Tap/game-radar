/**
 * Steam 外部事实：给「重点游戏」雷达补上模型看不见的东西——这游戏到底上线多久了、有多少人在评。
 *
 * 为什么需要：模型只能读到文章正文。一篇文章说「PEAK 今日登陆 Xbox」和说「某新作首曝」，
 * 在它眼里长得一样。但对我们来说这两件事差着一整个时间窗：前者是二次事件，后者是抢窗口。
 * 所以要把「发售日 / 已上线天数 / 评价数」从 Steam 查出来，塞进打分输入。
 */
import { q } from './db.ts';
import { politeFetch } from './fetch.ts';
import { log } from './db.ts';

export interface SteamFacts {
  query: string;
  matched: string | null;
  appid: string | null;
  releaseDate: string | null; // ISO
  comingSoon: boolean;
  reviews: number | null;
  priceYuan: number | null;
  fetchedAt: string;
}

const CACHE_DAYS = 14;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[：:·・—\-–_/\\|'"“”‘’《》()（）[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 搜索结果可能跑到别的作品上去（查 Hypnos 会先给 Hypnospace Outlaw），这里做一道名字核对。 */
function looksSame(query: string, candidate: string): boolean {
  const a = norm(query);
  const b = norm(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length <= 6 && (b === a || b.startsWith(a) || b.includes(a))) return true;
  const at = new Set(a.split(' ').filter((t) => t.length >= 2));
  const bt = b.split(' ').filter((t) => t.length >= 2);
  return bt.some((t) => at.has(t));
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

async function searchApp(name: string): Promise<{ appid: string; name: string } | null> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=cn&l=schinese`;
  const r = await politeFetch(url);
  if (!r.ok) return null;
  try {
    const d = JSON.parse(r.body) as { items?: Array<{ id: number; name: string }> };
    for (const it of d.items ?? []) {
      if (looksSame(name, it.name)) return { appid: String(it.id), name: it.name };
    }
  } catch {
    /* 解析失败就当没查到 */
  }
  return null;
}

async function appDetails(appid: string): Promise<Omit<SteamFacts, 'query' | 'matched' | 'appid' | 'fetchedAt'>> {
  const out = { releaseDate: null as string | null, comingSoon: false, reviews: null as number | null, priceYuan: null as number | null };
  const r = await politeFetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=cn&l=schinese`);
  if (!r.ok) return out;
  try {
    const parsed = JSON.parse(r.body) as Record<string, { success?: boolean; data?: Record<string, unknown> }>;
    const d = parsed[appid]?.data;
    if (!d) return out;
    const rd = (d.release_date ?? {}) as { date?: string; coming_soon?: boolean };
    out.comingSoon = Boolean(rd.coming_soon);
    if (rd.date && !out.comingSoon) out.releaseDate = parseRelease(rd.date);
    const recs = (d.recommendations as { total?: number } | undefined)?.total;
    if (typeof recs === 'number') out.reviews = recs;
    const pf = (d.price_overview as { final?: number } | undefined)?.final;
    if (typeof pf === 'number') out.priceYuan = Math.round(pf / 100);
  } catch {
    /* 忽略 */
  }
  return out;
}

/** 查一个游戏名，带库内缓存（14 天）。查不到也缓存，避免每天都去问一遍。 */
/** 只在标题里真出现过这个名字才去查，避免模型从摘要里抽个词就拉起一次查询。 */
export function mentionedInTitle(name: string, title: string): boolean {
  const n = norm(name);
  if (!n) return false;
  return norm(title).includes(n);
}

export async function lookupGame(name: string, opts: { fresh?: boolean } = {}): Promise<SteamFacts> {
  const cached = q<{ steam_appid: string | null; meta_json: string | null; last_at: string | null }>(
    'SELECT steam_appid, meta_json, last_at FROM games WHERE name = ?',
    name
  )[0];
  if (cached && !opts.fresh && cached.last_at) {
    const age = Date.now() - new Date(cached.last_at).getTime();
    if (age < CACHE_DAYS * 86_400_000) {
      const meta = cached.meta_json ? (JSON.parse(cached.meta_json) as SteamFacts) : null;
      if (meta) return meta;
    }
  }

  const now = new Date().toISOString();
  const hit = await searchApp(name);
  const facts: SteamFacts = hit
    ? { query: name, matched: hit.name, appid: hit.appid, ...(await appDetails(hit.appid)), fetchedAt: now }
    : { query: name, matched: null, appid: null, releaseDate: null, comingSoon: false, reviews: null, priceYuan: null, fetchedAt: now };

  q(
    `INSERT INTO games (name, name_cn, stage, steam_appid, first_at, last_at, mentions, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET
       stage = excluded.stage, steam_appid = excluded.steam_appid, last_at = excluded.last_at,
       mentions = games.mentions + 1, meta_json = excluded.meta_json`,
    name,
    facts.matched,
    stageOf(facts),
    facts.appid,
    now,
    now,
    JSON.stringify(facts)
  );
  return facts;
}

export type Stage = 'coming' | 'launch' | 'new' | 'recent' | 'old' | 'unknown';

export function stageOf(f: SteamFacts): Stage {
  if (!f.appid) return 'unknown';
  if (f.comingSoon || !f.releaseDate) return f.comingSoon ? 'coming' : 'unknown';
  const days = ageDays(f);
  if (days === null) return 'unknown';
  if (days <= 14) return 'launch';
  if (days <= 90) return 'new';
  if (days <= 365) return 'recent';
  return 'old';
}

export function ageDays(f: SteamFacts): number | null {
  if (!f.releaseDate) return null;
  const t = new Date(f.releaseDate).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** 塞进打分提示词的素材：只放事实，不下结论（结论交给模型）。 */
export function factsLine(f: SteamFacts): string {
  if (!f.appid) return '外部事实：Steam 未检索到该作品（可能未上架或名字对不上）。';
  const bits: string[] = [];
  bits.push(`Steam 页面为《${f.matched ?? f.query}》`);
  if (f.comingSoon || !f.releaseDate) {
    bits.push('状态：尚未发售（页面显示即将推出）');
  } else {
    const d = new Date(f.releaseDate);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    bits.push(`发售日 ${iso}（已上线 ${ageDays(f)} 天）`);
  }
  bits.push(f.reviews === null ? '累计评价数：无（可能刚上架或无人评价）' : `累计评价数 ${f.reviews}`);
  if (f.priceYuan !== null) bits.push(`国区售价约 ${f.priceYuan} 元`);
  return `外部事实（非文章内容，来自 Steam）：${bits.join('；')}。`;
}

/** 给已有分数的条目补查（用于老数据）。 */
export async function resolveForPending(radar: 'game', limit = 200): Promise<number> {
  const rows = q<{ game_name: string | null; title: string }>(
    `SELECT DISTINCT p.game_name, i.title
     FROM prescreen p
     JOIN items i ON i.id = p.item_id
     LEFT JOIN scores sc ON sc.item_id = i.id AND sc.radar = 'game'
     WHERE p.radar = 'game' AND p.game_name IS NOT NULL AND p.game_name <> ''
     LIMIT ?`,
    limit
  );
  let n = 0;
  for (const r of rows) {
    if (!r.game_name || !mentionedInTitle(r.game_name, r.title)) continue;
    try {
      await lookupGame(r.game_name);
      n++;
    } catch (e) {
      log(`[steam] 查询失败 ${r.game_name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  void radar;
  return n;
}
