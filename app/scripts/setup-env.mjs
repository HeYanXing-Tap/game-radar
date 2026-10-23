// 交互式配置模型 key：跑 `npm run setup`。
// 不依赖 readline：它会在终端里把输入回显出来，key 会露在屏幕上。
import { readFileSync, writeFileSync } from 'node:fs';

const PROVIDERS = [
  { label: 'DeepSeek（深度求索）', base: 'https://api.deepseek.com/v1' },
  { label: '通义千问（阿里云）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: '其他（公司内部代理 / 自己填地址）', base: '' },
];

const tty = Boolean(process.stdin.isTTY);
const piped = tty ? null : readFileSync(0, 'utf8').split(/\r?\n/);
const pending = [];
const waiting = [];
let echo = false;
let buf = '';
let rawSet = false;

function finishLine() {
  const line = buf;
  buf = '';
  if (tty) process.stdout.write('\n');
  const w = waiting.shift();
  if (w) w(line);
  else pending.push(line);
}

if (tty) {
  const stdin = process.stdin;
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
    rawSet = true;
  }
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    // 粘贴时终端会加 \x1b[200~ … \x1b[201~ 包裹，去掉
    const clean = chunk.replace(/\u001b\[20[01]~/g, '');
    for (const ch of clean) {
      if (ch === '\u0003') {
        process.stdout.write('\n已取消，什么都没改。\n');
        process.exit(1);
      }
      if (ch === '\r' || ch === '\n') {
        finishLine();
        continue;
      }
      if (ch === '\u007f' || ch === '\b') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          if (echo) process.stdout.write('\b \b');
        }
        continue;
      }
      if (ch < ' ' || ch === '\u001b') continue; // 忽略方向键等控制字符
      buf += ch;
      if (echo) process.stdout.write(ch); // 只有非密输入才回显
    }
  });
}

function ask(q, { secret = false } = {}) {
  process.stdout.write(q);
  if (!tty) {
    const line = piped.shift() ?? '';
    return Promise.resolve(line.trim());
  }
  echo = !secret;
  return new Promise((resolve) => waiting.push((v) => resolve(v.trim())));
}

const askSecret = (q) => ask(q, { secret: true });

/** 试着找一个能用的接口地址：很多代理要带 /v1，用户常漏 */
async function resolveBase(base, key) {
  const b = base.replace(/\/+$/, '');
  const cands = [b];
  if (!/\/v\d+$/.test(b)) cands.push(`${b}/v1`);
  if (/\/v\d+$/.test(b)) cands.push(b.replace(/\/v\d+$/, ''));

  let last = null;
  for (const c of cands) {
    try {
      const res = await fetch(`${c}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404) continue; // 这个路径不存在，换下一个
      if (res.status === 401 || res.status === 403) {
        // 端点存在但拒绝：可能是 Key 不对，也可能这个地址不允许列模型。
        // 不当场下结论，交给最后那次真实调用判定。
        return { base: c, models: [], note: `列表查询被拒（HTTP ${res.status}）` };
      }
      if (res.ok) {
        const j = await res.json();
        const models = (j.data ?? j.models ?? [])
          .map((m) => (typeof m === 'string' ? m : m.id || m.name))
          .filter(Boolean);
        // 有的代理对任何路径都返回 200 但给空列表，这种情况继续试下一个候选
        if (!models.length) {
          last = { base: c, models: [], note: '该地址返回了空列表' };
          continue;
        }
        return { base: c, models };
      }
      return { base: c, models: [], note: `HTTP ${res.status}` };
    } catch (e) {
      return { base: c, models: [], note: e.message };
    }
  }
  return last ?? { base: b, models: [], note: '所有候选路径都不通' };
}

const outFile = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '.env';

console.log('\n=== 游戏资讯雷达 · 模型配置 ===\n');
console.log('你需要一个模型 API Key（一串 sk- 开头的字符）。');
console.log('一个 Key 能用哪些模型由服务商决定，通常不止一个——下面列给你挑。\n');

console.log('你用的是哪一家？');
PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}) ${p.label}`));
const pick = Number(await ask('\n输入编号（直接回车 = 1 DeepSeek）：')) || 1;
const prov = PROVIDERS[pick - 1] ?? PROVIDERS[0];

let base = prov.base;
if (!base) {
  base = (await ask('接口地址（形如 https://xxx/v1；只填域名也行，我帮你试）：')) || '';
  if (!base) {
    console.log('\n没填地址，已退出。');
    process.exit(1);
  }
}

const key = await askSecret('把 Key 粘贴进来（打字时不显示，粘贴后按回车）：');
if (!key) {
  console.log('\n没读到 Key，已退出，什么都没改。');
  process.exit(1);
}

console.log('\n正在找接口地址、查这个 Key 能用哪些模型……');
const found = await resolveBase(base, key);
base = found.base;

let models = found.models;
if (!models.length) {
  console.log(`  没列出模型（${found.note ?? '该地址不支持列表查询'}），等下直接手输模型名。`);
}

let model = '';
let cheap = '';

if (models.length) {
  const show = models.slice(0, 40);
  console.log(`\n地址可用：${base}`);
  console.log(`你的 Key 能用的模型（共 ${models.length} 个${models.length > 40 ? '，只显示前 40' : ''}）：`);
  show.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}) ${m}`));
  const pick2 = Number(await ask('\n用哪个模型打分？输编号（直接回车 = 1）：')) || 1;
  model = show[pick2 - 1] ?? show[0];

  console.log('\n粗筛（预筛）要不要换个更便宜的模型？');
  console.log('它一天跑几十批，换便宜的能省一个数量级；直接回车 = 和打分用同一个。');
  const cheapPick = await ask('输编号或模型名（回车跳过）：');
  if (cheapPick) {
    const n = Number(cheapPick);
    cheap = Number.isInteger(n) && n >= 1 && n <= show.length ? show[n - 1] : cheapPick;
  }
} else {
  console.log(`\n用这个地址：${base}`);
  model = (await ask('模型名（问下平台同事，或看代理文档）：')) || '';
  if (!model) {
    console.log('\n没填模型名，已退出，什么都没改。');
    process.exit(1);
  }
  cheap = (await ask('粗筛用的便宜模型（回车 = 用同一个）：')) || '';
}

const lines = [
  '# 模型配置（由 npm run setup 生成，别提交到 git）',
  `LLM_BASE_URL=${base}`,
  `LLM_MODEL=${model}`,
];
if (cheap && cheap !== model) lines.push(`LLM_CHEAP_MODEL=${cheap}`);
lines.push(`LLM_API_KEY=${key}`, '');
writeFileSync(outFile, lines.join('\n'));

console.log(`\n已写入 ${outFile}：打分用 ${model}${cheap && cheap !== model ? `，粗筛用 ${cheap}` : ''}`);
console.log('现在正式测一下……');
try {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复 ok' }], max_tokens: 5 }),
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  if (res.ok) {
    console.log('✓ Key 和模型都能用。\n\n下一步跑一次完整流程：\n  npm run run\n');
  } else {
    console.log(`✗ 调用失败了（HTTP ${res.status}）`);
    console.log('  常见原因：模型名不对 / 这个模型你没权限 / 没充值。');
    console.log('  服务端原话：' + text.slice(0, 300));
    console.log(`\n配置已写进 ${outFile}，改好重跑 npm run setup 即可。`);
    process.exitCode = 2;
  }
} catch (e) {
  console.log(`✗ 连不上 ${base}：${e.message}`);
  process.exitCode = 2;
}

if (rawSet) process.stdin.setRawMode(false);
process.exit(process.exitCode ?? 0);
