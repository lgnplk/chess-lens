// One-time build of js/ladder.json (not loaded by the app). Run inside the desktop app (native Stockfish 19),
// started with the project folder as its site (desktop/main.js: CL_SITE=.. CL_PROFILE=../.ladder-build), in DevTools:
//   await loadScript('tools/build-ladder.js?' + Date.now()); LB.start();   …   LB.status   …   JSON.stringify(await LB.build())
//
// v4 design, for accuracy per hour:
// • Sampling. "Focus" players are found by walking opponents; each time control × 250-point band ("cell") gets up
//   to a quota of them, always drawn from the emptiest cell. Each gives habits from its latest 50 rated games
//   and engine numbers from 20 of them.
// • Both sides of every game count. Each downloaded game also gives the opponent's habits, and each analysed game
//   the opponent's engine numbers, so a band holds thousands of distinct players, not just the focus ones.
//   A player's band is the median of their rating over the games used.
// • Measurement noise is removed. A player's value from a few games is their true level plus game-to-game luck.
//   The luck's size is measured from focus players' games (within-player variance, pooled over nearby bands) and
//   taken out with a random-effects model: values are pulled toward the local trend by exactly the share of
//   their spread that is noise, so band medians and percentiles describe players, not lucky samples.
// • Sliding window. Each band pools every player of the time control with Gaussian weights by rating
//   (trend-corrected; see kernelFit), so bands borrow strength from neighbours.
// • Engine. Stockfish 19, depth 12, top 3 lines: exactly the desktop app's scan, so the performance numbers
//   (only moves found, sound sacrifices taken, hard refutations) are measured the same way for you and the ladder.
// Progress is saved in IndexedDB and resumes after a reload.
(() => {
const HABIT_GAMES = 50, OPP_CAP = 2000, MIN_GAMES = 10;
const CRAWLERS = 6, MAX_MONTHS = 6, BATCH = 12, NATIVE_N = 30, DEPTH = 12, MULTIPV = 3;
const SEEDS = ['gogangoblin', 'magnuschace', 'jcbmrk', 'hikaru', 'danielnaroditsky'];
// quota: focus players per cell; engineGames: analysed games per focus player; minutes: time budget; key: saved state
const OPTS = { quota: 40, engineGames: 20, minutes: 48 * 60, key: 'cl:ladder:build:v4' };
const LB = window.LB = { players: new Map(), visited: new Set(), frontier: {}, pending: [], status: 'idle', stop: false, running: false, errors: 0, analysed: 0, opts: { ...OPTS } };

const cellOf = (tc, r) => `${tc}:${ladderBandOf(r)}`;
const pkey = (tc, user) => `${tc}|${user.toLowerCase()}`;
const bandRating = p => median(p.ratings);
function cellCounts() {
  const focus = {}, opp = {};
  for (const p of LB.players.values()) { const c = cellOf(p.tc, bandRating(p)); (p.focus ? focus : opp)[c] = ((p.focus ? focus : opp)[c] || 0) + 1; }
  return { focus, opp };
}
let _counts = null, _countsAt = 0;
const counts = () => { if (!_counts || performance.now() - _countsAt > 5000) { _counts = cellCounts(); _countsAt = performance.now(); } return _counts; };

function player(tc, user, rating) {
  const k = pkey(tc, user);
  let p = LB.players.get(k);
  if (!p) LB.players.set(k, p = { tc, user: user.toLowerCase(), focus: false, ratings: [], h: [], e: [], hg: new Set(), eg: new Set() });
  if (rating) p.ratings.push(rating);
  return p;
}

// one side of one game as a habit record: [checks, captures, pawn moves, moves, castled by 10 (-1 n/a), early queen, time trouble (-1 n/a)]
function habitRow(g, mine) {
  if (!g.f) replayFeatures(g);
  const f = g.f, long = g.sans.length >= 30;
  const moves = mine ? f.myMoves : f.oppMoves;
  if (moves < 5) return null;
  const cm = mine ? f.castleMove : f.oppCastleMove, clk = mine ? f.minClockFrac : f.oppMinClockFrac;
  return [mine ? f.checks : f.oppChecks, mine ? f.captures : f.oppCaptures, mine ? f.pawnMoves : f.oppPawnMoves, moves,
    long ? (cm && cm <= 10 ? 1 : 0) : -1, (mine ? f.earlyQueen : f.oppEarlyQueen) ? 1 : 0, clk != null ? (clk < 0.1 ? 1 : 0) : -1];
}

// ---------- crawl ----------
function addFrontier(tc, rating, name) {
  if (!LADDER_TCS.includes(tc) || !rating || rating < 100 || rating >= 3500) return;
  const n = name.toLowerCase();
  if (LB.visited.has(n)) return;
  (LB.frontier[cellOf(tc, rating)] ||= new Set()).add(n);
}
function pick() {
  const c = counts().focus;
  const open = Object.entries(LB.frontier).filter(([k, s]) => (c[k] || 0) < LB.opts.quota && s.size);
  if (!open.length) return null;
  const least = Math.min(...open.map(([k]) => c[k] || 0));
  const choices = open.filter(([k]) => (c[k] || 0) === least);
  const [, s] = choices[Math.floor(Math.random() * choices.length)];
  const arr = [...s], name = arr[Math.floor(Math.random() * arr.length)];
  s.delete(name);
  return LB.visited.has(name) ? pick() : name;
}

async function visit(user) {
  LB.visited.add(user);
  let data;
  try { data = await loadChesscomRecent({ kind: 'chesscom', user, tc: 'all', recent: 200, maxMonths: MAX_MONTHS }); } catch { LB.errors++; return; }
  const { focus, opp } = counts();
  for (const tc of LADDER_TCS) {
    const gs = data.games.filter(g => g.timeClass === tc && g.rated && g.me?.rating && g.opp?.rating).slice(0, HABIT_GAMES);
    if (!gs.length) continue;
    // the opponents' side of every game (capped per cell; players already in the sample always get it)
    for (const g of gs) {
      addFrontier(tc, g.opp.rating, g.opp.name);
      const k = pkey(tc, g.opp.name), c = cellOf(tc, g.opp.rating);
      if (!LB.players.has(k) && (opp[c] || 0) >= OPP_CAP) continue;
      const p = player(tc, g.opp.name, null);
      if (p.hg.has(g.id)) continue;
      const row = habitRow(g, false);
      if (!row) continue;
      if (!p.ratings.length) opp[c] = (opp[c] || 0) + 1;
      p.ratings.push(g.opp.rating); p.h.push(row); p.hg.add(g.id);
    }
    if (gs.length < MIN_GAMES) continue;
    const c = cellOf(tc, median(gs.map(g => g.me.rating)));
    if ((focus[c] || 0) >= LB.opts.quota) continue;
    // a focus player: their own side of all 50 games, and 20 of them for the engine
    const p = player(tc, user, null);
    p.focus = true;
    for (const g of gs) {
      if (p.hg.has(g.id)) continue;
      const row = habitRow(g, true);
      if (!row) continue;
      p.ratings.push(g.me.rating); p.h.push(row); p.hg.add(g.id);
    }
    focus[c] = (focus[c] || 0) + 1;
    LB.lastFocusAt = performance.now();
    const eg = gs.filter(g => g.plies >= 20 && !p.eg.has(g.id)).slice(0, LB.opts.engineGames);
    LB.pending.push({ tc, games: eg.map(g => ({ ...g, id: null, gid: g.id, focusUser: user, focusColor: g.color, oppName: g.opp.name, myRating: g.me.rating, oppRating: g.opp.rating })) });
  }
}

// once the bands that exist are full, only near-empty ones (3000+ rapid, say) are left open: stop when 30 minutes
// pass without a new focus player instead of searching for them until the time budget runs out
const stalled = () => performance.now() - (LB.lastFocusAt ?? LB.t0) > 30 * 60000;
async function crawler() {
  while (!LB.stop && !LB.timeUp() && !stalled()) {
    if (LB.pending.length > 120) { LB.lastFocusAt = performance.now(); await sleep(1000); continue; } // let the engine catch up (not a stall)
    const user = LB.seeds.length ? LB.seeds.shift() : pick();
    if (!user) { if (!LB.pending.length && LB.engineIdle) break; await sleep(1000); continue; }
    if (LB.visited.has(user) && !LB.seedSet.has(user)) continue;
    await visit(user);
  }
}

// ---------- engine ----------
// one side of an analysed game, measured as the app's scan measures you (aggregateScan, styleRecords):
// [accuracy, blunders, counted moves, was winning (+3), was losing (−3), score,
//  only moves found, only-move chances, brilliance hits, brilliance chances (sound sacrifices on offer + hard refutations)]
function engineRow(g, a, c) {
  const ms = a.moves.filter(m => m.color === c && m.cls !== 'book' && m.cls !== 'forced');
  const acc = a.summary?.[c]?.accuracy;
  if (acc == null || ms.length < 5) return null;
  const sign = c === 'w' ? 1 : -1, evs = a.evals.map(e => evalToCp(e) * sign);
  const recs = a._style?.[c === 'w' ? 'white' : 'black'] || [];
  const tally = key => { const xs = recs.filter(r => r[key] !== undefined); return [xs.filter(r => r[key]).length, xs.length]; };
  const [ck, cn] = tally('critical'), [sk, sn] = tally('sacOpp'), [pk, pn] = tally('punishHard');
  const s = scoreOf(g);
  return [acc, ms.filter(m => m.loss >= 20).length, ms.length, Math.max(...evs) >= 300 ? 1 : 0, Math.min(...evs) <= -300 ? 1 : 0,
    c === g.focusColor[0] ? s : 1 - s, ck, cn, sk + pk, sn + pn];
}

function record(g, a) {
  const focusSide = g.focusColor[0];
  for (const c of ['w', 'b']) {
    const row = engineRow(g, a, c);
    if (!row) continue;
    const mine = c === focusSide;
    const p = player(g.timeClass, mine ? g.focusUser : g.oppName, null);
    if (p.eg.has(g.gid)) continue;
    if (!mine) p.ratings.push(g.oppRating); // the focus player's ratings are already in from their habits
    p.e.push(row); p.eg.add(g.gid);
  }
  LB.analysed++;
}

async function engineLoop(native) {
  while (!LB.stop) {
    if (!LB.pending.length) { LB.engineIdle = true; if (LB.crawlersDone) break; await sleep(500); continue; }
    LB.engineIdle = false;
    const jobs = LB.pending.splice(0, BATCH), t0 = performance.now();
    const games = jobs.flatMap(j => j.games);
    await analyzeGamesParallel(games, DEPTH, { engines: native, verify: false, multipv: MULTIPV, onResult: record });
    LB.lastBatch = { games: games.length, secs: Math.round((performance.now() - t0) / 1000) };
  }
}

// ---------- persistence ----------
async function save() {
  await evalDB.set(LB.opts.key, {
    players: [...LB.players.values()].map(p => ({ ...p, hg: [...p.hg], eg: [...p.eg] })),
    visited: [...LB.visited], frontier: Object.fromEntries(Object.entries(LB.frontier).map(([k, s]) => [k, [...s]])),
    pending: LB.pending, analysed: LB.analysed,
  });
}
async function load() {
  const s = await evalDB.get(LB.opts.key);
  if (!s) return;
  LB.players = new Map(s.players.map(p => [pkey(p.tc, p.user), { ...p, hg: new Set(p.hg), eg: new Set(p.eg) }]));
  LB.visited = new Set(s.visited); LB.pending = s.pending || []; LB.analysed = s.analysed || 0;
  LB.frontier = Object.fromEntries(Object.entries(s.frontier).map(([k, a]) => [k, new Set(a)]));
}

LB.timeUp = () => (performance.now() - LB.t0) / 60000 > LB.opts.minutes;
LB.more = n => { for (let i = 0; i < n; i++) crawler(); return `${n} more crawlers`; };
// load the saved build without crawling (to rebuild ladder.json from it)
LB.load = async (opts = {}) => { Object.assign(LB.opts, opts); await load(); return `${LB.players.size} players loaded`; };
LB.halt = () => { LB.stop = true; return "stopping after the current batch (a minute or two; progress is saved)"; };

LB.start = async (opts = {}) => {
  if (LB.running) return 'already running';
  Object.assign(LB.opts, opts);
  const native = getAnalysisPool(NATIVE_N);
  if (!native[0]?.native) return 'needs the desktop app (native Stockfish)';
  LB.running = true; LB.stop = false; LB.t0 = performance.now(); LB.crawlersDone = false;
  await load();
  LB.seedSet = new Set(SEEDS);
  LB.seeds = SEEDS.filter(s => !LB.visited.has(s));
  for (const t of ['GM', 'IM', 'FM', 'CM', 'NM', 'WGM', 'WIM', 'WFM']) {
    const list = await fetchTitled(t).catch(() => []);
    for (let i = 0; i < 12 && list.length; i++) { const u = list[Math.floor(Math.random() * list.length)].toLowerCase(); if (!LB.visited.has(u)) LB.seeds.push(u); }
  }
  const saver = setInterval(() => save().catch(() => {}), 120000);
  const tick = setInterval(() => {
    const { focus } = counts(), ps = [...LB.players.values()];
    LB.status = `${ps.filter(p => p.focus).length} focus players, ${ps.length} players in all (${ps.filter(p => p.e.length).length} with engine data), ` +
      `${Object.values(focus).filter(v => v >= LB.opts.quota).length} full cells, ${LB.pending.length} queued, ${LB.analysed} games analysed, ` +
      `${LB.visited.size} visited, ${LB.errors} errors, ${Math.round((performance.now() - LB.t0) / 60000)} min` +
      (LB.lastBatch ? `, last batch ${LB.lastBatch.games} games in ${LB.lastBatch.secs}s` : '');
  }, 3000);
  const eng = engineLoop(native);
  await Promise.all(Array.from({ length: CRAWLERS }, () => crawler()));
  LB.crawlersDone = true;
  await eng;
  clearInterval(saver); clearInterval(tick);
  await save();
  LB.running = false;
  LB.status = `done: ${LB.players.size} players`;
  return LB.status;
};

// ---------- the published file ----------
// metric: per-game [numerator, denominator] from a player's rows, and a scale. kind: 'rate' (per-move rates and
// accuracy; noise measured from repeat games), 'binary' (yes/no outcomes per game or per chance; binomial noise),
// 'spread' (a player's game-to-game SD of accuracy; noise from the sampling variance of a variance)
const METRICS = {
  accuracy:    { rows: 'e', of: r => [r[0], 1], scale: 1, kind: 'rate' },
  blunders:    { rows: 'e', of: r => [r[1], r[2]], scale: 100, kind: 'rate' },
  conversion:  { rows: 'e', of: r => (r[3] ? [r[5], 1] : null), scale: 100, kind: 'binary' },
  resilience:  { rows: 'e', of: r => (r[4] ? [r[5], 1] : null), scale: 100, kind: 'binary' },
  brilliance:  { rows: 'e', of: r => (r[9] ? [r[8], r[9]] : null), scale: 100, kind: 'binary' },
  clutch:      { rows: 'e', of: r => (r[7] ? [r[6], r[7]] : null), scale: 100, kind: 'binary' },
  consistency: { rows: 'e', scale: 1, kind: 'spread' },
  checks:      { rows: 'h', of: r => [r[0], r[3]], scale: 100, kind: 'rate' },
  captures:    { rows: 'h', of: r => [r[1], r[3]], scale: 100, kind: 'rate' },
  pawns:       { rows: 'h', of: r => [r[2], r[3]], scale: 100, kind: 'rate' },
  castleEarly: { rows: 'h', of: r => (r[4] < 0 ? null : [r[4], 1]), scale: 100, kind: 'binary' },
  earlyQueen:  { rows: 'h', of: r => [r[5], 1], scale: 100, kind: 'binary' },
  timeTrouble: { rows: 'h', of: r => (r[6] < 0 ? null : [r[6], 1]), scale: 100, kind: 'binary' },
};

// a player's value: scale·Σnum/Σden, with Σden (its sample size) and per-game rates for the within-player variance
function measure(p, m) {
  if (m.kind === 'spread') return measureSpread(p[m.rows].map(r => r[0]));
  const xs = p[m.rows].map(m.of).filter(x => x && x[1] > 0);
  if (!xs.length) return null;
  const A = sum(xs.map(x => x[0])), M = sum(xs.map(x => x[1]));
  return { r: A / M, M, xs };
}
// game-to-game spread of accuracy: the unbiased variance k2 (r) with its degrees of freedom (M), and the fourth
// k-statistic k4 (unbiased for the fourth cumulant), which sets how noisy a variance from n games is
function measureSpread(accs) {
  const n = accs.length;
  if (n < 4) return null;
  const m = mean(accs), m2 = mean(accs.map(x => (x - m) ** 2)), m4 = mean(accs.map(x => (x - m) ** 4));
  const k2 = n * m2 / (n - 1), k4 = n * n * ((n + 1) * m4 - 3 * (n - 1) * m2 * m2) / ((n - 1) * (n - 2) * (n - 3));
  return { r: k2, M: n - 1, n, k4 };
}

// within-player variance per unit of denominator: Σ m (r_i − r̄)² / Σ(n − 1), over players with 2+ games
function withinVar(items) {
  let ss = 0, df = 0;
  for (const it of items) {
    if (it.xs.length < 2) continue;
    for (const [a, m] of it.xs) ss += m * (a / m - it.r) ** 2;
    df += it.xs.length - 1;
  }
  return df ? { s2: ss / df, df } : null;
}
// excess-kurtosis ratio κ = κ4/σ⁴ of single-game accuracy around a player's own level, pooled over players with
// 8+ games (k4 is unbiased; σ⁴ is estimated from k2², whose own noise is taken out by a short fixed point)
function kurtosisRatio(items) {
  const xs = items.filter(x => x.n >= 8);
  if (xs.length < 20) return null;
  let kap = 0;
  for (let it = 0; it < 6; it++) {
    const s4 = xs.map(x => x.r * x.r / (1 + 2 / x.M + kap / x.n));
    kap = Math.max(-1.5, sum(xs.map(x => x.n * x.k4)) / sum(xs.map((x, i) => x.n * s4[i])));
  }
  return kap;
}

const quant = (xs, p) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
function wquantiles(vals, ws, k = 21) {
  const o = vals.map((v, i) => [v, ws[i]]).sort((a, b) => a[0] - b[0]);
  const W = sum(ws), out = [];
  for (let q = 0; q < k; q++) {
    const target = q / (k - 1) * W;
    let acc = 0, v = o[0][0];
    for (const [x, w] of o) { acc += w; v = x; if (acc >= target) break; }
    out.push(+v.toFixed(3));
  }
  return out;
}

// A band's estimate from its own players alone is noisier than the real change between neighbouring bands, so each
// band centre R borrows from every player of the time control through a sliding window:
// • Gaussian weights around R (bandwidth H0, cut at CUT·h), widened where data is thin until the weights add up
//   to MIN_EFF players (at most HMAX); the bandwidth used is recorded per band.
// • The rating trend is taken out: a weighted local-linear fit of the metric on rating, so the band's level is the
//   fit at R and a wide window doesn't drag in the level of stronger/weaker players the way a fixed wide band would.
// • Random effects: each player's value = trend + their true offset + game-to-game noise. The noise variance is
//   known per player (yes/no outcomes: binomial, exact; rates and accuracy: measured from players with repeat
//   games; spread: the sampling variance of a variance, from n and the kurtosis), and the true spread τ² is a
//   precision-weighted (REML-style) estimate, so well-measured players carry it.
// • The band is then described by its fitted distribution of true levels: Beta(mean, τ²) for yes/no outcomes (stays
//   within 0–100%), Normal(mean, τ²) otherwise (kept ≥ 0). Medians, quartiles and the TC-wide percentiles come
//   from these (seeded draws), not from individually shrunk players, whose single-game values would cluster.
const H0 = 125, HMAX = 400, CUT = 2.5, DRAWS = 4000, TAU_SMOOTH = 150;
// players the window must hold; a spread needs several games per player, so fewer (mostly focus) players carry it
const MIN_EFF = { rate: 150, binary: 150, spread: 60 };
const wsum = (xs, ws) => xs.reduce((s, x, i) => s + x * ws[i], 0);
const clamp01 = p => Math.min(0.999, Math.max(0.001, p));

// seeded random numbers, so a rebuild of the same data gives the same file
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hashSeed = s => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);
const normal = rnd => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
function gamma(rnd, k) {                      // Marsaglia–Tsang
  if (k < 1) return gamma(rnd, k + 1) * Math.pow(rnd() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { const x = normal(rnd), v = (1 + c * x) ** 3; if (v <= 0) continue; const u = rnd(); if (Math.log(u || 1e-12) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v; }
}
// draws of true levels (unscaled) for one band
function drawBand(f, binary, seed) {
  const rnd = rng(seed), out = new Array(DRAWS);
  if (binary) {
    const mu = clamp01(f.alpha), tau2 = Math.min(f.tau2, 0.95 * mu * (1 - mu));
    if (tau2 <= 1e-9) return out.fill(mu);
    const k = mu * (1 - mu) / tau2 - 1, a = mu * k, b = (1 - mu) * k;
    for (let i = 0; i < DRAWS; i++) { const x = gamma(rnd, a), y = gamma(rnd, b); out[i] = x / (x + y); }
  } else {
    const sd = Math.sqrt(f.tau2);
    for (let i = 0; i < DRAWS; i++) out[i] = Math.max(0, f.alpha + sd * normal(rnd));
  }
  return out;
}

// items: [{ rating, r, M, xs }] (r unscaled: a proportion, a per-move rate, accuracy or a variance); returns the fit at R
function kernelFit(items, R, kind) {
  const binary = kind === 'binary', spread = kind === 'spread';
  let h = H0, sel, w;
  for (;;) {
    sel = items.filter(x => Math.abs(x.rating - R) <= CUT * h);
    w = sel.map(x => Math.exp(-0.5 * ((x.rating - R) / h) ** 2));
    if (sum(w) >= MIN_EFF[kind] || h >= HMAX) break;
    h = Math.min(HMAX, h * 1.25);
  }
  if (sel.length < 30) return null;
  // game-to-game variance for rates/accuracy: from the window's repeat players, wider if too few
  let s2 = null, kap = null;
  if (kind === 'rate') {
    let wv = withinVar(sel);
    if (!wv || wv.df < 60) wv = withinVar(items.filter(x => Math.abs(x.rating - R) <= 400));
    if (!wv || wv.df < 60) wv = withinVar(items);
    if (!wv) return null;
    s2 = wv.s2;
  }
  if (spread) {
    kap = kurtosisRatio(sel) ?? kurtosisRatio(items.filter(x => Math.abs(x.rating - R) <= 400)) ?? kurtosisRatio(items);
    if (kap == null) return null;
  }
  const d = sel.map(x => x.rating - R), y = sel.map(x => x.r), M = sel.map(x => x.M), W = sum(w);
  // noise variance of each player's value: binomial for yes/no outcomes (E[p(1−p)] = μ(1−μ) − τ² at their rating);
  // for a variance from n games, (E[σ⁴])·(2/(n−1) + κ/n) with E[σ⁴] = μ² + τ²
  const noise = (alpha, beta, tau2) => binary
    ? M.map((Mi, i) => { const p = clamp01(alpha + beta * d[i]); return Math.max(1e-6, p * (1 - p) - tau2) / Mi; })
    : spread ? M.map((Mi, i) => { const mu = Math.max(1e-6, alpha + beta * d[i]); return (mu * mu + tau2) * Math.max(1e-3, 2 / Mi + kap / (Mi + 1)); })
    : M.map(Mi => s2 / Mi);
  let alpha = wsum(y, w) / W, beta = 0;
  let v = noise(alpha, 0, 0);
  const vMed = quant(v, 0.5);
  let tau2 = Math.max(0.1 * vMed, wsum(y.map(yi => (yi - alpha) ** 2), w) / W - wsum(v, w) / W);
  for (let it = 0; it < 80; it++) {
    v = noise(alpha, beta, tau2);
    // weighted least squares y = α + β·d, weights = window × precision
    const a = w.map((wi, i) => wi / (tau2 + v[i]));
    const A = sum(a), Sd = wsum(d, a), Sy = wsum(y, a), Sdd = wsum(d.map(x => x * x), a), Sdy = wsum(d.map((x, i) => x * y[i]), a);
    const den = A * Sdd - Sd * Sd;
    beta = den > 0 ? (A * Sdy - Sd * Sy) / den : 0;
    alpha = (Sy - beta * Sd) / A;
    const a2 = a.map(x => x * x);
    let next = Math.max(0, wsum(y.map((yi, i) => (yi - alpha - beta * d[i]) ** 2 - v[i]), a2) / sum(a2));
    if (binary) next = Math.min(next, 0.95 * clamp01(alpha) * (1 - clamp01(alpha)));
    if (Math.abs(next - tau2) <= 1e-7 * (tau2 + vMed)) { tau2 = next; break; }
    tau2 = next;
  }
  if (binary) alpha = clamp01(alpha);
  const sdGame = binary ? Math.sqrt(alpha * (1 - alpha)) : spread ? null : Math.sqrt(s2);
  return { h, W, n: sel.length, alpha, beta, tau2, sdGame, kap };
}

// the rating CDF of a time control from [rating, percentile] points: sorted, made monotone, piecewise linear
function cdfFrom(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  let m = 0; const xs = [], ys = [];
  for (const [r, pc] of pts) { m = Math.max(m, pc / 100); xs.push(r); ys.push(m); }
  // below the first point: linear from chess.com's rating floor (100); above the last: the remaining share over 300 points
  return r => { if (r <= xs[0]) return ys[0] * Math.max(0, r - 100) / Math.max(1, xs[0] - 100); if (r >= xs.at(-1)) return Math.min(1, ys.at(-1) + (1 - ys.at(-1)) * Math.min(1, (r - xs.at(-1)) / 300));
    let i = 1; while (xs[i] < r) i++; const f = (r - xs[i - 1]) / (xs[i] - xs[i - 1] || 1); return ys[i - 1] + f * (ys[i] - ys[i - 1]); };
}

LB.build = async () => {
  // the browser-engine mapping is kept from the published file (the desktop app scans with Stockfish 19 itself)
  const prev = await fetch('js/ladder.json').then(r => r.json()).catch(() => null);
  LB.ratingDist ||= await fetch('tools/rating-dist.json').then(r => r.json()).catch(() => null);
  const out = { version: 4, built: new Date().toISOString().slice(0, 10), engine: 'Stockfish 19', depth: DEPTH, multipv: MULTIPV,
    method: 'both sides of every game; sliding trend-corrected rating window; random effects (noise removed); bands described by their fitted distributions',
    bandWidth: LADDER_BAND, window: { start: H0, max: HMAX, minPlayers: MIN_EFF }, calib: prev?.calib || {}, calibFit: prev?.calibFit || {}, tc: {} };

  for (const tc of LADDER_TCS) {
    const ps = [...LB.players.values()].filter(p => p.tc === tc && p.ratings.length).map(p => ({ p, rating: bandRating(p) }));
    const inBand = groupBy(ps, x => ladderBandOf(x.rating));
    // report every band that has players of its own (no extrapolation into empty rating ranges); its centre is the
    // median rating of those players (the lowest band starts at chess.com's floor of 100, the top one is thin)
    const bands = [...inBand.keys()].filter(b => inBand.get(b).length >= 5).sort((a, b) => a - b);
    const cells = Object.fromEntries(bands.map(b => [b, { n: inBand.get(b).length, nFocus: inBand.get(b).filter(x => x.p.focus).length,
      centre: Math.round(median(inBand.get(b).map(x => x.rating))),
      median: {}, p25: {}, p75: {}, mean: {}, sdPlayers: {}, sdGame: {}, slope: {}, window: {}, nEff: {} }]));
    const quantiles = {};
    const popCdf = LB.ratingDist?.[tc] ? cdfFrom(LB.ratingDist[tc]) : null;
    if (popCdf) out.population = { ...(out.population || {}), [tc]: LB.ratingDist[tc] };
    for (const [key, m] of Object.entries(METRICS)) {
      const binary = m.kind === 'binary', spread = m.kind === 'spread', sc = m.scale, cap = binary || key === 'accuracy' ? 100 : Infinity;
      const items = ps.map(x => ({ ...x, ...(measure(x.p, m) || {}) })).filter(x => x.M);
      const pooled = [];
      const fits = Object.fromEntries(bands.map(b => [b, kernelFit(items, cells[b].centre, m.kind)]).filter(([, f]) => f));
      // The true spread changes slowly with rating, but each band's estimate of it rests on the few repeat-game players
      // near it, so it jitters band to band. Smooth it across neighbouring bands (Gaussian, σ = TAU_SMOOTH, weighted
      // by each band's sample) before drawing the band distributions.
      const fb = Object.keys(fits).map(Number);
      for (const b of fb) {
        const ws = fb.map(o => fits[o].W * Math.exp(-0.5 * ((cells[o].centre - cells[b].centre) / TAU_SMOOTH) ** 2));
        fits[b].tau2s = wsum(fb.map(o => fits[o].tau2), ws) / sum(ws);
      }
      for (const b of bands) {
        const f0 = fits[b];
        if (!f0) continue;
        const f = { ...f0, tau2: f0.tau2s };
        // a spread is fitted as a variance and published as an SD (accuracy points)
        const draws = drawBand(f, binary, hashSeed(`${tc}:${key}:${b}`)).map(x => Math.min(cap, sc * (spread ? Math.sqrt(x) : x)));
        const c = cells[b];
        c.median[key] = +quant(draws, 0.5).toFixed(3);
        c.p25[key] = +quant(draws, 0.25).toFixed(3);
        c.p75[key] = +quant(draws, 0.75).toFixed(3);
        c.mean[key] = +(spread ? mean(draws) : sc * f.alpha).toFixed(3);
        c.sdPlayers[key] = +(spread ? Math.sqrt(mean(draws.map(x => (x - c.mean[key]) ** 2))) : sc * Math.sqrt(f.tau2)).toFixed(3);
        if (f.sdGame != null) c.sdGame[key] = +(sc * f.sdGame).toFixed(3);
        c.slope[key] = +(spread ? f.beta * 100 / (2 * Math.sqrt(Math.max(1e-6, f.alpha))) : sc * f.beta * 100).toFixed(3);   // per 100 rating points
        c.window[key] = Math.round(f.h);
        c.nEff[key] = Math.round(f.W);
        pooled.push({ b, draws });
      }
      // TC-wide percentiles: the mix of the band distributions, each band weighted by its real share of chess.com
      // players in this time control (LB.ratingDist, from chess.com's published percentiles); equal shares without it
      if (pooled.length >= 3) {
        const share = b => (popCdf ? Math.max(0, popCdf(b + LADDER_BAND) - popCdf(b)) : 1);
        const vals = pooled.flatMap(x => x.draws), ws = pooled.flatMap(x => x.draws.map(() => share(x.b) / DRAWS));
        quantiles[key] = wquantiles(vals, ws);
      }
    }
    const kept = Object.fromEntries(Object.entries(cells).filter(([, c]) => Object.keys(c.median).length));
    out.tc[tc] = { players: ps.length, focus: ps.filter(x => x.p.focus).length, quantiles, bands: kept };
  }
  return out;
};
})();
