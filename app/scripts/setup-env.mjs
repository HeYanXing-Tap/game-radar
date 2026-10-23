// 交互式配置模型 key：跑 `npm run setup`。
// 会先把 key 能用到的模型列出来让你挑，省得你去猜模型名。
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const PROVIDERS = [
  { label: 'DeepSeek（深度求索）', base: 'https://api.deepseek.com/v1' },
  { label: '通义千问（阿里云）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: '其他（自己填地址）', base: '' },
];

const rl = createInterface({ input: process.stdin, output: process.stdout });
const lineQ = [];
const waiterQ = [];
rl.on('line', (l) => {
  const w = waiterQ.shift();
  if (w) w(l);
  else lineQ.push(l);
});
function ask(q) {
  process.stdout.write(q);
  return new Promise((resolve) => {
    const ready = lineQ.shift();
    if (ready !== undefined) resolve(ready.trim());
    else waiterQ.push((l) => resolve(l.trim()));
  });
}

function askSecret(q) {
  if (!process.stdin.isTTY) return ask(q);
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(wasRaw);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (c === '\u0003') { process.stdout.write('\n已取消。\n'); process.exit(1); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const outFile = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '.env';

console.log('\n=== 游戏资讯雷达 · 模型配置 ===\n');
console.log('你需要一个模型 API Key（一串 sk- 开头的字符）。');
console.log('一个 Key 能用哪些模型是服务商定的，通常不止一个——下面会列给你挑。\n');

console.log('你用的是哪一家？');
PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}) ${p.label}`));
const pick = Number(await ask('\n输入编号（直接回车 = 1 DeepSeek）：')) || 1;
const prov = PROVIDERS[pick - 1] ?? PROVIDERS[0];

let base = prov.base;
if (!base) {
  base = (await ask('接口地址（形如 https://xxx/v1）：')) || 'https://api.deepseek.com/v1';
}
base = base.replace(/\/$/, '');

const key = await askSecret('把 Key 粘贴进来（打字时不显示，粘贴后按回车）：');
if (!key) {
  console.log('\n没读到 Key，已退出，什么都没改。');
  rl.close();
  process.exit(1);
}

// ---- 列出这个 key 能用的模型 ----
let models = [];
console.log('\n正在查这个 Key 能用哪些模型……');
try {
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.ok) {
    const j = await res.json();
    models = (j.data ?? j.models ?? [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
  } else {
    console.log(`  查不到（HTTP ${res.status}），等下直接手输模型名。`);
  }
} catch (e) {
  console.log(`  查不到（${e.message}），等下直接手输模型名。`);
}

let model = '';
let cheap = '';

if (models.length) {
  const show = models.slice(0, 40);
  console.log(`\n你的 Key 能用的模型（共 ${models.length} 个${models.length > 40 ? '，只显示前 40' : ''}）：`);
  show.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}) ${m}`));
  const pick2 = Number(await ask('\n用哪个模型打分？输编号（直接回车 = 1）：')) || 1;
  model = show[pick2 - 1] ?? show[0];

  console.log('\n粗筛（预筛）那一步要不要换个更便宜的模型？');
  console.log('它一天要跑几十批，用便宜模型能省下一个数量级的钱；直接回车 = 和打分用同一个。');
  const cheapPick = await ask('输编号或模型名（回车跳过）：');
  if (cheapPick) {
    const n = Number(cheapPick);
    cheap = Number.isInteger(n) && n >= 1 && n <= show.length ? show[n - 1] : cheapPick;
  }
} else {
  model = (await ask('模型名（例如 deepseek-chat）：')) || 'deepseek-chat';
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
    console.log('  常见原因：Key 打错 / 没充值 / 这个模型你没权限。');
    console.log('  服务端原话：' + text.slice(0, 300));
    console.log(`\n配置已写进 ${outFile}，改好重跑 npm run setup 即可。`);
    process.exitCode = 2;
  }
} catch (e) {
  console.log(`✗ 连不上 ${base}：${e.message}`);
  process.exitCode = 2;
}
rl.close();
