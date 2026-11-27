import { exec, log, nowIso, q } from './db.ts';
import { prefilter, scoreItem, thresholdFor } from './score.ts';
import { BudgetExceeded, stats } from './llm.ts';
import { hasLlm, llmConfig } from './config.ts';
import { PRESCREEN_CUTOFF } from './prescreen.ts';
import { factsLine, lookupGame } from './steam.ts';
import { biliHeatFor, biliLine } from './heat.ts';
import type { Radar } from './types.ts';

interface PendingItem {
  id: number;
  title: string;
  summary: string | null;
  url: string;
  game_name?: string | null;
  game_alt?: string | null;
  published_at: string | null;
  fetched_at: string;
  heat_json: string | null;
  source_name: string;
  tier: number;
  role: string;
}

export interface ScoreRunOpts {
  radar: Radar;
  limit?: number;
  days?: number;
  /** 跳过预筛门槛，全部细评（贵，调试用） */
  ignorePrescreen?: boolean;
  /** 重打：先清掉这批条目在该雷达下的旧分（改规则后重算用） */
  redo?: boolean;
  /** 只打高于即时门槛的（用于补跑） */
}

/**
 * 打分队列。默认只打「还没有该雷达分数」的条目，可反复跑。
 * 注意：选题雷达和作品雷达各自独立消化队列——同一条内容可能两边都值得。
 */
export async function scorePending(opts: ScoreRunOpts): Promise<{ scored: number; failed: number; skipped: number }> {
  if (!hasLlm()) {
    log('未配置 LLM_API_KEY，跳过打分（先跑 npm run collect 验证抓取）');
    return { scored: 0, failed: 0, skipped: 0 };
  }
  const limit = opts.limit ?? 60;
  const days = opts.days ?? 3;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  if (opts.redo) {
    const n = q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM scores WHERE radar = ?
         AND item_id IN (SELECT id FROM items WHERE COALESCE(published_at, fetched_at) >= ?)`,
      opts.radar,
      since
    )[0]?.n ?? 0;
    exec(
      `DELETE FROM scores WHERE radar = ?
         AND item_id IN (SELECT id FROM items WHERE COALESCE(published_at, fetched_at) >= ?)`,
      opts.radar,
      since
    );
    log(`[${opts.radar}] 重打：已清掉 ${n} 条旧分`);
  }

  // 默认只细评预筛过线的；没有预筛记录的老数据也放进来（首次接入时不会漏）
  const rows = q<PendingItem & { sid: number }>(
    `SELECT i.id AS sid, i.title, i.summary, i.url, i.published_at, i.fetched_at, i.heat_json,
            s.name AS source_name, s.tier, s.role, ps.game_name AS game_key, p.game_name AS game_name, ps.game_name_alt AS game_alt
     FROM items i
     JOIN sources s ON s.id = i.source_id
     LEFT JOIN scores sc ON sc.item_id = i.id AND sc.radar = ?
     LEFT JOIN prescreen p ON p.item_id = i.id AND p.radar = ?
     WHERE sc.id IS NULL AND i.is_dup = 0
       AND COALESCE(i.published_at, i.fetched_at) >= ?
       AND (? = 1 OR p.id IS NULL OR p.total >= ?)
     ORDER BY COALESCE(p.total, 50) DESC, COALESCE(i.published_at, i.fetched_at) DESC
     LIMIT ?`,
    opts.radar,
    opts.radar,
    since,
    opts.ignorePrescreen ? 1 : 0,
    PRESCREEN_CUTOFF[opts.radar],
    limit
  );

  let scored = 0;
  let failed = 0;
  let skipped = 0;

  // 逐条串行太慢：一条带推理的模型调用 20–60 秒，60 条要半小时以上。
  // 这里开工位并行，真正的并发上限由 llm.ts 的闸门控制（cfg.concurrency），
  // 工位开多一点只是为了让排队期不留空档。
  let cursor = 0;
  let stop = false;
  const workers = Math.max(1, Math.min(8, llmConfig().concurrency * 2));

  const one = async (row: PendingItem & { sid: number }): Promise<void> => {
    const pf = prefilter(row.title, row.summary);
    if (!pf.pass) {
      skipped++;
      return;
    }
    try {
      // 重点游戏雷达：先查 Steam 事实（发售日/上线天数/评价数）再打分。
      // 模型看不到时间，不喂这个它就分不清「首曝」和「两年前的游戏上了个新平台」。
      let facts: string | null = null;
      if (opts.radar === 'game' && row.game_name) {
        const parts: string[] = [];
        // Steam：这游戏上线多久了、有多少人在评（判断时间窗）
        // 以前要求标题里必须出现这个名字才查，结果中文名/英文名对不上时就整条跳过，
        // 看板上既没封面也没状态。现在只要名字像个作品名就查——查不到也只是多一次请求。
        const nameOk = row.game_name.length <= 40 && !/[见报道原文？?]/.test(row.game_name);
        if (nameOk) {
          try {
            let f = await lookupGame(row.game_name);
            // 中文名在 Steam 上搜不到时，用预筛给的英文原名再试一次
            // （「杀戮尖塔2」在商店里就叫「Slay the Spire 2」，中文名搜是 0 结果）。
            if (!f.appid && row.game_alt && row.game_alt !== row.game_name) {
              const alt = await lookupGame(row.game_alt);
              if (alt.appid) f = alt;
            }
            parts.push(factsLine(f));
          } catch (e) {
            log(`[steam] ${row.game_name} 查询失败：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // B站：国内到底有没有人在看（判断是不是首曝窗口）
        try {
          const h = await biliHeatFor(row.game_name);
          if (h && h.top.length) parts.push(biliLine(h));
        } catch (e) {
          log(`[bili] ${row.game_name} 查询失败：${e instanceof Error ? e.message : String(e)}`);
        }
        facts = parts.filter(Boolean).join('｜') || null;
      }
      const s = await scoreItem(
        {
          facts,
          title: row.title,
          summary: row.summary,
          url: row.url,
          sourceName: row.source_name,
          tier: row.tier,
          role: row.role,
          publishedAt: row.published_at,
          heat: row.heat_json ? (JSON.parse(row.heat_json) as Record<string, number>) : null,
        },
        opts.radar
      );
      if (!s) {
        failed++;
        return;
      }
      exec(
        `INSERT INTO scores (item_id, radar, total, axes_json, verdict, angle, games_json, against, model, scored_at, facts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(item_id, radar) DO UPDATE SET
           total=excluded.total, axes_json=excluded.axes_json, verdict=excluded.verdict,
           angle=excluded.angle, games_json=excluded.games_json, against=excluded.against,
           model=excluded.model, scored_at=excluded.scored_at, facts=excluded.facts`,
        row.sid,
        opts.radar,
        s.total,
        JSON.stringify(s.axes),
        s.verdict,
        s.angle ?? null,
        s.games ? JSON.stringify(s.games) : null,
        s.against ?? null,
        s.model,
        s.scoredAt,
        s.facts ?? null
      );
      const mark = s.total >= thresholdFor(opts.radar, row.tier) ? '★' : ' ';
      log(`${mark} [${opts.radar}] ${s.total}  ${row.title.slice(0, 44)}`);
      scored++;
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        stop = true;
        return;
      }
      failed++;
      log(`✗ 打分失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!stop && cursor < rows.length) {
        const row = rows[cursor++];
        await one(row);
      }
    })
  );

  log(
    `打分完成 [${opts.radar}]：成功 ${scored}，失败 ${failed}，规则预筛跳过 ${skipped}，模型调用 ${stats.calls} 次，token ${stats.promptTokens}+${stats.completionTokens}`
  );
  return { scored, failed, skipped };
}

export interface BoardEntry {
  item_id: number;
  radar: Radar;
  total: number;
  verdict: string;
  angle: string | null;
  against: string | null;
  games: string[];
  axes: Array<{ key: string; score: number; why: string }>;
  title: string;
  url: string;
  summary: string | null;
  image: string | null;
  published_at: string | null;
  source_name: string;
  tier: number;
  role: string;
  event_id: number | null;
  /** 外部事实：Steam 评价数/发售日、B站播放量。卡片和日报都靠它撑证据。 */
  facts: string | null;
  rank: number | null;
  event_heat: number | null;
  event_sources: number | null;
  scored_at: string;
  /** 同事件的其它篇数。同一件事被十家媒体写，榜上只该占一行。 */
  also?: number;
  /** 重点游戏专用：预筛阶段抽出的规范游戏名（Steam 查询用的就是它）。 */
  game_key?: string | null;
  /** 重点游戏专用：Steam appid（用来拼封面图）。 */
  appid?: number | null;
  /** 重点游戏专用：Steam 商店页里的实机截图（封面不算，实机才算）。 */
  shot?: string | null;
  /** 重点游戏专用：发布阶段。 */
  stage?: string | null;
  /** 重点游戏专用：给人看的一句话状态，如「尚未发售」「首发 1 天」「上线 23 天」「Steam 查不到」。 */
  stage_label?: string | null;
}

/** 精选：过了门槛的条目，按分数 + 事件热度排。 */
export function board(radar: Radar, opts: { days?: number; limit?: number; onlyPassing?: boolean } = {}): BoardEntry[] {
  const days = opts.days ?? 3;
  const limit = opts.limit ?? 60;
  const onlyPassing = opts.onlyPassing !== false;

  const rows = q<Omit<BoardEntry, 'games' | 'axes'> & { axes_json: string; games_json: string | null }>(
    `SELECT i.id AS item_id, sc.radar, sc.total, sc.verdict, sc.angle, sc.against,
            sc.axes_json, sc.games_json, sc.scored_at, sc.facts,
            COALESCE(i.title_zh, i.title) AS title, i.url,
            COALESCE(i.summary_zh, i.summary) AS summary,
            i.image, i.published_at, i.event_id, i.heat_json,
            s.name AS source_name, s.tier, s.role, ps.game_name AS game_key
     FROM scores sc
     JOIN items i ON i.id = sc.item_id
     JOIN sources s ON s.id = i.source_id
     LEFT JOIN prescreen ps ON ps.item_id = i.id AND ps.radar = sc.radar
     WHERE sc.radar = ? AND COALESCE(i.published_at, i.fetched_at) >= ?
       AND COALESCE(ps.related, '') <> 'off'
       -- 选题素材（B站 UP 主视频等）不进重点游戏队列
       AND (? = 'topic' OR i.topic_only = 0)
     ORDER BY sc.total DESC
     LIMIT 400`,
    radar,
    new Date(Date.now() - days * 86_400_000).toISOString(),
    radar
  );

  const heatMap = new Map<number, { heat: number; sources: number }>();
  for (const r of q<{ event_id: number; heat: number; sources: number }>(
    `SELECT e.id AS event_id, COUNT(DISTINCT i.source_id) AS sources,
            COUNT(DISTINCT i.source_id) AS heat
     FROM events e JOIN items i ON i.event_id = e.id
     WHERE e.last_at >= ? GROUP BY e.id`,
    new Date(Date.now() - 7 * 86_400_000).toISOString()
  )) {
    heatMap.set(r.event_id, { heat: r.heat, sources: r.sources });
  }

  // 同一件事只留一条（分最高的那条），其余记进 also。
  // 否则黄仁勋辞职这种新闻会一次占掉半个榜，把真正不一样的选题挤下去。
  const seenEvent = new Map<number, BoardEntry>();
  const out: BoardEntry[] = [];
  for (const r of rows) {
    const threshold = thresholdFor(radar, r.tier);
    if (onlyPassing && r.total < threshold) continue;
    if (r.event_id) {
      const prev = seenEvent.get(r.event_id);
      if (prev) { prev.also = (prev.also ?? 1) + 1; continue; }
    }
    const h = r.event_id ? heatMap.get(r.event_id) : undefined;
    const { axes_json, games_json, heat_json, ...rest } = r;
    out.push({
      ...rest,
      games: games_json ? (JSON.parse(games_json) as string[]) : [],
      axes: JSON.parse(axes_json) as Array<{ key: string; score: number; why: string }>,
      rank: heat_json ? (JSON.parse(heat_json) as { rank?: number }).rank ?? null : null,
      event_heat: h?.heat ?? null,
      event_sources: h?.sources ?? null,
      also: 1,
    });
    if (r.event_id) seenEvent.set(r.event_id, out[out.length - 1]);
    if (out.length >= limit) break;
  }
  // 重点游戏：把 Steam 状态挂上去。分数是「值不值得谈」，状态是「还来不来得及」，
  // 两者都得露出，不然编辑得逐条点开才知道这个标的是不是已经过期了。
  if (radar === 'game' && out.length) {
    const names = [...new Set(out.map((e) => e.game_key || e.games[0]).filter((n): n is string => !!n))];
    if (names.length) {
      const gs = q<{ name: string; steam_appid: string | null; meta_json: string | null }>(
        `SELECT name, steam_appid, meta_json FROM games WHERE name IN (${names.map(() => '?').join(',')})`,
        ...names
      );
      const byName = new Map(gs.map((g) => [g.name, g]));
      for (const e of out) {
        const key = e.game_key || e.games[0];
        const g = key ? byName.get(key) : undefined;
        e.appid = g?.steam_appid ? Number(g.steam_appid) : null;
        e.stage_label = stageLabelOf(g) ?? stageFromFacts(e.facts);
        e.shot = firstShot(g?.meta_json);
      }
    }
  }

  return out;
}

/** 单条内容的详细正文抓取（详情页用），懒加载避免浪费 token。 */
export function itemDetail(id: number): Record<string, unknown> | null {
  const row = q<Record<string, unknown>>(
    `SELECT i.*, s.name AS source_name, s.tier, s.role FROM items i JOIN sources s ON s.id=i.source_id WHERE i.id = ?`,
    id
  )[0];
  if (!row) return null;
  const scores = q<Record<string, unknown>>('SELECT * FROM scores WHERE item_id = ?', id);
  const siblings = row.event_id
    ? q<Record<string, unknown>>(
        'SELECT i.id, i.title, i.url, s.name AS source_name, i.published_at FROM items i JOIN sources s ON s.id=i.source_id WHERE i.event_id = ? AND i.id != ?',
        row.event_id as number,
        id
      )
    : [];
  return { item: row, scores, siblings };
}

export function recordRun(kind: string, startedAt: string, statsObj: unknown): void {
  exec('INSERT INTO runs (kind, started_at, finished_at, stats_json) VALUES (?,?,?,?)', kind, startedAt, nowIso(), JSON.stringify(statsObj));
}


/** 商店页第一张实机截图。老记录没存过就没有，不补查——导出阶段不该发网络请求。 */
function firstShot(metaJson: string | null | undefined): string | null {
  if (!metaJson) return null;
  try {
    const m = JSON.parse(metaJson) as { shots?: string[] };
    return Array.isArray(m.shots) && m.shots.length ? m.shots[0] : null;
  } catch {
    return null;
  }
}

/** 库里没有这条游戏时，从它打分时用的 facts 文本里还原状态。 */
function stageFromFacts(facts: string | null): string | null {
  if (!facts) return null;
  if (/尚未发售/.test(facts)) return '尚未发售';
  const m = /已上线\s*(\d+)\s*天/.exec(facts);
  if (m) {
    const d = Number(m[1]);
    return d <= 14 ? (d <= 0 ? '首发当天' : `首发 ${d} 天`) : `上线 ${d} 天`;
  }
  if (/未检索到/.test(facts)) return 'Steam 查不到';
  return null;
}

/** 把 Steam 库里的状态翻成一句人话。没有 appid 就明说查不到——这本身也是信息。 */
function stageLabelOf(g?: { steam_appid: string | null; meta_json: string | null }): string | null {
  if (!g) return null;
  if (!g.steam_appid) return 'Steam 查不到';
  if (!g.meta_json) return null;
  let meta: { releaseDate?: string | null; comingSoon?: boolean } | null = null;
  try { meta = JSON.parse(g.meta_json); } catch { return null; }
  if (!meta) return null;
  if (meta.comingSoon || !meta.releaseDate) return '尚未发售';
  const t = new Date(meta.releaseDate).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return '首发当天';
  if (days <= 14) return `首发 ${days} 天`;
  return `上线 ${days} 天`;
}
