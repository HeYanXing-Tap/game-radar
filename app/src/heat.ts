/**
 * 站内热度事实：把 B 站头部视频的播放量整理成一句能喂给模型的话。
 *
 * 为什么要单独一层：`bili.ts` 只负责「查」，不碰数据库；
 * 而打分时同一个游戏名会被多篇文章反复问到（一篇文章一条），
 * 不缓存的话一天能白打几十次请求。所以这里做 24 小时缓存。
 *
 * 对引进业务的意义：Steam 评价数只说明「国外有人在玩」，
 * B 站播放量才说明「国内有没有人在看」——两者都高是成熟标的，
 * 前者高后者低是「还没被国内看见」的首曝窗口，判断完全不同。
 */
import { searchPlays, type BiliHeat } from './bili.ts';
import { log, q } from './db.ts';

const CACHE_HOURS = 24;

export function biliLine(h: BiliHeat): string {
  const wan = (n: number) => `${(n / 10000).toFixed(1)} 万`;
  const head = h.top[0];
  const parts = [`B站站内搜索：头部 ${h.top.length} 条视频合计 ${wan(h.totalPlays)}播放`];
  if (head) parts.push(`最高《${head.title.slice(0, 28)}》${wan(head.plays)}播放`);
  if (h.vids < 3) parts.push('相关视频很少，国内几乎没人拍');
  return parts.join('；');
}

/** 查一个作品在 B 站的热度，带 24 小时库内缓存。查不到也缓存，避免反复空转。 */
export async function biliHeatFor(name: string, opts: { fresh?: boolean } = {}): Promise<BiliHeat | null> {
  const row = q<{ bili_json: string | null; bili_at: string | null }>(
    'SELECT bili_json, bili_at FROM games WHERE name = ?',
    name
  )[0];
  if (row && !opts.fresh && row.bili_at) {
    const age = Date.now() - new Date(row.bili_at).getTime();
    if (age < CACHE_HOURS * 3_600_000) {
      try {
        return row.bili_json ? (JSON.parse(row.bili_json) as BiliHeat) : null;
      } catch {
        /* 缓存坏了就重查 */
      }
    }
  }

  let heat: BiliHeat | null = null;
  try {
    heat = await searchPlays(name, { limit: 5 });
  } catch (e) {
    log(`[bili] ${name} 查询失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  const now = new Date().toISOString();
  q(
    `INSERT INTO games (name, first_at, last_at, mentions, bili_json, bili_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(name) DO UPDATE SET bili_json = excluded.bili_json, bili_at = excluded.bili_at`,
    name,
    now,
    now,
    heat ? JSON.stringify(heat) : null,
    now
  );
  return heat;
}
