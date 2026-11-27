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

const DEFAULT_DAYS = { topic: 3, game: 14 };
const state = { view: 'topic', days: 3, all: false, cache: new Map(), static: false, mustknow: null };

async function api(path) {
  const r = await fetch(path, { cache: 'no-store' });
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
    const when = s.generated_at
      ? new Date(s.generated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';
    $('#statline').textContent = `${s.items} 条 · ${s.events} 事件 · ${s.sources} 源${when ? ` · 更新 ${when}` : ''}`;
  } catch {}
}

/** 重点游戏的状态标签：分数说「值不值得谈」，这个说「还来不来得及」。 */
function stageClass(label) {
  if (!label) return '';
  if (label === '尚未发售') return 'st-coming';
  if (label.indexOf('首发') === 0) return 'st-launch';
  if (label.indexOf('上线') === 0) return 'st-age';
  return 'st-miss';
}

const STEAM_HEADER = (id) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;

function card(e, passing, lead, prevSrc, radar) {
  const isGame = radar === 'game';
  const cls = [passing ? 'pass' : 'fail', lead ? 'lead' : '', isGame ? 'game' : '']
    .join(' ').replace(/\s+/g, ' ').trim();
  const tierBadge = e.tier === 3 ? '<span class="tier3">一手</span>' : '';
  const heat = e.event_sources > 1 ? `<span>${e.event_sources} 源在说</span>` : '';
  const also = (e.also ?? 1) > 1 ? `<span class="also">同事件另有 ${e.also - 1} 篇</span>` : '';
  const stage = isGame && e.stage_label
    ? `<span class="stage ${stageClass(e.stage_label)}">${esc(e.stage_label)}</span>` : '';

  const headline = isGame ? (e.games && e.games[0]) || e.title : e.title;
  // 重点游戏把游戏名当标题、原文章标题退成一行出处；选题则相反。
  const sub = isGame && (e.games || []).length ? `<p class="art">${esc(e.title)}</p>` : '';

  // 封面列永远占位，保证所有行的正文宽度一致；图挂了就把这一格留空。
  const cover = isGame
    ? `<div class="cover">${e.appid ? `<img src="${STEAM_HEADER(e.appid)}" alt="" loading="lazy"
         onerror="this.closest('.cover').classList.add('nocover');this.remove()" />` : ''}</div>`
    : '';

  return `
  <article class="row ${cls}" data-id="${e.item_id}">
    <div class="s">${Math.round(e.total)}</div>
    <div class="b">
      <h3><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(headline)}</a></h3>
      ${e.verdict ? `<p class="v">${esc(e.verdict)}</p>` : ''}
      <div class="m">
        ${stage}
        ${e.source_name && e.source_name !== prevSrc ? `<span class="src">${esc(e.source_name)}${tierBadge}</span>` : ''}
        <span>${e.published_at ? relTime(e.published_at) : e.rank ? `榜 #${e.rank}` : '时间未知'}</span>
        ${heat}${also}
      </div>
      ${sub}
      ${lead && e.angle ? `<p class="a">${esc(e.angle)}</p>` : ''}
    </div>
    ${cover}
  </article>`;
}

const MK_KEY = 'radar.mkOpen';
function mkIsOpen() {
  try {
    return localStorage.getItem(MK_KEY) === '1';
  } catch {
    return false;
  }
}

function mustKnowStrip(rows) {
  if (!rows.length) return '';
  const open = mkIsOpen();
  const top = rows.filter((h) => h.sources >= 3).slice(0, 8);
  const usedIds = new Set(top.map((h) => h.event_id));
  const more = rows.filter((h) => !usedIds.has(h.event_id)).slice(0, 24);
  const rowOf = (h, showSources) => {
    const days = Math.max(1, Math.round((new Date(h.last_at) - new Date(h.first_at)) / 86400000));
    const names = String(h.source_names || '').split(' / ').slice(0, 3).join(' / ');
    const lead = showSources ? h.sources : h.heat.toFixed(0);
    return `<a class="mk-row"${h.url ? ` href="${esc(h.url)}" target="_blank" rel="noopener"` : ''}>
        <span class="mk-s">${lead}</span>
        <span class="mk-t">${esc(h.title)}</span>
        <span class="mk-m">${esc(names)}${days > 1 ? ` · 已持续 ${days} 天` : ''}</span>
      </a>`;
  };
  return `
  <section class="mk${open ? '' : ' mk-collapsed'}" id="mk">
    <button class="mk-head" type="button" id="mk-toggle" aria-expanded="${open}">
      <b>今日必知</b>
      <span class="mk-sub">${top.length} 条多家在说 · 另有 ${more.length} 条单一来源在涨</span>
      <span class="mk-chev">${open ? '收起 ▴' : '展开 ▾'}</span>
    </button>
    <div class="mk-body">
      <div class="mk-note">左边数字＝几家在说（3 家以上算「全网在说」）；下面第二部分按热度排，数字是热度值</div>
      ${top.map((h) => rowOf(h, true)).join('')}
      ${more.length ? `<div class="mk-div">单一来源，但热度在涨</div>${more.map((h) => rowOf(h, false)).join('')}` : ''}
    </div>
  </section>`;
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
    const mk0 = radar === 'topic' ? mustKnowStrip(await getHot()) : '';
    el.innerHTML = noModel
      ? mk0 + `<div class="empty">
          <strong>打分层还没跑起来。</strong><br /><br />
          抓取是正常的（已经存了 ${st.items} 条资讯、归并成 ${st.events} 个事件），但还没有任何一条被模型打过分。<br /><br />
          原因通常只有一个：<b>没配模型 key</b>。在 <code>app/.env</code> 里填 <code>LLM_API_KEY</code>，然后跑一次
          <code>npm run run</code>，这一栏就会有内容了。
        </div>`
      : mk0 + `<div class="empty">
          ${state.all ? '还没有任何打分结果。' : '没有过门槛的条目。'}<br /><br />
          先跑一次 <code>npm run run</code>，或者勾上右上角的「显示未过门槛」降低标准看全量。
        </div>`;
    return;
  }
  const list = state.all ? data.entries : data.entries.filter((e) => e.pass !== false);
  const head = `<div class="boardbar">近 ${state.days} 天 · ${list.length} 条${state.all ? '候选' : '过门槛'}</div>`;
  const mk = radar === 'topic' ? mustKnowStrip(await getHot()) : '';
  el.innerHTML =
    mk +
    head +
    list
      .map((e, i) => card(e, e.pass !== false, i === 0, i ? list[i - 1].source_name : null, radar))
      .join('');
}

/** 极简 markdown：够渲染我们自己生成的日报就行。 */
function md(src) {
  const lines = src.split('\n');
  const out = [];
  let inList = false;
  let mdH3 = 0;
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
    if (l.startsWith('### ')) { mdH3 += 1; out.push(`<h3 id="s${mdH3}">${inline(l.slice(4))}</h3>`); }
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

async function renderArchive() {
  const el = $('#view-archive');
  el.innerHTML = '<div class="empty">载入中…</div>';
  try {
    const list = await getDigests();
    if (!list.length) {
      el.innerHTML = '<div class="empty">还没有日报。云端每天 8 点会自动生成一份。</div>';
      return;
    }
    const want = state.digestDate || list[0].date;
    const chips = list
      .slice(0, 30)
      .map((d) => `<button class="dchip${d.date === want ? ' on' : ''}" data-date="${esc(d.date)}">${esc(d.date.slice(5))}</button>`)
      .join('');
    el.innerHTML = `<div class="dbar">${chips}</div><div id="dbody" class="empty">载入中…</div>`;
    el.querySelectorAll('.dchip').forEach((b) =>
      b.addEventListener('click', () => {
        state.digestDate = b.dataset.date;
        renderArchive();
      })
    );

    const d = await getDigest(want);
    const body = $('#dbody');
    if (!body) return;
    // 只留题目索引，全文折叠——存档是用来回溯的，不是用来看的
    // 索引按日报自己的章节分组（一、选题雷达 / 二、重点游戏雷达 …），
    // 编号也跟着章节走，不然会出现两个「1」。
    const blocks = [];
    let cur = null;
    let hn = 0;
    for (const line of String(d.markdown || '').split('\n')) {
      if (line.startsWith('## ')) {
        cur = { title: line.slice(3).trim(), rows: [] };
        blocks.push(cur);
      } else if (line.startsWith('### ')) {
        hn += 1;
        const m = line.slice(4).match(/^(\d+)\.\s*(.*)$/);
        if (m && cur) cur.rows.push({ n: m[1], t: m[2], id: `s${hn}` });
      }
    }
    const idx = blocks
      .filter((b) => b.rows.length)
      .map(
        (b) => `<div class="dix-sec"><h4>${esc(b.title)}</h4>${b.rows
          .map(
            (r) => `<a class="dix-row" href="#${r.id}"><b>${r.n}</b><span>${esc(r.t)}</span></a>`
          )
          .join('')}</div>`
      )
      .join('');
    body.className = '';
    body.innerHTML = `
      <div class="dix">${idx || '<div class="empty">这一天没有条目</div>'}</div>
      <details class="dall"><summary>看完整日报</summary><div class="md">${md(d.markdown || '')}</div></details>`;
    body.querySelectorAll('.dix-row').forEach((a) =>
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const det = body.querySelector('.dall');
        if (det) det.open = true;
        const target = body.querySelector(`#${a.getAttribute('href').slice(1)}`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
    );
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

const RENDER = { topic: () => renderBoard('topic'), game: () => renderBoard('game'), archive: renderArchive, sources: renderSources };

function switchView(v) {
  if (!RENDER[v]) v = 'topic';
  state.view = v;
  // 两个雷达的「新鲜」标准不一样：选题按天看，重点游戏按两周看
  // （游戏从被发现到下决定要不要谈，本来就不是一天的事）
  if (DEFAULT_DAYS[v]) {
    state.days = DEFAULT_DAYS[v];
    const sel = $('#days');
    if (sel) sel.value = String(state.days);
  }
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
  const map = { 1: 'topic', 2: 'game', 3: 'archive', 4: 'sources' };
  if (map[e.key]) switchView(map[e.key]);
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('#mk-toggle');
  if (!t) return;
  const sec = t.closest('.mk');
  const open = sec.classList.toggle('mk-collapsed') === false;
  t.setAttribute('aria-expanded', String(open));
  const chev = t.querySelector('.mk-chev');
  if (chev) chev.textContent = open ? '收起 ▴' : '展开 ▾';
  try {
    localStorage.setItem(MK_KEY, open ? '1' : '0');
  } catch {}
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
