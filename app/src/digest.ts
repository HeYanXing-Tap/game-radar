import { exec, log, nowIso, q } from './db.ts';
import { board } from './pipeline.ts';
import { computeHeat } from './cluster.ts';
import { hasLlm } from './config.ts';
import { chat } from './llm.ts';
import { toZhTime } from './parsers.ts';

function today(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

const AXIS_LABEL: Record<string, string> = {
  quirk: '谈资',
  reach: '外溢',
  window: '时机',
  craft: '可做',
  fit: '匹配',
  quality: '品质',
  category: '品类',
  business: '商业',
  momentum: '势能',
  landing: '落地',
};

function fmtAxes(axes: Array<{ key: string; score: number; why: string }>): string {
  return axes.map((a) => `${AXIS_LABEL[a.key] ?? a.key} ${a.score}`).join(' · ');
}

export interface Digest {
  date: string;
  markdown: string;
  topicCount: number;
  gameCount: number;
}

/** 日报：两条队列各一节 + 一个热点补充。规则化生成，模型只写导读。 */
export async function buildDigest(dateStr?: string): Promise<Digest> {
  const date = dateStr ?? today();
  const topic = board('topic', { days: 1, limit: 12 });
  const game = board('game', { days: 3, limit: 12 });
  const hot = computeHeat().slice(0, 8);

  let intro = '';
  if (hasLlm() && (topic.length || game.length)) {
    try {
      intro = await chat(
        `今天是 ${date}。下面是今天游戏资讯雷达筛出的选题候选和作品候选，请写一段 80 字以内的导读，口吻像游戏媒体编辑在早会上说话，点出今天最值得注意的一两件事，不要罗列，不要用「综上所述」。\n\n选题：${topic.slice(0, 5).map((t) => t.title).join('；')}\n作品：${game.slice(0, 5).map((t) => t.title).join('；')}`,
        { system: '你是 TapTap 游戏频道的资深编辑，说话直接、有判断、不用套话。', temperature: 0.7, maxTokens: 300 }
      );
      intro = intro.trim();
      // 模型偶尔不听话，把 JSON 或代码块当导读吐回来，直接丢掉
      if (/^[\[{`]|```/.test(intro)) intro = '';
    } catch {
      intro = '';
    }
  }

  const L: string[] = [];
  L.push(`# 游戏资讯雷达 · ${date}`);
  L.push('');
  if (intro) {
    L.push(`> ${intro}`);
    L.push('');
  }

  L.push(`## 一、选题雷达（${topic.length} 条过硬门槛）`);
  L.push('');
  if (topic.length === 0) {
    L.push('_今天没有过门槛的选题候选。要么信源产出少，要么标准偏严——去 app/src/prompts/radar-topic.md 调门槛。_');
  }
  topic.forEach((t, i) => {
    L.push(`### ${i + 1}. ${t.title}`);
    L.push(`**${t.total} 分** · ${t.source_name} · ${toZhTime(t.published_at)} · ${fmtAxes(t.axes)}`);
    L.push('');
    L.push(`**判断**：${t.verdict}`);
    if (t.angle) L.push(`**角度**：${t.angle}`);
    if (t.against) L.push(`**风险**：${t.against}`);
    L.push('');
    L.push(`[原文](${t.url})`);
    L.push('');
  });

  L.push(`---`);
  L.push('');
  L.push(`## 二、作品雷达（${game.length} 条过硬门槛）`);
  L.push('');
  if (game.length === 0) {
    L.push('_没有值得跟的作品信号。_');
  }
  game.forEach((g, i) => {
    L.push(`### ${i + 1}. ${g.games.length ? g.games.join(' / ') : '（未识别作品）'}`);
    L.push(`**${g.total} 分** · ${g.source_name} · ${toZhTime(g.published_at)} · ${fmtAxes(g.axes)}`);
    L.push('');
    L.push(`**判断**：${g.verdict}`);
    if (g.angle) L.push(`**下一步**：${g.angle}`);
    if (g.against) L.push(`**风险**：${g.against}`);
    L.push('');
    L.push(`[原文](${g.url})`);
    L.push('');
  });

  L.push('---');
  L.push('');
  L.push('## 三、当前热点（按独立来源数排，48h 半衰）');
  L.push('');
  for (const h of hot) {
    L.push(`- **${h.heat}** · ${h.sources} 源 · ${h.title}`);
    if (h.source_names) L.push(`  <sub>${h.source_names}</sub>`);
  }
  L.push('');

  const markdown = L.join('\n');
  const dateKey = dateStr ?? today();

  exec(
    `INSERT INTO digests (date, kind, markdown, data_json, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(date, kind) DO UPDATE SET markdown=excluded.markdown, data_json=excluded.data_json, created_at=excluded.created_at`,
    dateKey,
    'daily',
    markdown,
    JSON.stringify({ topicCount: topic.length, gameCount: game.length, hot }),
    nowIso()
  );

  log(`日报已生成：${dateKey}，选题 ${topic.length} 条，作品 ${game.length} 条`);
  return { date: dateKey, markdown, topicCount: topic.length, gameCount: game.length };
}

export function listDigests(limit = 30): Array<{ date: string; kind: string }> {
  return q<{ date: string; kind: string }>('SELECT date, kind FROM digests ORDER BY date DESC LIMIT ?', limit);
}

export function getDigest(date: string, kind = 'daily'): string | null {
  const r = q<{ markdown: string }>('SELECT markdown FROM digests WHERE date=? AND kind=?', date, kind)[0];
  return r?.markdown ?? null;
}
