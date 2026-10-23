import { politeFetch } from './fetch.ts';
import { extractHtmlList, mapJsonItems, parseFeed, parseDate, stripHtml } from './parsers.ts';
import { digPath, extractRows, type JsonSourceAdapter, type RowsAdapter } from './adapters.ts';
import { exec, log, nowIso, one, titleKey, urlKey } from './db.ts';
import { dueSources, type SourceRow } from './sources.ts';
import type { RawItem } from './types.ts';

/** "7903979" / "3.1万" / 12.5 → 数字；拿不到就 null */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/,/g, '');
  const yi = /^([\d.]+)\s*亿/.exec(t);
  if (yi) return Math.round(Number(yi[1]) * 1e8);
  const wan = /^([\d.]+)\s*万/.exec(t);
  if (wan) return Math.round(Number(wan[1]) * 1e4);
  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

/**
 * Steam 榜单只有名字和价格，没有简介、没有发售日、没有品类——
 * 单靠它没法判断值不值得引进。所以对前 N 条补一次 appdetails。
 */
async function enrichSteam(items: RawItem[]): Promise<void> {
  for (const it of items) {
    const m = /\/app\/(\d+)/.exec(it.url);
    if (!m) continue;
    const appid = m[1];
    const r = await politeFetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=cn&l=schinese`);
    if (!r.ok) continue;
    try {
      const parsed = JSON.parse(r.body) as Record<string, { success?: boolean; data?: Record<string, unknown> }>;
      const d = parsed[appid]?.data;
      if (!d) continue;
      const desc = String(d.short_description ?? '');
      const genres = Array.isArray(d.genres)
        ? (d.genres as Array<{ description?: string }>)
            .map((g) => g.description)
            .filter(Boolean)
            .join(' / ')
        : '';
      const release = (d.release_date as { date?: string } | undefined)?.date;
      it.summary = [genres, desc].filter(Boolean).join('｜').slice(0, 800) || undefined;
      it.image = (d.header_image as string) ?? it.image;
      if (release && !/coming soon|即将推出/i.test(release)) {
        const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(release);
        const when = cn
          ? new Date(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3])).toISOString()
          : parseDate(release);
        // 未发售作品的发售日不能当发布时间：否则 2027 年才上的游戏会排到「最新」第一
        if (when && new Date(when).getTime() <= Date.now()) it.publishedAt = when;
      }
      const recs = (d.recommendations as { total?: number } | undefined)?.total;
      if (typeof recs === 'number') it.heat = { ...(it.heat ?? {}), reviews: recs };
    } catch {
      // 补全失败不影响主流程
    }
  }
}

export async function fetchSource(
  src: SourceRow,
  force = false
): Promise<{ items: RawItem[]; error?: string; notModified?: boolean }> {
  const baseHeaders = src.headers_json ? (JSON.parse(src.headers_json) as Record<string, string>) : {};
  const adapter = src.adapter_json ? (JSON.parse(src.adapter_json) as Record<string, unknown>) : {};
  const headers: Record<string, string> = { ...baseHeaders, ...((adapter.headers as Record<string, string>) ?? {}) };
  if (adapter.referer) headers.Referer = String(adapter.referer);

  const res = await politeFetch(src.url, {
    headers,
    // --force 时忽略缓存校验，否则调试时永远拿到 304
    etag: force ? null : src.etag,
    lastModified: force ? null : src.last_modified,
  });
  if (res.notModified) return { items: [], notModified: true };
  if (!res.ok) return { items: [], error: res.error ?? `HTTP ${res.status}` };

  const items: RawItem[] = [];
  const lang = src.region === 'cn' ? 'zh' : 'en';

  if (src.type === 'rss') {
    for (const it of parseFeed(res.body, src.url)) items.push({ sourceId: src.id, ...it, lang });
  } else if (src.type === 'json') {
    const a = adapter as unknown as JsonSourceAdapter;
    let root: unknown;
    try {
      root = JSON.parse(res.body);
    } catch {
      return { items: [], error: 'JSON 解析失败' };
    }

    const slices: Array<{ label: string; rows: unknown[] }> = [];
    if (a.sections?.length) {
      for (const sec of a.sections) {
        const rows = digPath(root, sec);
        if (Array.isArray(rows)) slices.push({ label: sec, rows });
      }
    } else {
      const rows = digPath(root, a.path);
      if (!Array.isArray(rows)) return { items: [], error: `JSON 路径无数组: ${a.path}` };
      slices.push({ label: '', rows });
    }

    for (const slice of slices) {
      const mapped = mapJsonItems(slice.rows, a.map, src.url, a.urlTemplate);
      mapped.forEach((it, idx) => {
        const native = (it.native ?? {}) as Record<string, unknown>;
        const heat: Record<string, number> = { rank: idx + 1 };
        if (slice.label) heat[slice.label] = idx + 1;
        if (a.heat) {
          for (const [k, path] of Object.entries(a.heat)) {
            const n = toNumber(digPath(native, path));
            if (n !== null) heat[k] = n;
          }
        }
        if (a.imagePrefix && it.image && !/^https?:\/\//.test(it.image)) {
          it.image = a.imagePrefix.replace(/\/$/, '') + '/' + it.image.replace(/^\//, '');
        }
        items.push({ sourceId: src.id, ...it, lang, heat });
      });
    }

    if (a.enrich === 'steamApp' && items.length) await enrichSteam(items.slice(0, a.enrichLimit ?? 12));
  } else {
    const a = adapter as unknown as RowsAdapter & {
      rowPattern?: string;
      hrefPattern?: string;
      minTitle?: number;
      limit?: number;
    };
    if (a.rowPattern) {
      for (const r of extractRows(res.body, a as RowsAdapter, src.url)) {
        const heat: Record<string, number> = {};
        const rowAdapter = a as RowsAdapter;
        if (rowAdapter.heat) {
          for (const [k, spec] of Object.entries(rowAdapter.heat)) {
            const pattern = typeof spec === 'string' ? spec : spec.pattern;
            const mult = typeof spec === 'string' ? 1 : (spec.mult ?? 1);
            const m = new RegExp(pattern, 'i').exec(r.raw ?? '');
            const n = toNumber(m ? m[1] ?? m[0] : undefined);
            if (n !== null) heat[k] = Math.round(n * mult);
          }
        }
        items.push({
          sourceId: src.id,
          url: r.url,
          title: r.title,
          summary: r.summary,
          image: r.image,
          author: r.author,
          lang,
          publishedAt: parseDate(r.time ?? null),
          heat: Object.keys(heat).length ? heat : null,
        });
      }
    } else {
      for (const it of extractHtmlList(res.body, src.url, {
        hrefPattern: a.hrefPattern,
        minTitle: a.minTitle,
        limit: a.limit,
      })) {
        items.push({
          sourceId: src.id,
          url: it.url,
          title: it.title,
          lang,
          // 通用抽链拿不到真实发布时间，显式标 null——绝不能拿抓取时间冒充
          publishedAt: null,
        });
      }
    }
  }

  if (res.headers.get('etag')) exec('UPDATE sources SET etag=? WHERE id=?', res.headers.get('etag'), src.id);
  if (res.headers.get('last-modified')) {
    exec('UPDATE sources SET last_modified=? WHERE id=?', res.headers.get('last-modified'), src.id);
  }
  return { items };
}

/** 入库：URL 判重 + 跨源标题指纹判重（同一件事不重复进队列）。 */
export function saveItems(items: RawItem[]): { inserted: number; dupUrl: number; dupTitle: number } {
  let inserted = 0;
  let dupUrl = 0;
  let dupTitle = 0;
  const now = nowIso();

  for (const it of items) {
    if (!it.url || !it.title) continue;
    const uk = urlKey(it.url);
    if (one('SELECT id FROM items WHERE url_key = ?', uk)) {
      dupUrl++;
      continue;
    }
    const tk = titleKey(it.title);
    const near = one<{ id: number }>('SELECT id FROM items WHERE title_key = ? LIMIT 1', tk);
    const isDup = near ? 1 : 0;
    if (isDup) dupTitle++;

    exec(
      `INSERT OR IGNORE INTO items
       (source_id,url,url_key,title,title_key,summary,image,author,published_at,fetched_at,lang,heat_json,topic_only,is_dup)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      it.sourceId,
      it.url,
      uk,
      it.title.slice(0, 400),
      tk,
      it.summary ? stripHtml(it.summary).slice(0, 1200) : null,
      it.image ?? null,
      it.author ?? null,
      it.publishedAt ?? null,
      now,
      it.lang ?? 'zh',
      it.heat ? JSON.stringify(it.heat) : null,
      it.topicOnly ? 1 : 0,
      isDup
    );
    inserted++;
  }
  return { inserted, dupUrl, dupTitle };
}

export interface CollectResult {
  sources: number;
  ok: number;
  failed: number;
  inserted: number;
  errors: Array<{ id: string; error: string }>;
}

export async function collect(force = false, only?: string): Promise<CollectResult> {
  let list = dueSources(force);
  if (only) list = list.filter((s) => s.id === only);
  const result: CollectResult = { sources: list.length, ok: 0, failed: 0, inserted: 0, errors: [] };

  for (const src of list) {
    const startedAt = nowIso();
    try {
      const r = await fetchSource(src, force);
      if (r.error) {
        result.failed++;
        result.errors.push({ id: src.id, error: r.error });
        exec('UPDATE sources SET last_fetch_at=?, fail_streak=fail_streak+1 WHERE id=?', startedAt, src.id);
        log(`✗ ${src.name}: ${r.error}`);
        continue;
      }
      if (r.notModified) {
        result.ok++;
        exec('UPDATE sources SET last_fetch_at=?, last_ok_at=?, fail_streak=0 WHERE id=?', startedAt, startedAt, src.id);
        log(`= ${src.name}: 未变更`);
        continue;
      }
      const saved = saveItems(r.items);
      result.ok++;
      result.inserted += saved.inserted;
      exec(
        `UPDATE sources SET last_fetch_at=?, last_ok_at=?, fail_streak=0,
         yield_count=CASE WHEN ? > 0 THEN ? ELSE yield_count END WHERE id=?`,
        startedAt,
        startedAt,
        saved.inserted,
        saved.inserted,
        src.id
      );
      log(`✓ ${src.name}: 抓到 ${r.items.length} 条，新增 ${saved.inserted}，跨源重复 ${saved.dupTitle}`);
    } catch (e) {
      result.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ id: src.id, error: msg });
      exec('UPDATE sources SET last_fetch_at=?, fail_streak=fail_streak+1 WHERE id=?', startedAt, src.id);
      log(`✗ ${src.name}: ${msg}`);
    }
  }
  return result;
}
