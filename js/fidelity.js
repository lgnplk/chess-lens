// High-fidelity player bots: Maia's human move choices, calibrated to how accurately this player really plays.
//
// Maia's probabilities are spread over several moves mostly because the model can't tell which one this player
// would pick, not because the player picks at random. Sampling from them as if they were the player's own
// randomness makes a strong player's bot err far more often than the player does. High fidelity scores each of
// Maia's candidate moves with Stockfish and reweights them:
//
//     P(move) ∝ p_maia(move)^a · exp(θ[band] + θ[situation, band] + θ[phase, band] + θ[time trouble, band]
//                                     + β[phase] · [it's Stockfish's top choice])
//
// a and the θs are fitted by maximum likelihood on the player's own moves (convex; Newton's method). At the
// maximum, the bot's expected share of moves in each loss band equals the player's real share — overall, in
// winning and losing positions, and in the opening and endgame — so it errs as often and as badly as the
// player, and in the same phases (a GM who calculates pawn endings exactly doesn't get a bot that blunders them).
// β captures calculation that Maia, which plays by pattern, lacks: how much more often than Maia expects the
// player finds the engine's own move. The situation, phase and time-trouble terms are adjustments with a tighter prior, so thin data falls back to the
// player's overall rates, not to plain Maia. Time trouble (under 10% of the clock, or 10 s) is learned separately
// from the player's clock data so that the bot, which has no clock, plays at their with-time-to-think rates
// instead of averaging in their time scrambles. The moves themselves still come from Maia's model of human play.
const FID_DEPTH = 10, FID_MS = 8000;          // default Stockfish depth; the deepest fidelity level uses 12
const FID_BANDS = [1, 3, 8, 15, 30];            // win-% loss band edges: <1 (best) · 1–3 · 3–8 · 8–15 · 15–30 · 30+
const FID_BAND_LABELS = ['best (<1)', '1–3', '3–8', '8–15', '15–30', '30+ (blunder)'];
const FID_CTX = ['balanced', 'winning', 'losing'];
const FID_PHASES = ['middlegame', 'opening', 'endgame'];
const FID_MIN_P = 0.005, FID_MAX_K = 10;        // candidates: Maia's top 3, plus any other move with ≥0.5%, up to 10
const FID_PRIOR = 4, FID_PRIOR_ADJ = 1;          // Gaussian prior variances: overall band weights, situation/phase adjustments

const lossBand = loss => { let b = 0; while (b < FID_BANDS.length && loss >= FID_BANDS[b]) b++; return b; };
const fidCtx = wpBest => (wpBest > 85 ? 1 : wpBest < 15 ? 2 : 0);
const NB = FID_BANDS.length;
// weights: [a, overall bands ×5, winning ×5, losing ×5, opening ×5, endgame ×5, time trouble ×5, engine-best: overall, opening, endgame]
const FID_BEST = 1 + NB * 6;
const FID_DIM = FID_BEST + 3;
const fidPriorVar = k => (k <= NB || k === FID_BEST ? FID_PRIOR : FID_PRIOR_ADJ);

// Game phase of a position, as the training data labels it (js/bot.js botDecisions)
function fidPhase(fen) {
  const c = new Chess(fen), [, side, , , , full] = fen.split(' ');
  const ply = (+full - 1) * 2 + (side === 'b' ? 1 : 0);
  return nonPawnMaterial(c) <= 26 ? 'endgame' : ply < 20 ? 'opening' : 'middlegame';
}

function fidCandidates(moves, extraUci = null) {
  const c = moves.filter((m, i) => i < 3 || m.p >= FID_MIN_P).slice(0, FID_MAX_K);
  if (extraUci && !c.some(m => m.uci === extraUci)) { const m = moves.find(x => x.uci === extraUci); if (m) c.push(m); }
  return c;
}

// Stockfish win-% (side to move) of the best move and of each candidate, cached per position
async function scoreCandidates(engine, fen, ucis, depth = FID_DEPTH) {
  const key = `cl:fid:v1:d${depth}:${fen}`;
  const hit = (await evalDB.get(key)) || { b: null, m: {} };
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  const wp = l => winPct(clamp(evalToCp(l) * sign, -1500, 1500));
  let changed = false;
  if (hit.b == null) {
    const r = await engine.analyse(fen, depth, FID_MS, 1);
    hit.b = wp(r); if (r.best) hit.m[r.best] = hit.b; changed = true;
  }
  const need = ucis.filter(u => hit.m[u] == null);
  if (need.length) {
    const r = await engine.analyse(fen, depth, FID_MS, need.length, need.join(' '));
    for (const l of r.lines) if (l.pv?.[0]) hit.m[l.pv[0]] = wp(l);
    for (const u of need) if (hit.m[u] == null) hit.m[u] = wp(await engine.analyse(fen, depth, FID_MS, 1, u)); // missed by multipv
    changed = true;
  }
  if (changed) await evalDB.set(key, hit);
  const best = Math.max(hit.b, ...ucis.map(u => hit.m[u]));
  return { best, loss: Object.fromEntries(ucis.map(u => [u, Math.max(0, best - hit.m[u])])) };
}

// One decision → { c: [{ uci, lp, loss, band }], y (index of the move played, or -1), ctx }
function fidRow(cands, sc, playedUci = null, phase = 'middlegame', tp = false) {
  const ctx = fidCtx(sc.best), ph = Math.max(0, FID_PHASES.indexOf(phase));
  const c = cands.map(m => { const loss = sc.loss[m.uci] ?? 0; return { uci: m.uci, san: m.san, p: m.p, lp: Math.log(Math.max(m.p, 1e-6)), loss, band: lossBand(loss) }; });
  const minLoss = Math.min(...c.map(x => x.loss));
  c.forEach(x => { x.best = x.loss === minLoss; });
  return { c, y: playedUci ? c.findIndex(m => m.uci === playedUci) : -1, ctx, ph, tp: !!tp };
}

function fidFeatures(row, cand) {
  const x = new Float64Array(FID_DIM);
  x[0] = cand.lp;
  if (cand.best) { x[FID_BEST] = 1; if (row.ph) x[FID_BEST + row.ph] = 1; }
  if (cand.band > 0) {
    const b = cand.band - 1;
    x[1 + b] = 1;
    if (row.ctx) x[1 + NB * row.ctx + b] = 1;              // winning / losing adjustment
    if (row.ph) x[1 + NB * (2 + row.ph) + b] = 1;          // opening / endgame adjustment
    if (row.tp) x[1 + NB * 5 + b] = 1;                     // time-trouble adjustment
  }
  return x;
}

const dotv = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function fidProbs(w, row) {
  const s = row.c.map(c => dotv(w, fidFeatures(row, c)));
  const m = Math.max(...s);
  const e = s.map(v => Math.exp(v - m));
  const z = sum(e);
  return e.map(v => v / z);
}

// Maximum-likelihood fit (with a weak Gaussian prior centred on "plain Maia": a = 1, θ = 0)
function fitFidelity(rows, { iters = 40 } = {}) {
  const data = rows.filter(r => r.y >= 0 && r.c.length > 1).map(r => ({ X: r.c.map(c => fidFeatures(r, c)), y: r.y }));
  const w0 = new Float64Array(FID_DIM); w0[0] = 1;
  const objective = w => {
    let ll = 0;
    for (const { X, y } of data) {
      const s = X.map(x => dotv(w, x)), m = Math.max(...s);
      ll += s[y] - m - Math.log(sum(s.map(v => Math.exp(v - m))));
    }
    for (let k = 0; k < FID_DIM; k++) ll -= (w[k] - w0[k]) ** 2 / (2 * fidPriorVar(k));
    return ll;
  };
  let w = Float64Array.from(w0), f = objective(w);
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(FID_DIM), H = Array.from({ length: FID_DIM }, () => new Float64Array(FID_DIM));
    for (const { X, y } of data) {
      const s = X.map(x => dotv(w, x)), m = Math.max(...s);
      const e = s.map(v => Math.exp(v - m)), z = sum(e), p = e.map(v => v / z);
      const ex = new Float64Array(FID_DIM);
      X.forEach((x, j) => { for (let k = 0; k < FID_DIM; k++) ex[k] += p[j] * x[k]; });
      for (let k = 0; k < FID_DIM; k++) g[k] += X[y][k] - ex[k];
      X.forEach((x, j) => { for (let a = 0; a < FID_DIM; a++) { if (!x[a] && !ex[a]) continue; for (let b = 0; b < FID_DIM; b++) H[a][b] += p[j] * (x[a] - ex[a]) * (x[b] - ex[b]); } });
    }
    for (let k = 0; k < FID_DIM; k++) { g[k] -= (w[k] - w0[k]) / fidPriorVar(k); H[k][k] += 1 / fidPriorVar(k); }
    const step = solveLinear(H, g);            // H here is the (positive definite) negated Hessian
    let t = 1, wn, fn;
    do { wn = w.map((v, k) => v + t * step[k]); fn = objective(wn); t /= 2; } while (fn < f - 1e-9 && t > 1e-4);
    if (fn < f) break;
    const gain = fn - f;
    w = wn; f = fn;
    if (gain < 1e-6) break;
  }
  return { w: Array.from(w), n: data.length, logLik: f };
}

function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / d; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

// Score the decisions' candidates with Stockfish, in parallel on the engine pool
async function fidRowsFor(decs, preds, { depth = FID_DEPTH, onProgress, shouldAbort } = {}) {
  const engines = getEnginePool();
  const rows = new Array(decs.length);
  let next = 0, done = 0;
  await Promise.all(engines.map(async e => {
    while (next < decs.length) {
      if (shouldAbort?.()) throw new Error('Stopped.');
      const i = next++, d = decs[i];
      const cands = fidCandidates(preds[i].moves, d.played);
      const sc = await scoreCandidates(e, d.fens.at(-1), cands.map(m => m.uci), depth);
      rows[i] = fidRow(cands, sc, d.played, d.phase, d.tp);
      onProgress?.(++done / decs.length);
    }
  }));
  return rows;
}

// How well a set of weights explains held-out moves, and how its mistakes compare with the player's
function fidReport(rows, w) {
  const R = rows.filter(r => r.y >= 0);
  const nb = FID_BANDS.length + 1, zero = () => new Array(nb).fill(0);
  const actual = zero(), maiaRaw = zero(), maiaPool = zero(), fid = zero();
  let llM = 0, llF = 0, t1M = 0, t1F = 0, lossA = 0, lossM = 0, lossF = 0;
  // per phase: share of moves losing 8+ win-% points (mistakes and worse), real vs today's sampling vs fitted
  const byPhase = Object.fromEntries(FID_PHASES.map(p => [p, { n: 0, actual: 0, today: 0, fid: 0 }]));
  const clock = { calm: { n: 0, bad: 0 }, trouble: { n: 0, bad: 0 } };  // the player's real 8+ rate with and without time trouble
  for (const r of R) {
    const pm = r.c.map(c => c.p), zm = sum(pm), pf = fidProbs(w, r);
    // today's "like them" sampling: smallest set covering 90% of Maia's probability, each ≥2%
    const pool = []; let cum = 0;
    for (const j of r.c.map((c, j) => j).sort((a, b) => r.c[b].p - r.c[a].p)) {
      if (pool.length && (cum >= SAMPLE_TOP_P || r.c[j].p < SAMPLE_MIN_P)) break;
      pool.push(j); cum += r.c[j].p;
    }
    const zp = sum(pool.map(j => r.c[j].p));
    actual[r.c[r.y].band]++; lossA += r.c[r.y].loss;
    r.c.forEach((c, j) => { maiaRaw[c.band] += pm[j] / zm; fid[c.band] += pf[j]; lossM += c.loss * pm[j] / zm; lossF += c.loss * pf[j]; });
    pool.forEach(j => { maiaPool[r.c[j].band] += r.c[j].p / zp; });
    const bp = byPhase[FID_PHASES[r.ph || 0]], bad = c => c.band >= 3;
    bp.n++; bp.actual += bad(r.c[r.y]);
    const ck = clock[r.tp ? 'trouble' : 'calm']; ck.n++; ck.bad += bad(r.c[r.y]);
    pool.forEach(j => { bp.today += bad(r.c[j]) * r.c[j].p / zp; });
    r.c.forEach((c, j) => { bp.fid += bad(c) * pf[j]; });
    llM += Math.log(Math.max(pm[r.y] / zm, 1e-9)); llF += Math.log(Math.max(pf[r.y], 1e-9));
    t1M += pm.indexOf(Math.max(...pm)) === r.y; t1F += pf.indexOf(Math.max(...pf)) === r.y;
  }
  const n = R.length, norm = a => a.map(v => v / n);
  return {
    n, top1: { maia: t1M / n, fid: t1F / n }, logLik: { maia: llM / n, fid: llF / n },
    avgLoss: { actual: lossA / n, maia: lossM / n, fid: lossF / n },
    bands: { actual: norm(actual), maiaRaw: norm(maiaRaw), maiaPool: norm(maiaPool), fid: norm(fid) },
    clock: { calm: clock.calm.n ? clock.calm.bad / clock.calm.n : null, trouble: clock.trouble.n ? clock.trouble.bad / clock.trouble.n : null, troubleShare: clock.trouble.n / n },
    byPhase: Object.fromEntries(Object.entries(byPhase).map(([p, v]) => [p, { n: v.n, actual: v.n ? v.actual / v.n : null, today: v.n ? v.today / v.n : null, fid: v.n ? v.fid / v.n : null }])),
  };
}

// The bot's odds for each of Maia's candidates: score them, then reweight with the player's fitted weights
async function fidRanked(bot, moves, fen, engine) {
  const cands = fidCandidates(moves);
  const sc = await scoreCandidates(engine, fen, cands.map(m => m.uci), bot.fidelity.depth || FID_DEPTH);
  const row = fidRow(cands, sc, null, fidPhase(fen));
  const ps = fidProbs(bot.fidelity.w, row);
  return row.c.map((c, j) => ({ san: c.san, uci: c.uci, p: ps[j], maiaP: c.p, loss: c.loss })).sort((a, b) => b.p - a.p);
}

// Pick a move: sample from those odds ("like them") or take the top one
async function fidChoose(bot, moves, fen, engine, mode = 'sample') {
  const ranked = await fidRanked(bot, moves, fen, engine);
  let pick = ranked[0];
  if (mode === 'sample') { let r = Math.random(); for (const m of ranked) { r -= m.p; if (r <= 0) { pick = m; break; } } }
  // tally the bot's own move quality, to compare with the player's real games
  const st = bot.fidStats ||= { n: 0, loss: 0, bands: new Array(FID_BANDS.length + 1).fill(0) };
  st.n++; st.loss += pick.loss; st.bands[lossBand(pick.loss)]++;
  return { move: pick, ranked };
}
