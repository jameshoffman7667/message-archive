// Message Archive front end. No framework, and no HTML parsing of data: every node is built with h().
const $app = document.getElementById('app');
const MOBILE = () => window.matchMedia('(max-width: 767px)').matches;

// ---------- DOM helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  chats: 'M4 5h16v11H8l-4 4z',
  search: 'M10.5 4a6.5 6.5 0 1 0 4 11.6l4.4 4.4 1.4-1.4-4.4-4.4A6.5 6.5 0 0 0 10.5 4zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
  imports: 'M12 3v10m0 0-4-4m4 4 4-4M4 15v4h16v-4',
  stats: 'M5 20V10m7 10V4m7 16v-7',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6 6 18',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  warn: 'M12 4 2.5 20h19zM12 10v4m0 3v.5',
  group: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 19c0-3 3-5 6-5s6 2 6 5m0-4.6c.6-.2 1.3-.4 2-.4 3 0 6 2 6 5',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  calendar: 'M5 6h14v14H5zM5 10h14M9 4v4m6-4v4',
};
function icon(name) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name]);
  s.append(p);
  return s;
}

// ---------- formatting ----------
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const fmtShort = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function when(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  if (dayKey(ms) === dayKey(now.getTime())) return fmtTime.format(d);
  if (d.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
  return fmtShort.format(d);
}
function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
const num = (n) => Number(n || 0).toLocaleString();
const phone = (a) => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(a); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : a; };
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
function initials(title) {
  const w = String(title || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '#';
  if (/^\d/.test(w[0])) return '#';
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}
const colorOf = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) >>> 0; return `c${x % 8}`; };
function avatar(conv) {
  if (conv.is_group) return h('div', { class: `avatar group ${colorOf(conv.title)}`, 'aria-hidden': 'true' }, icon('group'));
  return h('div', { class: `avatar ${colorOf(conv.title)}`, 'aria-hidden': 'true' }, initials(conv.title));
}

// ---------- API ----------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') opts.headers['X-Requested-With'] = 'fetch';
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && !path.startsWith('/api/auth/')) { state.auth = null; render(); throw new ApiError(401, 'signed out'); }
  if (!res.ok) throw new ApiError(res.status, data?.error || `request failed (${res.status})`);
  return data;
}

// ---------- state and routing ----------
const state = { auth: null, convs: null, convFilter: '', thread: null, lightbox: null, jobsTimer: null };
function route() {
  const u = new URL(location.href);
  const p = u.pathname;
  let m;
  if ((m = /^\/c\/(\d+)\/?$/.exec(p))) return { name: 'thread', id: Number(m[1]), msg: Number(u.searchParams.get('m')) || null };
  if (p.startsWith('/search')) return { name: 'search', params: u.searchParams };
  if (p.startsWith('/imports')) return { name: 'imports' };
  if (p.startsWith('/stats')) return { name: 'stats' };
  if (p.startsWith('/settings')) return { name: 'settings' };
  return { name: 'chats' };
}
function go(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
window.addEventListener('popstate', () => {
  if (state.lightbox && !history.state?.lightbox) { closeLightbox(false); return; }
  render();
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

// ---------- shell ----------
const NAV = [['chats', '/', 'Chats'], ['search', '/search', 'Search'], ['imports', '/imports', 'Imports'], ['stats', '/stats', 'Stats'], ['settings', '/settings', 'Settings']];
let shell = null;
function buildShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    h('span', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '' }), 'Message Archive'),
    NAV.map(([key, href, label]) => h('a', { href, 'data-nav': '', dataset: { key } }, icon(key), h('span', { text: label }))));
  const main = h('div', { class: 'main' });
  const root = h('div', { class: 'shell' }, nav, main);
  return { root, nav, main };
}
function setNav(active) {
  for (const a of shell.nav.querySelectorAll('a[data-key]')) {
    a.classList.toggle('active', a.dataset.key === active);
    if (a.dataset.key === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

async function render() {
  if (!state.auth) {
    try { state.auth = await api('/api/auth/state'); } catch { state.auth = null; }
    if (!state.auth) { $app.replaceChildren(h('div', { class: 'boot', text: 'Cannot reach the server.' })); return; }
  }
  if (!state.auth.signedIn) { shell = null; renderSignIn(); return; }
  if (!shell) { shell = buildShell(); $app.className = ''; $app.replaceChildren(shell.root); }
  const r = route();
  setNav(r.name === 'thread' ? 'chats' : r.name);
  shell.root.classList.toggle('in-thread', r.name === 'thread' || (r.name === 'search' && !!r.params.get('c') && MOBILE()));
  shell.main.className = 'main';
  if (r.name === 'chats' || r.name === 'thread') return renderChats(r);
  if (r.name === 'search') return renderSearch(r);
  shell.main.classList.add('single');
  if (r.name === 'imports') return renderImports();
  if (r.name === 'stats') return renderStats();
  if (r.name === 'settings') return renderSettings();
}

// ---------- sign-in / first run ----------
function renderSignIn() {
  const setup = !state.auth.setup;
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 10 : null });
  const pw2 = setup ? h('input', { type: 'password', id: 'pw2', autocomplete: 'new-password', required: true }) : null;
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit', text: setup ? 'Create password' : 'Sign in' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (setup && pw.value !== pw2.value) { err.textContent = 'The passwords do not match.'; return; }
      btn.disabled = true;
      try {
        await api(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { password: pw.value } });
        state.auth = null;
        await render();
      } catch (x) { err.textContent = x.message; btn.disabled = false; }
    },
  },
  h('label', { for: 'pw', text: setup ? 'New password (at least 10 characters)' : 'Password' }), pw,
  setup ? [h('label', { for: 'pw2', text: 'Repeat password' }), pw2] : null,
  err, h('div', { class: 'actions' }, btn));
  $app.className = '';
  $app.replaceChildren(h('main', { class: 'center-card' }, h('div', { class: 'card' },
    h('img', { src: '/icons/icon-192.png', alt: '', width: 56, height: 56 }),
    h('h1', { text: setup ? 'Set up Message Archive' : 'Message Archive' }),
    h('p', { class: 'muted', text: setup ? 'Choose the password for this archive. Only you will use it.' : 'Sign in to view your archived messages.' }),
    form)));
  pw.focus();
}

// ---------- chats ----------
async function loadConvs(force = false) {
  if (state.convs && !force) return state.convs;
  const d = await api('/api/conversations?limit=2000');
  state.convs = d.conversations;
  return state.convs;
}

function convList(activeId, onPick) {
  const filter = h('input', { type: 'search', placeholder: 'Filter by name or number', 'aria-label': 'Filter conversations', value: state.convFilter, id: 'conv-filter' });
  const scroll = h('div', { class: 'list-scroll', role: 'list' });
  const draw = () => {
    const q = state.convFilter.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    const rows = (state.convs || []).filter((c) => !q || c.title.toLowerCase().includes(q) || (qd && c.participants.some((p) => p.includes(qd))));
    if (!state.convs) { scroll.replaceChildren(h('div', { class: 'empty', text: 'Loading…' })); return; }
    if (!rows.length) {
      scroll.replaceChildren(h('div', { class: 'empty' }, state.convs.length ? 'No conversation matches.' : [h('p', { text: 'The archive is empty.' }), h('p', null, 'Set up the phone upload on the ', h('a', { href: '/imports', 'data-nav': '', text: 'Imports' }), ' page.')]));
      return;
    }
    scroll.replaceChildren(...rows.map((c) => h('a', {
      class: `conv${c.id === activeId ? ' active' : ''}`, href: `/c/${c.id}`, role: 'listitem', 'data-nav': onPick ? null : '',
      onclick: onPick ? (e) => { e.preventDefault(); onPick(c); } : null,
    }, avatar(c), h('div', { class: 'body' }, h('div', { class: 'who', text: c.title }), h('div', { class: 'snip', text: c.last_snippet || '' })),
    h('div', { class: 'when', text: when(c.last_date) }))));
  };
  filter.addEventListener('input', () => { state.convFilter = filter.value; draw(); });
  draw();
  return { filter, scroll, draw };
}

async function renderChats(r) {
  const activeId = r.name === 'thread' ? r.id : null;
  shell.main.classList.add(activeId ? 'mobile-thread' : 'mobile-list');
  const list = convList(activeId);
  const listPane = h('section', { class: 'pane list', 'aria-label': 'Conversations' },
    h('div', { class: 'list-head' }, h('h1', { text: 'Chats' }), list.filter), list.scroll);
  const threadPane = h('section', { class: 'pane thread', 'aria-label': 'Conversation' });
  shell.main.replaceChildren(listPane, threadPane);
  if (!state.convs) loadConvs().then(() => list.draw()).catch(() => {});
  if (activeId) openThread(threadPane, activeId, r.msg, { backTo: '/' });
  else threadPane.append(h('div', { class: 'placeholder' }, h('div', null, h('p', { text: 'Pick a conversation.' }), h('p', { class: 'small', text: 'Press / to filter.' }))));
}

// ---------- thread ----------
function mediaNode(p, msg) {
  if (p.missing || !p.sha) {
    return h('span', { class: 'file-chip missing', title: msg.restricted ? 'End-to-end encrypted RCS: run a backup "as default SMS app" to capture it.' : 'This attachment was not in any backup so far.' },
      icon('warn'), `${p.name || p.ct || 'Attachment'} not in backup`);
  }
  const src = `/api/media/${p.sha}`;
  const ct = String(p.ct || '').toLowerCase();
  if (ct.startsWith('image/') && !/heic|heif/.test(ct)) {
    const img = h('img', { src, alt: p.name || 'Photo', loading: 'lazy', decoding: 'async', tabindex: '0', role: 'button' });
    const open = () => openLightbox(p);
    img.addEventListener('click', open);
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    img.addEventListener('error', () => img.replaceWith(fileChip(p)), { once: true });
    return img;
  }
  if (ct.startsWith('video/')) return h('video', { src, controls: true, preload: 'none', playsinline: true, 'aria-label': p.name || 'Video' });
  if (ct.startsWith('audio/')) return h('audio', { src, controls: true, preload: 'none', 'aria-label': p.name || 'Audio' });
  return fileChip(p);
}
function fileChip(p) {
  return h('a', { class: 'file-chip', href: `/api/media/${p.sha}?download&name=${encodeURIComponent(p.name || 'attachment')}`, download: p.name || '' },
    icon('file'), `${p.name || p.ct || 'Attachment'} · ${bytes(p.size)}`);
}

function messageNodes(msgs, conv, prev) {
  const out = [];
  let last = prev;
  for (const m of msgs) {
    if (!last || dayKey(last.date) !== dayKey(m.date)) out.push(h('div', { class: 'day', text: fmtDay.format(new Date(m.date)) }));
    const out_ = m.box !== 1;
    const first = !last || last.box !== m.box || last.sender !== m.sender || m.date - last.date > 10 * 60_000 || dayKey(last.date) !== dayKey(m.date);
    const node = h('div', { class: `msg ${out_ ? 'out' : 'in'}${first ? ' first' : ''}`, id: `m${m.id}`, dataset: { id: m.id, date: m.date } },
      first && conv.is_group && !out_ && m.senderName ? h('div', { class: 'from', text: m.senderName }) : null,
      m.parts.length ? h('div', { class: 'media' }, m.parts.map((p) => mediaNode(p, m))) : null,
      m.body ? h('div', { class: 'bubble', text: m.body }) : null,
      !m.body && !m.parts.length ? h('div', { class: 'bubble muted', text: m.restricted ? '(encrypted message, not readable in this backup)' : '(empty message)' }) : null,
      h('div', { class: 'meta', title: fmtFull.format(new Date(m.date)), text: fmtTime.format(new Date(m.date)) + (m.box >= 3 ? ' · not sent' : '') }));
    out.push(node);
    last = m;
  }
  return out;
}

async function openThread(pane, id, highlight, { backTo }) {
  const token = {};
  state.thread = token;
  pane.replaceChildren(h('div', { class: 'placeholder', text: 'Loading…' }));
  let conv;
  try { conv = await api(`/api/conversations/${id}`); } catch (e) { pane.replaceChildren(h('div', { class: 'placeholder', text: e.status === 404 ? 'Conversation not found.' : e.message })); return; }
  if (state.thread !== token) return;
  const jump = h('input', { type: 'date', class: 'jump-input', tabindex: '-1', 'aria-hidden': 'true' });
  const jumpBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Jump to date', title: 'Jump to date', onclick: () => { try { jump.showPicker(); } catch { jump.focus(); } } }, icon('calendar'));
  if (conv.first_date) { jump.min = new Date(conv.first_date).toISOString().slice(0, 10); jump.max = new Date(conv.last_date).toISOString().slice(0, 10); }
  const sub = conv.participants.length > 1
    ? `${conv.participants.length} people · ${num(conv.message_count)} messages`
    : `${phone(conv.participants[0]?.address || '')} · ${num(conv.message_count)} messages`;
  const head = h('header', { class: 'thread-head' },
    h('button', { class: 'icon-btn back', 'aria-label': 'Back', onclick: () => (history.length > 1 && history.state ? history.back() : go(backTo)) }, icon('back')),
    avatar(conv), h('div', { class: 'title' }, h('b', { text: conv.title }), h('span', { text: sub })), h('span', { class: 'jump' }, jump, jumpBtn));
  const inner = h('div', { class: 'thread-inner' });
  const scroller = h('div', { class: 'thread-scroll' }, inner);
  pane.replaceChildren(head, scroller);

  let loaded = [];
  let hasOlder = false, hasNewer = false, busy = false;
  const topLoader = h('div', { class: 'loader', text: 'Loading older messages…' });
  const bottomLoader = h('div', { class: 'loader', text: 'Loading newer messages…' });

  function draw() {
    inner.replaceChildren(hasOlder ? topLoader : h('div', { class: 'loader', text: conv.first_date ? `Start of the archive · ${fmtShort.format(new Date(conv.first_date))}` : '' }),
      ...messageNodes(loaded, conv, null), hasNewer ? bottomLoader : '');
  }
  async function load(params) {
    const q = new URLSearchParams({ limit: '80', ...params });
    return api(`/api/conversations/${id}/messages?${q}`);
  }
  async function initial(anchorParams) {
    busy = true;
    const d = await load(anchorParams || {});
    if (state.thread !== token) return;
    loaded = d.messages; hasOlder = !!d.hasOlder; hasNewer = !!d.hasNewer;
    draw();
    const target = d.anchor ? inner.querySelector(`#m${d.anchor}`) : null;
    if (target) {
      if (highlight && d.anchor === highlight) target.classList.add('hl');
      target.scrollIntoView({ block: 'center' });
    } else scroller.scrollTop = scroller.scrollHeight;
    busy = false;
  }
  async function older() {
    if (busy || !hasOlder || !loaded.length) return;
    busy = true;
    const first = loaded[0];
    const d = await load({ beforeDate: first.date, beforeId: first.id });
    if (state.thread !== token) return;
    const before = scroller.scrollHeight, top = scroller.scrollTop;
    loaded = [...d.messages, ...loaded]; hasOlder = !!d.hasOlder;
    draw();
    scroller.scrollTop = scroller.scrollHeight - before + top;
    busy = false;
  }
  async function newer() {
    if (busy || !hasNewer || !loaded.length) return;
    busy = true;
    const last = loaded[loaded.length - 1];
    const d = await load({ afterDate: last.date, afterId: last.id });
    if (state.thread !== token) return;
    const top = scroller.scrollTop;
    loaded = [...loaded, ...d.messages]; hasNewer = !!d.hasNewer;
    draw();
    scroller.scrollTop = top;
    busy = false;
  }
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop < 300) older().catch(() => { busy = false; });
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 300) newer().catch(() => { busy = false; });
  }, { passive: true });
  jump.addEventListener('change', () => {
    if (!jump.value) return;
    const [y, mo, d] = jump.value.split('-').map(Number);
    initial({ aroundDate: String(new Date(y, mo - 1, d).getTime()) }).catch(() => {});
  });
  try { await initial(highlight ? { around: String(highlight) } : null); } catch (e) { inner.replaceChildren(h('div', { class: 'placeholder', text: e.message })); }
}

// ---------- lightbox (has its own history entry so Back closes it) ----------
function openLightbox(p) {
  closeLightbox(false);
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.name || 'Photo' },
    h('div', { class: 'bar' },
      h('a', { class: 'icon-btn', href: `/api/media/${p.sha}?download&name=${encodeURIComponent(p.name || 'photo')}`, 'aria-label': 'Download' }, icon('download')),
      h('span', { class: 'small', text: `${p.name || ''} · ${bytes(p.size)}` }),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => closeLightbox(true) }, icon('close'))),
    h('div', { class: 'stage', onclick: (e) => { if (e.target.classList.contains('stage')) closeLightbox(true); } }, h('img', { src: `/api/media/${p.sha}`, alt: p.name || 'Photo' })));
  document.body.append(box);
  state.lightbox = box;
  history.pushState({ lightbox: true }, '', location.href);
  box.querySelector('button').focus();
}
function closeLightbox(viaHistory) {
  if (!state.lightbox) return;
  state.lightbox.remove();
  state.lightbox = null;
  if (viaHistory && history.state?.lightbox) history.back();
}

// ---------- search ----------
let convOptionsCache = null;
async function renderSearch(r) {
  const p = r.params;
  const openC = Number(p.get('c')) || null, openM = Number(p.get('m')) || null;
  shell.main.classList.add(openC ? 'mobile-thread' : 'mobile-list');
  const q = h('input', { type: 'search', id: 'q', placeholder: 'Search all messages', value: p.get('q') || '', 'aria-label': 'Search text', enterkeyhint: 'search' });
  const conv = h('select', { id: 'f-conv', 'aria-label': 'Conversation' }, h('option', { value: '', text: 'All conversations' }));
  const from = h('input', { type: 'date', id: 'f-from', value: p.get('from') || '' });
  const to = h('input', { type: 'date', id: 'f-to', value: p.get('to') || '' });
  const media = h('input', { type: 'checkbox', id: 'f-media' });
  media.checked = p.get('media') === '1';
  const results = h('div', { class: 'list-scroll', 'aria-live': 'polite' });
  const form = h('form', {
    class: 'filters', role: 'search',
    onsubmit: (e) => {
      e.preventDefault();
      const n = new URLSearchParams();
      if (q.value.trim()) n.set('q', q.value.trim());
      if (conv.value) n.set('conv', conv.value);
      if (from.value) n.set('from', from.value);
      if (to.value) n.set('to', to.value);
      if (media.checked) n.set('media', '1');
      go(`/search${n.toString() ? '?' + n : ''}`);
    },
  }, h('div', { class: 'row' }, q, h('button', { class: 'btn primary', type: 'submit', text: 'Search' })),
  h('div', null, h('label', { for: 'f-conv', text: 'Contact' }), conv),
  h('div', { class: 'field-row two' },
    h('div', null, h('label', { for: 'f-from', text: 'From' }), from),
    h('div', null, h('label', { for: 'f-to', text: 'To' }), to)),
  h('label', { class: 'check', for: 'f-media' }, media, 'Only messages with photos or videos'));
  const listPane = h('section', { class: 'pane list', 'aria-label': 'Search' }, h('div', { class: 'list-head' }, h('h1', { text: 'Search' }), form), results);
  const threadPane = h('section', { class: 'pane thread', 'aria-label': 'Conversation' });
  shell.main.replaceChildren(listPane, threadPane);

  loadConvs().then((cs) => {
    if (!convOptionsCache) convOptionsCache = cs.slice().sort((a, b) => a.title.localeCompare(b.title));
    conv.append(...convOptionsCache.map((c) => h('option', { value: String(c.id), text: c.title })));
    conv.value = p.get('conv') || '';
  }).catch(() => {});

  if (openC) openThread(threadPane, openC, openM, { backTo: `/search?${strip(p)}` });
  else threadPane.append(h('div', { class: 'placeholder', text: 'Results open here.' }));

  const hasQuery = p.get('q') || p.get('conv') || p.get('from') || p.get('to') || p.get('media');
  if (!hasQuery) {
    results.replaceChildren(h('div', { class: 'empty', text: 'Search covers every archived message. Matching ignores case and accents; the last word matches as a prefix.' }));
    if (!openC && !MOBILE()) q.focus();
    return;
  }
  const params = new URLSearchParams({ limit: '50' });
  if (p.get('q')) params.set('q', p.get('q'));
  if (p.get('conv')) params.set('conversation', p.get('conv'));
  if (p.get('from')) params.set('from', String(localDay(p.get('from'))));
  if (p.get('to')) params.set('to', String(localDay(p.get('to')) + 86400_000));
  if (p.get('media')) params.set('media', '1');
  let offset = 0;
  results.replaceChildren(h('div', { class: 'empty', text: 'Searching…' }));
  const more = h('button', { class: 'btn', type: 'button', text: 'Load more' });
  const wrap = h('div');
  async function page() {
    params.set('offset', String(offset));
    const d = await api(`/api/search?${params}`);
    if (offset === 0) results.replaceChildren(h('div', { class: 'loader', text: `${num(d.total)} result${d.total === 1 ? '' : 's'}` }), wrap);
    for (const x of d.results) {
      const base = new URLSearchParams(p); base.set('c', String(x.conversationId)); base.set('m', String(x.id));
      const href = MOBILE() ? `/c/${x.conversationId}?m=${x.id}` : `/search?${base}`;
      wrap.append(h('a', { class: `result${x.id === openM ? ' active' : ''}`, href, 'data-nav': '' },
        h('div', { class: 'top' }, h('b', { text: x.title }), h('span', { text: fmtShort.format(new Date(x.date)) })),
        h('div', { class: 'text' }, x.box !== 1 ? h('span', { class: 'muted', text: 'You: ' }) : (x.senderName && x.senderName !== x.title ? h('span', { class: 'muted', text: `${x.senderName}: ` }) : null),
          x.snippet.length ? x.snippet.map((s) => (s.h ? h('mark', { text: s.t }) : s.t)) : h('span', { class: 'muted', text: x.mediaCount ? '[photo or video]' : '' }))));
    }
    offset += d.results.length;
    more.remove();
    if (offset < d.total) results.append(h('div', { class: 'actions' }, more));
  }
  more.addEventListener('click', () => page().catch(() => {}));
  try { await page(); } catch (e) { results.replaceChildren(h('div', { class: 'empty', text: e.message })); }
}
const strip = (p) => { const n = new URLSearchParams(p); n.delete('c'); n.delete('m'); return n.toString(); };
const localDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

// ---------- imports ----------
async function renderImports() {
  const page = h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('h1', { text: 'Imports' }), h('p', { class: 'muted', text: 'Loading…' })));
  shell.main.replaceChildren(page);
  const draw = async () => {
    if (route().name !== 'imports') return;
    let d, s;
    try { [d, s] = await Promise.all([api('/api/imports'), api('/api/settings')]); } catch { return; }
    const jobs = d.jobs;
    const busy = !!jobs.running || jobs.queued.length > 0;
    const scan = h('button', { class: 'btn primary', type: 'button', text: 'Scan inbox now', disabled: busy, onclick: async () => { await api('/api/imports/scan', { method: 'POST' }); draw(); } });
    const verify = h('button', { class: 'btn', type: 'button', text: 'Verify all media files', disabled: busy, onclick: async () => { await api('/api/media/verify', { method: 'POST' }); draw(); } });
    const lastVerify = jobs.last['verify-media'];
    const inner = h('div', { class: 'page-inner' }, h('h1', { text: 'Imports' }),
      !s.dav.enabled ? h('div', { class: 'notice warn' }, 'Phone upload is off. ', h('a', { href: '/settings', 'data-nav': '', text: 'Set a WebDAV password in Settings' }), ' to let SMS Backup & Restore upload here.') : null,
      h('div', { class: 'card' },
        h('h2', { text: 'Inbox' }),
        h('p', { class: 'muted', text: `New backups are picked up when an upload finishes, and the inbox is scanned every ${d.inbox.scanIntervalMinutes || '–'} minutes. Files copied in by hand are imported once they have been unchanged for ${d.inbox.settleSeconds} seconds.` }),
        jobs.running ? h('p', null, h('span', { class: 'badge running', text: 'running' }), ` ${jobs.running.name}${jobs.running.progress ? ' · ' + jobs.running.progress : ''}`) : null,
        lastVerify ? h('p', { class: 'small' }, lastVerify.ok
          ? `Last media check ${fmtFull.format(new Date(lastVerify.finished))}: ${num(lastVerify.result.ok)} of ${num(lastVerify.result.total)} files OK${lastVerify.result.missing || lastVerify.result.mismatched ? `, ${lastVerify.result.missing} missing, ${lastVerify.result.mismatched} damaged` : ''}.`
          : `Last media check failed: ${lastVerify.error}`) : null,
        h('div', { class: 'actions' }, scan, verify)),
      h('div', { class: 'card' }, h('h2', { text: 'History' }),
        d.imports.length ? d.imports.map(importRow) : h('p', { class: 'muted', text: 'No backups imported yet.' })));
    page.replaceChildren(inner);
    clearTimeout(state.jobsTimer);
    if (busy || d.imports.some((i) => i.status === 'running')) state.jobsTimer = setTimeout(draw, 3000);
  };
  await draw();
}
function importRow(i) {
  const retry = (i.status === 'failed' || i.status === 'interrupted') ? h('button', { class: 'btn', type: 'button', text: 'Retry', onclick: async (e) => { e.target.disabled = true; try { await api(`/api/imports/${i.id}/retry`, { method: 'POST' }); } catch (x) { alert(x.message); } renderImports(); } }) : null;
  return h('div', { class: 'imp' },
    h('div', { class: 'top' }, h('span', { class: `badge ${i.status}`, text: i.status }), h('span', { class: 'name', text: i.file_name }), h('span', { class: 'muted small', text: `#${i.id} · ${bytes(i.file_size)} · ${i.source}` })),
    h('div', { class: 'small', text: i.message || '' }),
    i.parsed ? h('div', { class: 'small muted', text: `${num(i.parsed_sms)} SMS, ${num(i.parsed_mms)} MMS · ${num(i.new_messages)} new · ${num(i.media_new)} new media files (${bytes(i.media_new_bytes)})${i.upgraded_messages ? ` · ${num(i.upgraded_messages)} completed` : ''}${i.restricted ? ` · ${num(i.restricted)} restricted` : ''}` }) : null,
    h('div', { class: 'small muted', text: `${i.started_at ? fmtFull.format(new Date(i.started_at)) : ''}${i.backup_date ? ` · backup made ${fmtFull.format(new Date(i.backup_date))}` : ''}` }),
    retry);
}

// ---------- stats ----------
async function renderStats() {
  const page = h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('h1', { text: 'Stats' }), h('p', { class: 'muted', text: 'Loading…' })));
  shell.main.replaceChildren(page);
  let s;
  try { s = await api('/api/stats'); } catch (e) { return; }
  const t = s.totals;
  const maxYear = Math.max(1, ...s.byYear.map((y) => y.messages));
  const bars = s.byYear.map((y) => {
    const fill = h('div', { class: 'bar-fill' });
    fill.style.width = `${Math.round((y.messages / maxYear) * 100)}%`;
    return h('div', { class: 'bar-row' }, h('span', { text: y.year }), h('div', { class: 'bar-track', title: `${num(y.messages)} messages` }, fill), h('span', { class: 'num', text: `${num(y.messages)} · ${bytes(y.media_bytes)}` }));
  });
  page.replaceChildren(h('div', { class: 'page-inner' }, h('h1', { text: 'Stats' }),
    h('div', { class: 'tiles' },
      tile(num(t.messages), 'messages'), tile(num(t.conversations), 'conversations'), tile(num(t.mediaFiles), 'media files'), tile(bytes(t.mediaBytes), 'media stored')),
    h('div', { class: 'card' }, h('h2', { text: 'Older than the cutoff' }),
      h('p', null, `Messages older than ${s.cutoff.days} days (and outside the last ${s.cutoff.keepRecentDays} days): `, h('b', { text: num(s.cutoff.messages) }), ', with ', h('b', { text: num(s.cutoff.mediaParts) }), ' attachments (', h('b', { text: bytes(s.cutoff.mediaBytes) }), ').'),
      h('p', { class: 'muted small', text: `That is before ${fmtShort.format(new Date(s.cutoff.before))}. Read-only preview: nothing is deleted from the phone in this version.` })),
    h('div', { class: 'card' }, h('h2', { text: 'By year' }), s.byYear.length ? h('div', { class: 'bars' }, bars) : h('p', { class: 'muted', text: 'Nothing archived yet.' })),
    h('div', { class: 'card' }, h('h2', { text: 'Details' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'SMS / MMS' }), h('dd', { text: `${num(t.sms)} / ${num(t.mms)}` }),
        h('dt', { text: 'Date range' }), h('dd', { text: t.oldest ? `${fmtShort.format(new Date(t.oldest))} to ${fmtShort.format(new Date(t.newest))}` : '–' }),
        h('dt', { text: 'Attachments not in backups' }), h('dd', { text: num(t.mediaMissing) }),
        h('dt', { text: 'Restricted (encrypted RCS)' }), h('dd', { text: num(t.restricted) }),
        h('dt', { text: 'Your numbers' }), h('dd', { text: t.selfAddresses.join(', ') || 'not learned yet' })))));
}
const tile = (v, label) => h('div', { class: 'tile' }, h('b', { text: v }), h('span', { text: label }));

// ---------- settings ----------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (route().name === 'settings') renderSettings(); });
async function renderSettings() {
  const page = h('div', { class: 'page' });
  shell.main.replaceChildren(page);
  let s;
  try { s = await api('/api/settings'); } catch { return; }
  const davUrl = `${location.origin}/dav/`;
  const secret = h('div');
  const davMsg = h('p', { class: 'err', role: 'alert' });
  const gen = h('button', { class: 'btn primary', type: 'button', text: s.dav.enabled ? 'Make a new WebDAV password' : 'Turn on phone upload', onclick: async () => {
    if (s.dav.enabled && !confirm('Make a new password? The phone keeps uploading only after you enter the new one in SMS Backup & Restore.')) return;
    try {
      const d = await api('/api/settings/dav-password', { method: 'POST', body: { generate: true } });
      secret.replaceChildren(h('p', { text: 'Enter this password in SMS Backup & Restore now; it is shown only once:' }), h('div', { class: 'secret', text: d.password }));
      s.dav.enabled = true; gen.textContent = 'Make a new WebDAV password'; off.classList.remove('hidden');
    } catch (e) { davMsg.textContent = e.message; }
  } });
  const off = h('button', { class: `btn danger${s.dav.enabled ? '' : ' hidden'}`, type: 'button', text: 'Turn off phone upload', onclick: async () => {
    await api('/api/settings/dav-password', { method: 'POST', body: { disable: true } }); renderSettings();
  } });

  const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', id: 'nw', autocomplete: 'new-password', minlength: 10 });
  const pwMsg = h('p', { class: 'err', role: 'alert' });
  const pwForm = h('form', { onsubmit: async (e) => {
    e.preventDefault(); pwMsg.textContent = '';
    try { await api('/api/auth/password', { method: 'POST', body: { current: cur.value, next: nw.value } }); cur.value = ''; nw.value = ''; pwMsg.textContent = 'Password changed. Other devices are signed out.'; }
    catch (x) { pwMsg.textContent = x.message; }
  } }, h('div', { class: 'field-row' }, h('div', null, h('label', { for: 'cur', text: 'Current password' }), cur), h('div', null, h('label', { for: 'nw', text: 'New password' }), nw)), pwMsg,
  h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit', text: 'Change password' })));

  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const install = standalone ? h('p', { class: 'muted', text: 'Running as an installed app.' })
    : deferredInstall ? h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', text: 'Install app', onclick: async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; renderSettings(); } }))
      : h('p', { class: 'muted', text: ios ? 'In Safari: Share, then Add to Home Screen.' : (location.protocol === 'https:' ? 'Use your browser menu: Install app / Add to Home screen.' : 'Installing needs an HTTPS address (for example Tailscale HTTPS). In a browser over plain http everything else works.') });

  page.replaceChildren(h('div', { class: 'page-inner' }, h('h1', { text: 'Settings' }),
    h('div', { class: 'card' }, h('h2', { text: 'Phone upload (WebDAV)' }),
      h('p', null, 'Status: ', h('span', { class: `badge ${s.dav.enabled ? 'verified' : 'skipped'}`, text: s.dav.enabled ? 'on' : 'off' })),
      h('dl', { class: 'kv' }, h('dt', { text: 'Server URL' }), h('dd', { class: 'mono', text: davUrl }), h('dt', { text: 'User name' }), h('dd', { class: 'mono', text: s.dav.user })),
      h('p', { class: 'small muted', text: 'Away from home, use the server\'s Tailscale address in the URL instead.' }),
      secret, davMsg, h('div', { class: 'actions' }, gen, off),
      h('h2', { text: 'SMS Backup & Restore setup' }),
      h('ol', { class: 'steps' },
        h('li', { text: 'Install SMS Backup & Restore Pro (WebDAV is a Pro feature).' }),
        h('li', { text: 'Back up: Messages on, Call logs off. Under advanced options: include MMS media, add contact names, back up text-only MMS.' }),
        h('li', { text: 'Backup location: WebDAV, with the URL, user name and password above. Leave the backup password (zip encryption) off.' }),
        h('li', { text: 'Schedule: daily, at night, with incremental backups on.' }),
        h('li', { text: 'Once a month or so, run a manual backup with "Back up as default SMS app" so encrypted RCS messages are included, then make Google Messages the default again.' }))),
    h('div', { class: 'card' }, h('h2', { text: 'Account' }), pwForm,
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'button', text: 'Sign out', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); state.auth = null; state.convs = null; render(); } }))),
    h('div', { class: 'card' }, h('h2', { text: 'App' }), install,
      h('dl', { class: 'kv' }, h('dt', { text: 'Version' }), h('dd', { text: s.version }),
        h('dt', { text: 'Your numbers' }), h('dd', { text: s.selfAddresses.map((a) => a.address).join(', ') || 'not learned yet' }),
        h('dt', { text: 'Cutoff preview' }), h('dd', { text: `${s.cutoffDays} days (keeps the last ${s.keepRecentDays} days)` })))));
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.lightbox) { closeLightbox(true); return; }
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) {
    const el = document.getElementById('conv-filter') || document.getElementById('q');
    if (el) { e.preventDefault(); el.focus(); }
  }
});

// ---------- service worker and update prompt ----------
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    const offer = (w) => {
      if (!w || !navigator.serviceWorker.controller) return;
      const t = h('div', { class: 'toast', role: 'status' }, 'Update available', h('button', { class: 'btn', type: 'button', text: 'Reload', onclick: () => w.postMessage('SKIP_WAITING') }));
      document.body.append(t);
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
  }).catch(() => {});
  // Reload only when a new worker replaced an existing one; never on the very first install.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
}

render();
