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
  /** 商店页里的实机截图（缩略图 600x338）。用来在看板上替代封面图。 */
  shots?: string[];
  fetchedAt: string;
}

const CACHE_DAYS = 14;

function norm(s: string): string {
  return s
    .toLowerCase()
    // 中文标点也要去掉，否则「勇者小队全灭了」和 Steam 上的「勇者小队全灭了。」对不上
    .replace(/[：:·・—\-–_/\\|'"“”‘’《》()（）[\]。！？，、；…·「」『』【】®™©]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉虚词再比：中文游戏名常多一个「的/了」，「我带过最差的一届」和 Steam 上的「我带过的最差的一届」是同一个。 */
function stripParticles(s: string): string {
  return s.replace(/[的了个呀吧呢]/g, '');
}

/** 搜索结果可能跑到别的作品上去（查 Hypnos 会先给 Hypnospace Outlaw），这里做一道名字核对。 */
/** 资料片/Demo/原声带这类条目不是本体，它们的封面和发售日都不能拿来表示这款游戏。 */
const DERIVATIVE = /(demo|soundtrack|\bost\b|dlc|pack|upgrade|bundle|expansion|season pass|体验版|试玩|原声|配乐|典藏|扩展包|角色包|卡牌?包)/i;
function isDerivative(query: string, candidate: string): boolean {
  return DERIVATIVE.test(candidate) && !DERIVATIVE.test(query);
}

export function looksSame(query: string, candidate: string): boolean {
  const a = norm(query);
  const b = norm(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = stripParticles(a);
  const pb = stripParticles(b);
  if (pa && pa === pb) return true;

  // 中文名常带副标题：「深空当铺」对「深空当铺：可能是偷的」。
  // 只对含中文的一方才放宽包含判断——拉丁名靠包含会出事
  // （「The Expanse」是「The Expanse: Osiris Reborn」的前缀，但不是同一个作品）。
  const shorter = pa.length <= pb.length ? pa : pb;
  const longer = pa.length <= pb.length ? pb : pa;
  // 两字名在中文里很常见（「嬗变」「九王」），门槛放到 2 个字。
  if (/[\u4e00-\u9fa5]/.test(shorter) && shorter.length >= 2 && longer.includes(shorter) && !isDerivative(a, b)) return true;

  // 拉丁名按词比：共享词要占到六成。
  // 以前「有一个词相同就算同一款」，结果「黑神话：钟馗」配上了「黑神话：悟空」的封面、
  // 「战锤40K：黑暗异端」配上了「战锤40K：暗潮」——宁可没封面，不能给错图。
  const at = new Set(a.split(' ').filter((t) => t.length >= 2));
  const bt = new Set(b.split(' ').filter((t) => t.length >= 2));
  if (!at.size || !bt.size) return false;
  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  const union = at.size + bt.size - inter;
  if (union > 0 && inter / union >= 0.6 && !isDerivative(a, b)) return true;

  // 「Hela」对「Hela：鼠鼠奇旅」——拉丁主名 + 中文副标题，中文是国内发行时加的。
  // 反过来不行：「The Expanse」是「The Expanse: Osiris Reborn」的前缀，多出来的还是拉丁词，不是副标题。
  const small = at.size <= bt.size ? at : bt;
  const big = at.size <= bt.size ? bt : at;
  if (!small.size) return false;
  let covered = 0;
  for (const t of small) if (big.has(t)) covered++;
  if (covered !== small.size) return false;
  for (const t of big) if (!small.has(t) && !/[\u4e00-\u9fa5]/.test(t)) return false;
  return true;
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

/** 先按原名搜；查不到再拿「主标题」搜一次（中文独立游戏常在 Steam 上挂了副标题）。 */
async function searchApp(name: string): Promise<{ appid: string; name: string } | null> {
  const queries = [name];
  const main = name.split(/[：:｜|—–\-]/)[0].trim();
  if (main && main !== name && main.length >= 2) queries.push(main);
  // Steam 的搜索是按字面匹配的：媒体写「我带过最差的一届」，商店里叫「我带过的最差一届」，
  // 原样搜是 0 结果。多试几种写法——去虚词、去掉前面几个字取尾部片段，
  // 命中结果仍要过 looksSame 这道闸，所以放宽查询不会换来错图。
  const bases = [name, main, stripParticles(name), stripParticles(main)].filter((x) => !!x && x.length >= 2);
  for (const base of bases) {
    for (const cut of [6, 5, 4]) {
      if (base.length > cut + 2) queries.push(base.slice(-cut));
    }
  }
  const uniq = [...new Set(queries)].filter((x) => x.length >= 2);
  for (const q of uniq) {
    const hits = await searchRaw(q);
    for (const it of hits) {
      if (looksSame(name, it.name)) return { appid: it.appid, name: it.name };
    }
  }
  return null;
}

/** 单次 Steam 商店搜索，原样返回前 8 条（名字核对交给调用方）。 */
async function searchRaw(term: string): Promise<Array<{ appid: string; name: string }>> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=cn&l=schinese`;
  const r = await politeFetch(url);
  if (!r.ok) return [];
  try {
    const d = JSON.parse(r.body) as { items?: Array<{ id: number; name: string }> };
    return (d.items ?? []).slice(0, 8).map((it) => ({ appid: String(it.id), name: it.name }));
  } catch {
    return [];
  }
}

async function appDetails(appid: string): Promise<Omit<SteamFacts, 'query' | 'matched' | 'appid' | 'fetchedAt'>> {
  const out = {
    releaseDate: null as string | null,
    comingSoon: false,
    reviews: null as number | null,
    priceYuan: null as number | null,
    shots: [] as string[],
  };
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
    // 商店页的截图就是实机画面，比 capsule 封面更能代表游戏本身。
    const shots = (d.screenshots as Array<{ path_thumbnail?: string }> | undefined) ?? [];
    out.shots = shots.map((x) => x.path_thumbnail).filter((x): x is string => !!x).slice(0, 3);
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

/**
 * 从文章里抠出英文作品名去 Steam 搜。
 *
 * 为什么需要：「杀戮尖塔2」在 Steam 上叫「Slay the Spire 2」，商店页没有中文名，
 * 拿中文去搜永远是 0 条。但文章正文里往往直接写着英文名——那就用文章自己的字去查，
 * 并且要求搜到的名字**在正文里原样出现过**，这样不会认错人。
 */
async function searchByContext(context: string): Promise<{ appid: string; name: string } | null> {
  const text = norm(context);
  if (!text) return null;
  // 抠出连续的拉丁片段（书名号、竖线会被 norm 变成空格），取 2–4 个词、4–40 个字符的
  const runs = text.match(/[a-z][a-z0-9'’:!&.\-]*(?: [a-z0-9'’:!&.\-]+){0,5}/g) ?? [];
  // 一段连续英文里，作品名往往只是开头的两三个词（"slay the spire 2 beta patch notes"），
  // 所以每个片段再各取前 2/3/4 个词的短版本一起试。
  const expanded: string[] = [];
  for (const run of runs) {
    const words = run.trim().split(' ').filter(Boolean);
    for (const n of [4, 3, 2]) {
      if (words.length >= n) expanded.push(words.slice(0, n).join(' '));
    }
    expanded.push(run.trim());
  }
  const cands = [...new Set(expanded.filter((x) => x.length >= 4 && x.length <= 40))].slice(0, 6);
  for (const cand of cands) {
    const hits = await searchRaw(cand);
    for (const h of hits.slice(0, 5)) {
      const n = norm(h.name);
      // 只认「正文里原样出现过」的结果
      if (n.length >= 4 && text.includes(n) && !DERIVATIVE.test(h.name)) return h;
    }
  }
  return null;
}

export async function lookupGame(name: string, opts: { fresh?: boolean; context?: string } = {}): Promise<SteamFacts> {
  const cached = q<{ steam_appid: string | null; meta_json: string | null; last_at: string | null }>(
    'SELECT steam_appid, meta_json, last_at FROM games WHERE name = ?',
    name
  )[0];
  // 只缓存「查到了」的结果。查不到的要每次重试——名字匹配规则会改，
  // 中文名/副标题对不上是常态，把失败也缓存 14 天等于把错判固化了。
  if (cached && !opts.fresh && cached.last_at && cached.steam_appid) {
    const age = Date.now() - new Date(cached.last_at).getTime();
    if (age < CACHE_DAYS * 86_400_000) {
      const meta = cached.meta_json ? (JSON.parse(cached.meta_json) as SteamFacts) : null;
      if (meta) return meta;
    }
  }

  const now = new Date().toISOString();
  let hit = await searchApp(name);
  if (!hit && opts.context) hit = await searchByContext(opts.context);
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
