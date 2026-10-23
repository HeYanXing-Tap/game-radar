import { llmConfig, type LlmConfig } from './config.ts';
import { postJson } from './fetch.ts';

export interface LlmStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  failures: number;
}

export const stats: LlmStats = { calls: 0, promptTokens: 0, completionTokens: 0, failures: 0 };

let running = 0;
const waiting: Array<() => void> = [];

async function acquire(cfg: LlmConfig): Promise<void> {
  if (running < cfg.concurrency) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
}
function release(): void {
  running--;
  const next = waiting.shift();
  if (next) next();
}

export class BudgetExceeded extends Error {}

export interface ChatOpts {
  system?: string;
  /** 覆盖模型 */
  model?: string;
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
}

/** OpenAI 兼容 chat completions。DeepSeek / 千问 / 智谱 都能直接用。 */
export async function chat(user: string, opts: ChatOpts = {}): Promise<string> {
  const cfg = llmConfig();
  if (!cfg.apiKey) throw new Error('未配置 LLM_API_KEY，见 app/.env');
  if (stats.calls >= cfg.maxCallsPerRun) {
    throw new BudgetExceeded(`本次运行已达调用上限 ${cfg.maxCallsPerRun} 次`);
  }

  await acquire(cfg);
  try {
    const messages = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: user });

    const body: Record<string, unknown> = {
      model: opts.model || cfg.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      stream: false,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    stats.calls++;
    const res = await postJson(
      `${cfg.baseUrl}/chat/completions`,
      body,
      { Authorization: `Bearer ${cfg.apiKey}` },
      cfg.timeoutMs
    );

    if (!res.ok) {
      stats.failures++;
      const e = res.json as { error?: { message?: string } } | null;
      throw new Error(`LLM ${res.status}: ${e?.error?.message ?? JSON.stringify(res.json)?.slice(0, 300)}`);
    }

    const j = res.json as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    stats.promptTokens += j.usage?.prompt_tokens ?? 0;
    stats.completionTokens += j.usage?.completion_tokens ?? 0;
    return j.choices?.[0]?.message?.content ?? '';
  } finally {
    release();
  }
}

/** 从模型输出里抠出第一个完整 JSON 对象（模型偶尔会包 ```json 或加前言）。 */
export function extractJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function chatJson<T>(user: string, opts: ChatOpts = {}): Promise<T | null> {
  const text = await chat(user, { ...opts, json: true });
  return extractJson<T>(text);
}
