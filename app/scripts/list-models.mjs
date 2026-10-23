// 列出当前 Key 能用的模型（不会打印 Key 本身）
import { llmConfig } from '../src/config.ts';

const cfg = llmConfig();
if (!cfg.apiKey) {
  console.log('还没有配置 Key，先跑 npm run setup');
  process.exit(1);
}
const cands = [cfg.baseUrl];
if (!/\/v\d+$/.test(cfg.baseUrl)) cands.push(cfg.baseUrl + '/v1');
cands.push(cfg.baseUrl.replace(/\/v\d+$/, ''));

for (const base of cands) {
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) continue;
    if (res.status === 401 || res.status === 403) {
      console.log(`地址 ${base} 拒绝了这个 Key（HTTP ${res.status}）。`);
      process.exit(2);
    }
    if (!res.ok) continue;
    const j = await res.json();
    const models = (j.data ?? j.models ?? [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    if (!models.length) continue;
    console.log(`地址：${base}`);
    console.log(`共 ${models.length} 个模型（* = 当前打分在用）\n`);
    models.forEach((m, i) => {
      const mark = m === cfg.model ? ' *' : '';
      console.log(`${String(i + 1).padStart(3)}) ${m}${mark}`);
    });
    if (cfg.cheapModel) console.log(`\n粗筛模型：${cfg.cheapModel}`);
    process.exit(0);
  } catch { /* 换下一个候选 */ }
}
console.log('没能列出模型（这个地址可能不允许查询列表），直接问平台同事模型名即可。');
process.exit(3);
