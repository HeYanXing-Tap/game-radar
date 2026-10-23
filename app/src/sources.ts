import { readFileSync, existsSync } from 'node:fs';
import { SOURCES_PATH } from './config.ts';
import { exec, one, q } from './db.ts';
import type { Source } from './types.ts';

interface SourceFile {
  version: number;
  updatedAt: string;
  sources: Source[];
}

export function loadSourceFile(): Source[] {
  if (!existsSync(SOURCES_PATH)) return [];
  const raw = JSON.parse(readFileSync(SOURCES_PATH, 'utf8')) as SourceFile | Source[];
  const list = Array.isArray(raw) ? raw : raw.sources;
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of list) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({
      tier: 1,
      enabled: true,
      intervalMin: 60,
      role: 'media',
      region: 'cn',
      ...s,
    });
  }
  return out;
}

/** 把 sources.json 同步进库，配置以文件为准。 */
export function syncSources(): number {
  const list = loadSourceFile();
  for (const s of list) {
    const existing = one<{ id: string }>('SELECT id FROM sources WHERE id = ?', s.id);
    if (existing) {
      exec(
        `UPDATE sources SET name=?, role=?, region=?, type=?, url=?, tier=?, enabled=?,
         interval_min=?, headers_json=?, adapter_json=?, note=? WHERE id=?`,
        s.name,
        s.role,
        s.region,
        s.type,
        s.url,
        s.tier,
        s.enabled ? 1 : 0,
        s.intervalMin,
        JSON.stringify(s.headers ?? {}),
        JSON.stringify(s.adapter ?? {}),
        s.note ?? null,
        s.id
      );
    } else {
      exec(
        `INSERT INTO sources (id,name,role,region,type,url,tier,enabled,interval_min,headers_json,adapter_json,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.id,
        s.name,
        s.role,
        s.region,
        s.type,
        s.url,
        s.tier,
        s.enabled ? 1 : 0,
        s.intervalMin,
        JSON.stringify(s.headers ?? {}),
        JSON.stringify(s.adapter ?? {}),
        s.note ?? null
      );
    }
  }
  // 配置文件里删掉的源要被停用，否则会一直按老配置抓
  const ids = list.map((s) => s.id);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const stale = q<{ id: string; name: string }>(
      `SELECT id, name FROM sources WHERE enabled = 1 AND id NOT IN (${placeholders})`,
      ...ids
    );
    for (const s of stale) {
      exec('UPDATE sources SET enabled = 0 WHERE id = ?', s.id);
    }
    if (stale.length) {
      console.log(`已停用 ${stale.length} 个不再出现在配置里的源：${stale.map((x) => x.name).join('、')}`);
    }
  }
  return list.length;
}

export interface SourceRow {
  id: string;
  name: string;
  role: string;
  region: string;
  type: string;
  url: string;
  tier: number;
  enabled: number;
  interval_min: number;
  headers_json: string | null;
  adapter_json: string | null;
  note: string | null;
  last_fetch_at: string | null;
  last_ok_at: string | null;
  fail_streak: number;
  etag: string | null;
  last_modified: string | null;
  yield_count: number;
}

export function allSources(): SourceRow[] {
  return q<SourceRow>('SELECT * FROM sources ORDER BY tier DESC, id');
}

/** 到点该抓的源。fail_streak 越高退避越久，最多退到 8 倍间隔。 */
export function dueSources(force = false): SourceRow[] {
  if (force) return allSources().filter((s) => s.enabled);
  return allSources().filter((s) => {
    if (!s.enabled) return false;
    if (!s.last_fetch_at) return true;
    const backoff = Math.min(8, 1 + s.fail_streak);
    const due = new Date(s.last_fetch_at).getTime() + s.interval_min * 60_000 * backoff;
    return Date.now() >= due;
  });
}

/** 把 sources.json 里的一条定义转成库行形状，供 probe 在不入库的情况下复用抓取逻辑。 */
export function toSourceRow(s: Source): SourceRow {
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    region: s.region,
    type: s.type,
    url: s.url,
    tier: s.tier,
    enabled: s.enabled ? 1 : 0,
    interval_min: s.intervalMin,
    headers_json: JSON.stringify(s.headers ?? {}),
    adapter_json: JSON.stringify(s.adapter ?? {}),
    note: s.note ?? null,
    last_fetch_at: null,
    last_ok_at: null,
    fail_streak: 0,
    etag: null,
    last_modified: null,
    yield_count: 0,
  };
}
