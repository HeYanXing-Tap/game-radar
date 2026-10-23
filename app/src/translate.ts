import { exec, log, q } from './db.ts';
import { chatJson } from './llm.ts';
import { hasLlm } from './config.ts';

interface Row {
  id: number;
  title: string;
  summary: string | null;
}

const BATCH = 12;

/**
 * 把英文条目的标题/摘要翻成中文，写回 title_zh / summary_zh。
 * 只影响展示：抓取、聚类、打分仍然用原文，避免污染指纹。
 */
export async function translatePending(opts: { limit?: number } = {}): Promise<{
  translated: number;
  batches: number;
  failed: number;
}> {
  if (!hasLlm()) {
    log('未配置 LLM_API_KEY，跳过翻译');
    return { translated: 0, batches: 0, failed: 0 };
  }
  const limit = opts.limit ?? 600;
  const rows = q<Row>(
    `SELECT id, title, summary FROM items
     WHERE COALESCE(lang, 'zh') != 'zh' AND title_zh IS NULL AND is_dup = 0
     ORDER BY COALESCE(published_at, fetched_at) DESC
     LIMIT ?`,
    limit
  );

  let translated = 0;
  let batches = 0;
  let failed = 0;

  // 一批 25 条、每条都要出中文标题+摘要，单批要 40–60 秒；串行跑 20 批就快一小时。
  // 这里按批并行，真正的并发上限由 llm.ts 的闸门控制。
  const slices: Row[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) slices.push(rows.slice(i, i + BATCH));

  let cursor = 0;
  const workers = Math.max(1, Math.min(4, 4));

  const oneBatch = async (slice: Row[], idx: number): Promise<void> => {
    const list = slice
      .map((r, k) => `${k + 1}. 标题：${r.title}${r.summary ? `\n   摘要：${r.summary.slice(0, 220)}` : ''}`)
      .join('\n');
    const user = `把下面 ${slice.length} 条游戏资讯翻译成简体中文，用于中文游戏媒体编辑的选题看板。

要求：
- 标题要像中文游戏媒体报道的写法，不是直译。抓人、具体、不夸张。
- 游戏名、厂商名、人名、平台名保留原文（如 Hollow Knight、Nintendo Switch 2、BioWare）。
- 摘要译成 60 字以内的中文，保留关键数字。
- 每条都要译，不许跳过、不许合并。

${list}

只输出 JSON：{"items":[{"i":1,"t":"中文标题","s":"中文摘要"}]}`;

    try {
      const out = await chatJson<{ items: Array<{ i: number; t: string; s?: string }> }>(user, {
        system: '你是资深游戏媒体编辑，擅长把英文游戏新闻写成中文标题。只输出 JSON。',
        temperature: 0.2,
        maxTokens: 3000,
      });
      const items = Array.isArray(out?.items) ? out.items : [];
      if (items.length < slice.length) {
        log(`  ⚠ 第 ${idx + 1} 批只回了 ${items.length}/${slice.length} 条（输出被截断），下轮补`);
      }
      for (const it of items) {
        const row = slice[Number(it.i) - 1];
        if (!row || !it.t) continue;
        exec('UPDATE items SET title_zh = ?, summary_zh = ? WHERE id = ?', it.t.trim(), (it.s ?? '').trim() || null, row.id);
        translated++;
      }
      batches++;
      if (idx % 4 === 0) log(`  翻译进度 ${Math.min(translated, rows.length)}/${rows.length}`);
    } catch (e) {
      failed++;
      log(`✗ 翻译失败（第 ${idx + 1} 批）：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < slices.length) {
        const idx = cursor++;
        await oneBatch(slices[idx], idx);
      }
    })
  );

  // 事件标题跟着换成中文（取该事件下第一条有中文译名的条目）
  exec(
    `UPDATE events SET title_zh = (
       SELECT i.title_zh FROM items i
       WHERE i.event_id = events.id AND i.title_zh IS NOT NULL
       ORDER BY COALESCE(i.published_at, i.fetched_at) ASC LIMIT 1
     )
     WHERE title_zh IS NULL
       AND EXISTS (SELECT 1 FROM items i WHERE i.event_id = events.id AND i.title_zh IS NOT NULL)`
  );

  return { translated, batches, failed };
}
