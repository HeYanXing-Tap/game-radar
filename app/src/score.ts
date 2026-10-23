import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT, THRESHOLDS, llmConfig } from './config.ts';
import { chatJson } from './llm.ts';
import type { AxisScore, ItemScore, Radar } from './types.ts';

const PROMPT_DIR = join(APP_ROOT, 'src', 'prompts');
const promptCache = new Map<string, string>();

function prompt(name: string): string {
  const hit = promptCache.get(name);
  if (hit) return hit;
  const text = readFileSync(join(PROMPT_DIR, name), 'utf8');
  promptCache.set(name, text);
  return text;
}

/** 与 prompts/radar-*.md 里写的权重保持一致。改提示词时请同步改这里。 */
const WEIGHTS: Record<Radar, Record<string, number>> = {
  topic: { quirk: 0.25, reach: 0.3, window: 0.2, craft: 0.15, fit: 0.1 },
  game: { quality: 0.3, category: 0.2, business: 0.25, momentum: 0.15, landing: 0.1 },
};

const AXIS_KEYS: Record<Radar, string[]> = {
  topic: ['quirk', 'reach', 'window', 'craft', 'fit'],
  game: ['quality', 'category', 'business', 'momentum', 'landing'],
};

export interface ScoreInput {
  title: string;
  summary?: string | null;
  url: string;
  sourceName: string;
  tier: number;
  role: string;
  publishedAt?: string | null;
  heat?: Record<string, number> | null;
  /** 补充的正文（摘要太短时抓的） */
  body?: string | null;
}

function itemBlock(input: ScoreInput): string {
  const parts: string[] = [];
  parts.push(`来源：${input.sourceName}（${input.role}，${input.tier} 级信源）`);
  if (input.publishedAt) {
    const hours = Math.max(0, Math.round((Date.now() - new Date(input.publishedAt).getTime()) / 3_600_000));
    parts.push(`发布时间：${input.publishedAt}（约 ${hours} 小时前）`);
  }
  if (input.heat && Object.keys(input.heat).length) {
    parts.push(`热度字段：${JSON.stringify(input.heat)}`);
  }
  parts.push(`标题：${input.title}`);
  const text = (input.body || input.summary || '').replace(/\s+/g, ' ').trim();
  if (text) parts.push(`正文/摘要：${text.slice(0, 1500)}`);
  parts.push(`链接：${input.url}`);
  return parts.join('\n');
}

interface RawParsed {
  total?: number;
  axes?: AxisScore[];
  verdict?: string;
  angle?: string;
  against?: string;
  games?: string[];
}

/** 不信任模型给的总分：按权重自己算，防止模型算错或抬分。 */
function recompute(radar: Radar, axes: AxisScore[]): number {
  const w = WEIGHTS[radar];
  let sum = 0;
  let wsum = 0;
  for (const k of AXIS_KEYS[radar]) {
    const a = axes.find((x) => x.key === k);
    const s = a ? Math.min(5, Math.max(1, Number(a.score) || 1)) : 1;
    sum += s * w[k];
    wsum += w[k];
  }
  return Math.round((sum / wsum) * 20);
}

export async function scoreItem(input: ScoreInput, radar: Radar): Promise<ItemScore | null> {
  const cfg = llmConfig();
  const system = prompt(radar === 'topic' ? 'radar-topic.md' : 'radar-game.md');
  const user = `请按你的评分标准给下面这条内容打分。\n\n---\n${itemBlock(input)}\n---`;

  const model = cfg.model;
  const first = await chatJson<RawParsed>(user, { system, model, temperature: 0.2, maxTokens: 1600 });
  if (!first || !Array.isArray(first.axes)) return null;

  let axes: AxisScore[] = first.axes
    .filter((a) => a && typeof a.key === 'string')
    .map((a) => ({ key: a.key, score: Number(a.score) || 1, why: String(a.why ?? '').slice(0, 120) }));

  let total = recompute(radar, axes);

  // AIHOT 的双打分精神：分数贴着门槛时再打一次，取均值降低随机性。
  // 这里不做无脑两遍，只在「可能改变结论」的区间复检，省 token。
  const threshold = THRESHOLDS[radar][(input.tier >= 1 && input.tier <= 3 ? input.tier : 1) as 1 | 2 | 3];
  if (Math.abs(total - threshold) <= 8) {
    const second = await chatJson<RawParsed>(user, { system, model, temperature: 0.6, maxTokens: 1600 });
    if (second && Array.isArray(second.axes)) {
      const axes2: AxisScore[] = second.axes
        .filter((a) => a && typeof a.key === 'string')
        .map((a) => ({ key: a.key, score: Number(a.score) || 1, why: String(a.why ?? '').slice(0, 120) }));
      const total2 = recompute(radar, axes2);
      // 两次分歧大就取低值（保守，防止单次抬分把噪音送进精选）
      total = Math.abs(total - total2) > 12 ? Math.min(total, total2) : Math.round((total + total2) / 2);
      if (total2 < total) axes = axes2;
    }
  }

  return {
    radar,
    total,
    axes,
    verdict: String(first.verdict ?? '').slice(0, 200),
    angle: first.angle ? String(first.angle).slice(0, 300) : undefined,
    against: first.against ? String(first.against).slice(0, 300) : undefined,
    games: Array.isArray(first.games) ? first.games.filter(Boolean).map(String).slice(0, 6) : [],
    model,
    scoredAt: new Date().toISOString(),
  };
}

export function thresholdFor(radar: Radar, tier: number): number {
  const t = (tier === 2 || tier === 3 ? tier : 1) as 1 | 2 | 3;
  return THRESHOLDS[radar][t];
}

/** 预筛：在花 token 之前把明显不值得的内容挡掉。 */
const NOISE = /(招聘|诚聘|免责声明|版权声明|广告|商务合作|投稿邮箱|关于我们|用户协议|隐私政策|下载客户端|登录注册)/;

export function prefilter(title: string, summary?: string | null): { pass: boolean; reason?: string } {
  if (!title || title.trim().length < 6) return { pass: false, reason: '标题过短' };
  if (NOISE.test(title)) return { pass: false, reason: '页面噪音' };
  if (/^(首页|新闻|资讯|游戏|专题)$/.test(title.trim())) return { pass: false, reason: '导航标题' };
  const full = `${title} ${summary ?? ''}`;
  if (full.length < 12) return { pass: false, reason: '内容过少' };
  return { pass: true };
}
