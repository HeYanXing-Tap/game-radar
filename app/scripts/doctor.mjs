// 体检：确认 Key、地址、模型三者现在都还能用（不发 Key、不打印 Key）
import { llmConfig } from '../src/config.ts';

const cfg = llmConfig();
if (!cfg.apiKey) { console.log('✗ 没有 Key，先跑 npm run setup'); process.exit(1); }
console.log(`地址：${cfg.baseUrl}`);
console.log(`打分模型：${cfg.model}`);
console.log(`粗筛模型：${cfg.cheapModel || '（跟打分同一个）'}`);

const t0 = Date.now();
try {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: '只回两个字：能。' }],
      max_tokens: 8,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    console.log(`✗ HTTP ${res.status}（${ms}ms）`);
    console.log(`  ${text.slice(0, 300)}`);
    process.exit(2);
  }
  const j = JSON.parse(text);
  const reply = (j.choices?.[0]?.message?.content ?? '').trim();
  console.log(`✓ 能用（${ms}ms）模型回了：${reply || '(空)'}`);
  if (j.usage) console.log(`  token：输入 ${j.usage.prompt_tokens} / 输出 ${j.usage.completion_tokens}`);
} catch (e) {
  console.log(`✗ 调用失败：${e.message}`);
  process.exit(3);
}
