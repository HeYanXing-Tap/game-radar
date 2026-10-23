import { FETCH_DELAY_MS, FETCH_TIMEOUT_MS, UA } from './config.ts';

/** 同域名串行 + 固定间隔，避免把人家站点打挂，也避免被 CDN 拉黑。 */
const hostQueue = new Map<string, Promise<unknown>>();
const lastHit = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function polite(host: string): Promise<void> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const next = prev.then(async () => {
    const gap = Date.now() - (lastHit.get(host) ?? 0);
    if (gap < FETCH_DELAY_MS) await sleep(FETCH_DELAY_MS - gap);
    lastHit.set(host, Date.now());
  });
  hostQueue.set(host, next);
  await next;
}

export interface FetchResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Headers;
  notModified: boolean;
  error?: string;
}

export interface FetchOpts {
  headers?: Record<string, string>;
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  retries?: number;
}

export async function politeFetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  let host = 'unknown';
  try {
    host = new URL(url).host;
  } catch {
    return {
      status: 0,
      ok: false,
      body: '',
      headers: new Headers(),
      notModified: false,
      error: `invalid url: ${url}`,
    };
  }

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(opts.headers ?? {}),
  };
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;

  const retries = opts.retries ?? 1;
  let lastErr = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    await polite(host);
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
      });
      if (res.status === 304) {
        return { status: 304, ok: true, body: '', headers: res.headers, notModified: true };
      }
      if (res.status >= 500 && attempt < retries) {
        lastErr = `HTTP ${res.status}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const body = await res.text();
      return { status: res.status, ok: res.ok, body, headers: res.headers, notModified: false };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt < retries) await sleep(1200 * (attempt + 1));
    }
  }
  return {
    status: 0,
    ok: false,
    body: '',
    headers: new Headers(),
    notModified: false,
    error: lastErr,
  };
}

/** LLM 调用用这个，不走站点礼貌队列。 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 120000
): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 2000) };
    }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e instanceof Error ? e.message : String(e) };
  }
}
