#!/usr/bin/env node
import { collect } from './collector.ts';
import { syncSources, toSourceRow } from './sources.ts';
import { readFileSync } from 'node:fs';
import { fetchSource } from './collector.ts';
import { cluster, computeHeat } from './cluster.ts';
import { scorePending, board, recordRun } from './pipeline.ts';
import { translatePending } from './translate.ts';
import { prescreenQueue } from './prescreen.ts';
import { buildDigest } from './digest.ts';
import { exportStatic, prune } from './export.ts';
import { serve } from './server.ts';
import { closeDb, log, nowIso, q } from './db.ts';
import { hasLlm } from './config.ts';
import { stats } from './llm.ts';
import type { Radar } from './types.ts';

const [, , cmd, ...args] = process.argv;

function flag(name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'serve': {
      serve();
      return;
    }

    case 'collect': {
      const started = nowIso();
      const n = syncSources();
      log(`信源配置已同步：${n} 个`);
      const r = await collect(has('force'), flag('only'));
      recordRun('collect', started, r);
      if (r.errors.length) {
        log('失败清单：');
        for (const e of r.errors) log(`  - ${e.id}: ${e.error}`);
      }
      return;
    }

    case 'prescreen': {
      const radar = (flag('radar') ?? 'both') as Radar | 'both';
      const days = Number(flag('days') ?? 2);
      const limit = Number(flag('limit') ?? 400);
      if (radar === 'topic' || radar === 'both') await prescreenQueue('topic', { days, limit });
      if (radar === 'game' || radar === 'both') await prescreenQueue('game', { days, limit });
      return;
    }

    case 'score': {
      const started = nowIso();
      const radar = (flag('radar') ?? 'both') as Radar | 'both';
      const limit = Number(flag('limit') ?? 200);
      const days = Number(flag('days') ?? 3);
      const out: Record<string, unknown> = {};
      const ignorePrescreen = has('all');
      if (radar === 'topic' || radar === 'both')
        out.topic = await scorePending({ radar: 'topic', limit, days, ignorePrescreen });
      if (radar === 'game' || radar === 'both')
        out.game = await scorePending({ radar: 'game', limit, days, ignorePrescreen });
      recordRun('score', started, { ...out, llm: stats });
      return;
    }

    case 'cluster': {
      const started = nowIso();
      const r = await cluster((m) => {
        if (Math.random() < 0.1) log(m);
      });
      recordRun('cluster', started, r);
      return;
    }

    case 'translate': {
      const t = await translatePending({ limit: Number(flag('limit') ?? 600) });
      console.log(`翻译完成：${t.translated} 条，${t.batches} 批，失败 ${t.failed} 批`);
      return;
    }

    case 'digest': {
      await buildDigest(flag('date'));
      return;
    }

    case 'run': {
      const started = nowIso();
      const limit = Number(flag('limit') ?? 200);
      log('1/6 同步信源');
      syncSources();
      log('2/6 抓取');
      const c = await collect(has('force'));
      log('3/6 聚簇');
      const cl = await cluster();
      log('4/6 预筛（标题粗排，便宜）');
      const pt = await prescreenQueue('topic', { days: 2 });
      const pg = await prescreenQueue('game', { days: 2 });
      log('5/7 翻译英文标题');
      const tr = await translatePending({ limit: 300 });
      log('6/7 细评（五轴打分，只打过线的）');
      const t = await scorePending({ radar: 'topic', limit });
      const g = await scorePending({ radar: 'game', limit });
      log('7/7 日报');
      const d = await buildDigest();
      recordRun('run', started, { collect: c, cluster: cl, translate: tr, prescreen: { topic: pt, game: pg }, topic: t, game: g, digest: { topicCount: d.topicCount, gameCount: d.gameCount }, llm: stats });
      log(`完成。选题 ${d.topicCount} 条，作品 ${d.gameCount} 条。`);
      return;
    }

    case 'export': {
      const c = exportStatic();
      log(`静态数据已导出到 public/data：选题 ${c.topic} 条、作品 ${c.game} 条、热点 ${c.hot} 条、日报 ${c.digests} 份`);
      return;
    }

    case 'prune': {
      const r = prune(Number(flag('days') ?? 45));
      log(`清理完成：删除 ${r.items} 条过期条目，剩余事件 ${r.events} 个`);
      return;
    }

    case 'status': {
      const counts = q<{ k: string; n: number }>(
        `SELECT 'items' AS k, COUNT(*) AS n FROM items
         UNION ALL SELECT 'events', COUNT(*) FROM events
         UNION ALL SELECT 'sources', COUNT(*) FROM sources
         UNION ALL SELECT 'scored_topic', COUNT(*) FROM scores WHERE radar='topic'
         UNION ALL SELECT 'scored_game', COUNT(*) FROM scores WHERE radar='game'
         UNION ALL SELECT 'digests', COUNT(*) FROM digests`
      );
      console.log('\n数据概览');
      for (const c of counts) console.log(`  ${c.k.padEnd(14)} ${c.n}`);
      console.log(`\n  LLM  ${hasLlm() ? '已配置' : '未配置（打分/日报导读不可用）'}`);
      const bySource = q<{ name: string; n: number; fail_streak: number; last_ok_at: string | null }>(
        `SELECT s.name, s.fail_streak, s.last_ok_at, COUNT(i.id) AS n
         FROM sources s LEFT JOIN items i ON i.source_id = s.id
         GROUP BY s.id ORDER BY n DESC`
      );
      console.log('\n信源产出');
      for (const s of bySource) {
        const flagTxt = s.fail_streak > 0 ? ` ⚠ 连败 ${s.fail_streak}` : '';
        console.log(`  ${s.name.padEnd(18)} ${String(s.n).padStart(5)} 条${flagTxt}`);
      }
      const passing: Record<string, number> = {};
      for (const r of ['topic', 'game'] as Radar[]) passing[r] = board(r, { days: 3, limit: 200 }).length;
      console.log(`\n过门槛：选题 ${passing.topic} 条，作品 ${passing.game} 条`);
      console.log('');
      return;
    }

    case 'probe': {
      const file = flag('file');
      if (!file) {
        console.log('用法: node src/cli.ts probe --file=app/sources.d/cn-media.json [--only=id]');
        return;
      }
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const list = (Array.isArray(raw) ? raw : raw.sources) as Array<import('./types.ts').Source>;
      const only = flag('only');
      const targets = only ? list.filter((s) => s.id === only) : list;
      console.log(`\n探测 ${targets.length} 个信源（不入库）\n`);
      for (const src of targets) {
        const row = toSourceRow({ ...src, tier: src.tier ?? 1, enabled: src.enabled ?? true, intervalMin: src.intervalMin ?? 60 });
        const t0 = Date.now();
        const r = await fetchSource(row, true);
        const ms = Date.now() - t0;
        if (r.error) {
          console.log(`✗ ${String(src.id).padEnd(20)} ${(r.error || '').slice(0, 80)}  (${ms}ms)`);
          continue;
        }
        const withDate = r.items.filter((i) => i.publishedAt).length;
        const withSum = r.items.filter((i) => i.summary).length;
        const withHeat = r.items.filter((i) => i.heat).length;
        console.log(
          `✓ ${String(src.id).padEnd(20)} ${String(r.items.length).padStart(4)} 条  时间 ${withDate}  摘要 ${withSum}  热度 ${withHeat}  (${ms}ms)`
        );
        for (const it of r.items.slice(0, 2)) {
          console.log(`    · ${it.title.slice(0, 60)}`);
          console.log(`      ${it.url}`);
          if (it.publishedAt) console.log(`      ${it.publishedAt}  ${(it.summary ?? '').slice(0, 50)}`);
        }
      }
      console.log('');
      return;
    }

    case 'hot': {
      const hot = computeHeat().slice(0, Number(flag('limit') ?? 15));
      console.log('\n当前热点（独立来源数加权，48h 半衰）\n');
      for (const h of hot) {
        console.log(`  ${String(h.heat).padStart(6)}  ${String(h.sources).padStart(2)} 源  ${h.title.slice(0, 60)}`);
        console.log(`          ${h.source_names}`);
      }
      console.log('');
      return;
    }

    default: {
      console.log(`
游戏资讯雷达  ——  选题雷达 + 作品雷达

  node src/cli.ts serve              启动看板 http://127.0.0.1:7317
  node src/cli.ts collect [--force]  只抓取（--only=<源id> 抓单个）
  node src/cli.ts cluster            聚簇成事件
  node src/cli.ts prescreen [--radar=topic|game] [--days=2]   标题粗排，决定谁进细评
  node src/cli.ts score [--radar=topic|game] [--limit=60] [--days=3] [--all]
  node src/cli.ts digest [--date=YYYY-MM-DD]
  node src/cli.ts run                抓取→聚簇→预筛→细评→日报 一条龙
  node src/cli.ts export             导出静态 JSON（给 GitHub Pages / 静态托管用）
  node src/cli.ts prune --days=45    清理过期条目，控制仓库体积
  node src/cli.ts status             数据概览 + 信源健康度
  node src/cli.ts hot                当前热点

首次使用：cp .env.example .env，填 LLM_API_KEY，然后 npm run run
`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
