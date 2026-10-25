// App wiring: loading, filters, pages (the shell around them, settings and themes: js/shell.js)
const S = { username: null, player: null, games: [], filtered: [], months: 3, tab: null, scanAgg: null };

const RENDERERS = {
  overview: renderOverview, games: renderGames, openings: renderOpenings, playstyle: renderPlaystyle,
  analytics: renderAnalytics, insights: renderInsights, prepare: renderPrepare, learn: renderLearn, play: renderPlay, editor: renderEditor, puzzles: renderPuzzles, explorer: renderExplorer, drills: renderDrills, vision: renderVision, bot: renderBot, arena: renderArena, report: renderReport,
  settings: renderSettings, home: () => {},
};

// Sections and their pages (the sidebar); home and settings sit outside them
const SECTIONS = {
  overview: [['overview', 'Summary'], ['analytics', 'Analytics'], ['report', 'Report']],
  games: [['games', 'Games'], ['review', 'Review'], ['explorer', 'Explorer'], ['editor', 'Editor'], ['openings', 'Openings'], ['prepare', 'Prepare']],
  insights: [['insights', 'Insights']],
  train: [['puzzles', 'Puzzles'], ['drills', 'Drills'], ['vision', 'Vision'], ['learn', 'Openings']],
  bots: [['play', 'Play'], ['bot', 'Your bot'], ['arena', 'Arena']],
  app: [['home', 'Home'], ['settings', 'Settings']],
};
const sectionOf = tab => Object.keys(SECTIONS).find(k => SECTIONS[k].some(([t]) => t === tab));
const lastInSection = {};
// without a loaded player only these pages work (in this order of preference within a section); the others are locked
const GUEST_TABS = ['home', 'settings', 'play', 'arena', 'insights', 'puzzles', 'explorer', 'editor', 'review', 'learn', 'drills', 'vision'];
const firstTab = sec => !S.username
  ? GUEST_TABS.find(t => SECTIONS[sec].some(([x]) => x === t)) || SECTIONS[sec][0][0] : SECTIONS[sec][0][0];

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
  const prev = S.tab;
  S.tab = tab;
  lastInSection[sectionOf(tab)] = tab;
  onNavigate(prev, tab);   // sidebar, crumbs, history, filters (js/shell.js)
  $$('.tab').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
  // the menu repaints first; heavy pages then render on the next frame instead of blocking the click
  if (['review', 'bot', 'prepare', 'arena', 'settings'].includes(tab)) renderTab(tab);
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
    renderPlayerCard();
    renderNav();
    setStatus('');
    themeChartDefaults();
    applyFilters(false);
    switchTab(!S.tab || ['home', 'settings'].includes(S.tab) ? 'overview' : S.tab);
    $('#username').blur();
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

// Welcome page: Morphy's Opera Game final position, and a way into the arena or the puzzles without loading anyone
function initWelcome() {
  new BoardView($('#heroBoard')).set({ fen: '1n1Rkb1r/p4ppp/4q3/4p1B1/4P3/8/PPP2PPP/2K5 b k - 1 17', orientation: 'white', lastMove: { from: 'd1', to: 'd8' } });

  $('#guestArena').onclick = () => switchTab('arena');
  $('#guestTrain').onclick = () => switchTab('puzzles');
}

function init() {
  initShell();
  initWelcome();
  initReview();
  themeChartDefaults();
  $('#loadForm').addEventListener('submit', e => { e.preventDefault(); loadUser($('#username').value); });
  ['#fTime', '#fColor', '#fRated'].forEach(s => $(s).addEventListener('change', () => { gamesState.page = 0; applyFilters(); }));
  // the username box starts empty: nothing is remembered between launches (?user=<name> still pre-loads one)
  store.set('cl:lastUser', null);
  const qp = new URLSearchParams(location.search).get('user');
  switchTab('home');
  if (qp) { $('#username').value = qp; loadUser(qp); }
}

init();
