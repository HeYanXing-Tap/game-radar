import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { DB_PATH, DATA_DIR } from './config.ts';

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// --- 轻量迁移：老库补列，新库建表时就带上 ---
function ensureColumn(table: string, column: string, def: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  } catch {
    /* 表还不存在时交给建表语句 */
  }
}


db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;


CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  region        TEXT NOT NULL,
  type          TEXT NOT NULL,
  url           TEXT NOT NULL,
  tier          INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  interval_min  INTEGER NOT NULL DEFAULT 60,
  headers_json  TEXT,
  adapter_json  TEXT,
  note          TEXT,
  last_fetch_at TEXT,
  last_ok_at    TEXT,
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  etag          TEXT,
  last_modified TEXT,
  yield_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL REFERENCES sources(id),
  url          TEXT NOT NULL,
  url_key      TEXT NOT NULL,
  title        TEXT NOT NULL,
  title_key    TEXT NOT NULL,
  summary      TEXT,
  image        TEXT,
  author       TEXT,
  published_at TEXT,
  fetched_at   TEXT NOT NULL,
  lang         TEXT,
  heat_json    TEXT,
  topic_only   INTEGER NOT NULL DEFAULT 0,
  event_id     INTEGER,
  is_dup       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS items_url_key ON items(url_key);
CREATE INDEX IF NOT EXISTS items_published ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS items_title_key ON items(title_key);
CREATE INDEX IF NOT EXISTS items_event ON items(event_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  summary    TEXT,
  first_at   TEXT,
  last_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_last ON events(last_at DESC);

CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  radar      TEXT NOT NULL,
  total      REAL NOT NULL,
  axes_json  TEXT,
  verdict    TEXT,
  angle      TEXT,
  games_json TEXT,
  against    TEXT,
  model      TEXT,
  scored_at  TEXT NOT NULL,
  UNIQUE(item_id, radar)
);
CREATE INDEX IF NOT EXISTS scores_radar ON scores(radar, total DESC);

CREATE TABLE IF NOT EXISTS prescreen (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  radar      TEXT NOT NULL,
  total      REAL NOT NULL,
  why        TEXT,
  model      TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, radar)
);
CREATE INDEX IF NOT EXISTS prescreen_radar ON prescreen(radar, total DESC);

CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  name_cn     TEXT,
  stage       TEXT,
  steam_appid TEXT,
  first_at    TEXT,
  last_at     TEXT,
  mentions    INTEGER NOT NULL DEFAULT 0,
  meta_json   TEXT
);

CREATE TABLE IF NOT EXISTS digests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'daily',
  markdown   TEXT NOT NULL,
  data_json  TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(date, kind)
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats_json  TEXT
);
`);

// 展示用的中文译名，抓取/聚类/打分仍用原文
ensureColumn('items', 'title_zh', 'TEXT');
ensureColumn('items', 'summary_zh', 'TEXT');
ensureColumn('events', 'title_zh', 'TEXT');
// 内容相关性：game/acg/tech/society/off，off 的不进热点榜
ensureColumn('prescreen', 'related', 'TEXT');
ensureColumn('prescreen', 'game_name', 'TEXT');
ensureColumn('scores', 'facts', 'TEXT');

/** ---------- 小工具 ---------- */

export function nowIso(): string {
  return new Date().toISOString();
}

/** URL 归一化：去 utm/去锚点/去末尾斜杠，用于判重。 */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|spm|from|share|ref|fbclid|gclid|source)/i.test(k)) u.searchParams.delete(k);
    }
    let s = `${u.host.replace(/^www\./, '')}${u.pathname}`.replace(/\/+$/, '');
    const q = u.searchParams.toString();
    return (s + (q ? `?${q}` : '')).toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * 标题指纹：中文按字 bigram，英文按词，都输出「排序后用空格连接的 token 串」。
 * 存库用于精确判重；比较相似度时用 similarity() 按 token 集合算，不要拿这个串再做 n-gram。
 */
export function titleKey(title: string): string {
  return titleTokens(title).sort().join(' ');
}

export function titleTokens(title: string): string[] {
  const t = title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[【】\[\]（）()《》<>「」""''·—\-\u2014…,，。.!！?？:：;；|/\\_+*#@&%$^~`]/g, ' ');
  const cjk = t.match(/[\u4e00-\u9fa5]/g);
  // 中文占多数就按字 bigram 切，否则按词切
  if (cjk && cjk.length >= 4) {
    const grams: string[] = [];
    const cjkOnly = t.replace(/[^\u4e00-\u9fa5]+/g, '');
    for (let i = 0; i < cjkOnly.length - 1; i++) grams.push(cjkOnly.slice(i, i + 2));
    const words = t.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return [...grams, ...words];
  }
  return [...new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
}

/** 两条标题的相似度：先各自切 token，再算集合 Jaccard。中英文都走这条路。 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = new Set(titleTokens(a));
  const sb = new Set(titleTokens(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function jaccard(a: string, b: string, n = 2): number {
  if (!a || !b) return 0;
  const sa = new Set<string>();
  const sb = new Set<string>();
  for (let i = 0; i < a.length - n + 1; i++) sa.add(a.slice(i, i + n));
  for (let i = 0; i < b.length - n + 1; i++) sb.add(b.slice(i, i + n));
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function q<T>(sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function one<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function exec(sql: string, ...params: (string | number | null)[]): void {
  db.prepare(sql).run(...params);
}

/**
 * 收尾：把 WAL 合并回主库再关连接。GitHub 上要靠这个保证提交进仓库的
 * radar.db 是完整的，否则 -wal 里还有没落盘的数据。
 */
export function closeDb(): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    // 已经关了就算了
  }
}

export function log(msg: string): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  process.stdout.write(`[${t}] ${msg}\n`);
}
