import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT, hasLlm, llmConfig } from './config.ts';
import { chatJson } from './llm.ts';
import { exec, log, nowIso, q } from './db.ts';
import type { Radar } from './types.ts';

const BATCH = 25;

/** 相关性分类：off 的内容不进热点榜（地震、案件这类硬社会新闻） */
const RELATED = { KEEP: new Set(['game', 'acg', 'tech', 'society', 'off']) };
const PROMPT_DIR = join(APP_ROOT, 'src', 'prompts');

const PROMPT_FILE: Record<Radar, string> = {
  topic: 'prescreen-topic.md',
  game: 'prescreen-game.md',
};

/** 细评门槛：预筛低于此分数的条目不会进入第二轮。 */
export const PRESCREEN_CUTOFF: Record<Radar, number> = {
  topic: 45,
  game: 55,
};

interface Row {
  id: number;
  title: string;
  summary: string | null;
  source_name: string;
}

interface BatchResp {
  scores?: Array<{ i: number; s: number; why?: string; r?: string; g?: string }>;
}

/**
 * 预筛：先用标题批量粗排，只让过线的进第二轮细评。
 * 这一步是整个成本模型的关键——1000 条内容全部五轴细评，一天要几百万 token；
 * 先粗排能砍掉 85% 左右，且不会漏掉真正重要的东西（标题就够判断「值不值得看」）。
 */
export async function prescreenQueue(
  radar: Radar,
  opts: { days?: number; limit?: number } = {}
): Promise<{ screened: number; calls: number; failed: number }> {
  if (!hasLlm()) {
    log(`[预筛/${radar}] 未配置 LLM_API_KEY，跳过`);
    return { screened: 0, calls: 0, failed: 0 };
  }
  const days = opts.days ?? 2;
  const limit = opts.limit ?? 400;

  const rows = q<Row>(
    `SELECT i.id, i.title, i.summary, s.name AS source_name
     FROM items i
     JOIN sources s ON s.id = i.source_id
     LEFT JOIN prescreen p ON p.item_id = i.id AND p.radar = ?
     LEFT JOIN scores sc ON sc.item_id = i.id AND sc.radar = ?
     WHERE (p.id IS NULL OR p.related IS NULL OR (? = 'game' AND p.game_name IS NULL)) AND i.is_dup = 0
       AND COALESCE(i.published_at, i.fetched_at) >= ?
     ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
     LIMIT ?`,
    radar,
    radar,
    radar,
    new Date(Date.now() - days * 86_400_000).toISOString(),
    limit
  );

  if (!rows.length) {
    log(`[预筛/${radar}] 没有待筛条目`);
    return { screened: 0, calls: 0, failed: 0 };
  }

  const system = readFileSync(join(PROMPT_DIR, PROMPT_FILE[radar]), 'utf8');
  let screened = 0;
  let calls = 0;
  let failed = 0;

  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    const lines = batch.map((r, idx) => {
      const sum = (r.summary ?? '').replace(/\s+/g, ' ').slice(0, 110);
      return `${idx + 1}. [${r.source_name}] ${r.title}${sum ? ` —— ${sum}` : ''}`;
    });
    try {
      const resp = await chatJson<BatchResp>(lines.join('\n'), {
        system,
        temperature: 0.1,
        maxTokens: 2000,
        // 粗排一次要跑几十批，用便宜模型能省一个数量级
        model: llmConfig().cheapModel || undefined,
      });
      calls++;
      if (!resp?.scores?.length) {
        failed++;
        continue;
      }
      for (const s of resp.scores) {
        const idx = Number(s.i) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
        const total = Math.max(0, Math.min(100, Math.round(Number(s.s))));
        if (!Number.isFinite(total)) continue;
        const g = s.g ? String(s.g).replace(/[《》]/g, '').trim().slice(0, 80) : null;
        exec(
          `INSERT INTO prescreen (item_id, radar, total, why, model, created_at, related, game_name)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(item_id, radar) DO UPDATE SET total=excluded.total, why=excluded.why,
             created_at=excluded.created_at, related=excluded.related,
             game_name=COALESCE(excluded.game_name, prescreen.game_name)`,
          batch[idx].id,
          radar,
          total,
          String(s.why ?? '').slice(0, 60),
          'prescreen',
          nowIso(),
          RELATED.KEEP.has(String(s.r ?? '')) ? String(s.r) : 'game',
          g
        );
        screened++;
      }
    } catch (e) {
      failed++;
      log(`[预筛/${radar}] 批次失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const passed = q<{ n: number }>(
    'SELECT COUNT(*) AS n FROM prescreen WHERE radar = ? AND total >= ?',
    radar,
    PRESCREEN_CUTOFF[radar]
  )[0]?.n ?? 0;
  log(
    `[预筛/${radar}] 筛 ${screened}/${rows.length} 条，${calls} 次调用，失败 ${failed} 批；过线（≥${PRESCREEN_CUTOFF[radar]}）累计 ${passed} 条待细评`
  );
  return { screened, calls, failed };
}
