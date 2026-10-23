/** HTML 行块抽取 + JSON 字段映射的通用实现。零依赖，全部用正则，配置写在 sources.json 里。 */

export interface RowsAdapter {
  /** 行块正则，每条内容匹配一次；例如 "<li[^>]*class=\"[^\"]*selectpost[^\"]*\"[\\s\\S]*?</li>" */
  rowPattern: string;
  /** 每个字段是行块内的正则，取第 1 个捕获组 */
  title: string;
  link: string;
  time?: string;
  summary?: string;
  image?: string;
  author?: string;
  /** 链接是相对路径时的前缀 */
  urlPrefix?: string;
  /** 时间需要特殊处理时给一个标志 */
  timeFormat?: 'cn' | 'timestamp' | 'iso';
  /**
   * 在行块内抠热度数字。
   * 写法一："([\\d.]+)\\s*万"（先换算好单位）
   * 写法二：{ pattern: "([\\d.]+)W", mult: 10000 }（源站用 W 表示万时用这个）
   */
  heat?: Record<string, string | { pattern: string; mult?: number }>;
}

export interface JsonHeatMap {
  /** 字段路径，数组表示层级；值会写进 heat_json */
  [key: string]: string | string[];
}

export interface JsonSourceAdapter {
  /** 取数组的路径，如 "data.list"；留空表示根就是数组 */
  path?: string;
  /** 多榜单：如 Steam 的 ["new_releases.items"] */
  sections?: string[];
  map: {
    title: string[];
    url: string[];
    summary?: string[];
    publishedAt?: string[];
    image?: string[];
    author?: string[];
  };
  /** 列表里没有链接时用模板拼，占位符可以用任意字段名 */
  urlTemplate?: string;
  heat?: JsonHeatMap;
  /** 图片字段是裸文件名时补上前缀 */
  imagePrefix?: string;
  enrich?: 'steamApp';
  enrichLimit?: number;
  /** 请求头里要合并的字段 */
  headers?: Record<string, string>;
}

/** href 里的 &amp; 不处理会带进 URL，贴吧这类 query 型链接尤其明显 */
function decodeEnt(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function digPath(obj: unknown, path: string | string[] | undefined): unknown {
  if (!path || (Array.isArray(path) && path.length === 0) || path === '') return obj;
  const segs = Array.isArray(path) ? path : String(path).split('.');
  let cur: unknown = obj;
  for (const seg of segs) {
    if (cur == null) return undefined;
    const idx = Number(seg);
    if (Array.isArray(cur) && Number.isInteger(idx)) cur = cur[idx];
    else cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function fillTemplate(tpl: string, obj: Record<string, unknown>): string | null {
  let missing = false;
  const out = tpl.replace(/\{([\w.]+)(?:\|(\w+))?\}/g, (_, k: string, fn?: string) => {
    let cur: unknown = obj;
    for (const seg of k.split('.')) {
      if (cur == null) break;
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === undefined || cur === null || cur === '') {
      missing = true;
      return '';
    }
    const str = String(cur);
    if (fn === 'lastPathSegment') return str.split('?')[0].replace(/\/+$/, '').split('/').pop() ?? '';
    if (fn === 'digits') return (str.match(/\d+/) ?? [''])[0];
    return str;
  });
  return missing ? null : out;
}

export interface RowHit {
  title: string;
  url: string;
  time?: string;
  summary?: string;
  image?: string;
  author?: string;
  /** 原始行块，供热度正则复用 */
  raw?: string;
}

/** 按行切块再逐字段抠。比通用 <a> 扫描准得多，能同时拿到时间和摘要。 */
export function extractRows(html: string, a: RowsAdapter, baseUrl: string): RowHit[] {
  const out: RowHit[] = [];
  let rowRe: RegExp;
  try {
    rowRe = new RegExp(a.rowPattern, 'gi');
  } catch {
    return out;
  }
  const grab = (block: string, pattern?: string): string | undefined => {
    if (!pattern) return undefined;
    try {
      const m = new RegExp(pattern, 'i').exec(block);
      return m ? m[1] ?? m[0] : undefined;
    } catch {
      return undefined;
    }
  };

  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = rowRe.exec(html)) && guard++ < 500) {
    const block = m[0];
    const title = decodeEnt((grab(block, a.title) ?? '').replace(/<[^>]+>/g, '').trim());
    let href = decodeEnt((grab(block, a.link) ?? '').trim());
    if (!title || !href) continue;
    if (a.urlPrefix && !/^https?:\/\//.test(href)) href = a.urlPrefix.replace(/\/$/, '') + (href.startsWith('/') ? href : `/${href}`);
    try {
      href = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    // 只砍 fragment，保留 query：贴吧/NGA 这类站点靠 query 区分条目
    const key = href.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      url: href,
      time: grab(block, a.time)?.replace(/<[^>]+>/g, '').trim(),
      summary: grab(block, a.summary)?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      image: grab(block, a.image),
      author: grab(block, a.author)?.replace(/<[^>]+>/g, '').trim(),
      raw: block,
    });
  }
  return out;
}
