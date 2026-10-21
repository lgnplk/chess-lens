// Rating ladder: what the typical chess.com player looks like in each 250-point band, per time control.
// js/ladder.json is built once by tools/build-ladder.js from sampled chess.com players; the same functions
// below measure those players and you, so the comparison is like for like.
//
// Method (see tools/build-ladder.js): both sides of every sampled game; Stockfish 19 (depth 12, top 3 lines, as the
// desktop app scans) for the performance numbers; a sliding, trend-corrected rating window around each band;
// game-to-game noise removed, so a band's median (its typical player) and the percentiles describe players' real
// levels. Radar axes are percentiles among all chess.com players of that time control: bands weighted by chess.com's
// published rating distribution (tools/rating-dist.json). Browser-engine (Stockfish 10) scans have their accuracy
// and blunders mapped onto the Stockfish 19 scale (ladder.json calib).
const LADDER_TCS = ['bullet', 'blitz', 'rapid'];
const LADDER_BAND = 250, LADDER_MIN_GAMES = 10, LADDER_YOU_GAMES = 100;
// cell: the bare number for tables (unit shown once, beside the row name); fmt: number + unit for tooltips
const ladderAxis = (key, label, cell, unit, extra = {}) => ({ key, label, cell, unit, fmt: v => cell(v) + (unit ? ' ' + unit.replace('/100', 'per 100') : ''), ...extra });
// habits: how a player plays (different, not better)
const LADDER_STYLE = [
  ladderAxis('checks', 'Checks', v => num(v, 1), '/100 moves'),
  ladderAxis('captures', 'Captures', v => num(v, 1), '/100 moves'),
  ladderAxis('pawns', 'Pawn moves', v => num(v, 0) + '%', 'of moves'),
  ladderAxis('castleEarly', 'Early castling', v => num(v, 0) + '%', 'of games'),
  ladderAxis('earlyQueen', 'Early queen', v => num(v, 0) + '%', 'of games'),
  ladderAxis('timeTrouble', 'Time trouble', v => num(v, 0) + '%', 'of games'),
];
// performance: how well (outward is better), from an engine scan
const LADDER_PERF = [
  ladderAxis('accuracy', 'Accuracy', v => num(v, 1) + '%', ''),
  ladderAxis('blunders', 'Few blunders', v => num(v, 1), '/100 moves', { row: 'Blunders', invert: true }),
  ladderAxis('conversion', 'Conversion', v => num(v, 0) + '%', 'scored from +3'),
  ladderAxis('resilience', 'Resilience', v => num(v, 0) + '%', 'scored from −3'),
  ladderAxis('brilliance', 'Brilliance', v => num(v, 0) + '%', 'sound sacs and hard refutations found'),
  ladderAxis('consistency', 'Consistency', v => '±' + num(v, 1), 'accuracy, game to game', { row: 'Game-to-game swing', invert: true }),
  ladderAxis('clutch', 'Clutch', v => num(v, 0) + '%', 'of only moves found'),
];
const PERF_KEYS = new Set(LADDER_PERF.map(a => a.key));
const ladderRowName = a => (a.row || a.label) + (a.unit ? ` <span class="unit">${a.unit}</span>` : '');

// Habits of one player in one time control (games carry replayFeatures' g.f)
function ladderHabits(games) {
  const gs = games.filter(g => { if (!g.f) { try { replayFeatures(g); } catch { return false; } } return g.f && g.f.myMoves >= 5; });
  if (gs.length < LADDER_MIN_GAMES) return null;
  const S1 = f => sum(gs.map(f)), moves = S1(g => g.f.myMoves);
  const long = gs.filter(g => g.sans.length >= 30), clk = gs.filter(g => g.f.minClockFrac != null);
  return {
    games: gs.length,
    checks: 100 * S1(g => g.f.checks) / moves,
    captures: 100 * S1(g => g.f.captures) / moves,
    pawns: 100 * S1(g => g.f.pawnMoves) / moves,
    castleEarly: long.length ? 100 * long.filter(g => g.f.castleMove && g.f.castleMove <= 10).length / long.length : null,
    earlyQueen: 100 * gs.filter(g => g.f.earlyQueen).length / gs.length,
    timeTrouble: clk.length ? 100 * clk.filter(g => g.f.minClockFrac < 0.1).length / clk.length : null,
  };
}

// Performance from your engine scan in one time control, measured as the ladder measures its players
// (tools/build-ladder.js engineRow); n: how many games or chances each number rests on
function ladderPerf(agg, tc) {
  const pg = (agg?.perGame || []).filter(p => p.game.timeClass === tc && p.acc != null);
  if (!pg.length) return null;
  const S1 = f => sum(pg.map(f)), counted = S1(p => p.myCounted || 0);
  const accs = pg.map(p => p.acc), m = mean(accs);
  const win = pg.filter(p => p.maxEval >= 300), lose = pg.filter(p => p.minEval <= -300);
  const score = list => 100 * mean(list.map(p => scoreOf(p.game)));
  const [ck, cn] = [0, 1].map(i => S1(p => p.myCrit?.[i] || 0)), [bk, bn] = [0, 1].map(i => S1(p => p.myBril?.[i] || 0));
  const enough = pg.length >= 3 && counted >= 20;
  return {
    vals: {
      accuracy: enough ? ladderCalibrate('accuracy', m) : null,
      blunders: enough ? ladderCalibrate('blunders', 100 * S1(p => p.myBl || 0) / counted) : null,
      conversion: win.length >= 5 ? score(win) : null,
      resilience: lose.length >= 5 ? score(lose) : null,
      brilliance: bn >= 10 ? 100 * bk / bn : null,
      consistency: pg.length >= 8 ? Math.sqrt(sum(accs.map(x => (x - m) ** 2)) / (pg.length - 1)) : null,
      clutch: cn >= 10 ? 100 * ck / cn : null,
    },
    n: { accuracy: pg.length, blunders: counted, conversion: win.length, resilience: lose.length, brilliance: bn, consistency: pg.length, clutch: cn },
  };
}

const ladderBandOf = r => Math.floor(r / LADDER_BAND) * LADDER_BAND;

// Percentile (0–100) of a value among the sampled players, from stored quantiles (q[0] = min … q[20] = max).
// Ties take the middle of their run: if a third of rapid players are never in time trouble, 0% sits near
// the 17th percentile, not at the bottom.
function ladderPct(q, v) {
  if (!q || v == null) return null;
  const last = q.length - 1;
  if (v < q[0]) return 0;
  if (v > q[last]) return 100;
  const lo = q.findIndex(x => x >= v), hi = q.findLastIndex(x => x <= v);
  if (lo <= hi) return (lo + hi) / 2 * 100 / last;               // v equals one or more quantiles
  const f = (v - q[hi]) / (q[lo] - q[hi]);                         // strictly between q[hi] and q[lo] (lo = hi + 1)
  return (hi + f) * 100 / last;
}

// Radar values for a set of raw metrics in a time control
function ladderRadar(tcData, vals, axes) {
  return axes.map(a => { const p = ladderPct(tcData.quantiles[a.key], vals?.[a.key]); return p == null ? null : a.invert ? 100 - p : p; });
}

let _ladder = null;
let _ladderCalib = null;
const getLadder = () => _ladder ||= fetch('js/ladder.json').then(r => (r.ok ? r.json() : null)).then(L => { _ladderCalib = L?.calib || null; return L; }).catch(() => null);
// a browser-engine (Stockfish 10) measurement on the ladder's Stockfish 19 scale: y = a + b·x, fitted per metric
const ladderCalibrate = (key, v) => {
  const f = !NATIVE_SF && _ladderCalib?.[key];
  return f && v != null ? f[0] + f[1] * v : v;
};

// The typical player of a band: the median of its players' true levels
const ladderTypical = band => band && { ...band.median };
const bandLabel = b => (+b === 0 ? `<${LADDER_BAND}` : `${b}–${+b + LADDER_BAND - 1}`); // the lowest band: chess.com ratings start at 100
const tcTitle = tc => tc[0].toUpperCase() + tc.slice(1);

// ---------- you: the same metrics, from your loaded games (and your engine scan for performance) ----------
function ladderMeasure(games, tc, agg = null) {
  const gs = games.filter(g => g.timeClass === tc && g.rated);
  if (gs.length < LADDER_MIN_GAMES) return null;
  // the ladder holds players' true levels (noise removed), so you get your most precise estimate: up to 100 recent games
  const recent = gs.slice(0, LADDER_YOU_GAMES);
  const perf = ladderPerf(agg, tc);
  const vals = { ...(ladderHabits(recent) || {}), ...(perf?.vals || {}) };
  return { vals, n: perf?.n || {}, games: gs.length, band: ladderBandOf(median(recent.map(g => g.me.rating))) };
}
const ladderYou = tc => ladderMeasure(S.games, tc, S.scanAgg);
const hasPerf = vals => LADDER_PERF.some(a => vals?.[a.key] != null);

// The radar cards below build their layout once and afterwards only change its contents, so picking a band
// or a time control glides the radar to its new shape instead of rebuilding every chart on the card.
const slot = (el, cls) => $(`.${cls}`, el);
const valTip = (a, label, v) => `${label}: ${v != null ? a.fmt(v) : '–'}`;

// ---------- performance on a rating scale ----------
// A percentile squeezes the strong end together (80% and 99% accuracy are both "top few percent"), so the
// Performance radar instead places each value at the rating whose typical player has it: the band medians,
// made monotone in rating (pool adjacent violators) and joined linearly, extended past the end bands along
// their trend. The distance between two players then reads as a rating gap. Resilience falls as rating rises
// (stronger opponents convert better), so it has no rating equivalent and stays off the radar.
const RATING_MAX = 3500;
const PERF_RADAR = LADDER_PERF.filter(a => a.key !== 'resilience');
const _curves = new WeakMap();
function ladderCurve(T, a) {
  let c = _curves.get(T);
  if (!c) _curves.set(T, c = {});
  if (c[a.key]) return c[a.key];
  const s = a.invert ? -1 : 1, blocks = [];
  const pts = Object.entries(T.bands).map(([b, x]) => [x.centre ?? +b + LADDER_BAND / 2, x.median[a.key]]).filter(p => p[1] != null).sort((p, q) => p[0] - q[0]);
  for (const [x, y] of pts) {
    blocks.push({ x0: x, x1: x, y: s * y, n: 1 });
    while (blocks.length > 1 && blocks.at(-2).y > blocks.at(-1).y) {
      const b = blocks.pop(), p = blocks.at(-1);
      Object.assign(p, { x1: b.x1, y: (p.y * p.n + b.y * b.n) / (p.n + b.n), n: p.n + b.n });
    }
  }
  return c[a.key] = blocks.flatMap(b => (b.x1 > b.x0 ? [[b.x0, b.y], [b.x1, b.y]] : [[b.x0, b.y]]));
}
function ladderRatingOf(T, a, v) {
  const pts = v == null ? [] : ladderCurve(T, a);
  if (pts.length < 2) return null;
  const y = a.invert ? -v : v;
  // past an end: the slope of the last few bands there (flat: stay at the end)
  const extend = (end, far) => { const [xe, ye] = pts[end], [xf, yf] = pts[far], k = (ye - yf) / (xe - xf); return k > 0 ? xe + (y - ye) / k : xe; };
  let r;
  if (y <= pts[0][1]) r = extend(0, Math.min(2, pts.length - 1));
  else if (y >= pts.at(-1)[1]) r = extend(pts.length - 1, Math.max(0, pts.length - 3));
  else {
    let i = 0;
    while (pts[i + 1][1] < y) i++;
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    r = y1 === y0 ? (x0 + x1) / 2 : x0 + (y - y0) * (x1 - x0) / (y1 - y0);
  }
  return Math.max(0, Math.min(RATING_MAX, r));
}
// A measured value is a player's level plus luck. On the rating scale a little luck moves a measure that changes
// slowly with rating (conversion, brilliance) by hundreds of points, so a player's value is first pulled toward
// the typical player of their own band by the share of its spread that is luck: true spread (sdPlayers) against
// sampling error (sdGame per game or chance, over n). Consistency is a spread itself: its error is about
// SD·√(0.75/(n−1)) (excess kurtosis near 1). A band's typical player is already a true level.
function ladderShrink(T, a, side) {
  const v = side.vals?.[a.key], n = side.n?.[a.key];
  if (v == null || !n || side.band == null) return v;
  const B = T.bands[nearestBand(Object.keys(T.bands).map(Number), side.band)];
  const typ = B.median[a.key], tau = B.sdPlayers?.[a.key], sg = B.sdGame?.[a.key];
  const se2 = a.key === 'consistency' ? v * v * 0.75 / Math.max(1, n - 1) : sg ? sg * sg / n : null;
  if (typ == null || !tau || se2 == null) return v;
  return typ + (v - typ) * tau * tau / (tau * tau + se2);
}
const ratingWord = r => (r >= RATING_MAX ? `${RATING_MAX}+` : (Math.round(r / 50) * 50).toLocaleString());

const ladderState = { tc: null, band: null, cmp: null };

function ladderTcTabs(tcs, cur, attr) {
  return `<div class="seg">${tcs.map(tc => `<button ${attr}="${tc}" class="${tc === cur ? 'active' : ''}">${tcTitle(tc)}</button>`).join('')}</div>`;
}

function nearestBand(bands, b) {
  return bands.reduce((best, x) => Math.abs(x - b) < Math.abs(best - b) ? x : best, bands[0]);
}

// Bars from a centre line (the one you're compared with). rows: [{ label, diff, tip, faded }]; goodBad colours
// them green/red (performance) or leaves them neutral (style: different, not better); unit scales the bar
function divergingBars(rows, goodBad, unit = 1) {
  return rows.map(r => {
    const w = Math.min(50, Math.abs(r.diff) / unit), up = r.diff >= 0, shown = Math.round(Math.abs(r.diff)).toLocaleString();
    const col = goodBad ? (up ? 'var(--good-text)' : 'var(--critical)') : 'var(--brass)';
    return `<div class="dv-row${r.faded ? ' faded' : ''}" title="${esc(r.tip)}"><span class="dv-lab">${esc(r.label)}</span>
      <div class="dv-trk"><div class="dv-mid"></div><div class="dv-bar" style="background:${col};${up ? 'left' : 'right'}:50%;width:${w}%"></div></div>
      <span class="dv-val" style="color:${goodBad ? col : 'inherit'}">${shown !== '0' ? (up ? '+' : '−') : ''}${shown}</span></div>`;
  }).join('');
}

// ---------- the comparison: a band's typical player, or a chess.com player ----------
// ladderState.cmp, once "chess.com player" is chosen: { user, data, loading, msg, error, agg, aggTc, run }
function cmpPlayer() { const c = ladderState.cmp; return c?.data ? c : null; }

async function loadCmp(el, user) {
  user = user.trim().toLowerCase();
  if (!user) return;
  if (user === (S.username || '').toLowerCase()) { ladderState.cmp = { user, error: "That's you. Pick someone else." }; fillShapeCard(el); return; }
  const c = ladderState.cmp = { user, loading: true, msg: 'Loading…' };
  fillShapeCard(el);
  try { c.data = await loadSource({ kind: 'chesscom', user, months: S.months }, m => { c.msg = m; const s = $('.cmp-msg', el); if (s) showStatus(s, m); }); }
  catch (e) { c.error = e.message || String(e); }
  c.loading = false;
  if (ladderState.cmp === c) fillShapeCard(el);
}

// their engine numbers: Stockfish over their latest games in this time control, as your scan does yours
async function analyzeCmp(el, tc) {
  const c = cmpPlayer();
  if (!c || c.run) return;
  const list = c.data.games.filter(g => g.timeClass === tc && g.plies >= 10).slice(0, 25), results = [];
  c.run = { done: 0, n: list.length };
  fillShapeCard(el);
  await analyzeGamesParallel(list, 12, {
    onProgress: (f, d) => { c.run.done = d; const s = $('.perf-sub', el); if (s) s.textContent = `Analyzing ${c.data.label}'s games: ${d} of ${list.length}…`; },
    onResult: (g, a) => results.push({ game: g, analysis: a }),
  });
  c.agg = results.length ? aggregateScan(results) : null;
  c.aggTc = tc;
  c.run = null;
  if (ladderState.cmp === c) fillShapeCard(el);
}

// your record against them (from your loaded games), and their current ratings
const cmpGames = c => S.games.filter(g => (g.opp.name || '').toLowerCase() === c.data.label.toLowerCase());
function cmpRecord(c) {
  const name = c.data.label, games = cmpGames(c);
  const st = c.data.player?.stats || {};
  const rat = ['bullet', 'blitz', 'rapid', 'daily'].map(k => (st['chess_' + k]?.last ? `${tcTitle(k)} <b>${st['chess_' + k].last.rating}</b>` : '')).filter(Boolean).join(' · ');
  if (!games.length) return `<div class="cmp-record"><p class="small muted">${rat ? `${esc(name)}: ${rat}. ` : ''}You haven't played ${esc(name)} in the loaded period.</p></div>`;
  const r = wdl(games), byTc = [...groupBy(games, g => g.timeClass)].map(([tc, gs]) => ({ tc, ...wdl(gs) }));
  return `<div class="cmp-record"><h3>Your record against ${esc(name)}</h3>${rat ? `<div class="sub">${esc(name)}: ${rat}</div>` : ''}
    <div class="tiles">
      ${tile('Games', r.n, `${r.w}W · ${r.d}D · ${r.l}L`)}
      ${tile('Your score', pct(r.score, 1), `${esc(name)}: ${pct(1 - r.score, 1)}`)}
      ${tile('Last game', fmtDate(games[0].end), `${games[0].result} as ${games[0].color}`)}
      ${byTc.map(t => tile(t.tc, `${t.w}–${t.d}–${t.l}`, `${pct(t.score)} for you`)).join('')}
    </div>
    <div class="table-wrap" style="max-height:280px;overflow-y:auto"><table><thead><tr><th>Date</th><th></th><th>Result</th><th>Time</th><th>Opening</th><th class="num">Moves</th></tr></thead><tbody>
      ${games.slice(0, 100).map((g, i) => `<tr class="clickable" data-cg="${i}"><td>${fmtDate(g.end)}</td><td><span class="dot ${g.color}"></span></td><td>${resBadge(g.result)}</td><td><span class="pill">${tcLabel(g)}</span></td><td>${esc(g.opening.length > 40 ? g.opening.slice(0, 38) + '…' : g.opening)}</td><td class="num">${g.moves}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// one pane: you against the other side, as a radar or as bars. scale: 'pct' (percentile among the time
// control's players) or 'rating' (the rating whose typical player matches)
function shapePane(el, canvasId, barsCls, T, axes, you, other, scale) {
  const rating = scale === 'rating';
  const at = (side, a) => {
    const vals = side.vals;
    if (rating) return ladderRatingOf(T, a, ladderShrink(T, a, side));
    const p = ladderPct(T.quantiles[a.key], vals?.[a.key]);
    return p == null ? null : a.invert ? 100 - p : p;
  };
  const yP = axes.map(a => at(you, a)), oP = axes.map(a => at(other, a));
  const tip = (a, label, v, r) => valTip(a, label, v) + (rating && r != null ? ` · plays like a typical ${ratingWord(r)}` : '');
  radarChart($('#' + canvasId, el), axes.map(a => a.label), [
    { label: 'You', data: yP, slot: '--s1' },
    { label: other.label, data: oP, ...(other.player ? { slot: '--s2' } : { dashed: true }) },
  ], { rating, tooltip: c => { const a = axes[c.dataIndex], side = c.datasetIndex ? other : you; return tip(a, c.dataset.label, side.vals[a.key], (c.datasetIndex ? oP : yP)[c.dataIndex]); } });
  const rows = axes.map((a, i) => ({ a, i })).filter(({ i }) => yP[i] != null && oP[i] != null).map(({ a, i }) => ({ label: a.label, diff: yP[i] - oP[i],
    tip: `You ${a.fmt(you.vals[a.key])} · ${other.label} ${a.fmt(other.vals[a.key])}${rating ? ' (rating points)' : ' (percentile points)'}`,
    faded: PERF_KEYS.has(a.key) && (you.n?.[a.key] ?? 99) < 15 }));
  rows.sort(rating ? (x, y) => y.diff - x.diff : (x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  slot(el, barsCls).innerHTML = divergingBars(rows, rating, rating ? 40 : 1);
}

// the "vs" picker: every band, then a chess.com player
const shapeSelect = (bands, cur) => `<select id="shapeBand">${bands.map(b => `<option value="${b}" ${cur !== 'player' && +b === +cur ? 'selected' : ''}>${bandLabel(b)}</option>`).join('')}
  <option disabled>──────</option><option value="player" ${cur === 'player' ? 'selected' : ''}>chess.com player…</option></select>`;

const SHAPE_BODY = `<div class="grid cols-2 shape-grid">
    <div class="shape-pane">
      <span class="pane-title">Style</span>
      <div class="chart-box radar shape-radar"><canvas id="shapeRadar"></canvas></div>
      <div class="shape-bars style-bars"></div>
      <div class="muted small pane-note">Percentile among players · differences, not scores</div>
    </div>
    <div class="shape-pane perf-pane">
      <span class="pane-title">Performance</span>
      <div class="sub perf-sub"></div>
      <div class="chart-box radar shape-radar perf-radar"><canvas id="perfRadar"></canvas></div>
      <div class="shape-bars perf-bars"></div>
      <div class="muted small pane-note perf-note">Rating whose typical player matches · outward is better</div>
    </div>
  </div>`;

// ---------- "Shape": you vs a band's typical player or a chess.com player, as a Style radar (habits,
// percentiles) and a Performance radar (from scans, on the rating scale), with a bars view ----------
async function fillShapeCard(el) {
  if (!el) return;
  const L = await getLadder();
  const c = ladderState.cmp, P = cmpPlayer();
  const theirs = tc => P && ladderMeasure(P.data.games, tc, P.aggTc === tc ? P.agg : null);
  const tcs = L ? LADDER_TCS.filter(tc => L.tc[tc] && Object.keys(L.tc[tc].bands).length && ladderYou(tc) && (!P || theirs(tc))) : [];
  const view = ladderState.view || 'radar';
  if (!$('.shape-pick', el)) el.innerHTML = `<div class="row-between"><h3>Shape</h3><span class="shape-view"></span></div>
    <div class="row-between shape-head"><div class="sub band-pick shape-pick"></div><span class="muted small shape-tcs"></span></div>
    <div class="shape-body"></div><div class="cmp-slot"></div>`;
  slot(el, 'shape-view').innerHTML = `<div class="seg">${[['radar', 'Radar'], ['bars', 'Bars']].map(([v, l]) => `<button data-shape-view="${v}" class="${v === view ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const form = c ? `<span class="cmp-form"><input class="cmp-user" placeholder="chess.com username" value="${esc(c.user || '')}" spellcheck="false"><button class="btn small-btn cmp-go">Compare</button></span>
    <span class="muted small cmp-msg">${c.loading ? esc(c.msg || '') : c.error ? `<span style="color:var(--critical)">${esc(c.error)}</span>` : ''}</span>` : '';
  const body = slot(el, 'shape-body');
  slot(el, 'cmp-slot').innerHTML = P ? cmpRecord(P) : '';
  // nothing to draw yet: a player still to pick or load, or no time control in common
  if (!tcs.length || (c && !P)) {
    const bands = L && tcs.length ? Object.keys(L.tc[tcs[0]].bands).map(Number).sort((a, b) => a - b) : [];
    slot(el, 'shape-pick').innerHTML = `You vs ${shapeSelect(bands, c ? 'player' : null)}${form}`;
    slot(el, 'shape-tcs').innerHTML = '';
    body.innerHTML = c && !P ? '' : `<p class="muted small">${!L ? 'Ladder data unavailable.' : P ? `No time control where you and ${esc(P.data.label)} both have 10+ rated games.` : 'Needs 10+ rated bullet, blitz or rapid games.'}</p>`;
    return bindShape(el, null);
  }
  if (!$('#shapeRadar', el)) body.innerHTML = SHAPE_BODY;
  // the header's time control when it has a ladder; otherwise the one with most of your games
  const hf = $('#fTime')?.value, tc = tcs.includes(hf) ? hf : tcs.reduce((a, b) => (ladderYou(a).games >= ladderYou(b).games ? a : b));
  const T = L.tc[tc], you = ladderYou(tc), bands = Object.keys(T.bands).map(Number).sort((a, b) => a - b);
  const band = bands.includes(ladderState.band) && ladderState.tc === tc ? ladderState.band : nearestBand(bands, you.band);
  Object.assign(ladderState, { tc, band });
  const other = P ? { label: P.data.label, player: true, ...theirs(tc) } : { label: `Typical ${bandLabel(band)}`, vals: ladderTypical(T.bands[band]), n: {} };
  slot(el, 'shape-pick').innerHTML = `You vs ${shapeSelect(bands, P ? 'player' : band)}${!P && you.band === band ? ' · your band' : ''}${form}`;
  slot(el, 'shape-tcs').textContent = tc === hf ? tcTitle(tc) : `${tcTitle(tc)} · most of your games`;
  $$('.shape-radar', el).forEach(x => x.classList.toggle('hidden', view !== 'radar'));
  $$('.shape-bars', el).forEach(x => x.classList.toggle('hidden', view !== 'bars'));
  shapePane(el, 'shapeRadar', 'style-bars', T, LADDER_STYLE, you, other, 'pct');

  // performance: your scan, and the other side's (a band's typical player has one; a chess.com player needs analysing)
  const mine = hasPerf(you.vals), ok = mine && hasPerf(other.vals);
  slot(el, 'perf-pane').classList.toggle('pending', !ok);
  const sub = slot(el, 'perf-sub');
  if (ok) { sub.textContent = ''; shapePane(el, 'perfRadar', 'perf-bars', T, PERF_RADAR, you, other, 'rating'); }
  else {
    slot(el, 'perf-bars').innerHTML = '';
    if (!mine) sub.textContent = S.scanAgg ? `Scan some ${tc} games to see this.` : 'Scan your games to see this.';
    else if (P?.run) sub.textContent = `Analyzing ${P.data.label}'s games: ${P.run.done} of ${P.run.n}…`;
    else sub.innerHTML = `<button class="btn small-btn primary cmp-an">Analyze ${esc(other.label)}'s ${tc} games</button> <span class="muted small">25 games</span>`;
  }
  bindShape(el, tc);
}

function bindShape(el, tc) {
  $$('[data-shape-view]', el).forEach(b => b.onclick = () => { ladderState.view = b.dataset.shapeView; fillShapeCard(el); });
  $('#shapeBand', el).onchange = e => {
    if (e.target.value === 'player') { ladderState.cmp ||= { user: '' }; fillShapeCard(el).then(() => $('.cmp-user', el)?.focus()); return; }
    ladderState.cmp = null; ladderState.band = +e.target.value; fillShapeCard(el);
  };
  const input = $('.cmp-user', el), go = () => loadCmp(el, input.value);
  if (input) { $('.cmp-go', el).onclick = go; input.onkeydown = e => { if (e.key === 'Enter') go(); }; }
  const an = $('.cmp-an', el);
  if (an) an.onclick = () => analyzeCmp(el, tc);
  const P = cmpPlayer();
  if (P) $$('[data-cg]', el).forEach(tr => tr.onclick = () => openReview(cmpGames(P)[+tr.dataset.cg]));
}

// ---------- by rating: the typical player of every band, for any measure ----------
async function renderByRating(sec) {
  const L = await getLadder();
  if (!L) { sec.innerHTML = empty('Ladder data unavailable.'); return; }
  const tcs = LADDER_TCS.filter(tc => L.tc[tc] && Object.keys(L.tc[tc].bands).length);
  // follows the header's time control; without a player (guest) it has its own tabs
  const guest = !S.games.length, hf = $('#fTime')?.value;
  const tc = guest ? (tcs.includes(ladderState.ltc) ? ladderState.ltc : tcs.includes('blitz') ? 'blitz' : tcs[0]) : tcs.includes(hf) ? hf : (tcs.includes(ladderState.tc) ? ladderState.tc : tcs.includes('blitz') ? 'blitz' : tcs[0]);
  const T = L.tc[tc], bands = Object.keys(T.bands).map(Number).sort((a, b) => a - b);
  const you = S.games.length ? ladderYou(tc) : null;
  const metric = [...LADDER_PERF, ...LADDER_STYLE].find(x => x.key === ladderState.trend) || LADDER_PERF[0];
  ladderState.ltc = tc;
  if (!$('#ladTrendChart', sec)) sec.innerHTML = `
    <div class="card">
      <div class="row-between"><div class="lad-tcs"></div><select id="ladTrend"></select></div>
      <div class="sub lad-trend-sub" style="margin-top:6px"></div>
      <div class="chart-box"><canvas id="ladTrendChart"></canvas></div>
    </div>
    <p class="muted small lad-foot" style="margin-top:10px"></p>`;
  slot(sec, 'lad-tcs').innerHTML = guest ? ladderTcTabs(tcs, tc, 'data-ladder-tc') : `<span class="muted small">${tcTitle(tc)}</span>`;
  $('#ladTrend', sec).innerHTML = [['Performance', LADDER_PERF], ['Style', LADDER_STYLE]].map(([g, axes]) =>
    `<optgroup label="${g}">${axes.map(x => `<option value="${x.key}" ${x.key === metric.key ? 'selected' : ''}>${x.row || x.label}</option>`).join('')}</optgroup>`).join('');
  slot(sec, 'lad-trend-sub').innerHTML = `Typical player at each rating, with the middle half of players shaded${metric.unit ? ` · ${metric.unit.replace('/100', 'per 100')}` : ''}`;
  slot(sec, 'lad-foot').textContent = `${T.players.toLocaleString()} ${tc} players sampled, about ${Math.round(median(bands.map(x => T.bands[x].n))).toLocaleString()} per band. Built ${L.built}.`;
  const xs = bands.filter(x => T.bands[x].median[metric.key] != null);
  const pt = (x, k) => ({ x: T.bands[x].centre ?? x + LADDER_BAND / 2, y: T.bands[x][k][metric.key], lo: T.bands[x].p25[metric.key], hi: T.bands[x].p75[metric.key] });
  const col = cssVar('--s1');
  const ds = [
    { label: 'Middle half', data: xs.map(x => pt(x, 'p75')), borderWidth: 0, pointRadius: 0, backgroundColor: col + '22', fill: '+1', tension: 0.25 },
    { label: '', data: xs.map(x => pt(x, 'p25')), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.25 },
    { label: 'Typical player', data: xs.map(x => pt(x, 'median')), borderColor: col, backgroundColor: col, pointRadius: 2.5, tension: 0.25 },
  ];
  const yv = you?.vals[metric.key];
  if (yv != null) ds.push({ label: 'You', data: [{ x: median(S.games.filter(g => g.timeClass === tc && g.rated).slice(0, LADDER_YOU_GAMES).map(g => g.me.rating)), y: yv }], borderColor: cssVar('--s2'), backgroundColor: cssVar('--s2'), pointRadius: 6, showLine: false });
  const fmtY = v => metric.cell(v);
  makeChart($('#ladTrendChart', sec), { type: 'line', data: { datasets: ds }, options: {
    parsing: false,
    plugins: { legend: { display: true, position: 'top', align: 'start', labels: { filter: i => i.text } },
      tooltip: { filter: i => i.datasetIndex >= 2, callbacks: { title: c => (c[0].datasetIndex === 3 ? 'You' : bandLabel(ladderBandOf(c[0].raw.x))),
        label: c => (c.datasetIndex === 2 ? `Typical: ${fmtY(c.raw.y)} · middle half ${fmtY(c.raw.lo)} to ${fmtY(c.raw.hi)}` : `${c.dataset.label}: ${fmtY(c.parsed.y)}`) } } },
    scales: baseScales({ ticks: { callback: fmtY } }, { type: 'linear', ticks: { callback: v => v } }),
  } });
  $$('[data-ladder-tc]', sec).forEach(btn => btn.onclick = () => { ladderState.ltc = btn.dataset.ladderTc; renderByRating(sec); });
  $('#ladTrend', sec).onchange = e => { ladderState.trend = e.target.value; renderByRating(sec); };
}
