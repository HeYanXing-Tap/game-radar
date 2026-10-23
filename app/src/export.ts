import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from './config.ts';
import { board } from './pipeline.ts';
import { computeHeat } from './cluster.ts';
import { getDigest, listDigests } from './digest.ts';
import { allSources } from './sources.ts';
import { exec, q } from './db.ts';
import type { Radar } from './types.ts';

const OUT = join(APP_ROOT, 'public', 'data');

function write(name: string, data: unknown): void {
  writeFileSync(join(OUT, name), JSON.stringify(data));
}

/**
 * 导出静态数据。给「没有常开机器」的用法：GitHub Actions 定时跑完，
 * 把结果写成 JSON 一起提交，看板就变成纯静态页，任何静态托管都能放。
 */
export function exportStatic(): Record<string, number> {
  mkdirSync(OUT, { recursive: true });

  const counts: Record<string, number> = {};

  for (const days of [1, 3, 7]) {
    for (const radar of ['topic', 'game'] as Radar[]) {
      const entries = board(radar, { days, limit: 60 });
      write(`${radar}-${days}.json`, { radar, days, entries });
      if (days === 3) counts[radar] = entries.length;
    }
  }

  const hot = computeHeat().slice(0, 40);
  write('hot.json', hot);
  counts.hot = hot.length;

  const digests = listDigests(60);
  write('digests.json', digests);
  counts.digests = digests.length;

  if (digests.length) {
    const latest = digests[0];
    write('digest-latest.json', { date: latest.date, markdown: getDigest(latest.date) });
    // 日报历史，供静态页切换
    const history = digests.slice(0, 14).map((d) => ({ date: d.date, markdown: getDigest(d.date) }));
    write('digest-history.json', history);
  }

  const stats = {
    items: q<{ n: number }>('SELECT COUNT(*) AS n FROM items')[0]?.n ?? 0,
    events: q<{ n: number }>('SELECT COUNT(*) AS n FROM events')[0]?.n ?? 0,
    sources: q<{ n: number }>('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1')[0]?.n ?? 0,
    latest_item:
      q<{ ts: string }>('SELECT COALESCE(published_at, fetched_at) AS ts FROM items ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 1')[0]
        ?.ts ?? null,
    generated_at: new Date().toISOString(),
  };
  write('stats.json', stats);
  write('sources.json', allSources());

  return counts;
}

/** 只保留最近 N 天的条目。GitHub 上要靠这个把仓库体积压住。 */
export function prune(days = 45): { items: number; events: number } {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const before = q<{ n: number }>('SELECT COUNT(*) AS n FROM items')[0]?.n ?? 0;

  exec('DELETE FROM items WHERE COALESCE(published_at, fetched_at) < ?', cutoff);
  exec('DELETE FROM scores WHERE item_id NOT IN (SELECT id FROM items)');
  exec('DELETE FROM prescreen WHERE item_id NOT IN (SELECT id FROM items)');
  // 没有任何条目的事件也一起清掉
  exec('DELETE FROM events WHERE id NOT IN (SELECT DISTINCT event_id FROM items WHERE event_id IS NOT NULL)');

  const after = q<{ n: number }>('SELECT COUNT(*) AS n FROM items')[0]?.n ?? 0;
  const events = q<{ n: number }>('SELECT COUNT(*) AS n FROM events')[0]?.n ?? 0;
  return { items: before - after, events };
}
