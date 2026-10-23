import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { APP_ROOT, PORT } from './config.ts';
import { board, itemDetail } from './pipeline.ts';
import { computeHeat } from './cluster.ts';
import { getDigest, listDigests } from './digest.ts';
import { allSources } from './sources.ts';
import { q } from './db.ts';
import type { Radar } from './types.ts';

const PUBLIC = join(APP_ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function json(res: import('node:http').ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function stats(): Record<string, unknown> {
  const t = (sql: string) => q<{ n: number }>(sql)[0]?.n ?? 0;
  return {
    items: t('SELECT COUNT(*) AS n FROM items'),
    events: t('SELECT COUNT(*) AS n FROM events'),
    sources: t('SELECT COUNT(*) AS n FROM sources WHERE enabled=1'),
    scored_topic: t("SELECT COUNT(*) AS n FROM scores WHERE radar='topic'"),
    scored_game: t("SELECT COUNT(*) AS n FROM scores WHERE radar='game'"),
    latest_item: q<{ ts: string }>(
      'SELECT COALESCE(published_at, fetched_at) AS ts FROM items ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 1'
    )[0]?.ts,
    failing: q<{ name: string; fail_streak: number }>(
      'SELECT name, fail_streak FROM sources WHERE fail_streak > 0 ORDER BY fail_streak DESC'
    ),
  };
}

export function serve(): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (path === '/api/stats') return json(res, 200, stats());

      if (path === '/api/board') {
        const radar = (url.searchParams.get('radar') === 'game' ? 'game' : 'topic') as Radar;
        const days = Number(url.searchParams.get('days') ?? 3);
        const limit = Number(url.searchParams.get('limit') ?? 40);
        const all = url.searchParams.get('all') === '1';
        return json(res, 200, {
          radar,
          days,
          entries: board(radar, { days, limit, onlyPassing: !all }),
        });
      }

      if (path === '/api/hot') return json(res, 200, computeHeat().slice(0, 40));

      if (path === '/api/digests') return json(res, 200, listDigests());

      if (path === '/api/digest') {
        const date = url.searchParams.get('date');
        if (date) {
          const md = getDigest(date);
          return json(res, md ? 200 : 404, { date, markdown: md });
        }
        const latest = listDigests(1)[0];
        if (!latest) return json(res, 404, { error: '还没有日报，先跑 npm run digest' });
        return json(res, 200, { date: latest.date, markdown: getDigest(latest.date) });
      }

      if (path === '/api/sources') return json(res, 200, allSources());

      if (path.startsWith('/api/item/')) {
        const id = Number(path.split('/').pop());
        const d = itemDetail(id);
        return json(res, d ? 200 : 404, d ?? { error: 'not found' });
      }

      // 静态文件
      const rel = path === '/' ? '/index.html' : path;
      if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
      const file = join(PUBLIC, rel);
      try {
        const buf = await readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': rel === '/index.html' ? 'no-cache' : 'max-age=300',
        });
        res.end(buf);
      } catch {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  游戏资讯雷达  →  http://127.0.0.1:${PORT}\n`);
  });
}
