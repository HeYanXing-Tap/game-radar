// 交互式配置模型 key。给不想手动改 .env 的人用：跑 `npm run setup` 就行。
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const PROVIDERS = [
  { label: 'DeepSeek（深度求索）', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '通义千问（阿里云）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { label: '其他（自己填地址）', base: '', model: '' },
];

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 用队列接行，而不是 rl.question：管道喂输入时，第二行可能在提问前就已经到了，
// 用 question 会漏掉它，然后卡死。
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

/** 读密码时不回显字符 */
function askSecret(q) {
  // 不是真终端（比如管道喂输入）时，退化成普通读取，避免 setRawMode 报错
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

console.log('\n=== 游戏资讯雷达 · 模型配置 ===\n');
console.log('你需要一样东西：一个模型 API Key（一串 sk- 或类似的字符）。');
console.log('没有的话，去你打算用的那家的控制台申请一个，充几块钱就够跑很久。\n');

console.log('你用的是哪一家？');
PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}) ${p.label}`));
const pick = Number(await ask('\n输入编号（直接回车 = 1 DeepSeek）：')) || 1;
const prov = PROVIDERS[pick - 1] ?? PROVIDERS[0];

let base = prov.base;
let model = prov.model;
if (!base) {
  base = await ask('接口地址（形如 https://xxx/v1）：') || 'https://api.deepseek.com/v1';
  model = await ask('模型名（如 deepseek-chat）：') || 'deepseek-chat';
}

const key = await askSecret('\n把 Key 粘贴进来（打字时不显示，粘贴后按回车）：');
if (!key) {
  console.log('\n没读到 Key，已退出，什么都没改。');
  rl.close();
  process.exit(1);
}

const out = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '.env';
writeFileSync(out, `# 模型配置（由 npm run setup 生成，别提交到 git）
LLM_BASE_URL=${base}
LLM_MODEL=${model}
LLM_API_KEY=${key}
`);

console.log(`\n已写入 ${out}。现在测一下这个 Key 能不能用……`);
try {
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复 ok 两个字' }], max_tokens: 5 }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (res.ok) {
    console.log('✓ Key 有效，模型回应正常。');
    console.log('\n下一步：跑一次完整流程\n  npm run run\n');
  } else {
    console.log(`✗ 调用失败了（HTTP ${res.status}）`);
    console.log('  常见原因：Key 打错了 / 没充值 / 模型名不对。');
    console.log('  服务端原话：' + text.slice(0, 300));
    console.log(`\n配置已经写进 ${out}，改好 Key 后重跑 npm run setup 即可。`);
    process.exitCode = 2;
  }
} catch (e) {
  console.log(`✗ 连不上 ${base}`);
  console.log('  可能是网络问题或地址写错了：' + e.message);
  process.exitCode = 2;
}
rl.close();
