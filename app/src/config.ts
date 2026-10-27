import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.RADAR_DATA_DIR || join(APP_ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'radar.db');
export const SOURCES_PATH = process.env.RADAR_SOURCES || join(APP_ROOT, 'sources.json');

/** 极简 .env 读取（不引依赖）。已存在的进程环境变量优先。 */
function loadDotEnv(): void {
  const p = join(APP_ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 聚簇/复核可以单独换一家模型，留空则跟随主模型 */
  reviewModel: string;
  /** 打分用的小模型，可为空 */
  cheapModel: string;
  timeoutMs: number;
  /** 单次运行的调用预算，防跑飞 */
  maxCallsPerRun: number;
  concurrency: number;
}

export function llmConfig(): LlmConfig {
  return {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    reviewModel: process.env.LLM_REVIEW_MODEL || '',
    cheapModel: process.env.LLM_CHEAP_MODEL || '',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 120000),
    maxCallsPerRun: Number(process.env.LLM_MAX_CALLS_PER_RUN || 400),
    concurrency: Number(process.env.LLM_CONCURRENCY || 4),
  };
}

export function hasLlm(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

export const PORT = Number(process.env.PORT || 7317);

/** 入选门槛：一手源放宽。AIHOT 的核心机制之一，这里按雷达各存一套。 */
export const THRESHOLDS = {
  topic: { 1: 72, 2: 66, 3: 60 },
  game: { 1: 72, 2: 68, 3: 64 },
} as const;

/** 抓取礼貌间隔（毫秒），同域名串行。 */
export const FETCH_DELAY_MS = Number(process.env.FETCH_DELAY_MS || 1200);
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);

export const UA =
  process.env.FETCH_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
