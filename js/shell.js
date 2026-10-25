// App shell: the sidebar, the app bar (in the desktop app it is the window's title bar), page history, the command
// palette, keyboard shortcuts, and the settings that make the app yours: theme, accent, headings, interface size,
// board colours, piece set, coordinates, move dots, animation speed and sound. Settings are kept on this computer.

// ---------- settings ----------
const SET_KEY = 'cl:settings:v1';
const SET_DEFAULTS = { theme: 'system', accent: '', headings: 'serif', scale: 1.1, board: 'theme', pieces: 'cburnett', coords: true, dots: true, anim: 'normal', volume: 0.8, sounds: 'wood', sidebar: 'full', boardSize: 0 };
const settings = { ...SET_DEFAULTS, ...store.get(SET_KEY, {}) };

// swatch: page, surface, accent, ink, light square, dark square (the CSS holds the full token sets)
const THEMES = {
  book: { label: 'Chess book', scheme: 'light', sw: ['#f2ede3', '#fbf8f2', '#2c4d3b', '#1f1c17', '#eedbb6', '#b38862'] },
  paper: { label: 'Paper', scheme: 'light', sw: ['#f4f4f2', '#ffffff', '#2f5bd3', '#1b1b19', '#f0d9b5', '#b58863'] },
  night: { label: 'Night', scheme: 'dark', sw: ['#14120f', '#1c1915', '#c4a668', '#eee7d8', '#dcc59e', '#9a7351'] },
  slate: { label: 'Slate', scheme: 'dark', sw: ['#0f1419', '#161c23', '#6ea8fe', '#e6edf3', '#c9d3dd', '#7f93a8'] },
  forest: { label: 'Tournament hall', scheme: 'dark', sw: ['#0f1a14', '#15231b', '#d4b46a', '#e8efe9', '#ebecd0', '#739552'] },
  midnight: { label: 'Midnight', scheme: 'dark', sw: ['#000000', '#0e0e10', '#a78bfa', '#f2f2f2', '#e6dff0', '#8c75a8'] },
};
const ACCENTS = ['#2c4d3b', '#94743a', '#2f5bd3', '#6ea8fe', '#7c5cd6', '#b33a3a', '#1f8a8a', '#d0702c', '#d4b46a'];
const BOARDS = {
  theme: ['Theme', null], wood: ['Wood', ['#eedbb6', '#b38862']], brown: ['Brown', ['#f0d9b5', '#b58863']], green: ['Green', ['#ebecd0', '#739552']],
  blue: ['Blue', ['#dee3e6', '#8ca2ad']], ice: ['Ice', ['#dfe9f2', '#7f9fbd']], purple: ['Purple', ['#e6dff0', '#8c75a8']],
  gray: ['Grey', ['#dcdcdc', '#9e9e9e']], coral: ['Coral', ['#f3e3d7', '#cf8a76']], olive: ['Olive', ['#e9e6c9', '#8a8a5a']],
};
// lichess's piece sets (lichess.org, each under its own free licence; served by jsDelivr)
const PIECE_SETS = ['cburnett', 'merida', 'alpha', 'california', 'cardinal', 'chessnut', 'companion', 'fresca', 'gioco', 'governor', 'kosal', 'leipzig', 'maestro', 'staunty', 'tatiana', 'horsey', 'pixel'];
const ANIM_MS = { off: 1, fast: 120, normal: 200, slow: 320 };
const SCALE_MIN = 0.85, SCALE_MAX = 1.6;

const resolvedTheme = () => (settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'book') : THEMES[settings.theme] ? settings.theme : 'book');
const isDark = () => THEMES[resolvedTheme()].scheme === 'dark';
// readable text on a colour
const inkOn = hex => { const n = parseInt(hex.slice(1), 16), [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255]; return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1a1712' : '#ffffff'; };

function applySettings() {
  const root = document.documentElement, t = resolvedTheme(), st = root.style;
  root.dataset.theme = t;
  root.dataset.scheme = THEMES[t].scheme;
  root.dataset.headings = settings.headings;
  if (settings.accent) { st.setProperty('--accent', settings.accent); st.setProperty('--accent-ink', inkOn(settings.accent)); }
  else { st.removeProperty('--accent'); st.removeProperty('--accent-ink'); }
  const sq = BOARDS[settings.board]?.[1];
  if (sq) { st.setProperty('--sq-light', sq[0]); st.setProperty('--sq-dark', sq[1]); }
  else { st.removeProperty('--sq-light'); st.removeProperty('--sq-dark'); }
  document.body.classList.toggle('hide-coords', !settings.coords);
  document.body.classList.toggle('hide-dots', !settings.dots);
  document.body.classList.toggle('sb-mini', settings.sidebar === 'mini');
  BOARD_ANIM_MS = ANIM_MS[settings.anim] ?? 200;
  if (settings.boardSize) setBoardSize(settings.boardSize);
  else { st.removeProperty('--bs-user'); document.body.classList.remove('bs-user'); }
  SOUND_VOL = settings.volume;
  SOUND_SET = SOUND_SETS[settings.sounds] ? settings.sounds : 'wood';
  Sound.preload(SOUND_SET);
  PIECE_IMG = `https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/${PIECE_SETS.includes(settings.pieces) ? settings.pieces : 'cburnett'}/`;
  applyZoom();
  syncTitleBar();
}

// interface size: the desktop app zooms the page itself; a browser gets CSS zoom
function applyZoom() {
  const z = clamp(+settings.scale || 1, SCALE_MIN, SCALE_MAX);
  const native = !!window.chessLensNative?.setZoom;
  if (native) window.chessLensNative.setZoom(z);
  else document.documentElement.style.zoom = z;
  document.documentElement.style.setProperty('--zoom', z);
  document.documentElement.style.setProperty('--vz', native ? 1 : z);
}

// the window controls sit on the app bar: give them its colours
function syncTitleBar() {
  if (!window.chessLensNative?.setTitleBar) return;
  requestAnimationFrame(() => window.chessLensNative.setTitleBar({ color: cssVar('--page'), symbolColor: cssVar('--ink'), height: Math.round(46 * clamp(+settings.scale || 1, SCALE_MIN, SCALE_MAX)) }));
}

// a setting changed: save it, apply it everywhere, redraw what shows it
function setSetting(key, value) {
  settings[key] = value;
  store.set(SET_KEY, settings);
  applySettings();
  if (['theme', 'accent', 'headings'].includes(key)) { themeChartDefaults(); if (S.tab !== 'settings' && S.tab !== 'home') renderTab(S.tab); }
  BoardView.all.forEach(b => b.render());
  if (key === 'sidebar') renderNav();
  if (S.tab === 'settings') renderSettings($('#tab-settings'));
  renderAppbar();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') setSetting('theme', 'system'); });

// the app bar's sun/moon: to the other scheme's usual theme
function toggleScheme() { setSetting('theme', isDark() ? (settings.lightTheme || 'book') : (settings.darkTheme || 'night')); }

// ---------- navigation: sidebar, crumbs, history ----------
const NAV_SECTIONS = ['overview', 'games', 'insights', 'train', 'bots'];
const SECTION_LABELS = { overview: 'Overview', games: 'Games', insights: 'Insights', train: 'Train', bots: 'Bots', app: 'Chess Lens' };
const PAGE_ICONS = { overview: 'layout-dashboard', analytics: 'chart-line', report: 'file-text', games: 'list', review: 'scan-search', explorer: 'compass', editor: 'pencil',
  openings: 'book-open', prepare: 'crosshair', insights: 'radar', puzzles: 'puzzle', drills: 'target', vision: 'eye', learn: 'graduation-cap', play: 'swords', bot: 'bot',
  arena: 'trophy', settings: 'settings', home: 'house' };
const pageLabel = t => (SECTIONS[sectionOf(t)] || []).find(([x]) => x === t)?.[1] || t;
const pageLocked = t => !S.username && !GUEST_TABS.includes(t);

function renderNav() {
  const closed = store.get('cl:nav:closed', {});
  const item = ([t, l]) => `<button class="sb-item ${S.tab === t ? 'active' : ''} ${pageLocked(t) ? 'locked' : ''}" data-tab="${t}" title="${esc(l)}${pageLocked(t) ? ': load a player first' : ''}">${icon(PAGE_ICONS[t])}<span class="sb-label">${esc(l)}</span></button>`;
  $('#nav').innerHTML = NAV_SECTIONS.map(sec => {
    const pages = SECTIONS[sec];
    if (pages.length === 1) return `<div class="sb-group single">${pages.map(item).join('')}</div>`;
    return `<div class="sb-group ${closed[sec] && !pages.some(([t]) => t === S.tab) ? 'closed' : ''}" data-sec="${sec}">
      <button class="sb-head" data-sechead="${sec}"><span class="sb-label">${SECTION_LABELS[sec]}</span>${icon('chevron-down', 14)}</button>
      <div class="sb-items">${pages.map(item).join('')}</div></div>`;
  }).join('');
  $('#sbFoot').innerHTML = item(['settings', 'Settings'])
    + `<button class="sb-item" id="sbCollapse" title="${settings.sidebar === 'mini' ? 'Expand' : 'Collapse'} the sidebar (Ctrl+B)">${icon(settings.sidebar === 'mini' ? 'panel-left-open' : 'panel-left-close')}<span class="sb-label">Collapse</span></button>`;
  $$('#sidebar [data-tab]').forEach(b => b.onclick = () => { goTo(b.dataset.tab); document.body.classList.remove('sb-open'); });
  $$('#nav [data-sechead]').forEach(b => b.onclick = () => {
    const c = store.get('cl:nav:closed', {}); c[b.dataset.sechead] = !c[b.dataset.sechead]; store.set('cl:nav:closed', c);
    b.parentElement.classList.toggle('closed', c[b.dataset.sechead]);
  });
  $('#sbCollapse').onclick = toggleSidebar;
}

// the page a click or shortcut asks for: locked pages (they need a player) point at the search box instead
function goTo(tab) {
  if (pageLocked(tab)) {
    setStatus(`Load a chess.com player to open ${pageLabel(tab)}.`);
    focusLoad();
    return;
  }
  switchTab(tab);
}
const focusLoad = () => { const u = $('#username'); u.focus(); u.select(); };
const toggleSidebar = () => {
  if (matchMedia('(max-width: 820px)').matches) return document.body.classList.toggle('sb-open');
  setSetting('sidebar', settings.sidebar === 'mini' ? 'full' : 'mini');
};

// called by switchTab: highlight, crumbs, history, window title
const hist = { back: [], fwd: [], moving: false };
function onNavigate(prev, tab) {
  if (!hist.moving && prev && prev !== tab) { hist.back.push(prev); hist.fwd = []; if (hist.back.length > 50) hist.back.shift(); }
  $$('#sidebar [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const sec = sectionOf(tab), grp = $(`#nav [data-sec="${sec}"]`);
  if (grp) grp.classList.remove('closed');
  const label = tab === 'home' ? 'Home' : tab === 'settings' ? 'Settings' : pageLabel(tab);
  $('#crumbs').innerHTML = NAV_SECTIONS.includes(sec) && SECTIONS[sec].length > 1 && label !== SECTION_LABELS[sec] ? `<span class="muted">${SECTION_LABELS[sec]}</span>${icon('chevron-right', 14)}<b>${esc(label)}</b>` : `<b>${esc(label)}</b>`;
  document.title = tab === 'home' ? 'Chess Lens' : `${label} · Chess Lens`;
  $('#navBack').disabled = !hist.back.length;
  $('#navFwd').disabled = !hist.fwd.length;
  // the filters (time control, colour, rated) belong to pages that read your loaded games
  $('#filters').classList.toggle('hidden', !S.username || !FILTER_TABS.includes(tab));
  // what the pinned filters cover, for anything pinned under them
  setTimeout(measureFilters, 0);
  $('#app').scrollTop = 0;
}
function measureFilters() { const f = $('#filters'); document.documentElement.style.setProperty('--filters-h', f.classList.contains('hidden') ? '0px' : Math.max(0, f.offsetHeight - 22) + 'px'); }
window.addEventListener('resize', () => setTimeout(measureFilters, 0));
const FILTER_TABS = ['overview', 'analytics', 'report', 'games', 'openings', 'insights'];
function histGo(dir) {
  const from = dir < 0 ? hist.back : hist.fwd, to = dir < 0 ? hist.fwd : hist.back, t = from.pop();
  if (!t) return;
  to.push(S.tab);
  hist.moving = true;
  try { pageLocked(t) ? null : switchTab(t); } finally { hist.moving = false; }
}

function renderAppbar() {
  $('#sbOpen').innerHTML = icon('menu');
  $('#navBack').innerHTML = icon('arrow-left');
  $('#navFwd').innerHTML = icon('arrow-right');
  $('#paletteBtn').innerHTML = icon('command');
  $('#lfIcon').innerHTML = icon('search', 16);
  $('#themeToggle').innerHTML = icon(isDark() ? 'sun' : 'moon');
  $('#themeToggle').title = isDark() ? 'Light theme' : 'Dark theme';
  $('#soundToggle').innerHTML = icon(Sound.on() ? 'volume-2' : 'volume-x');
}

// the player card at the top of the sidebar
function renderPlayerCard() {
  const el = $('#playerChip');
  if (!S.username || !S.player) { el.innerHTML = `<span class="sb-noplayer">${icon('user-round')}<span class="sb-label">No player loaded</span></span>`; el.onclick = focusLoad; return; }
  const p = S.player.profile, st = S.player.stats || {};
  const TC_IC = { bullet: 'rocket', blitz: 'zap', rapid: 'timer' };
  const rat = ['bullet', 'blitz', 'rapid'].map(k => st['chess_' + k]?.last ? `<span title="${tcTitle(k)}">${icon(TC_IC[k], 12)}<b>${st['chess_' + k].last.rating}</b></span>` : '').filter(Boolean).join('');
  el.onclick = null;
  el.innerHTML = `${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : `<span class="sb-avatar">${esc((p.username || S.username)[0].toUpperCase())}</span>`}
    <span class="sb-label sb-who"><a href="${esc(p.url)}" target="_blank" rel="noopener" title="Open on chess.com">${esc(p.username || S.username)}</a>${p.title ? ` <span class="pill">${esc(p.title)}</span>` : ''}
    <span class="sb-ratings">${rat}</span></span>`;
}

// ---------- command palette (Ctrl+K) ----------
const pal = { items: [], sel: 0 };
function paletteItems() {
  const pages = [...NAV_SECTIONS.flatMap(sec => SECTIONS[sec].map(([t, l]) => ({ label: l, hint: SECTION_LABELS[sec], ic: PAGE_ICONS[t], tab: t }))),
    { label: 'Settings', hint: 'Ctrl+,', ic: 'settings', tab: 'settings' }, { label: 'Home', hint: '', ic: 'house', tab: 'home' }];
  const acts = [
    { label: 'Load a chess.com player…', hint: 'Ctrl+L', ic: 'search', run: focusLoad },
    { label: isDark() ? 'Light theme' : 'Dark theme', hint: '', ic: isDark() ? 'sun' : 'moon', run: toggleScheme },
    { label: settings.sidebar === 'mini' ? 'Expand the sidebar' : 'Collapse the sidebar', hint: 'Ctrl+B', ic: 'panel-left-close', run: toggleSidebar },
    { label: 'Interface larger', hint: 'Ctrl+=', ic: 'layout-grid', run: () => bumpScale(1) },
    { label: 'Interface smaller', hint: 'Ctrl+−', ic: 'layout-grid', run: () => bumpScale(-1) },
    { label: Sound.on() ? 'Sound off' : 'Sound on', hint: '', ic: Sound.on() ? 'volume-x' : 'volume-2', run: () => { Sound.toggle(); renderAppbar(); } },
    ...Object.entries(THEMES).map(([k, v]) => ({ label: `Theme: ${v.label}`, hint: '', ic: 'palette', run: () => setSetting('theme', k) })),
  ];
  return [...pages.map(p => ({ ...p, locked: pageLocked(p.tab), run: () => goTo(p.tab) })), ...acts];
}
function openPalette() {
  pal.all = paletteItems(); pal.sel = 0;
  $('#palette').classList.remove('hidden');
  const inp = $('#palInput'); inp.value = ''; inp.focus();
  drawPalette();
}
const closePalette = () => $('#palette').classList.add('hidden');
function drawPalette() {
  const q = $('#palInput').value.trim().toLowerCase();
  const score = it => { const l = it.label.toLowerCase(), h = (it.hint || '').toLowerCase(); return !q ? 1 : l.startsWith(q) ? 3 : l.includes(q) ? 2 : h.includes(q) ? 1 : 0; };
  pal.items = pal.all.map(it => [it, score(it)]).filter(([, s]) => s).sort((a, b) => b[1] - a[1]).map(([it]) => it).slice(0, 12);
  pal.sel = clamp(pal.sel, 0, Math.max(0, pal.items.length - 1));
  $('#palList').innerHTML = pal.items.map((it, i) => `<button class="pal-item ${i === pal.sel ? 'sel' : ''} ${it.locked ? 'locked' : ''}" data-pi="${i}">${icon(it.ic)}<span>${esc(it.label)}</span><span class="pal-hint">${esc(it.locked ? 'needs a player' : it.hint || '')}</span></button>`).join('') || '<div class="muted small pal-empty">Nothing matches.</div>';
  $$('#palList [data-pi]').forEach(b => { b.onmousemove = () => { if (pal.sel !== +b.dataset.pi) { pal.sel = +b.dataset.pi; drawPalette(); } }; b.onclick = () => runPalette(+b.dataset.pi); });
}
function runPalette(i) { const it = pal.items[i]; if (!it) return; closePalette(); it.run(); }

// ---------- keyboard and mouse ----------
const bumpScale = d => setSetting('scale', Math.round(clamp((+settings.scale || 1) + d * 0.05, SCALE_MIN, SCALE_MAX) * 100) / 100);
function initShortcuts() {
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (!$('#palette').classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pal.sel += e.key === 'ArrowDown' ? 1 : -1; drawPalette(); }
      else if (e.key === 'Enter') { e.preventDefault(); runPalette(pal.sel); }
      return;
    }
    if (mod && k === 'k') { e.preventDefault(); openPalette(); }
    else if (mod && k === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (mod && k === 'l') { e.preventDefault(); focusLoad(); }
    else if (mod && e.key === ',') { e.preventDefault(); goTo('settings'); }
    else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); bumpScale(1); }
    else if (mod && e.key === '-') { e.preventDefault(); bumpScale(-1); }
    else if (mod && e.key === '0') { e.preventDefault(); setSetting('scale', SET_DEFAULTS.scale); }
    else if (mod && /^[1-5]$/.test(e.key)) { e.preventDefault(); const sec = NAV_SECTIONS[+e.key - 1]; goTo(lastInSection[sec] || firstTab(sec)); }
    else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); histGo(e.key === 'ArrowLeft' ? -1 : 1); }
  }, true);
  // the mouse's back and forward buttons
  window.addEventListener('mouseup', e => { if (e.button === 3 || e.button === 4) { e.preventDefault(); histGo(e.button === 3 ? -1 : 1); } });
  $('#palInput').oninput = () => { pal.sel = 0; drawPalette(); };
  $('#palette').onclick = e => { if (e.target.id === 'palette') closePalette(); };
}

function initShell() {
  if (window.chessLensNative?.setTitleBar) document.body.classList.add('native');
  applySettings();
  renderAppbar();
  renderNav();
  renderPlayerCard();
  initShortcuts();
  $('#sbBrand').onclick = () => switchTab(S.username ? 'overview' : 'home');
  $('#sbOpen').onclick = toggleSidebar;
  $('#sbScrim').onclick = () => document.body.classList.remove('sb-open');
  $('#navBack').onclick = () => histGo(-1);
  $('#navFwd').onclick = () => histGo(1);
  $('#paletteBtn').onclick = openPalette;
  $('#themeToggle').onclick = toggleScheme;
  $('#soundToggle').onclick = () => { Sound.toggle(); renderAppbar(); Sound.play('move'); };
}

// ---------- the Settings page ----------
let _setBoard = null;
function renderSettings(sec) {
  const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-set="${key}" data-val="${v}" class="${String(settings[key]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const toggle = (key, label) => `<label class="set-toggle"><input type="checkbox" data-set-check="${key}" ${settings[key] ? 'checked' : ''}><span>${label}</span></label>`;
  const themeCard = (k, t) => { const [pg, sf, ac, ink, l, d] = t.sw; return `<button class="theme-card ${settings.theme === k ? 'active' : ''}" data-set="theme" data-val="${k}">
      <span class="tc-prev" style="background:${pg}"><span class="tc-side" style="background:${sf}"></span><span class="tc-acc" style="background:${ac}"></span><span class="tc-ink" style="background:${ink}"></span><span class="tc-sq" style="background:linear-gradient(90deg, ${l} 50%, ${d} 50%)"></span></span>
      <span class="tc-name">${t.label}</span></button>`; };
  const sys = `<button class="theme-card ${settings.theme === 'system' ? 'active' : ''}" data-set="theme" data-val="system">
      <span class="tc-prev tc-system"><span style="background:${THEMES.book.sw[0]}"></span><span style="background:${THEMES.night.sw[0]}"></span></span><span class="tc-name">Match Windows</span></button>`;
  const html = `<div class="settings">
    <div class="card"><h3>${icon('palette')} Appearance</h3>
      <div class="set-row"><div class="set-label">Theme</div><div class="theme-grid">${sys}${Object.entries(THEMES).map(([k, t]) => themeCard(k, t)).join('')}</div></div>
      <div class="set-row"><div class="set-label">Accent</div><div class="swatches">
        <button class="swatch theme ${!settings.accent ? 'active' : ''}" data-set="accent" data-val="" title="The theme's own">${icon('sparkles', 14)}</button>
        ${ACCENTS.map(c => `<button class="swatch ${settings.accent === c ? 'active' : ''}" data-set="accent" data-val="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <label class="swatch custom ${settings.accent && !ACCENTS.includes(settings.accent) ? 'active' : ''}" title="Any colour" style="${settings.accent && !ACCENTS.includes(settings.accent) ? `background:${settings.accent}` : ''}"><input type="color" id="setAccent" value="${settings.accent || '#2c4d3b'}"></label></div></div>
      <div class="set-row"><div class="set-label">Headings</div>${seg('headings', [['serif', 'Book serif'], ['sans', 'Clean sans']])}</div>
      <div class="set-row"><div class="set-label">Interface size</div><div class="set-scale"><input type="range" id="setScale" min="${SCALE_MIN}" max="${SCALE_MAX}" step="0.05" value="${settings.scale}"><b id="setScaleV">${Math.round(settings.scale * 100)}%</b><span class="muted small">Ctrl + = / − / 0</span></div></div>
      <div class="set-row"><div class="set-label">Sidebar</div>${seg('sidebar', [['full', 'Full'], ['mini', 'Icons only']])}</div>
    </div>
    <div class="card"><h3>${icon('layout-grid')} Board</h3>
      <div class="set-board"><div class="set-preview"><div class="board" id="setBoard"></div></div><div class="set-board-opts">
        <div class="set-row"><div class="set-label">Squares</div><div class="board-swatches">${Object.entries(BOARDS).map(([k, [l, c]]) => `<button class="bsw ${settings.board === k ? 'active' : ''}" data-set="board" data-val="${k}" title="${l}">
          <span class="bsw-sq" style="${c ? `background:conic-gradient(${c[1]} 0 25%, ${c[0]} 0 50%, ${c[1]} 0 75%, ${c[0]} 0)` : 'background:conic-gradient(var(--sq-dark) 0 25%, var(--sq-light) 0 50%, var(--sq-dark) 0 75%, var(--sq-light) 0)'}"></span><span>${l}</span></button>`).join('')}</div></div>
        <div class="set-row"><div class="set-label">Pieces</div><div class="piece-grid">${PIECE_SETS.map(p => `<button class="pset ${settings.pieces === p ? 'active' : ''}" data-set="pieces" data-val="${p}" title="${p}"><img src="https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/${p}/wN.svg" alt="" loading="lazy"><span>${p}</span></button>`).join('')}</div></div>
        <div class="set-row"><div class="set-label">Show</div><div class="set-toggles">${toggle('coords', 'Coordinates')}${toggle('dots', 'Legal-move dots')}</div></div>
        <div class="set-row"><div class="set-label">Piece motion</div>${seg('anim', [['off', 'Off'], ['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']])}</div>
      </div></div>
    </div>
    <div class="card"><h3>${icon('volume-2')} Sound</h3>
      <div class="set-row"><div class="set-label">Sounds</div><div class="set-toggles"><label class="set-toggle"><input type="checkbox" id="setSound" ${Sound.on() ? 'checked' : ''}><span>Moves, captures and results</span></label></div></div>
      <div class="set-row"><div class="set-label">Set</div><div>${seg('sounds', Object.entries(SOUND_SETS))}<div class="muted small" style="margin-top:6px">Wood is made by the app; the others are lichess's recordings (Enigmahack, AGPL-3.0).</div></div></div>
      <div class="set-row"><div class="set-label">Volume</div><div class="set-scale"><input type="range" id="setVol" min="0.1" max="1" step="0.05" value="${settings.volume}"><b>${Math.round(settings.volume * 100)}%</b></div></div>
    </div>
    <div class="card"><h3>${icon('command')} Shortcuts</h3>
      <table class="keys"><tbody>
        ${[['Ctrl + K', 'Go to any page, or run a command'], ['Ctrl + L', 'Load a player'], ['Ctrl + 1 … 5', 'Overview, Games, Insights, Train, Bots'], ['Alt + ← / →', 'Back / forward (or the mouse\'s side buttons)'],
          ['Ctrl + B', 'Collapse the sidebar'], ['Ctrl + ,', 'Settings'], ['Ctrl + = / − / 0', 'Interface size'], ['F11', 'Full screen'], ['Ctrl + R', 'Reload']].map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}
      </tbody></table>
      <button class="btn" id="setReset" style="margin-top:12px">Restore the defaults</button>
    </div></div>`;
  sec.innerHTML = html;
  // the preview: an Italian Game with its last move, an arrow and a legal-move dot
  _setBoard = new BoardView($('#setBoard', sec), { onMove: () => {} });
  _setBoard.jump({ fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3', orientation: 'white', lastMove: { from: 'f1', to: 'c4' }, arrows: [{ from: 'g8', to: 'f6', color: cssVar('--good'), width: 0.18 }] });
  _setBoard.select('d7');
  $$('[data-set]', sec).forEach(b => b.onclick = () => { const k = b.dataset.set, v = b.dataset.val; setSetting(k, k === 'scale' || k === 'volume' ? +v : v); if (k === 'sounds') setTimeout(() => Sound.play('move'), 250); });
  $$('[data-set-check]', sec).forEach(c => c.onchange = () => setSetting(c.dataset.setCheck, c.checked));
  $('#setAccent', sec).oninput = e => { e.target.parentElement.style.background = e.target.value; };
  $('#setAccent', sec).onchange = e => setSetting('accent', e.target.value);
  const sc = $('#setScale', sec);
  sc.oninput = () => { $('#setScaleV', sec).textContent = Math.round(sc.value * 100) + '%'; };
  sc.onchange = () => setSetting('scale', +sc.value);
  const vol = $('#setVol', sec);
  vol.oninput = () => { vol.nextElementSibling.textContent = Math.round(vol.value * 100) + '%'; };
  vol.onchange = () => { setSetting('volume', +vol.value); Sound.play('move'); };
  $('#setSound', sec).onchange = e => { if (Sound.on() !== e.target.checked) Sound.toggle(); renderAppbar(); if (e.target.checked) Sound.play('move'); };
  $('#setReset', sec).onclick = () => { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, SET_DEFAULTS); setSetting('theme', SET_DEFAULTS.theme); renderNav(); };
}

// ---------- resizable boards ----------
// Each board page's layout (.rv: the board, then its panel) gets a divider: drag it to size the board (the panel takes
// the rest), double-click to return to the automatic size. One size for every such page, kept with the settings.
function addSplitters() {
  for (const rv of $$('.rv:not([data-split])')) {
    const panel = rv.querySelector(':scope > .rv-panel');
    if (!rv.querySelector(':scope > .rv-board') || !panel) continue;
    rv.dataset.split = '1';
    const h = document.createElement('div');
    h.className = 'rv-split'; h.title = 'Drag to resize the board · double-click for automatic';
    rv.insertBefore(h, panel);
    h.onpointerdown = e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const left = rv.querySelector('.board').getBoundingClientRect().left;
      try { h.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      h.classList.add('dragging'); document.body.classList.add('resizing');
      const move = ev => setBoardSize(ev.clientX - left - 10);
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', () => { h.removeEventListener('pointermove', move); h.classList.remove('dragging'); document.body.classList.remove('resizing'); store.set(SET_KEY, settings); }, { once: true });
    };
    h.ondblclick = () => setSetting('boardSize', 0);
  }
}
function setBoardSize(px) {
  settings.boardSize = Math.round(clamp(px, 240, 1600));
  document.documentElement.style.setProperty('--bs-user', settings.boardSize + 'px');
  document.body.classList.add('bs-user');
}
new MutationObserver(() => { clearTimeout(addSplitters.t); addSplitters.t = setTimeout(addSplitters, 50); }).observe(document.getElementById('app'), { childList: true, subtree: true });
