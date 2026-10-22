// Rating ladder: what the typical chess.com player looks like in each 250-point band, per time control.
// js/ladder.json is built once by tools/build-ladder.js from sampled chess.com players; the same functions
// below measure those players and you, so the comparison is like for like.
//
// Method (see tools/build-ladder.js): both sides of every sampled game; Stockfish 19 (depth 12, top 3 lines, as the
// desktop app scans) for the performance numbers; a sliding, trend-corrected rating window around each band;
// game-to-game noise removed, so a band's median (its typical player) and the percentiles describe players' real
// levels. Radar axes measure distance from the median player of that time control in units of how much players
// differ (population quantiles: bands weighted by chess.com's published rating distribution, tools/rating-dist.json). Browser-engine (Stockfish 10) scans have their accuracy
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
    const w = Math.min(50, Math.abs(r.diff) / unit), up = r.diff >= 0, shown = r.text ?? Math.round(Math.abs(r.diff)).toLocaleString();
    const col = goodBad ? (up ? 'var(--good-text)' : 'var(--critical)') : 'var(--brass)';
    return `<div class="dv-row${r.faded ? ' faded' : ''}" title="${esc(r.tip)}"><span class="dv-lab">${esc(r.label)}</span>
      <div class="dv-trk"><div class="dv-mid"></div><div class="dv-bar" style="background:${col};${up ? 'left' : 'right'}:50%;width:${w}%"></div></div>
      <span class="dv-val" style="color:${goodBad ? col : 'inherit'}">${r.text ? shown : `${shown !== '0' ? (up ? '+' : '−') : ''}${shown}`}</span></div>`;
  }).join('');
}

// ---------- the comparison: a stack of radars ----------
// You, plus up to five others on the same radars: the typical player of any rating band, chess.com players, and
// the legends (their classical over-the-board games). Each is read on its own time control's ladder, so your blitz
// can stand beside someone's rapid; a legend is placed on the rapid ladder by default (the closest to classical).
// ladderState.stack: [{ kind: 'band', tc, band } | { kind: 'player', user, label, data, tc, agg, aggTc, aggN, run }
//   | { kind: 'legend', id, label, data, tc, agg, aggN, run }]; null until changed (then: your band's typical player)
const STACK_MAX = 5, STACK_SLOTS = ['--s2', '--s3', '--s4', '--s5', '--s6'];
const AN_SIZES = [25, 50, 100, 200];
const stackPlayers = () => (ladderState.stack || []).filter(s => s.kind !== 'band' && s.data);
let _anQueue = Promise.resolve();   // engine runs one at a time (they share the analysis engines)

async function addToStack(el, item) {
  const st = ladderState.stack ||= [];
  if (st.length >= STACK_MAX) return;
  st.push(item);
  if (item.kind === 'band') return fillShapeCard(el);
  const src = item.kind === 'legend' ? famousSource(FAMOUS.find(f => f.id === item.id)) : { kind: 'chesscom', user: item.user, months: S.months };
  Object.assign(item, { loading: true, msg: 'Loading…' });
  fillShapeCard(el);
  try { item.data = await loadSource(src, m => { item.msg = m; }); item.label = item.data.label; }
  catch (e) { item.error = e.message || String(e); }
  item.loading = false;
  fillShapeCard(el);
}

// their engine numbers: Stockfish over their latest n games (in the chip's time control; all of a legend's),
// measured as your scan measures you
function analyzeStack(el, item, n) {
  if (item.run || !(n > 0)) return;
  const pool = item.data.games.filter(g => (g.plies ?? g.sans.length) >= 10 && (item.kind === 'legend' || g.timeClass === item.tc));
  const list = pool.slice(0, n), results = [];
  item.run = { done: 0, n: list.length, waiting: true };
  fillShapeCard(el);
  _anQueue = _anQueue.then(async () => {
    item.run.waiting = false;
    await analyzeGamesParallel(list, scanState.depth, {
      onProgress: (f, d) => { item.run.done = d; const s = $(`[data-sr="${ladderState.stack.indexOf(item)}"] .sr-run`, el); if (s) s.textContent = `analyzing ${d} of ${list.length}…`; },
      onResult: (g, a) => results.push({ game: g, analysis: a }),
    });
    Object.assign(item, { agg: results.length ? aggregateScan(results) : null, aggTc: item.tc, aggN: results.length, run: null });
    if (ladderState.stack?.includes(item)) fillShapeCard(el);
  });
}

// a legend's numbers: their games aren't online time controls, so all of them count (habits from the latest 100)
function legendMeasure(item) {
  const vals = { ...(ladderHabits(item.data.games.slice(0, LADDER_YOU_GAMES)) || {}) };
  let n = {};
  if (item.agg) {
    const p = ladderPerf({ ...item.agg, perGame: item.agg.perGame.map(x => ({ ...x, game: { ...x.game, timeClass: '*' } })) }, '*');
    Object.assign(vals, p?.vals || {}); n = p?.n || {};
  }
  return { vals, n, games: item.data.games.length, band: null };
}

// your record against a player (from your loaded games), and their current ratings
const cmpGames = name => S.games.filter(g => (g.opp.name || '').toLowerCase() === name.toLowerCase());
function cmpRecord(item) {
  const name = item.data.label, games = cmpGames(name);
  const st = item.data.player?.stats || {};
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
      ${games.slice(0, 100).map((g, i) => `<tr class="clickable" data-cg="${esc(name)}|${i}"><td>${fmtDate(g.end)}</td><td><span class="dot ${g.color}"></span></td><td>${resBadge(g.result)}</td><td><span class="pill">${tcLabel(g)}</span></td><td>${esc(g.opening.length > 40 ? g.opening.slice(0, 38) + '…' : g.opening)}</td><td class="num">${g.moves}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// Radar geometry. Each value is placed by how far it sits from the median player of its time control, in units of
// how much players really differ there (the ladder's population quantiles: median q50, spread (q75 − q25)/1.349;
// inverted where fewer is better), so a distance on the radar is a real difference in play: not a percentile,
// which blows up tiny gaps where players bunch together (captures differ by about ±2 per 100 moves), and not a
// rating, which runs out above the strongest band (Morphy's 62% brilliance). Each axis is then stretched to fit
// its most extreme value (at least 3 spreads either side): the middle ring is the median player and the rim the
// stack's extreme on that axis. Performance values are first pulled toward the player's band by the share of
// their spread that is sampling luck (ladderShrink).
const RADAR_MIN_SPREADS = 3;
function spreadOf(q) {
  const sd = (q[15] - q[5]) / 1.349;
  return sd > 0 ? sd : (q[18] - q[2]) / 2.563 > 0 ? (q[18] - q[2]) / 2.563 : 1;
}
function seriesValue(side, a, scale) {
  const q = side.T.quantiles[a.key];
  const v = scale === 'rating' ? ladderShrink(side.T, a, side) : side.vals?.[a.key];
  if (!q || v == null) return null;
  const z = (v - q[10]) / spreadOf(q);
  return a.invert ? -z : z;
}
// "plays like a typical 1,450", or past the strongest band's typical player
function ratingPhrase(T, a, v) {
  const pts = ladderCurve(T, a), y = a.invert ? -v : v;
  if (pts.length < 2) return '';
  if (y > pts.at(-1)[1]) return 'beyond the strongest band\'s typical player';
  const r = ladderRatingOf(T, a, v);
  return r == null ? '' : `plays like a typical ${ratingWord(r)}`;
}

// one pane: all the series on one radar; the bars compare you with the first of the others, in real units
function shapePane(el, canvasId, barsCls, axes, series, scale) {
  const perf = scale === 'rating';
  const z = series.map(s => axes.map(a => seriesValue(s, a, scale)));
  const reach = axes.map((_, i) => Math.max(RADAR_MIN_SPREADS, 1.08 * Math.max(0, ...z.map(r => Math.abs(r[i] ?? 0)))));
  const pts = z.map(r => r.map((x, i) => (x == null ? null : 50 + 50 * x / reach[i])));
  const tip = (a, s) => {
    const v = s.vals[a.key];
    if (v == null) return `${s.label}: –`;
    const like = perf ? ratingPhrase(s.T, a, ladderShrink(s.T, a, s)) : '';
    return `${s.label}: ${a.fmt(v)}${like ? ` · ${like}` : ''}`;
  };
  radarChart($('#' + canvasId, el), axes.map(a => a.label), series.map((s, i) => ({ label: s.label, data: pts[i], slot: s.slot, dashed: s.dashed })),
    { tooltip: c => tip(axes[c.dataIndex], series[c.datasetIndex]) });
  const [you, other] = series;
  if (!other) { slot(el, barsCls).innerHTML = ''; return; }
  // bar length: the gap in spreads; the number: the gap in the measure's own units
  const rows = axes.map((a, i) => ({ a, i })).filter(({ i }) => z[0][i] != null && z[1][i] != null).map(({ a, i }) => {
    const d = you.vals[a.key] - other.vals[a.key];
    return { label: a.label, diff: (z[0][i] - z[1][i]) * 12.5, text: `${d >= 0 ? '+' : '−'}${a.cell(Math.abs(d)).replace(/^±/, '')}`,
      tip: `${you.label} ${a.fmt(you.vals[a.key])} · ${other.label} ${a.fmt(other.vals[a.key])}`, faded: PERF_KEYS.has(a.key) && (you.n?.[a.key] ?? 99) < 15 };
  });
  rows.sort(perf ? (x, y) => y.diff - x.diff : (x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  slot(el, barsCls).innerHTML = `<div class="muted small" style="margin-bottom:4px">${esc(you.label)} against ${esc(other.label)}</div>` + divergingBars(rows, perf);
}

const tcSelect = (cls, tcs, cur, attrs = '') => `<select class="${cls}" ${attrs}>${tcs.map(tc => `<option value="${tc}" ${tc === cur ? 'selected' : ''}>${tcTitle(tc)}</option>`).join('')}</select>`;

const SHAPE_BODY = `<div class="grid cols-2 shape-grid">
    <div class="shape-pane">
      <span class="pane-title">Style</span>
      <div class="chart-box radar shape-radar"><canvas id="shapeRadar"></canvas></div>
      <div class="shape-bars style-bars"></div>
      <div class="muted small pane-note">Middle ring: the median player · differences, not scores</div>
    </div>
    <div class="shape-pane perf-pane">
      <span class="pane-title">Performance</span>
      <div class="sub perf-sub"></div>
      <div class="chart-box radar shape-radar perf-radar"><canvas id="perfRadar"></canvas></div>
      <div class="shape-bars perf-bars"></div>
      <div class="muted small pane-note perf-note">Middle ring: the median player · outward is better</div>
    </div>
  </div>`;

// ---------- "Shape": you and a stack of others, as a Style radar (habits, percentiles) and a Performance radar
// (from scans, on the rating scale), with a bars view of you against the first of them ----------
async function fillShapeCard(el) {
  if (!el) return;
  const L = await getLadder();
  const has = tc => L?.tc[tc] && Object.keys(L.tc[tc].bands).length;
  const tcsAll = LADDER_TCS.filter(has);
  const myTcs = tcsAll.filter(tc => ladderYou(tc));
  const view = ladderState.view || 'radar';
  if (!$('.shape-series', el)) el.innerHTML = `<div class="row-between"><h3>Shape</h3><span class="shape-view"></span></div>
    <div class="shape-series"></div><div class="sr-addrow hidden"></div>
    <div class="shape-body"></div><div class="cmp-slot"></div>`;
  slot(el, 'shape-view').innerHTML = `<div class="seg">${[['radar', 'Radar'], ['bars', 'Bars']].map(([v, l]) => `<button data-shape-view="${v}" class="${v === view ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const body = slot(el, 'shape-body');
  if (!myTcs.length) { slot(el, 'shape-series').innerHTML = ''; body.innerHTML = `<p class="muted small">${L ? 'Needs 10+ rated bullet, blitz or rapid games.' : 'Ladder data unavailable.'}</p>`; return; }

  // you: the header's time control (or the one with most of your games), or your own pick
  const hf = $('#fTime')?.value, most = (tcs, f) => tcs.reduce((a, b) => (f(a) >= f(b) ? a : b));
  const myTc = myTcs.includes(ladderState.myTc) ? ladderState.myTc : myTcs.includes(hf) ? hf : most(myTcs, tc => ladderYou(tc).games);
  const you = { ...ladderYou(myTc), T: L.tc[myTc], label: 'You', slot: '--s1' };
  // the default stack: the typical player of your band
  ladderState.stack ||= [{ kind: 'band', tc: null, band: null }];
  const stack = ladderState.stack;
  const series = [you], chips = [], notShownPerf = [];
  stack.forEach((it, i) => {
    const color = STACK_SLOTS[i % STACK_SLOTS.length];
    const x = `<button class="sr-x" data-srx="${i}" title="Remove">×</button>`;
    if (it.kind === 'band') {
      const tc = has(it.tc) ? it.tc : myTc, T = L.tc[tc], bands = Object.keys(T.bands).map(Number).sort((a, b) => a - b);
      const band = bands.includes(it.band) ? it.band : nearestBand(bands, you.band);
      Object.assign(it, { tc, band });
      series.push({ label: `Typical ${bandLabel(band)}${tc !== myTc ? ` (${tc})` : ''}`, vals: ladderTypical(T.bands[band]), n: {}, T, slot: color, dashed: true });
      chips.push(`<span class="sr-chip" data-sr="${i}"><i style="background:var(${color})"></i>Typical <select class="sr-band">${bands.map(b => `<option value="${b}" ${b === band ? 'selected' : ''}>${bandLabel(b)}</option>`).join('')}</select>${tcSelect('sr-tc', tcsAll, tc)}${you.band === band && tc === myTc ? '<span class="muted small">your band</span>' : ''}${x}</span>`);
      return;
    }
    const name = esc(it.label || it.user || FAMOUS.find(f => f.id === it.id)?.name || '');
    if (!it.data) {
      chips.push(`<span class="sr-chip" data-sr="${i}"><i style="background:var(${color})"></i>${name} <span class="muted small">${it.error ? `<span style="color:var(--critical)">${esc(it.error)}</span>` : esc(it.msg || 'loading…')}</span>${x}</span>`);
      return;
    }
    let m, tcs = tcsAll;
    if (it.kind === 'legend') { it.tc = has(it.tc) ? it.tc : 'rapid'; m = legendMeasure(it); }
    else {
      tcs = tcsAll.filter(tc => ladderMeasure(it.data.games, tc));
      if (!tcs.length) { chips.push(`<span class="sr-chip" data-sr="${i}"><i style="background:var(${color})"></i>${name} <span class="muted small">no time control with 10+ rated games</span>${x}</span>`); return; }
      it.tc = tcs.includes(it.tc) ? it.tc : tcs.includes(myTc) ? myTc : most(tcs, tc => ladderMeasure(it.data.games, tc).games);
      m = ladderMeasure(it.data.games, it.tc, it.aggTc === it.tc ? it.agg : null);
    }
    const label = it.kind === 'legend' ? it.label : it.tc !== myTc ? `${it.label} (${it.tc})` : it.label;
    const s = { ...m, T: L.tc[it.tc], label, slot: color };
    series.push(s);
    if (!hasPerf(s.vals)) notShownPerf.push(label);
    const avail = it.data.games.filter(g => (g.plies ?? g.sans.length) >= 10 && (it.kind === 'legend' || g.timeClass === it.tc)).length;
    const sizes = AN_SIZES.filter(n => n <= Math.max(25, avail));
    const engine = it.run ? `<span class="muted small sr-run">${it.run.waiting ? 'waiting for the engine…' : `analyzing ${it.run.done} of ${it.run.n}…`}</span>`
      : `<span class="sr-an-wrap">${it.aggN && it.aggTc === it.tc ? `<span class="muted small">${it.aggN} analysed</span>` : ''}<select class="sr-n">${sizes.map(n => `<option value="${n}" ${n === (it.lastN || 25) ? 'selected' : ''}>${Math.min(n, avail)} games</option>`).join('')}</select><button class="btn small-btn sr-an">${it.aggN && it.aggTc === it.tc ? 'Re-analyze' : 'Analyze'}</button></span>`;
    chips.push(`<span class="sr-chip" data-sr="${i}"><i style="background:var(${color})"></i>${esc(it.label)}${it.kind === 'legend' ? ` <span class="muted small" title="Classical over-the-board games, placed among online players of this time control">classical, as</span>` : ''}${tcSelect('sr-tc', tcs, it.tc)}${engine}${x}</span>`);
  });
  slot(el, 'shape-series').innerHTML = `<span class="sr-chip sr-you"><i style="background:var(--s1)"></i>You${tcSelect('sr-mytc', myTcs, myTc)}</span>
    <span class="muted small">vs</span>${chips.join('')}${stack.length < STACK_MAX ? '<button class="btn small-btn sr-add">+ Add</button>' : ''}`;
  // the add row: a typical player of any band, a chess.com player, or a legend
  const bands0 = Object.keys(L.tc[myTc].bands).map(Number).sort((a, b) => a - b);
  slot(el, 'sr-addrow').innerHTML = `<span>Typical player ${tcSelect('ad-tc', tcsAll, myTc)}<select class="ad-band">${bands0.map(b => `<option value="${b}" ${b === nearestBand(bands0, you.band + LADDER_BAND) ? 'selected' : ''}>${bandLabel(b)}</option>`).join('')}</select><button class="btn small-btn ad-band-go">Add</button></span>
    <span>Player <input class="ad-user" placeholder="chess.com username" spellcheck="false"><button class="btn small-btn ad-user-go">Add</button></span>
    <span>Legend <select class="ad-legend">${FAMOUS.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select><button class="btn small-btn ad-legend-go">Add</button></span>`;
  slot(el, 'cmp-slot').innerHTML = stackPlayers().filter(s => s.kind === 'player').map(cmpRecord).join('');

  if (!$('#shapeRadar', el)) body.innerHTML = SHAPE_BODY;
  $$('.shape-radar', el).forEach(x => x.classList.toggle('hidden', view !== 'radar'));
  $$('.shape-bars', el).forEach(x => x.classList.toggle('hidden', view !== 'bars'));
  shapePane(el, 'shapeRadar', 'style-bars', LADDER_STYLE, series, 'pct');

  // performance: the series with engine numbers (your scan; a band's typical player always has them)
  const perfSeries = series.filter(s => hasPerf(s.vals)), mine = hasPerf(you.vals);
  slot(el, 'perf-pane').classList.toggle('pending', !mine);
  const sub = slot(el, 'perf-sub');
  if (mine) {
    sub.textContent = notShownPerf.length ? `Not shown until analysed: ${notShownPerf.join(', ')}` : '';
    shapePane(el, 'perfRadar', 'perf-bars', PERF_RADAR, perfSeries, 'rating');
  } else {
    slot(el, 'perf-bars').innerHTML = '';
    sub.textContent = S.scanAgg ? `Scan some ${myTc} games to see this.` : 'Scan your games to see this.';
  }
  bindShape(el);
}

function bindShape(el) {
  const stack = ladderState.stack || [], at = e => stack[+e.target.closest('[data-sr]').dataset.sr];
  $$('[data-shape-view]', el).forEach(b => b.onclick = () => { ladderState.view = b.dataset.shapeView; fillShapeCard(el); });
  $('.sr-mytc', el)?.addEventListener('change', e => { ladderState.myTc = e.target.value; fillShapeCard(el); });
  $$('.sr-x', el).forEach(b => b.onclick = () => { stack.splice(+b.dataset.srx, 1); fillShapeCard(el); });
  $$('.sr-band', el).forEach(s => s.onchange = e => { at(e).band = +e.target.value; fillShapeCard(el); });
  $$('.sr-tc', el).forEach(s => s.onchange = e => { const it = at(e); it.tc = e.target.value; if (it.kind === 'band') it.band = null; fillShapeCard(el); });
  $$('.sr-an', el).forEach(b => b.onclick = e => { const it = at(e), n = +e.target.closest('[data-sr]').querySelector('.sr-n').value; it.lastN = n; analyzeStack(el, it, n); });
  $$('[data-cg]', el).forEach(tr => tr.onclick = () => { const [name, i] = tr.dataset.cg.split('|'); openReview(cmpGames(name)[+i]); });
  const row = slot(el, 'sr-addrow');
  $('.sr-add', el)?.addEventListener('click', () => row.classList.toggle('hidden'));
  // the add row's band list follows its time control
  $('.ad-tc', row).onchange = async e => {
    const L = await getLadder(), bands = Object.keys(L.tc[e.target.value].bands).map(Number).sort((a, b) => a - b);
    $('.ad-band', row).innerHTML = bands.map(b => `<option value="${b}">${bandLabel(b)}</option>`).join('');
  };
  $('.ad-band-go', row).onclick = () => { row.classList.add('hidden'); addToStack(el, { kind: 'band', tc: $('.ad-tc', row).value, band: +$('.ad-band', row).value }); };
  const addUser = () => {
    const u = $('.ad-user', row).value.trim().toLowerCase();
    if (!u) return;
    if (u === (S.username || '').toLowerCase()) { $('.ad-user', row).value = ''; $('.ad-user', row).placeholder = "that's you"; return; }
    row.classList.add('hidden'); addToStack(el, { kind: 'player', user: u, label: u });
  };
  $('.ad-user-go', row).onclick = addUser;
  $('.ad-user', row).onkeydown = e => { if (e.key === 'Enter') addUser(); };
  $('.ad-legend-go', row).onclick = () => { const f = FAMOUS.find(x => x.id === $('.ad-legend', row).value); row.classList.add('hidden'); addToStack(el, { kind: 'legend', id: f.id, label: f.name, tc: 'rapid' }); };
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
