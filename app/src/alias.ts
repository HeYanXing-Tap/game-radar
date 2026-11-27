/**
 * 作品名归一。
 *
 * 同一款游戏在不同稿子里会被写成《GTA6》/ 侠盗猎车手6 / Grand Theft Auto VI，
 * 甚至写成「侠盗猎车手6（Grand Theft Auto VI）」这种中英并列的一串。
 * 打分时模型只照抄当篇标题里的写法，于是 chips 重复、前端「同一主体只留两张卡」
 * 的折叠也会被拆成好几组。
 *
 * 这里不维护别名表（每天都有新游戏，维护不动），而是从数据自己推断：
 *
 * 1. 每条记录先把名字拆成若干候选写法：去掉书名号、去掉括号里的并列译名、
 *    括号外的部分也算一个写法。同一条记录里出现的写法视为「可能同一物」。
 * 2. 展示名 = 去掉名字里的中英并列部分（取第一个），用于统计出现次数。
 * 3. 如果写法 A 出现时几乎总有 B 陪着（co(A,B) 占少数方出现次数的 80% 以上，
 *    且至少 2 次），就把 A、B 并成一类，取类里出现最多的展示名做标准名。
 *
 * 这个判据天然避开「顺便提到」：《黄金矿工爆火 GTA6 危险了》里黄金矿工只出现一次、
 * 也很少和 GTA6 同框，不会被并进 GTA6。
 */

const LINK_MIN_COOCCUR = 2;
const LINK_RATIO = 0.8;

const BRACKETS = /[（(【\[]([^）)】\]]*)[）)】\]]/g;

function stripDecor(raw: string): string {
  return raw
    .replace(/[《》「」『』"“”]/g, '')
    .replace(/^[·\s.]+|[·\s.]+$/g, '')
    .trim();
}

/** 一条记录里出现过的所有候选写法（含中英并列的两半）。 */
export function variantsOf(raw: string): string[] {
  const base = stripDecor(raw);
  if (!base) return [];
  const out = new Set<string>();
  const outside = base.replace(BRACKETS, ' ').replace(/\s+/g, ' ').trim();
  if (outside) out.add(outside);
  for (const m of base.matchAll(BRACKETS)) {
    const inner = m[1].trim();
    if (inner) out.add(stripDecor(inner));
  }
  return [...out];
}

/** 用于统计与展示的标准写法：取括号外那部分。 */
function displayOf(raw: string): string {
  const base = stripDecor(raw);
  const outside = base.replace(BRACKETS, ' ').replace(/\s+/g, ' ').trim();
  return stripDecor(outside || base);
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let p = this.parent.get(x);
    if (!p) {
      this.parent.set(x, x);
      return x;
    }
    while (p !== x) {
      x = p;
      p = this.parent.get(x) ?? x;
    }
    return x;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export type AliasMap = Map<string, string>;

/** 从一组条目的 games 数组推断「写法 → 标准名」映射。 */
export function buildAliasMap(rows: Array<{ games: string[] }>): AliasMap {
  const shown = new Map<string, number>(); // 展示名 → 出现次数
  const co = new Map<string, number>();
  const uf = new UnionFind();

  for (const row of rows) {
    const allVariants = new Set<string>();
    const displays = new Set<string>();
    for (const g of row.games || []) {
      const d = displayOf(g);
      const vs = variantsOf(g);
      if (d) displays.add(d);
      for (const v of vs) allVariants.add(v);
      // 同一个字符串里写出来的两种写法（「侠盗猎车手6（Grand Theft Auto VI）」）
      // 本来就是作者自己给的对照，无条件当成同一个东西
      for (let i = 0; i < vs.length; i += 1) {
        for (let j = i + 1; j < vs.length; j += 1) uf.union(vs[i], vs[j]);
      }
    }
    for (const d of displays) shown.set(d, (shown.get(d) || 0) + 1);

    const list = [...allVariants];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const key = list[i] < list[j] ? `${list[i]}\u0000${list[j]}` : `${list[j]}\u0000${list[i]}`;
        co.set(key, (co.get(key) || 0) + 1);
      }
    }
  }

  // 出现次数也统计到「写法」层面，才好在不同写法之间比较
  const counts = new Map<string, number>();
  for (const [k, v] of shown) counts.set(k, v);
  for (const key of co.keys()) {
    for (const name of key.split('\u0000')) {
      if (!counts.has(name)) counts.set(name, 0);
    }
  }
  for (const row of rows) {
    for (const g of row.games || []) {
      for (const v of variantsOf(g)) {
        if (!shown.has(v)) counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
  }

  for (const [key, n] of co) {
    if (n < LINK_MIN_COOCCUR) continue;
    const [a, b] = key.split('\u0000');
    const ca = counts.get(a) || 0;
    const cb = counts.get(b) || 0;
    const ratio = n / Math.max(1, Math.min(ca, cb));
    if (ratio >= LINK_RATIO) uf.union(a, b);
  }

  // 同一类里选标准名：优先出现次数多的展示名；并列时优先更短的中文名
  const best = new Map<string, string>();
  const score = (name: string): number => {
    const n = shown.get(name) || 0;
    const cjk = /[\u4e00-\u9fa5]/.test(name) ? 1000 : 0;
    return n * 100 + cjk - name.length;
  };
  for (const name of new Set([...shown.keys(), ...counts.keys()])) {
    const root = uf.find(name);
    const cur = best.get(root);
    if (!cur || score(name) > score(cur)) best.set(root, name);
  }

  const map: AliasMap = new Map();
  for (const name of counts.keys()) {
    map.set(name, best.get(uf.find(name)) || name);
  }
  for (const v of best.values()) map.set(v, v);
  return map;
}

/** 把一条记录的 games 换成标准名，保持顺序并去重。 */
export function canonicalize(games: string[], map: AliasMap): string[] {
  const out: string[] = [];
  for (const g of games || []) {
    const display = displayOf(g);
    const name = map.get(display) || map.get(g.trim()) || display || g.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
