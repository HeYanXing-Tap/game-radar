#!/usr/bin/env node
/**
 * 把 sources.d/*.json 合并成 app/sources.json。
 * 同一 id 以 sources.d 里的为准；sources.manual.json 优先级最高（放自己临时加的源）。
 *
 * 用法：node scripts/merge-sources.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(APP, 'sources.d');
const OUT = join(APP, 'sources.json');

const ROLE_ORDER = ['internal', 'platform', 'signal', 'media', 'community', 'overseas'];

function readList(p) {
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(raw) ? raw : raw.sources ?? [];
}

const byId = new Map();

if (existsSync(DIR)) {
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
    for (const s of readList(join(DIR, f))) {
      if (!s?.id) continue;
      byId.set(s.id, normalize(s, f));
    }
  }
}

const manualPath = join(APP, 'sources.manual.json');
if (existsSync(manualPath)) {
  for (const s of readList(manualPath)) if (s?.id) byId.set(s.id, normalize(s, 'manual'));
}

function normalize(s, origin) {
  return {
    id: s.id,
    name: s.name ?? s.id,
    role: s.role ?? 'media',
    region: s.region ?? 'cn',
    type: s.type ?? 'rss',
    url: s.url,
    tier: s.tier ?? 1,
    enabled: s.enabled !== false,
    intervalMin: s.intervalMin ?? 60,
    headers: s.headers ?? {},
    adapter: s.adapter ?? {},
    note: s.note ?? (origin === 'manual' ? '手动添加' : ''),
  };
}

const sources = [...byId.values()].sort((a, b) => {
  const r = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
  if (r !== 0) return r;
  const t = (b.tier ?? 1) - (a.tier ?? 1);
  return t !== 0 ? t : a.id.localeCompare(b.id);
});

writeFileSync(
  OUT,
  JSON.stringify(
    {
      version: 2,
      updatedAt: new Date().toISOString(),
      note: '信源配置。改这里不用改代码。tier 3=一手官方，2=准一手，1=二手聚合。格式说明见 docs/sources.md',
      sources,
    },
    null,
    2
  ) + '\n'
);

console.log(`合并完成：${sources.length} 个信源 → app/sources.json`);
const byRole = {};
for (const s of sources) byRole[s.role] = (byRole[s.role] ?? 0) + 1;
for (const r of ROLE_ORDER) if (byRole[r]) console.log(`  ${r.padEnd(10)} ${byRole[r]}`);
