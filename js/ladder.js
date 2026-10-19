// Rating ladder: what the typical chess.com player looks like in each 100-point band, per time control.
// js/ladder.json is built once by tools/build-ladder.js from sampled chess.com players; the same functions
// below measure those players and you, so the comparison is like for like.
//
// Method (see tools/build-ladder.js): both sides of every sampled game; Stockfish 19 (depth 12, 1 line) for
// accuracy and blunders; a sliding, trend-corrected rating window around each band; game-to-game noise removed,
// so a band's median (its typical player) and the percentiles describe players' real levels. Radar axes are
// percentiles among all chess.com players of that time control: bands weighted by chess.com's published rating
// distribution (tools/rating-dist.json). Website scans use
// the browser engine (Stockfish 10); their numbers are mapped onto the Stockfish 19 scale (ladder.json calib).
const LADDER_TCS = ['bullet', 'blitz', 'rapid'];
const LADDER_BAND = 100, LADDER_MIN_GAMES = 10, LADDER_HABIT_GAMES = 50, LADDER_ENGINE_GAMES = 16, LADDER_DEPTH = 12, LADDER_YOU_GAMES = 100;
// cell: the bare number for tables (unit shown once, beside the row name); fmt: number + unit for tooltips
const ladderAxis = (key, label, cell, unit, extra = {}) => ({ key, label, cell, unit, fmt: v => cell(v) + (unit ? ' ' + unit.replace('/100', 'per 100') : ''), ...extra });
const LADDER_AXES = [
  ladderAxis('accuracy', 'Accuracy', v => num(v, 1) + '%', '', { engine: true }),
  ladderAxis('blunders', 'Few blunders', v => num(v, 1), '/100 moves', { row: 'Blunders', engine: true, invert: true }),
  ladderAxis('checks', 'Checks', v => num(v, 1), '/100 moves'),
  ladderAxis('captures', 'Captures', v => num(v, 1), '/100 moves'),
  ladderAxis('pawns', 'Pawn moves', v => num(v, 0) + '%', 'of moves'),
  ladderAxis('castleEarly', 'Early castling', v => num(v, 0) + '%', 'of games'),
  ladderAxis('earlyQueen', 'Early queen', v => num(v, 0) + '%', 'of games'),
  ladderAxis('timeTrouble', 'Time trouble', v => num(v, 0) + '%', 'of games'),
];
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

// Accuracy and blunders per 100 moves from analysed games: [{ game, analysis }] (the player's own moves)
function ladderEngine(items) {
  const accs = [], counted = [];
  for (const { game, analysis } of items) {
    const c = game.color[0];
    if (analysis.summary?.[c]?.accuracy != null) accs.push(analysis.summary[c].accuracy);
    counted.push(...analysis.moves.filter(m => m.color === c && m.cls !== 'book' && m.cls !== 'forced'));
  }
  if (!accs.length || counted.length < 20) return null;
  return { engineGames: accs.length, accuracy: mean(accs), blunders: 100 * counted.filter(m => m.loss >= 20).length / counted.length };
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
function ladderRadar(tcData, vals) {
  return LADDER_AXES.map(a => { const p = ladderPct(tcData.quantiles[a.key], vals?.[a.key]); return p == null ? null : a.invert ? 100 - p : p; });
}

let _ladder = null;
let _ladderCalib = null;
const getLadder = () => _ladder ||= fetch('js/ladder.json').then(r => (r.ok ? r.json() : null)).then(L => { _ladderCalib = L?.calib || null; return L; }).catch(() => null);
// a browser-engine (Stockfish 10) measurement on the ladder's Stockfish 19 scale: y = a + b·x, fitted per metric
const ladderCalibrate = (key, v) => {
  const f = !NATIVE_SF && _ladderCalib?.[key];
  return f && v != null ? f[0] + f[1] * v : v;
};

// The typical player of a band: the median for habits; the mean for engine metrics (only 4 games per player,
// where a median of few-move blunder counts would sit too low)
const ladderTypical = band => band && Object.fromEntries(LADDER_AXES.map(a => [a.key, (a.engine && !band.sdGame ? band.mean?.[a.key] : null) ?? band.median[a.key]]));
const bandLabel = b => `${b}–${+b + LADDER_BAND - 1}`;
const tcTitle = tc => tc[0].toUpperCase() + tc.slice(1);

// ---------- you: the same metrics, from your loaded games (and your engine scan for the engine axes) ----------
function ladderMeasure(games, tc, agg = null) {
  const gs = games.filter(g => g.timeClass === tc && g.rated);
  if (gs.length < LADDER_MIN_GAMES) return null;
  // the ladder holds players' true levels (noise removed), so you get your most precise estimate: up to 100 recent games
  const recent = gs.slice(0, LADDER_YOU_GAMES);
  const vals = { ...(ladderHabits(recent) || {}) };
  if (agg?.myMoves) {
    const pg = agg.perGame.filter(p => p.game.timeClass === tc && p.acc != null);
    const ms = agg.myMoves.filter(m => m.game.timeClass === tc && m.cls !== 'book' && m.cls !== 'forced');
    if (pg.length >= 3 && ms.length >= 20) {
      vals.accuracy = ladderCalibrate('accuracy', mean(pg.map(p => p.acc)));
      vals.blunders = ladderCalibrate('blunders', 100 * ms.filter(m => m.loss >= 20).length / ms.length);
    }
  }
  return { vals, games: gs.length, band: ladderBandOf(median(recent.map(g => g.me.rating))) };
}
const ladderYou = tc => ladderMeasure(S.games, tc, S.scanAgg);

// The three radar cards below build their layout once and afterwards only change its contents, so picking a band
// or a time control glides the radar to its new shape instead of rebuilding every chart on the card.
const slot = (el, cls) => $(`.${cls}`, el);

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
  ], { tooltip: c => { const x = LADDER_AXES[c.dataIndex], v = (c.datasetIndex ? b : a).vals[x.key]; return `${c.dataset.label}: ${v != null ? x.fmt(v) : '–'}`; } });
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
const ladderTable = (leftHead, rightHead, leftCell, rightVals) => `<thead><tr><th></th><th class="num">${leftHead}</th><th class="num">${rightHead}</th></tr></thead><tbody>
  ${LADDER_AXES.map(x => `<tr><td>${ladderRowName(x)}</td><td class="num">${leftCell(x)}</td><td class="num">${rightVals[x.key] != null ? x.cell(rightVals[x.key]) : '–'}</td></tr>`).join('')}</tbody>`;

// ---------- performance: from an engine scan, you vs your opponents in the same games ----------
// Each axis is drawn on a fixed scale (lo at the centre → hi at the rim) wide enough to span real players; tooltips
// and the bars view give the raw numbers. Opponents in the same games stand in for "the typical player at your
// level": matchmaking pairs you with people near your rating, and it cancels out game type.
const PERF_AXES = [
  { key: 'accuracy', label: 'Accuracy', lo: 55, hi: 95, fmt: v => num(v, 1) + '% accuracy' },
  { key: 'blunders', label: 'Few blunders', lo: 12, hi: 0, fmt: v => num(v, 1) + ' blunders per 100 moves' },
  { key: 'conversion', label: 'Conversion', lo: 0.4, hi: 1, fmt: v => pct(v) + ' scored from winning positions' },
  { key: 'resilience', label: 'Resilience', lo: 0, hi: 0.6, fmt: v => pct(v) + ' scored from losing positions' },
  { key: 'brilliance', label: 'Brilliance', lo: 0, hi: 0.7, fmt: v => pct(v) + ' of sound sacrifices and hard refutations found' },
  { key: 'consistency', label: 'Consistency', lo: 16, hi: 4, fmt: v => '±' + num(v, 1) + ' accuracy from game to game' },
  { key: 'clutch', label: 'Clutch', lo: 0.2, hi: 0.9, fmt: v => pct(v) + ' of only-move moments found' },
];
const perfScale = (a, v) => (v == null ? null : Math.max(0, Math.min(100, 100 * (v - a.lo) / (a.hi - a.lo))));

function computePerformance(agg) {
  const pg = agg?.perGame;
  if (!pg?.length || !agg.style) return null;
  const me = agg.style.me, op = agg.style.opp;
  const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
  const win = pg.filter(p => p.maxEval >= 300), lose = pg.filter(p => p.minEval <= -300);
  const sc = list => mean(list.map(p => scoreOf(p.game)));
  // pooled rate over several kinds of chance, once there are 10+ chances
  const pool = (...rs) => { const n = sum(rs.map(r => r?.n || 0)); return n >= 10 ? sum(rs.map(r => r?.k || 0)) / n : null; };
  const side = (accKey, who) => {
    const accs = pg.map(p => p[accKey]).filter(x => x != null), counted = sum(pg.map(p => p[who + 'Counted'] || 0));
    return {
      accuracy: accs.length >= 5 ? mean(accs) : null,
      blunders: counted >= 100 ? 100 * sum(pg.map(p => p[who + 'Bl'] || 0)) / counted : null,
      consistency: accs.length >= 8 ? sd(accs) : null,
    };
  };
  const you = { ...side('acc', 'my'), conversion: win.length >= 5 ? sc(win) : null, resilience: lose.length >= 5 ? sc(lose) : null,
    brilliance: pool(me.sacOpp, me.punishHard), clutch: me.critical.n >= 10 ? me.critical.rate : null };
  // your opponents converted the games where you were losing, and held the ones where you were winning
  const opp = { ...side('oppAcc', 'opp'), conversion: lose.length >= 5 ? 1 - sc(lose) : null, resilience: win.length >= 5 ? 1 - sc(win) : null,
    brilliance: pool(op.sacOpp, op.punishHard), clutch: op.critical.n >= 10 ? op.critical.rate : null };
  // how many chances each axis rests on (thin ones are faded in the bars view)
  const n = { accuracy: pg.length, blunders: pg.length, consistency: pg.length, conversion: Math.min(win.length, lose.length) || win.length,
    resilience: lose.length, brilliance: (me.sacOpp?.n || 0) + (me.punishHard?.n || 0), clutch: me.critical.n };
  return { games: pg.length, you, opp, n };
}

// Option B: bars from a centre line (the reference player). rows: [{ label, diff, tip, faded }]; goodBad colours
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

// ---------- "Shape": a Style radar (you vs the typical player of a band) and a Performance radar (you vs your
// opponents, from the scan), with a bars view of the same numbers ----------
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
  const perf = computePerformance(S.scanAgg);
  if (!$('#shapeRadar', el)) el.innerHTML = `<div class="row-between"><h3>Shape</h3><span class="shape-view"></span></div>
    <div class="grid cols-2 shape-grid">
      <div class="shape-pane">
        <div class="row-between"><span class="pane-title">Style</span><span class="shape-tcs"></span></div>
        <div class="sub band-pick shape-pick"></div>
        <div class="chart-box radar shape-radar"><canvas id="shapeRadar"></canvas></div>
        <div class="shape-bars style-bars"></div>
        <div class="muted small pane-note">Differences, not scores</div>
      </div>
      <div class="shape-pane perf-pane">
        <div class="row-between"><span class="pane-title">Performance</span></div>
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

  // style: the six habit axes, as percentiles among players of this time control
  const axes = LADDER_AXES.filter(a => !a.engine), keys = new Set(axes.map(a => a.key));
  const pick = arr => LADDER_AXES.map((a, i) => (keys.has(a.key) ? arr[i] : undefined)).filter(x => x !== undefined);
  const youP = pick(ladderRadar(T, you.vals)), typP = pick(ladderRadar(T, typ));
  radarChart($('#shapeRadar', el), axes.map(a => a.label), [
    { label: 'You', data: youP, slot: '--s1' },
    { label: `Typical ${bandLabel(band)}`, data: typP, dashed: true },
  ], { tooltip: c => { const a = axes[c.dataIndex], v = c.datasetIndex ? typ[a.key] : you.vals[a.key]; return `${c.dataset.label}: ${v != null ? a.fmt(v) : '–'}`; } });
  slot(el, 'style-bars').innerHTML = divergingBars(axes.map((a, i) => ({ label: a.label, diff: (youP[i] ?? 0) - (typP[i] ?? 0),
    tip: `You ${you.vals[a.key] != null ? a.fmt(you.vals[a.key]) : '–'} · typical ${typ[a.key] != null ? a.fmt(typ[a.key]) : '–'} (percentile points)`, faded: youP[i] == null }))
    .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)), false);

  // performance: needs a scan
  const pane = slot(el, 'perf-pane');
  pane.classList.toggle('pending', !perf);
  if (!perf) {
    slot(el, 'perf-sub').textContent = 'Scan your games to see this.';
    slot(el, 'perf-bars').innerHTML = '';
    return bindShape(el);
  }
  slot(el, 'perf-sub').textContent = `You vs your opponents · ${perf.games} scanned games`;
  const yP = PERF_AXES.map(a => perfScale(a, perf.you[a.key])), oP = PERF_AXES.map(a => perfScale(a, perf.opp[a.key]));
  radarChart($('#perfRadar', el), PERF_AXES.map(a => a.label), [
    { label: 'You', data: yP, slot: '--s1' },
    { label: 'Your opponents', data: oP, dashed: true },
  ], { tooltip: c => { const a = PERF_AXES[c.dataIndex], v = (c.datasetIndex ? perf.opp : perf.you)[a.key]; return `${c.dataset.label}: ${v != null ? a.fmt(v) : '–'}`; } });
  slot(el, 'perf-bars').innerHTML = divergingBars(PERF_AXES.filter((a, i) => yP[i] != null && oP[i] != null).map(a => {
    const i = PERF_AXES.indexOf(a);
    return { label: a.label, diff: yP[i] - oP[i], tip: `You: ${a.fmt(perf.you[a.key])} · opponents: ${a.fmt(perf.opp[a.key])}`, faded: perf.n[a.key] < 15 };
  }).sort((x, y) => y.diff - x.diff), true);
  bindShape(el);
}

function bindShape(el) {
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
  const b = bands.includes(ladderState.b) ? ladderState.b : nearestBand(bands, me ? you.band : a + 500);
  const trendKey = `${tc}|${you ? [you.band, you.vals.accuracy, you.vals.blunders].join() : ""}`;
  const tcChanged = ladderState.trendKey !== trendKey;
  Object.assign(ladderState, { ltc: tc, a, b, trendKey });
  const ta = ladderTypical(T.bands[a]), tb = ladderTypical(T.bands[b]);
  const left = me ? { label: 'You', vals: you.vals } : { label: bandLabel(a), vals: ta };
  const meBtn = !S.games.length ? '' : you
    ? `<button class="btn small-btn ${me ? '' : 'primary'}" id="ladMe">${me ? 'Compare two bands' : 'Compare my radar'}</button>`
    : `<button class="btn small-btn" disabled title="Needs 10+ rated ${tc} games">Compare my radar</button>`;
  const fresh = !$('#ladRadar', sec);
  if (fresh) sec.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="row-between"><h3>Rating ladder</h3><span class="lad-tcs"></span></div>
      <div class="sub band-pick lad-pick"></div>
      <div class="lad-hint"></div>
      <div class="grid cols-2">
        <div class="chart-box radar"><canvas id="ladRadar"></canvas></div>
        <table class="cmp ladder-vals lad-vals"></table>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card"><h3>Accuracy</h3><div class="chart-box"><canvas id="ladAcc"></canvas></div></div>
      <div class="card"><h3>Blunders per 100 moves</h3><div class="chart-box"><canvas id="ladBl"></canvas></div></div>
    </div>
    <p class="muted small lad-foot" style="margin-top:10px"></p>`;
  slot(sec, 'lad-tcs').innerHTML = ladderTcTabs(tcs, tc, 'data-ladder-tc');
  slot(sec, 'lad-pick').innerHTML = `${me ? '<b>You</b>' : ladderBandSelect('ladA', bands, a)} vs ${ladderBandSelect('ladB', bands, b)}${me && you.band === b ? ' · your band' : ''}<span class="band-me">${meBtn}</span>`;
  slot(sec, 'lad-hint').innerHTML = me && you.vals.accuracy == null ? '<div class="muted small" style="margin:-4px 0 6px">Scan your games (Insights → Accuracy) to add accuracy and blunders.</div>' : '';
  slot(sec, 'lad-vals').innerHTML = ladderTable(left.label, bandLabel(b), x => left.vals[x.key] != null ? x.cell(left.vals[x.key]) : me && x.engine ? '<span class="muted">scan</span>' : '–', tb);
  slot(sec, 'lad-foot').textContent = `${T.players} ${tc} players sampled, about ${Math.round(median(bands.map(x => T.bands[x].n)))} per band. Built ${L.built}.`;
  radarChart($('#ladRadar', sec), LADDER_AXES.map(x => x.label), [
    { label: left.label, data: ladderRadar(T, left.vals), slot: '--s1' },
    { label: me ? `Typical ${bandLabel(b)}` : bandLabel(b), data: ladderRadar(T, tb), slot: '--s3' },
  ], { tooltip: c => { const x = LADDER_AXES[c.dataIndex], v = (c.datasetIndex ? tb : left.vals)[x.key]; return `${c.dataset.label}: ${v != null ? x.fmt(v) : '–'}`; } });
  // the trend charts only depend on the time control (and you): leave them alone when just a band changes
  if (fresh || tcChanged) {
    const line = (id, key, fmtY) => {
      const pts = bands.map(x => ({ x, y: ladderTypical(T.bands[x])[key] })).filter(p => p.y != null);
      const ds = [{ label: 'Typical player', data: pts, borderColor: cssVar('--s1'), backgroundColor: cssVar('--s1'), pointRadius: 2.5, tension: 0.25 }];
      if (you?.vals[key] != null) ds.push({ label: 'You', data: [{ x: you.band + LADDER_BAND / 2, y: you.vals[key] }], borderColor: cssVar('--s2'), backgroundColor: cssVar('--s2'), pointRadius: 6, showLine: false });
      makeChart($(id, sec), { type: 'line', data: { datasets: ds }, options: {
        parsing: false, plugins: { legend: { display: !!you, position: 'top', align: 'start' }, tooltip: { callbacks: { title: c => bandLabel(c[0].raw.x - (c[0].raw.x % LADDER_BAND)), label: c => `${c.dataset.label}: ${fmtY(c.parsed.y)}` } } },
        scales: baseScales({ ticks: { callback: fmtY } }, { type: 'linear', ticks: { callback: v => v } }),
      } });
    };
    line('#ladAcc', 'accuracy', v => num(v, 0) + '%');
    line('#ladBl', 'blunders', v => num(v, 1));
  }
  $$('[data-ladder-tc]', sec).forEach(btn => btn.onclick = () => { ladderState.ltc = btn.dataset.ladderTc; ladderState.a = ladderState.b = null; renderLadder(sec); });
  const ladA = $('#ladA', sec);
  if (ladA) ladA.onchange = e => { ladderState.a = +e.target.value; renderLadder(sec); };
  const meB = $('#ladMe', sec);
  if (meB) meB.onclick = () => { ladderState.me = !me; ladderState.b = ladderState.me ? nearestBand(bands, you.band) : null; renderLadder(sec); };
  $('#ladB', sec).onchange = e => { ladderState.b = +e.target.value; renderLadder(sec); };
}
