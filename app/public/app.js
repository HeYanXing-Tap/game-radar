const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AXIS_LABEL = {
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

function relTime(iso) {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 0) return d.toLocaleDateString('zh-CN');
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  return days < 30 ? `${days} 天前` : d.toLocaleDateString('zh-CN');
}

const state = { view: 'topic', days: 3, all: false, cache: new Map(), static: false };

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

/**
 * 两种运行方式：
 *  - 本地：有 node 服务，走 /api/*
 *  - 静态：部署在 GitHub Pages 之类的地方，走预先生成的 /data/*.json
 * 启动时探一下 /api/stats 就知道自己在哪种模式。
 */
async function detectMode() {
  try {
    await api('/api/stats');
    state.static = false;
  } catch {
    state.static = true;
  }
}

// 相对路径：本地服务在根目录、GitHub Pages 在 /game-radar/ 子路径，两种都能用
const DATA = (name) => `data/${name}.json`;

async function getStats() {
  return state.static ? api(DATA('stats')) : api('/api/stats');
}

async function getBoard(radar, days, all) {
  if (state.static) {
    const d = await api(DATA(`${radar}-${days}`));
    return all ? d : { ...d, entries: d.entries };
  }
  return api(`/api/board?radar=${radar}&days=${days}&limit=40&all=${all ? 1 : 0}`);
}

async function getHot() {
  return state.static ? api(DATA('hot')) : api('/api/hot');
}

async function getDigests() {
  return state.static ? api(DATA('digests')) : api('/api/digests');
}

async function getDigest(date) {
  if (!state.static) return api(`/api/digest?date=${date}`);
  const history = await api(DATA('digest-history'));
  return history.find((h) => h.date === date) ?? history[0] ?? { date, markdown: '' };
}

async function getSources() {
  return state.static ? api(DATA('sources')) : api('/api/sources');
}

async function loadStats() {
  try {
    const s = await getStats();
    $('#statline').textContent = `${s.items} 条内容 · ${s.events} 个事件 · ${s.sources} 个信源`;
  } catch {}
}

function card(e, passing) {
  const cls = passing ? 'pass' : 'fail';
  const axes = (e.axes || [])
    .map((a) => `<i title="${esc(a.why)}">${AXIS_LABEL[a.key] || a.key} ${a.score}</i>`)
    .join('');
  const tierBadge = e.tier === 3 ? '<span class="tier3">一手</span>' : '';
  const heat = e.event_sources > 1 ? `· ${e.event_sources} 源在说` : '';
  return `
  <article class="card ${cls}" data-id="${e.item_id}">
    <div class="score"><b>${e.total}</b><span>SCORE</span></div>
    <div>
      <h3><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a></h3>
      <div class="meta">
        <span class="src">${esc(e.source_name)} ${tierBadge}</span>
        <span>${e.published_at ? relTime(e.published_at) : e.rank ? `榜 #${e.rank}` : '时间未知'}</span>
        <span>${esc(heat)}</span>
      </div>
      <div class="axes">${axes}</div>
      <p class="verdict">${esc(e.verdict)}</p>
      ${(e.games || []).length ? `<div class="games">${e.games.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
      ${e.angle ? `<p class="angle"><b>${e.radar === 'topic' ? '角度' : '下一步'}</b>${esc(e.angle)}</p>` : ''}
      ${e.against ? `<p class="against"><b>风险</b>${esc(e.against)}</p>` : ''}
      <div class="tools">
        <button data-copy="${esc(`${e.title}\n${e.angle || e.verdict}`)}">复制</button>
      </div>
    </div>
  </article>`;
}

async function renderBoard(radar) {
  const el = $(`#view-${radar}`);
  el.innerHTML = '<div class="empty">载入中…</div>';
  const key = `${radar}-${state.days}-${state.all}`;
  let data = state.cache.get(key);
  if (!data) {
    data = await getBoard(radar, state.days, state.all);
    state.cache.set(key, data);
  }
  if (!data.entries.filter((e) => state.all || e.pass !== false).length) {
    const st = await getStats().catch(() => null);
    const noModel = st && typeof st.scored === 'number' && st.scored === 0;
    el.innerHTML = noModel
      ? `<div class="empty">
          <strong>打分层还没跑起来。</strong><br /><br />
          抓取是正常的（已经存了 ${st.items} 条资讯、归并成 ${st.events} 个事件），但还没有任何一条被模型打过分。<br /><br />
          原因通常只有一个：<b>没配模型 key</b>。在 <code>app/.env</code> 里填 <code>LLM_API_KEY</code>，然后跑一次
          <code>npm run run</code>，这一栏就会有内容了。
        </div>`
      : `<div class="empty">
          ${state.all ? '还没有任何打分结果。' : '没有过门槛的条目。'}<br /><br />
          先跑一次 <code>npm run run</code>，或者勾上右上角的「显示未过门槛」降低标准看全量。
        </div>`;
    return;
  }
  const list = state.all ? data.entries : data.entries.filter((e) => e.pass !== false);
  const passCount = list.length;
  const head =
    radar === 'topic'
      ? `<div class="empty" style="padding:0 0 18px;text-align:left;color:var(--dim);font-size:12.5px;font-family:var(--mono)">近 ${state.days} 天 · ${list.length} 条候选${state.all ? '' : '（过门槛）'} · 按选题价值排序 · 外溢能力权重最高</div>`
      : `<div class="empty" style="padding:0 0 18px;text-align:left;color:var(--dim);font-size:12.5px;font-family:var(--mono)">近 ${state.days} 天 · ${list.length} 条候选${state.all ? '' : '（过门槛）'} · 按引进价值排序 · 品质与商业可行性权重最高</div>`;
  el.innerHTML = head + list.map((e) => card(e, e.pass !== false)).join('');
}

async function renderHot() {
  const el = $('#view-hot');
  el.innerHTML = '<div class="empty">载入中…</div>';
  const rows = await getHot();
  if (!rows.length) {
    el.innerHTML = '<div class="empty">还没有事件。跑 <code>npm run collect && npm run score</code></div>';
    return;
  }
  el.innerHTML = `
    <div class="empty" style="padding:0 0 18px;text-align:left;color:var(--dim);font-size:12.5px;font-family:var(--mono)">
      热度 = 48 小时内独立来源数加权求和 · 24 小时前对半折 · 同一媒体发十篇只算一次
    </div>
    ${rows
      .map(
        (h) => `
      <div class="hotrow">
        <div class="h">${h.heat.toFixed(1)}</div>
        <div class="t">${esc(h.title)}${h.heat_6h > 0 ? `<span class="up">↑ 近6h +${h.heat_6h}</span>` : ''}</div>
        <div class="s">${h.sources} 源<br />${relTime(h.last_at)}</div>
      </div>`
      )
      .join('')}`;
}

/** 极简 markdown：够渲染我们自己生成的日报就行。 */
function md(src) {
  const lines = src.split('\n');
  const out = [];
  let inList = false;
  const inline = (s) =>
    esc(s)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (/^- /.test(l)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(l.slice(2))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (!l.trim()) continue;
    if (l.startsWith('### ')) out.push(`<h3>${inline(l.slice(4))}</h3>`);
    else if (l.startsWith('## ')) out.push(`<h2>${inline(l.slice(3))}</h2>`);
    else if (l.startsWith('# ')) out.push(`<h1>${inline(l.slice(2))}</h1>`);
    else if (l.startsWith('> ')) out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
    else if (l === '---') out.push('<hr />');
    else if (/^  <sub>/.test(l)) out.push(inline(l.trim()));
    else out.push(`<p>${inline(l)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

async function renderDigest() {
  const el = $('#view-digest');
  el.innerHTML = '<div class="empty">载入中…</div>';
  try {
    const list = await getDigests();
    if (!list.length) {
      el.innerHTML = '<div class="empty">还没有日报。跑 <code>npm run digest</code> 生成今天的。</div>';
      return;
    }
    const d = await getDigest(list[0].date);
    el.innerHTML = `<div class="md">${md(d.markdown || '')}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function renderSources() {
  const el = $('#view-sources');
  el.innerHTML = '<div class="empty">载入中…</div>';
  const rows = await getSources();
  el.innerHTML = `
    <table>
      <thead><tr><th>信源</th><th>角色</th><th>分级</th><th>产出</th><th>最近成功</th><th>状态</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (s) => `
          <tr>
            <td>${esc(s.name)}<br /><span style="color:var(--dim);font-size:11px;font-family:var(--mono)">${esc(s.type)} · ${esc(s.id)}</span></td>
            <td><span class="pill">${esc(s.role)}</span></td>
            <td><span class="pill ${s.tier === 3 ? 't3' : ''}">${s.tier === 3 ? '一手' : s.tier === 2 ? '准一手' : '二手'}</span></td>
            <td class="num">${s.yield_count}</td>
            <td class="num">${s.last_ok_at ? relTime(s.last_ok_at) : '—'}</td>
            <td>${
              !s.enabled
                ? '<span class="pill">已停用</span>'
                : s.fail_streak > 0
                  ? `<span class="pill bad">连败 ${s.fail_streak}</span>`
                  : '<span class="pill ok">正常</span>'
            }</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

const RENDER = { topic: () => renderBoard('topic'), game: () => renderBoard('game'), hot: renderHot, digest: renderDigest, sources: renderSources };

function switchView(v) {
  if (!RENDER[v]) v = 'topic';
  state.view = v;
  if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('hidden', s.id !== `view-${v}`));
  RENDER[v]();
}

window.addEventListener('hashchange', () => switchView(location.hash.slice(1) || 'topic'));

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) switchView(b.dataset.view);
});

$('#days').addEventListener('change', (e) => {
  state.days = Number(e.target.value);
  state.cache.clear();
  if (state.view === 'topic' || state.view === 'game') RENDER[state.view]();
});
$('#all').addEventListener('change', (e) => {
  state.all = e.target.checked;
  state.cache.clear();
  if (state.view === 'topic' || state.view === 'game') RENDER[state.view]();
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const map = { 1: 'topic', 2: 'game', 3: 'hot', 4: 'digest', 5: 'sources' };
  if (map[e.key]) switchView(map[e.key]);
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    const old = b.textContent;
    b.textContent = '已复制';
    setTimeout(() => (b.textContent = old), 1200);
  } catch {}
});

detectMode().then(() => {
  loadStats();
  switchView(location.hash.slice(1) || 'topic');
});
