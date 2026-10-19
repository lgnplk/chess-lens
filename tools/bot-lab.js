// Bot lab: cross-validated experiments for the legacy player-bot model (js/bot-legacy.js; load it first).
// Not loaded by the app. In the browser console on the running site:
//   await loadScript('tools/bot-lab.js?' + Date.now())
//   const P = await LAB.player({ kind: 'chesscom', user: 'gogangoblin', months: 3 }, { tc: 'all', n: 80 })
//   await LAB.analyze(P, 10); LAB.decide(P, 10); const r = await LAB.cv(P, { name: 'base' })
(() => {
const LAB = window.LAB = window.LAB || { mem: new Map(), engines: [], status: '', results: {} };

// ---------- engine analysis: several Stockfish workers in parallel, cached like analyzeForBot ----------
function engines(n) { while (LAB.engines.length < n) LAB.engines.push(new Engine()); return LAB.engines.slice(0, n); }

async function analyzeGame(g, engine, depth, K, persist) {
  const key = `cl:bot:v1:${depth}m${K}:${g.id}:${g.color}`;
  const hit = LAB.mem.get(key) || store.get(key);
  if (hit) return hit;
  const chess = new Chess(), out = [], myTurn = g.color[0];
  for (let i = 0; i < g.sans.length && i < 120; i++) {
    if (chess.turn() === myTurn && i >= 4) {
      const r = await engine.analyse(chess.fen(), depth, depth <= 10 ? 2000 : 60000, K);
      out.push({ i, c: (r.lines || []).filter(l => l.best).map(l => [l.best, l.cp, l.mate]) });
    }
    if (!chess.move(g.sans[i], { sloppy: true })) break;
  }
  LAB.mem.set(key, out);
  if (persist) store.set(key, out);
  return out;
}

LAB.player = async (src, { tc = 'all', n = 80 } = {}) => {
  const data = await loadSource(src);
  const pool = data.games.filter(g => (tc === 'all' || g.timeClass === tc) && g.sans.length >= 16);
  return { label: data.label, pool, games: pool.slice(0, n), rows: {}, decs: {} };
};

LAB.analyze = async (P, depth, { K = 8, workers = 8, persist = true } = {}) => {
  const es = engines(workers), out = new Array(P.games.length);
  let next = 0, done = 0;
  const t0 = performance.now();
  await Promise.all(es.map(async e => {
    while (next < P.games.length) {
      const i = next++;
      out[i] = await analyzeGame(P.games[i], e, depth, K, persist);
      done++; LAB.status = `${P.label} d${depth}: ${done}/${P.games.length} games, ${((performance.now() - t0) / 1000).toFixed(0)} s`;
    }
  }));
  P.rows[depth] = out;
  return LAB.status;
};

// ---------- decisions with everything the variants need ----------
const T12 = 'pnbrqk';
function boardSig(chess) {
  const s = new Uint32Array(24); // 12 piece bitboards (white pnbrqk, black pnbrqk) x 2 halves
  const b = chess.board();
  let mat = 0;
  const sign = chess.turn() === 'w' ? 1 : -1;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = b[r][c]; if (!p) continue;
    const sq = (7 - r) * 8 + c;
    s[((p.color === 'w' ? 0 : 6) + T12.indexOf(p.type)) * 2 + (sq >> 5)] |= 1 << (sq & 31);
    mat += (p.color === 'w' ? 1 : -1) * sign * PIECE_VAL[p.type];
  }
  return { sig: s, mat };
}

LAB.decide = (P, depthP, depthS = null) => {
  const decs = [];
  const sideWp = (cands, sign) => new Map(cands.map(([u, cp, mate]) => [u, winPct(clamp(evalToCp({ cp, mate }) * sign, -1500, 1500))]));
  const sideCp = (cands, sign) => new Map(cands.map(([u, cp, mate]) => [u, clamp(evalToCp({ cp, mate }) * sign, -1500, 1500)]));
  P.games.forEach((g, gi) => {
    const rp = P.rows[depthP][gi], rs = depthS ? P.rows[depthS][gi] : null;
    if (!rp) return;
    const byP = new Map(rp.map(r => [r.i, r.c])), byS = rs ? new Map(rs.map(r => [r.i, r.c])) : null;
    const chess = new Chess();
    let last = null, myLast = null;
    for (let i = 0; i < g.sans.length; i++) {
      const cP = byP.get(i);
      if (cP && cP.length) {
        const sign = chess.turn() === 'w' ? 1 : -1;
        const wP = sideWp(cP, sign), bestP = Math.max(...wP.values());
        const cpP = sideCp(cP, sign), bestCp = Math.max(...cpP.values());
        const cS = byS?.get(i), wS = cS?.length ? sideWp(cS, sign) : null, bestS = wS ? Math.max(...wS.values()) : null;
        const rankP = new Map(cP.map((c, k) => [c[0], k]));
        let tt = false;
        if (g.base && g.clocks?.length) { const ck = i >= 2 ? g.clocks[i - 2] : g.base; tt = ck != null && ck / g.base < 0.15; }
        const { sig, mat } = boardSig(chess);
        const alts = moveFeatures(chess, last, myLast).map(a => {
          const from = a.uci.slice(0, 2), to = a.uci.slice(2, 4);
          return {
            uci: a.uci, san: a.san, f: a.f, from, to, piece: a.f[10] ? 'o' : chess.get(from).type,
            lossP: wP.has(a.uci) ? bestP - wP.get(a.uci) : null, rankP: rankP.has(a.uci) ? rankP.get(a.uci) : null,
            cpLossP: cpP.has(a.uci) ? Math.min(500, bestCp - cpP.get(a.uci)) : null,
            lossS: wS && wS.has(a.uci) ? bestS - wS.get(a.uci) : null,
          };
        });
        const key = chess.fen().split(' ').slice(0, 4).join(' ');
        const phase = phaseOf(chess, i);
        const mv = chess.move(g.sans[i], { sloppy: true });
        if (!mv) break;
        const played = alts.findIndex(a => a.uci === mv.from + mv.to + (mv.promotion || ''));
        if (played >= 0) decs.push({
          gi, ply: i, color: g.color, phase, tt, bestWp: bestP, mat, key, sig, alts, played,
          bestUci: cP[0][0], bestUciS: cS?.[0]?.[0] ?? null,
          worstP: Math.max(...[...wP.values()].map(w => bestP - w)), worstS: wS ? Math.max(...[...wS.values()].map(w => bestS - w)) : null,
        });
        myLast = mv; last = null;
        continue;
      }
      const mv = chess.move(g.sans[i], { sloppy: true });
      if (!mv) break;
      if (mv.color === g.color[0]) myLast = mv; else last = mv;
    }
  });
  const name = depthS ? `${depthP}+${depthS}` : String(depthP);
  P.decs[name] = decs;
  return { name, n: decs.length };
};

// ---------- similar positions (for the player's-own-moves prior) ----------
const pc32 = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
function jaccard(a, b, which) {
  let i = 0, u = 0;
  for (const k of which) { i += pc32(a[k] & b[k]); u += pc32(a[k] | b[k]); }
  return u ? i / u : 0;
}
const PAWN_WORDS = [0, 1, 12, 13], ALL_WORDS = [...Array(24).keys()];

// for each decision: up to 150 most similar decisions of the same colour from other games
function neighbours(decs, simType) {
  decs._nb = decs._nb || {};
  if (decs._nb[simType]) return decs._nb[simType];
  const which = simType === 'pawn' ? PAWN_WORDS : ALL_WORDS;
  const out = decs.map((d, a) => {
    const c = [];
    decs.forEach((e, b) => { if (b !== a && e.color === d.color && e.gi !== d.gi) c.push([b, jaccard(d.sig, e.sig, which)]); });
    c.sort((x, y) => y[1] - x[1]);
    return c.slice(0, 150);
  });
  return (decs._nb[simType] = out);
}

const PRIOR_NAMES = ['nnUci', 'nnPiece', 'nnTo', 'samePos', 'glob'];
// Prior features for every alternative, from the training decisions of OTHER games only
function priors(decs, isTrain, { simType = 'pawn', K = 25 } = {}) {
  const nb = neighbours(decs, simType);
  const pos = new Map(), glob = new Map();
  const bump = (m, k, gi) => { let e = m.get(k); if (!e) m.set(k, e = { n: 0, by: new Map() }); e.n++; e.by.set(gi, (e.by.get(gi) || 0) + 1); };
  decs.forEach((d, i) => {
    if (!isTrain[i]) return;
    const a = d.alts[d.played];
    bump(pos, d.color + d.key + a.uci, d.gi);
    bump(glob, d.color + a.uci, d.gi);
  });
  const cnt = (m, k, gi) => { const e = m.get(k); return e ? e.n - (e.by.get(gi) || 0) : 0; };
  return decs.map(d => {
    let wsum = 0;
    const uci = new Map(), piece = new Map(), to = new Map();
    let taken = 0;
    for (const [b, s] of nb[d._i]) {
      if (!isTrain[b] || decs[b].gi === d.gi) continue;
      const e = decs[b], a = e.alts[e.played];
      wsum += s;
      uci.set(a.uci, (uci.get(a.uci) || 0) + s);
      piece.set(a.piece, (piece.get(a.piece) || 0) + s);
      to.set(a.piece + a.to, (to.get(a.piece + a.to) || 0) + s);
      if (++taken >= K) break;
    }
    return d.alts.map(a => Float32Array.of(
      wsum ? (uci.get(a.uci) || 0) / wsum : 0,
      wsum ? (piece.get(a.piece) || 0) / wsum : 0,
      wsum ? (to.get(a.piece + a.to) || 0) / wsum : 0,
      Math.log1p(cnt(pos, d.color + d.key + a.uci, d.gi)),
      Math.log1p(cnt(glob, d.color + a.uci, d.gi)),
    ));
  });
}

// ---------- model variants: sparse design rows ----------
// spec flags: best, dual, phaseW, phaseV, band, mat, prior: [names], priorLog, simType, K, l2, phaseL2
function layout(spec) {
  const blocks = {}; let dim = 0;
  const l2 = spec.l2 ?? 0.002;
  const l2v = [];
  const add = (name, n, pen = l2) => { blocks[name] = dim; dim += n; for (let k = 0; k < n; k++) l2v.push(pen); };
  add('beta', 3); add('tt', 1); add('w', NF); add('b', 3, 0); add('v', NF);
  if (spec.best) add('best', 3);
  if (spec.shape) add('shape', 3);
  if (spec.cp) add('cp', 3);
  if (spec.dual) add('betaS', 3);
  if (spec.phaseW) add('wph', 3 * NF, spec.phaseL2 ?? l2 * 5);
  if (spec.phaseV) add('vph', 3 * NF, spec.phaseL2 ?? l2 * 5);
  if (spec.band) add('band', 10);
  if (spec.mat) add('mat', 6);
  if (spec.prior) add('prior', spec.prior.length);
  return { dim, blocks, l2v: Float64Array.from(l2v) };
}

const BAND_FEATS = [2, 0, 4]; // check, capture, trade
const MAT_FEATS = [0, 1, 2, 4]; // capture, gain, check, trade
function design(decs, spec, L, pri) {
  const B = L.blocks;
  const pidx = spec.prior ? spec.prior.map(n => PRIOR_NAMES.indexOf(n)) : [];
  return decs.map((d, di) => {
    const ptr = [0], idx = [], val = [];
    const band = d.bestWp >= 75 ? 1 : d.bestWp <= 25 ? 0 : -1; // 0 losing, 1 winning, -1 equal (reference)
    const m = clamp(d.mat, -9, 9) / 9;
    d.alts.forEach((a, ai) => {
      const put = (k, v) => { if (v) { idx.push(k); val.push(v); } };
      const top = a.lossP != null;
      if (top) {
        const L10 = -a.lossP / 10;
        put(B.beta + d.phase, L10);
        if (d.tt) put(B.tt, L10);
        for (let k = 0; k < NF; k++) put(B.w + k, a.f[k]);
        if (spec.best && a.rankP === 0) put(B.best + d.phase, 1);
        if (spec.shape) put(B.shape + d.phase, -Math.sqrt(a.lossP));
        if (spec.cp) put(B.cp + d.phase, -a.cpLossP / 100);
        if (spec.phaseW) for (let k = 0; k < NF; k++) put(B.wph + d.phase * NF + k, a.f[k]);
        if (spec.band && band >= 0) {
          put(B.band + band, L10);
          BAND_FEATS.forEach((q, j) => put(B.band + 4 + band * 3 + j, a.f[q]));
        }
        if (spec.mat) { put(B.mat, L10 * m); MAT_FEATS.forEach((q, j) => put(B.mat + 2 + j, a.f[q] * m)); }
      } else {
        put(B.b + d.phase, 1);
        for (let k = 0; k < NF; k++) put(B.v + k, a.f[k]);
        if (spec.phaseV) for (let k = 0; k < NF; k++) put(B.vph + d.phase * NF + k, a.f[k]);
        if (spec.band && band >= 0) put(B.band + 2 + band, 1);
        if (spec.mat) put(B.mat + 1, m);
      }
      if (spec.dual) {
        const ls = a.lossS != null ? a.lossS : top && d.worstS != null ? d.worstS : null;
        if (ls != null) put(B.betaS + d.phase, -ls / 10);
      }
      if (spec.prior) pidx.forEach((q, j) => {
        const x = pri[di][ai][q];
        put(B.prior + j, spec.priorLog && q < 3 ? Math.log(x + 0.02) - Math.log(0.02) : x);
      });
      ptr.push(idx.length);
    });
    return { n: d.alts.length, ptr: Int32Array.from(ptr), idx: Int32Array.from(idx), val: Float32Array.from(val), played: d.played };
  });
}

function probs(r, theta, out) {
  let mx = -Infinity;
  for (let i = 0; i < r.n; i++) {
    let v = 0;
    for (let p = r.ptr[i]; p < r.ptr[i + 1]; p++) v += r.val[p] * theta[r.idx[p]];
    out[i] = v; if (v > mx) mx = v;
  }
  let z = 0;
  for (let i = 0; i < r.n; i++) { out[i] = Math.exp(out[i] - mx); z += out[i]; }
  for (let i = 0; i < r.n; i++) out[i] /= z;
  return out;
}

async function fit(rows, L, { iters = 300, lr = 0.08 } = {}) {
  const D = L.dim, theta = new Float64Array(D);
  for (let k = 0; k < 3; k++) { theta[L.blocks.beta + k] = 1; theta[L.blocks.b + k] = -3; }
  const m = new Float64Array(D), v = new Float64Array(D), g = new Float64Array(D), buf = new Float64Array(256);
  for (let it = 1; it <= iters; it++) {
    g.fill(0);
    for (const r of rows) {
      const p = probs(r, theta, buf);
      for (let q = r.ptr[r.played]; q < r.ptr[r.played + 1]; q++) g[r.idx[q]] += r.val[q];
      for (let i = 0; i < r.n; i++) { const pi = p[i]; if (pi < 1e-7) continue; for (let q = r.ptr[i]; q < r.ptr[i + 1]; q++) g[r.idx[q]] -= pi * r.val[q]; }
    }
    for (let k = 0; k < D; k++) {
      const gk = g[k] / rows.length - L.l2v[k] * theta[k];
      m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk;
      theta[k] += lr * (m[k] / (1 - 0.9 ** it)) / (Math.sqrt(v[k] / (1 - 0.999 ** it)) + 1e-8);
    }
    if (it % 25 === 0) await nextFrame();
  }
  return theta;
}

// ---------- 5-fold cross-validation by game ----------
LAB.cv = async (P, spec = {}) => {
  const dname = spec.decs || '10';
  const decs = P.decs[dname];
  decs.forEach((d, i) => d._i = i);
  const L = layout(spec);
  const N = decs.length, F = 5;
  const res = { name: spec.name, player: P.label, decs: dname, n: N, games: P.games.length, dim: L.dim, logp: new Float64Array(N), rank: new Int32Array(N), bot1: new Uint8Array(N), bot3: new Uint8Array(N), book: new Uint8Array(N), thetas: [] };
  const buf = new Float64Array(256);
  const t0 = performance.now();
  for (let f = 0; f < F; f++) {
    LAB.status = `cv ${spec.name} ${P.label}: fold ${f + 1}/${F}`;
    const isTrain = decs.map(d => d.gi % F !== f);
    const pri = spec.prior ? priors(decs, isTrain, spec) : null;
    const rows = design(decs, spec, L, pri);
    const theta = await fit(rows.filter((r, i) => isTrain[i]), L, spec);
    res.thetas.push(theta);
    const testGames = new Set(P.games.filter((g, gi) => gi % F === f));
    const bookGames = P.pool.filter(g => !testGames.has(g));
    const trees = { white: buildTree(bookGames, 'white'), black: buildTree(bookGames, 'black') };
    decs.forEach((d, i) => {
      if (isTrain[i]) return;
      const p = probs(rows[i], theta, buf).slice(0, d.alts.length);
      const order = [...Array(d.alts.length).keys()].sort((a, b) => p[b] - p[a]);
      res.logp[i] = Math.log(Math.max(p[d.played], 1e-9));
      res.rank[i] = order.indexOf(d.played);
      const node = trees[d.color].get(d.key), ms = sortedMoves(node), san = d.alts[d.played].san;
      if (ms.length && node.n >= BOOK_MIN) { res.book[i] = 1; res.bot1[i] = ms[0].san === san ? 1 : 0; res.bot3[i] = ms.slice(0, 3).some(m => m.san === san) ? 1 : 0; }
      else { res.bot1[i] = res.rank[i] === 0 ? 1 : 0; res.bot3[i] = res.rank[i] < 3 ? 1 : 0; }
    });
  }
  res.sec = (performance.now() - t0) / 1000;
  res.summary = LAB.summary(res, decs);
  (LAB.results[P.label] = LAB.results[P.label] || {})[spec.name] = res;
  LAB.status = `cv ${spec.name} ${P.label}: done`;
  return res.summary;
};

LAB.summary = (res, decs) => {
  const N = res.n, m = a => a.reduce((s, x) => s + x, 0) / N;
  return {
    name: res.name, player: res.player, decs: res.decs, moves: N, games: res.games, dim: res.dim,
    ll: +m(res.logp).toFixed(4), modelTop1: +(m(Array.from(res.rank, r => r === 0 ? 1 : 0)) * 100).toFixed(1),
    modelTop3: +(m(Array.from(res.rank, r => r < 3 ? 1 : 0)) * 100).toFixed(1),
    botTop1: +(m(res.bot1) * 100).toFixed(1), botTop3: +(m(res.bot3) * 100).toFixed(1), book: +(m(res.book) * 100).toFixed(1),
    sfTop1: +(m(decs.map(d => d.alts[d.played].uci === d.bestUci ? 1 : 0)) * 100).toFixed(1),
    sec: +res.sec.toFixed(1),
  };
};

// paired difference in held-out log-likelihood per move (B - A), with a game-clustered standard error
LAB.compare = (label, a, b) => {
  const A = LAB.results[label][a], Bv = LAB.results[label][b];
  const N = A.n, byGame = new Map(), gi = LAB._gi[label];
  let s = 0;
  for (let i = 0; i < N; i++) s += Bv.logp[i] - A.logp[i];
  const mean = s / N;
  for (let i = 0; i < N; i++) { const d = Bv.logp[i] - A.logp[i] - mean; byGame.set(gi[i], (byGame.get(gi[i]) || 0) + d); }
  const G = byGame.size;
  const se = Math.sqrt(G / (G - 1) * [...byGame.values()].reduce((t, x) => t + x * x, 0)) / N;
  const t1 = (Array.from(Bv.rank, r => r === 0 ? 1 : 0).reduce((x, y) => x + y, 0) - Array.from(A.rank, r => r === 0 ? 1 : 0).reduce((x, y) => x + y, 0)) / N;
  return { a, b, dLL: +mean.toFixed(4), se: +se.toFixed(4), z: +(mean / se).toFixed(2), dTop1: +(t1 * 100).toFixed(1) };
};
LAB._gi = LAB._gi || {};
LAB.register = P => { for (const k of Object.keys(P.decs)) LAB._gi[P.label] = P.decs[k].map(d => d.gi); };
})();
