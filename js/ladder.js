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
// Head to head: accuracy, blunders and the habits on one radar
const LADDER_AXES = [...LADDER_PERF.slice(0, 2), ...LADDER_STYLE];
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
    n: { accuracy: pg.length, blunders: pg.length, conversion: win.length, resilience: lose.length, brilliance: bn, consistency: pg.length, clutch: cn },
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
function ladderRadar(tcData, vals, axes = LADDER_AXES) {
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

// Two players on the same scale (Head to head)
async function fillPairShape(el, A, B) {
  if (!el) return;
  const L = await getLadder();
  const tcs = L ? LADDER_TCS.filter(tc => L.tc[tc] && Object.keys(L.tc[tc].quantiles).length && ladderMeasure(A.games, tc) && ladderMeasure(B.games, tc)) : [];
  if (!tcs.length) { el.innerHTML = '<p class="muted small">Needs 10+ rated games each in one time control.</p>'; return; }
  const tc = tcs.includes(ladderState.ptc) ? ladderState.ptc : tcs.reduce((x, y) => (ladderMeasure(A.games, x).games + ladderMeasure(B.games, x).games >= ladderMeasure(A.games, y).games + ladderMeasure(B.games, y).games ? x : y));
  ladderState.ptc = tc;
  const T = L.tc[tc], a = ladderMeasure(A.games, tc, A.agg), b = ladderMeasure(B.games, tc, B.agg);
  const noEngine = a.vals.accuracy == null || b.vals.accuracy == null;
  if (!$('#pairRadar', el)) el.innerHTML = `<div class="row-between" style="margin-bottom:6px"><span class="sub pair-note" style="margin:0"></span><span class="pair-tcs"></span></div>
    <div class="chart-box radar"><canvas id="pairRadar"></canvas></div>`;
  slot(el, 'pair-note').textContent = `Percentile among ${tc} players${noEngine ? ' · analyze both for accuracy and blunders' : ''}`;
  slot(el, 'pair-tcs').innerHTML = ladderTcTabs(tcs, tc, 'data-pair-tc');
  radarChart($('#pairRadar', el), LADDER_AXES.map(x => x.label), [
    { label: A.label, data: ladderRadar(T, a.vals), slot: '--s1' },
    { label: B.label, data: ladderRadar(T, b.vals), slot: '--s2' },
  ], { tooltip: c => valTip(LADDER_AXES[c.dataIndex], c.dataset.label, (c.datasetIndex ? b : a).vals[LADDER_AXES[c.dataIndex].key]) });
  $$('[data-pair-tc]', el).forEach(btn => btn.onclick = () => { ladderState.ptc = btn.dataset.pairTc; fillPairShape(el, A, B); });
}

const ladderState = { tc: null, band: null, a: null, b: null };

function ladderTcTabs(tcs, cur, attr) {
  return `<div class="seg">${tcs.map(tc => `<button ${attr}="${tc}" class="${tc === cur ? 'active' : ''}">${tcTitle(tc)}</button>`).join('')}</div>`;
}

function ladderBandSelect(id, bands, cur) {
  return `<select id="${id}">${bands.map(b => `<option value="${b}" ${+b === +cur ? 'selected' : ''}>${bandLabel(b)}</option>`).join('')}</select>`;
}

function nearestBand(bands, b) {
  return bands.reduce((best, x) => Math.abs(x - b) < Math.abs(best - b) ? x : best, bands[0]);
}

// the comparison table under a radar: rows of metrics, a left and a right column
const ladderTable = (axes, leftHead, rightHead, leftCell, rightVals) => `<thead><tr><th></th><th class="num">${leftHead}</th><th class="num">${rightHead}</th></tr></thead><tbody>
  ${axes.map(x => `<tr><td>${ladderRowName(x)}</td><td class="num">${leftCell(x)}</td><td class="num">${rightVals[x.key] != null ? x.cell(rightVals[x.key]) : '–'}</td></tr>`).join('')}</tbody>`;

// Bars from a centre line (the reference player). rows: [{ label, diff, tip, faded }]; goodBad colours
// them green/red (performance) or leaves them neutral (style: different, not better)
function divergingBars(rows, goodBad) {
  return rows.map(r => {
    const w = Math.min(50, Math.abs(r.diff)), up = r.diff >= 0, shown = Math.round(Math.abs(r.diff));
    const col = goodBad ? (up ? 'var(--good-text)' : 'var(--critical)') : 'var(--brass)';
    return `<div class="dv-row${r.faded ? ' faded' : ''}" title="${esc(r.tip)}"><span class="dv-lab">${esc(r.label)}</span>
      <div class="dv-trk"><div class="dv-mid"></div><div class="dv-bar" style="background:${col};${up ? 'left' : 'right'}:50%;width:${w}%"></div></div>
      <span class="dv-val" style="color:${goodBad ? col : 'inherit'}">${shown ? (up ? '+' : '−') : ''}${shown}</span></div>`;
  }).join('');
}

// one radar (or its bars) of you against the typical player of a band, in percentile points
function shapePane(el, canvasId, barsCls, T, axes, you, typ, band, goodBad) {
  const yP = ladderRadar(T, you.vals, axes), tP = ladderRadar(T, typ, axes), typLabel = `Typical ${bandLabel(band)}`;
  radarChart($('#' + canvasId, el), axes.map(a => a.label), [
    { label: 'You', data: yP, slot: '--s1' },
    { label: typLabel, data: tP, dashed: true },
  ], { tooltip: c => { const a = axes[c.dataIndex]; return valTip(a, c.dataset.label, (c.datasetIndex ? typ : you.vals)[a.key]); } });
  const rows = axes.map((a, i) => ({ a, i })).filter(({ i }) => yP[i] != null && tP[i] != null).map(({ a, i }) => ({ label: a.label, diff: yP[i] - tP[i],
    tip: `You ${a.fmt(you.vals[a.key])} · typical ${a.fmt(typ[a.key])} (percentile points)`, faded: PERF_KEYS.has(a.key) && (you.n[a.key] ?? 99) < 15 }));
  slot(el, barsCls).innerHTML = divergingBars(goodBad ? rows.sort((x, y) => y.diff - x.diff) : rows.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)), goodBad);
}

// ---------- "Shape": you vs the typical player of a band, as a Style radar (habits) and a Performance radar
// (from the scan), with a bars view of the same numbers ----------
async function fillShapeCard(el) {
  if (!el) return;
  const L = await getLadder();
  const tcs = L ? LADDER_TCS.filter(tc => L.tc[tc] && Object.keys(L.tc[tc].bands).length && ladderYou(tc)) : [];
  if (!tcs.length) { el.innerHTML = `<h3>Shape</h3><p class="muted small">${L ? 'Needs 10+ rated bullet, blitz or rapid games.' : 'Ladder data unavailable.'}</p>`; return; }
  const tc = tcs.includes(ladderState.tc) ? ladderState.tc : tcs.reduce((a, b) => (ladderYou(a).games >= ladderYou(b).games ? a : b));
  const T = L.tc[tc], you = ladderYou(tc), bands = Object.keys(T.bands).map(Number).sort((a, b) => a - b);
  const band = bands.includes(ladderState.band) && ladderState.tc === tc ? ladderState.band : nearestBand(bands, you.band);
  const view = ladderState.view || 'radar';
  Object.assign(ladderState, { tc, band });
  const typ = ladderTypical(T.bands[band]);
  if (!$('#shapeRadar', el)) el.innerHTML = `<div class="row-between"><h3>Shape</h3><span class="shape-view"></span></div>
    <div class="row-between shape-head"><div class="sub band-pick shape-pick"></div><span class="shape-tcs"></span></div>
    <div class="grid cols-2 shape-grid">
      <div class="shape-pane">
        <span class="pane-title">Style</span>
        <div class="chart-box radar shape-radar"><canvas id="shapeRadar"></canvas></div>
        <div class="shape-bars style-bars"></div>
        <div class="muted small pane-note">Differences, not scores</div>
      </div>
      <div class="shape-pane perf-pane">
        <span class="pane-title">Performance</span>
        <div class="sub perf-sub"></div>
        <div class="chart-box radar shape-radar perf-radar"><canvas id="perfRadar"></canvas></div>
        <div class="shape-bars perf-bars"></div>
        <div class="muted small pane-note perf-note">Outward is better</div>
      </div>
    </div>`;
  slot(el, 'shape-view').innerHTML = `<div class="seg">${[['radar', 'Radar'], ['bars', 'Bars']].map(([v, l]) => `<button data-shape-view="${v}" class="${v === view ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  slot(el, 'shape-tcs').innerHTML = ladderTcTabs(tcs, tc, 'data-shape-tc');
  slot(el, 'shape-pick').innerHTML = `You vs ${ladderBandSelect('shapeBand', bands, band)}${you.band === band ? ' · your band' : ''}`;
  $$('.shape-radar', el).forEach(x => x.classList.toggle('hidden', view !== 'radar'));
  $$('.shape-bars', el).forEach(x => x.classList.toggle('hidden', view !== 'bars'));
  shapePane(el, 'shapeRadar', 'style-bars', T, LADDER_STYLE, you, typ, band, false);

  // performance: needs a scan with games in this time control
  const ok = hasPerf(you.vals);
  slot(el, 'perf-pane').classList.toggle('pending', !ok);
  if (!ok) {
    slot(el, 'perf-sub').textContent = S.scanAgg ? `Scan some ${tc} games to see this.` : 'Scan your games to see this.';
    slot(el, 'perf-bars').innerHTML = '';
  } else {
    slot(el, 'perf-sub').textContent = '';
    shapePane(el, 'perfRadar', 'perf-bars', T, LADDER_PERF, you, typ, band, true);
  }
  $$('[data-shape-view]', el).forEach(b => b.onclick = () => { ladderState.view = b.dataset.shapeView; fillShapeCard(el); });
  $$('[data-shape-tc]', el).forEach(b => b.onclick = () => { ladderState.tc = b.dataset.shapeTc; ladderState.band = null; fillShapeCard(el); });
  $('#shapeBand', el).onchange = e => { ladderState.band = +e.target.value; fillShapeCard(el); };
}

// ---------- the Ladder page: the typical player at every rating ----------
async function renderLadder(sec) {
  const L = await getLadder();
  if (!L) { sec.innerHTML = empty('Ladder data unavailable.'); return; }
  const tcs = LADDER_TCS.filter(tc => L.tc[tc] && Object.keys(L.tc[tc].bands).length);
  const tc = tcs.includes(ladderState.ltc) ? ladderState.ltc : (tcs.includes('blitz') ? 'blitz' : tcs[0]);
  const T = L.tc[tc], bands = Object.keys(T.bands).map(Number).sort((a, b) => a - b);
  const you = S.games.length ? ladderYou(tc) : null;
  // "Compare my radar": you (latest games in this time control) against the typical player of a chosen band
  const me = !!(ladderState.me && you);
  const a = bands.includes(ladderState.a) ? ladderState.a : nearestBand(bands, you?.band ?? 1000);
  const b = bands.includes(ladderState.b) ? ladderState.b : nearestBand(bands, me ? you.band : a + 1000);
  const metric = [...LADDER_PERF, ...LADDER_STYLE].find(x => x.key === ladderState.trend) || LADDER_PERF[0];
  const trendKey = `${tc}|${metric.key}|${you ? [you.band, you.vals[metric.key]].join() : ''}`;
  const trendChanged = ladderState.trendKey !== trendKey;
  Object.assign(ladderState, { ltc: tc, a, b, trendKey });
  const ta = ladderTypical(T.bands[a]), tb = ladderTypical(T.bands[b]);
  const left = me ? { label: 'You', vals: you.vals } : { label: bandLabel(a), vals: ta };
  const right = me ? `Typical ${bandLabel(b)}` : bandLabel(b);
  const meBtn = !S.games.length ? '' : you
    ? `<button class="btn small-btn ${me ? '' : 'primary'}" id="ladMe">${me ? 'Compare two bands' : 'Compare my radar'}</button>`
    : `<button class="btn small-btn" disabled title="Needs 10+ rated ${tc} games">Compare my radar</button>`;
  const fresh = !$('#ladRadar', sec);
  if (fresh) sec.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="row-between"><h3>Rating ladder</h3><span class="lad-tcs"></span></div>
      <div class="sub band-pick lad-pick"></div>
      <div class="lad-hint"></div>
      <div class="grid cols-2 shape-grid">
        <div><span class="pane-title">Style</span><div class="chart-box radar"><canvas id="ladRadar"></canvas></div><table class="cmp ladder-vals lad-vals-s"></table></div>
        <div><span class="pane-title">Performance</span><div class="chart-box radar"><canvas id="ladPerf"></canvas></div><table class="cmp ladder-vals lad-vals-p"></table></div>
      </div>
    </div>
    <div class="card">
      <div class="row-between"><h3>By rating</h3><select id="ladTrend"></select></div>
      <div class="sub lad-trend-sub"></div>
      <div class="chart-box"><canvas id="ladTrendChart"></canvas></div>
    </div>
    <p class="muted small lad-foot" style="margin-top:10px"></p>`;
  slot(sec, 'lad-tcs').innerHTML = ladderTcTabs(tcs, tc, 'data-ladder-tc');
  slot(sec, 'lad-pick').innerHTML = `${me ? '<b>You</b>' : ladderBandSelect('ladA', bands, a)} vs ${ladderBandSelect('ladB', bands, b)}${me && you.band === b ? ' · your band' : ''}<span class="band-me">${meBtn}</span>`;
  slot(sec, 'lad-hint').innerHTML = me && !hasPerf(you.vals) ? '<div class="muted small" style="margin:-4px 0 6px">Scan your games (Insights → Accuracy) to add performance.</div>' : '';
  const leftCell = x => left.vals[x.key] != null ? x.cell(left.vals[x.key]) : me && PERF_KEYS.has(x.key) ? '<span class="muted">scan</span>' : '–';
  slot(sec, 'lad-vals-s').innerHTML = ladderTable(LADDER_STYLE, left.label, right, leftCell, tb);
  slot(sec, 'lad-vals-p').innerHTML = ladderTable(LADDER_PERF, left.label, right, leftCell, tb);
  slot(sec, 'lad-foot').textContent = `${T.players.toLocaleString()} ${tc} players sampled, about ${Math.round(median(bands.map(x => T.bands[x].n))).toLocaleString()} per band. Radars: percentile among all ${tc} players. Built ${L.built}.`;
  for (const [id, axes] of [['#ladRadar', LADDER_STYLE], ['#ladPerf', LADDER_PERF]]) {
    radarChart($(id, sec), axes.map(x => x.label), [
      { label: left.label, data: ladderRadar(T, left.vals, axes), slot: '--s1' },
      { label: right, data: ladderRadar(T, tb, axes), slot: '--s3' },
    ], { tooltip: c => { const x = axes[c.dataIndex]; return valTip(x, c.dataset.label, (c.datasetIndex ? tb : left.vals)[x.key]); } });
  }
  // the trend chart only depends on the time control, the metric (and you): left alone when just a band changes
  if (fresh || trendChanged) {
    $('#ladTrend', sec).innerHTML = [['Performance', LADDER_PERF], ['Style', LADDER_STYLE]].map(([g, axes]) =>
      `<optgroup label="${g}">${axes.map(x => `<option value="${x.key}" ${x.key === metric.key ? 'selected' : ''}>${x.row || x.label}</option>`).join('')}</optgroup>`).join('');
    slot(sec, 'lad-trend-sub').innerHTML = `Typical player, with the middle half of players shaded${metric.unit ? ` · ${metric.unit.replace('/100', 'per 100')}` : ''}`;
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
  }
  $$('[data-ladder-tc]', sec).forEach(btn => btn.onclick = () => { ladderState.ltc = btn.dataset.ladderTc; ladderState.a = ladderState.b = null; renderLadder(sec); });
  const ladA = $('#ladA', sec);
  if (ladA) ladA.onchange = e => { ladderState.a = +e.target.value; renderLadder(sec); };
  const meB = $('#ladMe', sec);
  if (meB) meB.onclick = () => { ladderState.me = !me; ladderState.b = ladderState.me ? nearestBand(bands, you.band) : null; renderLadder(sec); };
  $('#ladB', sec).onchange = e => { ladderState.b = +e.target.value; renderLadder(sec); };
  $('#ladTrend', sec).onchange = e => { ladderState.trend = e.target.value; renderLadder(sec); };
}
