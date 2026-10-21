// App wiring: loading, filters, tabs, theme
const S = { username: null, player: null, games: [], filtered: [], months: 3, tab: 'overview', scanAgg: null };

const RENDERERS = {
  overview: renderOverview, games: renderGames, openings: renderOpenings, playstyle: renderPlaystyle,
  analytics: renderAnalytics, insights: renderInsights, prepare: renderPrepare, bot: renderBot, arena: renderArena, report: renderReport,
};

// Sections (top row) and their pages (second row)
const SECTIONS = {
  overview: [['overview', 'Summary'], ['analytics', 'Analytics'], ['report', 'Report']],
  games: [['games', 'Games'], ['review', 'Review'], ['openings', 'Openings'], ['prepare', 'Prepare']],
  insights: [['insights', 'Insights']],
  bots: [['bot', 'Your bot'], ['arena', 'Arena']],
};
const sectionOf = tab => Object.keys(SECTIONS).find(k => SECTIONS[k].some(([t]) => t === tab));
const lastInSection = {};
// without a loaded player only these pages work
const GUEST_TABS = ['arena', 'insights', 'review'];
const firstTab = sec => document.body.classList.contains('guest')
  ? SECTIONS[sec].map(([t]) => t).find(t => GUEST_TABS.includes(t)) : SECTIONS[sec][0][0];

function setStatus(msg, isError = false) {
  const s = $('#status');
  if (!msg) { s.classList.add('hidden'); s.innerHTML = ''; return; }
  s.classList.remove('hidden'); s.classList.toggle('error', isError);
  if (isError) s.innerHTML = msg; else showStatus(s, msg);
}

function applyFilters(render = true) {
  const t = $('#fTime').value, c = $('#fColor').value, r = $('#fRated').value;
  S.filtered = S.games.filter(g => (t === 'all' || g.timeClass === t) && (c === 'all' || g.color === c) && (r === 'all' || g.rated));
  $('#fCount').textContent = `${S.filtered.length} of ${S.games.length} games`;
  // the one time-control picker: every page reads it (counts honour the colour and rated filters)
  const base = filterBase();
  $('#fTimeSeg').innerHTML = TC_ORDER.map(tc => [tc, tc === 'all' ? base.length : base.filter(g => g.timeClass === tc).length]).filter(([tc, n]) => tc === 'all' || n || tc === t)
    .map(([tc, n]) => `<button data-ftc="${tc}" class="${tc === t ? 'active' : ''}">${tc === 'all' ? 'All' : tcTitle(tc)} <span class="seg-n">${n}</span></button>`).join('');
  $$('#fTimeSeg [data-ftc]').forEach(b => b.onclick = () => { const f = $('#fTime'); f.value = b.dataset.ftc; f.dispatchEvent(new Event('change')); });
  if (render) renderTab(S.tab);
}

function renderTab(tab) {
  const fn = RENDERERS[tab];
  if (fn) fn($('#tab-' + tab), S.filtered);
}

function switchTab(tab) {
  S.tab = tab;
  const sec = sectionOf(tab);
  lastInSection[sec] = tab;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.sec === sec));
  // the sub-menu is rebuilt only when the section changes; within a section only the highlight moves
  const sub = $('#subtabs');
  if (sub.dataset.sec !== sec) {
    sub.dataset.sec = sec;
    sub.innerHTML = SECTIONS[sec].length > 1 ? SECTIONS[sec].map(([t, label]) => `<button data-tab="${t}">${label}</button>`).join('') : '';
    $$('#subtabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  }
  $$('#subtabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
  // the menu repaints first; heavy pages then render on the next frame instead of blocking the click
  if (['review', 'bot', 'prepare', 'arena'].includes(tab)) renderTab(tab);
  else {
    // (a timer backs up the frames: a hidden or minimised window gets no animation frames)
    let done = false;
    const go = () => { if (done) return; done = true; if (S.tab === tab) renderTab(tab); };
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 60);
  }
  if (tab === 'review') showReview(); else hideReview();
  if (tab === 'prepare') maybeBotMove(); else hidePrepare();
  if (tab === 'bot') maybeBotThink(); else hideBot();
}

async function loadUser(username) {
  username = username.trim().toLowerCase();
  if (!username) return;
  const months = +$('#months').value;
  const btn = $('#loadForm button');
  btn.disabled = true;
  try {
    PLAYER_CACHE.delete(`${username}:${months}`); // an explicit load always fetches fresh games
    const { player, games } = await loadPlayerData(username, months, setStatus);
    await relabelOpenings(games);
    Object.assign(S, { username, player, games, months, scanAgg: null });
    const p = player.profile;
    $('#playerChip').innerHTML = `${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : ''}<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.username || username)}</a>${p.title ? ` <span class="pill">${esc(p.title)}</span>` : ''}`;
    $('#welcome').classList.add('hidden');
    $('#app').classList.remove('hidden');
    document.body.classList.remove('guest');
    setStatus('');
    themeChartDefaults();
    applyFilters(false);
    switchTab(S.tab);
    restoreScan(username);
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  } finally {
    btn.disabled = false;
  }
}

// Engine results are cached, so the last scan comes back by itself: the loaded games already analysed (at the
// scan's depth and lines) are re-read without engine work and the scan is rebuilt from them.
async function restoreScan(username) {
  const tag = getAnalysisPool()[0]?.tag || '';
  const cached = [];
  for (const g of S.games.filter(g => g.plies >= 10)) if (await evalCacheGet(cacheKey(g.id, scanState.depth, 3, tag))) cached.push(g);
  if (cached.length < 10 || S.username !== username || S.scanAgg || scanState.running) return;
  S.scanInfo = { tc: 'all', n: cached.length, depth: scanState.depth };
  runScan(cached);
}

function initTheme() {
  const saved = store.get('cl:theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeToggle').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('cl:theme', next);
    themeChartDefaults();
    if (S.games.length) renderTab(S.tab);
    if (review.analysis) drawEvalChart();
    if (review.game) drawReview();
  });
}

// Welcome page: Morphy's Opera Game final position, and a way into the arena without loading anyone
function initWelcome() {
  new BoardView($('#heroBoard')).set({ fen: '1n1Rkb1r/p4ppp/4q3/4p1B1/4P3/8/PPP2PPP/2K5 b k - 1 17', orientation: 'white', lastMove: { from: 'd1', to: 'd8' } });

  $('#guestArena').onclick = () => {
    document.body.classList.add('guest');
    $('#welcome').classList.add('hidden');
    $('#app').classList.remove('hidden');
    switchTab('arena');
  };
}

function initSound() {
  const b = $('#soundToggle'), show = () => b.classList.toggle('off', !Sound.on());
  show();
  b.addEventListener('click', () => { Sound.toggle(); show(); Sound.play('move'); });
}

function init() {
  initTheme();
  initSound();
  initWelcome();
  initReview();
  themeChartDefaults();
  $('#loadForm').addEventListener('submit', e => { e.preventDefault(); loadUser($('#username').value); });
  ['#fTime', '#fColor', '#fRated'].forEach(s => $(s).addEventListener('change', () => { gamesState.page = 0; applyFilters(); }));
  $$('#tabs button').forEach(b => b.addEventListener('click', () => switchTab(lastInSection[b.dataset.sec] || firstTab(b.dataset.sec))));
  // the username box starts empty: nothing is remembered between launches (?user=<name> still pre-loads one)
  store.set('cl:lastUser', null);
  const qp = new URLSearchParams(location.search).get('user');
  if (qp) { $('#username').value = qp; loadUser(qp); }
}

init();
