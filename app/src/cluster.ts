import { exec, log, nowIso, one, q, similarity, titleKey } from './db.ts';
import { chatJson } from './llm.ts';
import { hasLlm } from './config.ts';

interface ItemRow {
  id: number;
  source_id: string;
  title: string;
  summary: string | null;
  published_at: string | null;
  fetched_at: string;
  event_id: number | null;
}

interface EventRow {
  id: number;
  title: string;
  first_at: string | null;
  last_at: string | null;
}

const MERGE_SIM = 0.24; // 直接并入
const GRAY_LOW = 0.14; // 低于此新建；之间交给模型判

/** 事件聚簇：先文字重合度找候选，再让模型判「同一件事 / 后续进展 / 两件事」。 */
export async function cluster(onProgress?: (msg: string) => void): Promise<{ merged: number; created: number; judged: number }> {
  const pending = q<ItemRow>(
    `SELECT id, source_id, title, summary, published_at, fetched_at, event_id
     FROM items WHERE event_id IS NULL AND is_dup = 0
     ORDER BY COALESCE(published_at, fetched_at) ASC`
  );
  let merged = 0;
  let created = 0;
  let judged = 0;
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();

  for (const it of pending) {
    const recent = q<EventRow>(
      `SELECT id, title, first_at, last_at FROM events WHERE last_at >= ? ORDER BY last_at DESC LIMIT 400`,
      since
    );
    let best: { ev: EventRow; sim: number } | null = null;
    for (const ev of recent) {
      const sim = similarity(it.title, ev.title);
      if (!best || sim > best.sim) best = { ev, sim };
    }

    let targetId: number | null = null;

    if (best && best.sim >= MERGE_SIM) {
      targetId = best.ev.id;
    } else if (best && best.sim >= GRAY_LOW && hasLlm()) {
      judged++;
      const verdict = await chatJson<{ same: boolean; relation?: string }>(
        `判断两条游戏资讯是否在讲同一件事。\n\nA（已有事件）：${best.ev.title}\nB（新条目）：${it.title}\n${it.summary ? `B 摘要：${it.summary.slice(0, 300)}` : ''}\n\n只输出 JSON：{"same": true/false, "relation": "same|followup|different"}`,
        { system: '你是新闻编辑，擅长判断两条资讯是否报道同一件事。只输出 JSON。', temperature: 0 }
      );
      if (verdict?.same) targetId = best.ev.id;
    }

    if (targetId) {
      const ts = it.published_at ?? it.fetched_at;
      exec(
        `UPDATE events SET last_at = CASE WHEN last_at IS NULL OR ? > last_at THEN ? ELSE last_at END,
         first_at = CASE WHEN first_at IS NULL OR ? < first_at THEN ? ELSE first_at END WHERE id = ?`,
        ts,
        ts,
        ts,
        ts,
        targetId
      );
      exec('UPDATE items SET event_id = ? WHERE id = ?', targetId, it.id);
      merged++;
    } else {
      exec(
        'INSERT INTO events (title, summary, first_at, last_at, created_at) VALUES (?,?,?,?,?)',
        it.title,
        it.summary,
        it.published_at ?? it.fetched_at,
        it.published_at ?? it.fetched_at,
        nowIso()
      );
      const row = one<{ id: number }>('SELECT last_insert_rowid() AS id');
      const id = row?.id ?? 0;
      exec('UPDATE items SET event_id = ? WHERE id = ?', id, it.id);
      created++;
    }
    onProgress?.(`聚簇 ${merged + created}/${pending.length}`);
  }

  log(`聚簇完成：新事件 ${created}，并入 ${merged}，模型判定 ${judged}`);
  return { merged, created, judged };
}

export interface HotEvent {
  event_id: number;
  title: string;
  summary: string | null;
  first_at: string;
  last_at: string;
  sources: number;
  items: number;
  heat: number;
  heat_6h: number;
  delta: number;
  source_names: string;
  top_tier: number;
}

/**
 * 热度 = 独立来源数加权的半衰和。
 * 48 小时内：每个独立来源只算一次；24 小时以前的对半折。
 * 重复抓取不涨分，一家媒体发十篇也只算一次——这是 AIHOT 的核心，照抄。
 */
export function computeHeat(): HotEvent[] {
  const rows = q<{
    event_id: number;
    title: string;
    summary: string | null;
    first_at: string;
    last_at: string;
    src: string;
    tier: number;
    ts: string;
    srcname: string;
  }>(
    `SELECT e.id AS event_id, e.title, e.summary, e.first_at, e.last_at,
            i.source_id AS src, s.tier AS tier,
            COALESCE(i.published_at, i.fetched_at) AS ts,
            s.name AS srcname
     FROM events e
     JOIN items i ON i.event_id = e.id AND i.is_dup = 0
     JOIN sources s ON s.id = i.source_id
     WHERE e.last_at >= ?
       AND s.role IN ('media','community','overseas','internal')
     ORDER BY ts`,
    new Date(Date.now() - 7 * 86_400_000).toISOString()
  );

  const byEvent = new Map<number, HotEvent & { _seen: Set<string>; _seen6: Set<string> }>();
  const now = Date.now();

  for (const r of rows) {
    let e = byEvent.get(r.event_id);
    if (!e) {
      e = {
        event_id: r.event_id,
        title: r.title,
        summary: r.summary,
        first_at: r.first_at,
        last_at: r.last_at,
        sources: 0,
        items: 0,
        heat: 0,
        heat_6h: 0,
        delta: 0,
        source_names: '',
        top_tier: 1,
        _seen: new Set(),
        _seen6: new Set(),
      };
      byEvent.set(r.event_id, e);
    }
    e.items++;
    const age = now - new Date(r.ts).getTime();
    if (age > 48 * 3_600_000) continue;

    const tierBoost = r.tier === 3 ? 1.6 : r.tier === 2 ? 1.15 : 1.0;
    const weight = (age > 24 * 3_600_000 ? 0.5 : 1) * tierBoost;

    if (!e._seen.has(r.src)) {
      e._seen.add(r.src);
      e.heat += weight;
      e.sources++;
      e.source_names = e.source_names ? `${e.source_names} / ${r.srcname}` : r.srcname;
      e.top_tier = Math.max(e.top_tier, r.tier);
    }
    if (age <= 6 * 3_600_000 && !e._seen6.has(r.src)) {
      e._seen6.add(r.src);
      e.heat_6h += weight;
    }
  }

  return [...byEvent.values()]
    .map((e) => {
      const { _seen, _seen6, ...rest } = e;
      return { ...rest, heat: Math.round(rest.heat * 100) / 100, heat_6h: Math.round(rest.heat_6h * 100) / 100, delta: Math.round((rest.heat - rest.heat_6h) * 100) / 100 };
    })
    .sort((a, b) => b.heat - a.heat);
}
