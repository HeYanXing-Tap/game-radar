/** 零依赖解析：RSS/Atom、HTML 列表、JSON。刻意用正则而不是 DOM，够用且没有构建依赖。 */
import { fillTemplate } from './adapters.ts';

const ENT: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function stripHtml(s: string): string {
  return decodeEntities(
    s
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(block: string, names: string[]): string {
  for (const n of names) {
    const cd = new RegExp(`<${n}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${n}>`, 'i').exec(block);
    if (cd) return cd[1].trim();
    const plain = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(block);
    if (plain) return plain[1].trim();
  }
  return '';
}

function attr(block: string, tag: string, name: string): string {
  const m = new RegExp(`<${tag}[^>]*\\s${name}=["']([^"']+)["']`, 'i').exec(block);
  return m ? m[1] : '';
}

/** RSS 2.0 / Atom / RDF 通吃。 */
export function parseFeed(xml: string, baseUrl: string): Array<{
  title: string;
  url: string;
  summary?: string;
  publishedAt?: string | null;
  author?: string;
  image?: string;
}> {
  const out: Array<{
    title: string;
    url: string;
    summary?: string;
    publishedAt?: string | null;
    author?: string;
    image?: string;
  }> = [];

  const blocks: string[] = [];
  for (const tag of ['item', 'entry']) {
    const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'gi');
    const found = xml.match(re);
    if (found) blocks.push(...found);
  }
  if (blocks.length === 0) {
    // 有些站返回 JSON Feed
    return out;
  }

  for (const b of blocks) {
    const title = stripHtml(pick(b, ['title']));
    if (!title) continue;
    let link = pick(b, ['link']);
    if (!link) link = attr(b, 'link', 'href');
    if (!link) {
      const guid = pick(b, ['guid', 'id']);
      if (/^https?:\/\//.test(guid)) link = guid;
    }
    if (!link) continue;
    try {
      link = new URL(decodeEntities(link.trim()), baseUrl).toString();
    } catch {
      continue;
    }
    const summary = stripHtml(pick(b, ['description', 'summary', 'content:encoded', 'content'])) || undefined;
    const rawDate = pick(b, ['pubDate', 'published', 'updated', 'dc:date', 'date']);
    const author = stripHtml(pick(b, ['dc:creator', 'author', 'name'])) || undefined;
    let image = attr(b, 'enclosure', 'url') || attr(b, 'media:thumbnail', 'url');
    if (!image) {
      const im = /<img[^>]+src=["']([^"']+)["']/i.exec(pick(b, ['description', 'content:encoded', 'content']));
      if (im) image = im[1];
    }
    out.push({
      title,
      url: link,
      summary: summary ? summary.slice(0, 800) : undefined,
      publishedAt: parseDate(rawDate),
      author,
      image,
    });
  }
  return out;
}

/** JSON Feed / 任意 JSON 数组的字段映射。 */
export function mapJsonItems(
  rows: unknown[],
  m: { title: string[]; url: string[]; summary?: string[]; publishedAt?: string[]; image?: string[]; author?: string[] },
  baseUrl: string,
  urlTemplate?: string
): Array<{
  title: string;
  url: string;
  summary?: string;
  publishedAt?: string | null;
  author?: string;
  image?: string;
  native?: Record<string, unknown>;
}> {
  // 字段路径支持点号：["attributes.title"] 会走两层
  const get = (o: Record<string, unknown>, path: string[]): unknown => {
    for (const p of path) {
      let cur: unknown = o;
      for (const seg of String(p).split('.')) {
        if (cur == null) break;
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (cur !== undefined && cur !== null && cur !== '') return cur;
    }
    return undefined;
  };
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    const rawTitle = get(o, m.title);
    let rawUrl = m.url.length ? get(o, m.url) : undefined;
    if (!rawUrl && urlTemplate) {
      const filled = fillTemplate(urlTemplate, o);
      if (filled) rawUrl = filled;
    }
    if (!rawTitle || !rawUrl) continue;
    let url = String(rawUrl);
    try {
      url = new URL(url, baseUrl).toString();
    } catch {
      continue;
    }
    const rawDate = m.publishedAt ? get(o, m.publishedAt) : undefined;
    out.push({
      title: stripHtml(String(rawTitle)),
      url,
      summary: m.summary ? stripHtml(String(get(o, m.summary) ?? '')).slice(0, 800) || undefined : undefined,
      author: m.author ? String(get(o, m.author) ?? '') || undefined : undefined,
      image: m.image ? String(get(o, m.image) ?? '') || undefined : undefined,
      publishedAt: parseDate(
        typeof rawDate === 'number' ? new Date(rawDate > 1e12 ? rawDate : rawDate * 1000).toISOString() : String(rawDate ?? '')
      ),
      native: o,
    });
  }
  return out;
}

/**
 * 通用 HTML 列表页抽链。
 * 不追求通用性，追求「对新闻列表页够准」：靠链接路径模式 + 标题长度 + 去导航 过滤。
 */
export function extractHtmlList(
  html: string,
  baseUrl: string,
  cfg: { hrefPattern?: string; minTitle?: number; limit?: number } = {}
): Array<{ title: string; url: string }> {
  const minTitle = cfg.minTitle ?? 8;
  const limit = cfg.limit ?? 60;
  const hrefRe = cfg.hrefPattern ? new RegExp(cfg.hrefPattern) : null;
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string }> = [];

  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const hrefM = /\bhref=["']([^"']+)["']/i.exec(attrs);
    if (!hrefM) continue;
    let href = decodeEntities(hrefM[1].trim());
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    try {
      href = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (hrefRe && !hrefRe.test(href)) continue;
    const title = stripHtml(m[2]);
    if (title.length < minTitle) continue;
    if (/^(首页|登录|注册|更多|下一页|上一页|下载|关于我们|联系我们|广告|客户端)$/.test(title)) continue;
    const k = href.replace(/[?#].*$/, '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ title, url: href });
    if (out.length >= limit) break;
  }
  return out;
}

/** 解析各种时间写法，统一成带 Z 的 ISO。拿不到就 null——绝不能拿抓取时间冒充发布时间。 */
export function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 只有日期没有时刻（国内站点常见）：按本地时区当天 00:00，而不是按 UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split('-').map(Number);
    return new Date(y, mo - 1, d).toISOString();
  }

  const epoch = Number(s);
  if (/^\d{10}$/.test(s)) return new Date(epoch * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(epoch).toISOString();

  const cn = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (cn && /[\u4e00-\u9fa5]/.test(s) && !/[A-Za-z]{3},/.test(s)) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0'] = cn;
    const dt = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(sec)
    );
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();

  // 「3小时前」「刚刚」这类相对时间
  const rel = /(\d+)\s*(分钟|小时|天)前/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] === '分钟' ? 60_000 : rel[2] === '小时' ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - n * unit).toISOString();
  }
  if (/刚刚|刚才|just now/i.test(s)) return new Date().toISOString();
  return null;
}

export function toZhTime(iso: string | null): string {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
