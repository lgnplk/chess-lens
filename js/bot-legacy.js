// LEGACY: the original hand-built Player bot model (engine top-8 + style features), replaced in the app by
// the Maia-3 bot in js/bot.js. Kept only for maia-eval.html and tools/bot-lab.js comparisons; not loaded by index.html.
// Player bot: predicts the move a specific player would make.
//
// Book: while the position appears in the player's own games, play their moves from the opening tree.
// Model: a conditional-logit choice model over all legal moves, fitted to the player's games.
//   - The engine's top 8 moves get utility  -beta[phase] * loss  (+ beta_tt in time trouble)  + w · features
//     where loss = win-% points given up versus the best move.
//   - Every other legal move gets  b[phase] + v · features  (how often, and what kind of, "human" moves
//     the player makes outside the engine's top 8).
// Parameters are fitted by maximum likelihood (Adam), trained on 80% of games and tested on the other 20%.

const BOT_K = 8, BOT_DEPTH = 10;
const BOT_FEATURES = [
  ['capture', 'Captures'], ['gain', 'Captures big material'], ['check', 'Gives check'], ['recapture', 'Recaptures'],
  ['trade', 'Trades equal pieces'], ['knight', 'Knight moves'], ['bishop', 'Bishop moves'], ['rook', 'Rook moves'],
  ['queen', 'Queen moves'], ['king', 'King moves (not castling)'], ['castle', 'Castles'], ['promotion', 'Promotes'],
  ['advance', 'Advances up the board'], ['retreat', 'Retreats'], ['towardKing', 'Moves toward the enemy king'],
  ['fromAttacked', 'Moves an attacked piece'], ['toAttacked', 'Lands on an attacked square'], ['samePiece', 'Moves the same piece again'],
];
const NF = BOT_FEATURES.length;
// parameter layout
const P_BETA = 0, P_TT = 3, P_W = 4, P_B = 4 + NF, P_V = 7 + NF, P_DIM = 7 + 2 * NF;

const kingSq = (chess, color) => {
  const b = chess.board();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = b[r][c]; if (p && p.type === 'k' && p.color === color) return [c, 7 - r]; }
  return [4, color === 'w' ? 0 : 7];
};
const sqXYf = sq => [sq.charCodeAt(0) - 97, +sq[1] - 1];
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

// Squares the side not to move attacks (their piece moves + pawn diagonals)
function enemyAttacks(chess) {
  const p = chess.fen().split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w'; p[3] = '-';
  const set = new Set();
  try { new Chess(p.join(' ')).moves({ verbose: true }).forEach(m => { if (m.piece !== 'p' || m.captured) set.add(m.to); }); } catch { /* illegal flip */ }
  const them = p[1], dir = them === 'w' ? 1 : -1, b = chess.board();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const q = b[r][c];
    if (q && q.type === 'p' && q.color === them) for (const dc of [-1, 1]) {
      const f = c + dc, rank = 8 - r + dir;
      if (f >= 0 && f < 8 && rank >= 1 && rank <= 8) set.add(String.fromCharCode(97 + f) + rank);
    }
  }
  return set;
}

// Feature vector for each legal move in a position
function moveFeatures(chess, lastMove, myLastMove) {
  const moves = chess.moves({ verbose: true });
  const att = enemyAttacks(chess);
  const enemyK = kingSq(chess, chess.turn() === 'w' ? 'b' : 'w');
  const fwd = chess.turn() === 'w' ? 1 : -1;
  return moves.map(m => {
    const f = new Float32Array(NF);
    const from = sqXYf(m.from), to = sqXYf(m.to);
    const castle = m.flags.includes('k') || m.flags.includes('q');
    const dRank = (to[1] - from[1]) * fwd;
    f[0] = m.captured ? 1 : 0;
    f[1] = m.captured ? PIECE_VAL[m.captured] / 9 : 0;
    f[2] = /[+#]/.test(m.san) ? 1 : 0;
    f[3] = lastMove && lastMove.captured && m.captured && m.to === lastMove.to ? 1 : 0;
    f[4] = m.captured && m.piece !== 'p' && m.piece !== 'k' && PIECE_VAL[m.piece] === PIECE_VAL[m.captured] ? 1 : 0;
    f[5] = m.piece === 'n' ? 1 : 0; f[6] = m.piece === 'b' ? 1 : 0; f[7] = m.piece === 'r' ? 1 : 0;
    f[8] = m.piece === 'q' ? 1 : 0; f[9] = m.piece === 'k' && !castle ? 1 : 0; f[10] = castle ? 1 : 0;
    f[11] = m.promotion ? 1 : 0;
    f[12] = castle ? 0 : Math.max(0, dRank) / 7;
    f[13] = castle ? 0 : Math.max(0, -dRank) / 7;
    f[14] = (cheb(from, enemyK) - cheb(to, enemyK)) / 7;
    f[15] = att.has(m.from) ? 1 : 0;
    f[16] = att.has(m.to) ? 1 : 0;
    f[17] = myLastMove && m.from === myLastMove.to ? 1 : 0;
    return { uci: m.from + m.to + (m.promotion || ''), san: m.san, f };
  });
}

function phaseOf(chess, ply) { return nonPawnMaterial(chess) <= 26 ? 2 : ply < 20 ? 0 : 1; }

// One decision = every legal move as an alternative, with its parameter-space feature vector
function buildDecision(chess, ply, cands, ctx) {
  const sign = chess.turn() === 'w' ? 1 : -1;
  const phase = phaseOf(chess, ply);
  const wps = new Map(cands.map(([uci, cp, mate]) => [uci, winPct(clamp(evalToCp({ cp, mate }) * sign, -1500, 1500))]));
  const best = Math.max(...wps.values());
  const alts = moveFeatures(chess, ctx.lastMove, ctx.myLastMove);
  const X = new Float32Array(alts.length * P_DIM);
  alts.forEach((a, i) => {
    const o = i * P_DIM;
    if (wps.has(a.uci)) {
      a.loss = best - wps.get(a.uci);
      a.wp = wps.get(a.uci);
      X[o + P_BETA + phase] = -a.loss / 10;
      if (ctx.tt) X[o + P_TT] = -a.loss / 10;
      for (let k = 0; k < NF; k++) X[o + P_W + k] = a.f[k];
    } else {
      a.loss = null;
      X[o + P_B + phase] = 1;
      for (let k = 0; k < NF; k++) X[o + P_V + k] = a.f[k];
    }
  });
  return { alts, X, n: alts.length, phase };
}

function decisionProbs(dec, theta) {
  const s = new Float64Array(dec.n);
  let mx = -Infinity;
  for (let i = 0; i < dec.n; i++) {
    let v = 0; const o = i * P_DIM;
    for (let k = 0; k < P_DIM; k++) v += dec.X[o + k] * theta[k];
    s[i] = v; if (v > mx) mx = v;
  }
  let z = 0;
  for (let i = 0; i < dec.n; i++) { s[i] = Math.exp(s[i] - mx); z += s[i]; }
  for (let i = 0; i < dec.n; i++) s[i] /= z;
  return s;
}

function initTheta() {
  const t = new Float64Array(P_DIM);
  t[P_BETA] = t[P_BETA + 1] = t[P_BETA + 2] = 1; // ~ each 10 win-% points lost is e times less likely
  t[P_B] = t[P_B + 1] = t[P_B + 2] = -3;
  return t;
}

// Maximum-likelihood fit with Adam and light L2 regularization
async function fitBot(decs, { iters = 250, lr = 0.08, l2 = 0.002, theta = initTheta(), onProgress } = {}) {
  const m = new Float64Array(P_DIM), v = new Float64Array(P_DIM), g = new Float64Array(P_DIM);
  const b1 = 0.9, b2 = 0.999;
  for (let it = 1; it <= iters; it++) {
    g.fill(0);
    for (const d of decs) {
      const p = decisionProbs(d, theta);
      const o = d.played * P_DIM;
      for (let k = 0; k < P_DIM; k++) g[k] += d.X[o + k];
      for (let i = 0; i < d.n; i++) { const oi = i * P_DIM, pi = p[i]; if (pi < 1e-7) continue; for (let k = 0; k < P_DIM; k++) g[k] -= pi * d.X[oi + k]; }
    }
    for (let k = 0; k < P_DIM; k++) {
      const gk = g[k] / decs.length - ((k >= P_B && k < P_B + 3) ? 0 : l2 * theta[k]); // ridge, except the "other move" constants
      m[k] = b1 * m[k] + (1 - b1) * gk; v[k] = b2 * v[k] + (1 - b2) * gk * gk;
      theta[k] += lr * (m[k] / (1 - b1 ** it)) / (Math.sqrt(v[k] / (1 - b2 ** it)) + 1e-8);
    }
    if (it % 10 === 0) { onProgress?.(it / iters); await nextFrame(); }
  }
  return theta;
}

// ---------- training data ----------
const botCacheKey = (g, color) => `cl:bot:v1:${BOT_DEPTH}m${BOT_K}:${g.id}:${color}`;

// Engine candidates for each of the player's moves in one game (cached)
async function analyzeForBot(g, engine, shouldAbort) {
  const key = botCacheKey(g, g.color);
  const cached = store.get(key);
  if (cached) return cached;
  const chess = new Chess();
  const out = [];
  const myTurn = g.color[0];
  for (let i = 0; i < g.sans.length && i < 120; i++) {
    if (chess.turn() === myTurn && i >= 4) {
      if (shouldAbort?.()) return null;
      const r = await engine.analyse(chess.fen(), BOT_DEPTH, 2000, BOT_K);
      out.push({ i, c: (r.lines || []).filter(l => l.best).map(l => [l.best, l.cp, l.mate]) });
    }
    if (!chess.move(g.sans[i], { sloppy: true })) break;
  }
  if (!store.set(key, out)) { // make room: drop older bot caches first
    Object.keys(localStorage).filter(k => k.startsWith('cl:bot:')).slice(0, 40).forEach(k => localStorage.removeItem(k));
    store.set(key, out);
  }
  return out;
}

// Turn a game + its engine candidates into decisions
function gameDecisions(g, rows) {
  const decs = [];
  const chess = new Chess();
  const byPly = new Map(rows.map(r => [r.i, r.c]));
  let last = null, myLast = null;
  for (let i = 0; i < g.sans.length; i++) {
    const c = byPly.get(i);
    if (c && c.length) {
      const key = chess.fen().split(' ').slice(0, 4).join(' ');
      let tt = false;
      if (g.base && g.clocks?.length) { const ck = i >= 2 ? g.clocks[i - 2] : g.base; tt = ck != null && ck / g.base < 0.15; }
      const d = buildDecision(chess, i, c, { lastMove: last, myLastMove: myLast, tt });
      const mv = chess.move(g.sans[i], { sloppy: true });
      if (!mv) break;
      d.played = d.alts.findIndex(a => a.uci === mv.from + mv.to + (mv.promotion || ''));
      d.bestUci = c[0][0]; d.ply = i; d.key = key; d.game = g;
      if (d.played >= 0) decs.push(d);
      myLast = mv; last = null;
      continue;
    }
    const mv = chess.move(g.sans[i], { sloppy: true });
    if (!mv) break;
    if (mv.color === g.color[0]) myLast = mv; else last = mv;
  }
  return decs;
}

const BOOK_MIN = 3;

function evaluateBot(testDecs, theta, trees) {
  let n = 0, botTop1 = 0, botTop3 = 0, sfTop1 = 0, modelTop1 = 0, book = 0, ll = 0;
  for (const d of testDecs) {
    n++;
    const p = decisionProbs(d, theta);
    const order = [...p.keys()].sort((a, b) => p[b] - p[a]);
    const playedUci = d.alts[d.played].uci;
    if (order[0] === d.played) modelTop1++;
    if (d.bestUci === playedUci) sfTop1++;
    ll += Math.log(Math.max(p[d.played], 1e-9));
    const node = trees[d.game.color].get(d.key);
    const ms = sortedMoves(node);
    if (ms.length && node.n >= BOOK_MIN) {
      book++;
      if (ms[0].san === d.alts[d.played].san) botTop1++;
      if (ms.slice(0, 3).some(m => m.san === d.alts[d.played].san)) botTop3++;
    } else {
      if (order[0] === d.played) botTop1++;
      if (order.slice(0, 3).includes(d.played)) botTop3++;
    }
  }
  return { n, botTop1: botTop1 / n, botTop3: botTop3 / n, sfTop1: sfTop1 / n, modelTop1: modelTop1 / n, bookShare: book / n, avgLogLik: ll / n };
}

// Full pipeline: load games → engine candidates → fit on 80% → test on 20% → refit on all
async function trainPlayerBot(src, { nGames = 40, tc = 'all', engine, onStatus, shouldAbort }) {
  const data = await loadSource(src, onStatus);
  const pool = data.games.filter(g => (tc === 'all' || g.timeClass === tc) && g.sans.length >= 16);
  if (pool.length < 5) throw new Error(`Only ${pool.length} usable games${tc !== 'all' ? ' at ' + tc : ''} — need at least 5.`);
  const games = pool.slice(0, nGames);
  const decsByGame = [];
  for (let gi = 0; gi < games.length; gi++) {
    onStatus?.(`Analyzing game ${gi + 1} of ${games.length} with Stockfish (top ${BOT_K} moves, depth ${BOT_DEPTH})…`, gi / games.length);
    const rows = await analyzeForBot(games[gi], engine, shouldAbort);
    if (!rows) throw new Error('Training stopped.');
    decsByGame.push(gameDecisions(games[gi], rows));
    await nextFrame();
  }
  // hold out every 5th game for testing (needs 10+ games)
  const isTest = i => games.length >= 10 && i % 5 === 4;
  const test = [], train = [];
  decsByGame.forEach((ds, i) => (isTest(i) ? test : train).push(...ds));
  if (train.length < 50) throw new Error('Not enough positions to learn from — try more games.');
  const testGames = new Set(games.filter((g, i) => isTest(i)));
  onStatus?.('Fitting the model on 80% of games…', 0.9);
  let theta = await fitBot(train, { onProgress: f => onStatus?.(`Fitting the model… ${Math.round(f * 100)}%`, 0.9 + f * 0.05) });
  let evaluation = null;
  if (test.length) {
    // the book for evaluation is every game except the held-out ones, as it would be when playing
    const bookGames = pool.filter(g => !testGames.has(g));
    const evalTrees = { white: buildTree(bookGames, 'white'), black: buildTree(bookGames, 'black') };
    evaluation = evaluateBot(test, theta, evalTrees);
  }
  onStatus?.('Refitting on all games…', 0.95);
  theta = await fitBot([...train, ...test], { iters: 120, theta });
  const all = [...train, ...test];
  // descriptive profile from the data itself
  const inTop = all.filter(d => d.alts[d.played].loss != null);
  const stats = {
    decisions: all.length, games: games.length,
    playedBest: all.filter(d => d.alts[d.played].uci === d.bestUci).length / all.length,
    outsideTop: 1 - inTop.length / all.length,
    avgLossByPhase: [0, 1, 2].map(ph => { const xs = inTop.filter(d => d.phase === ph); return xs.length ? mean(xs.map(d => d.alts[d.played].loss)) : null; }),
    nByPhase: [0, 1, 2].map(ph => all.filter(d => d.phase === ph).length),
  };
  return {
    label: data.label, src, tc, theta, stats, evaluation,
    trees: { white: buildTree(pool, 'white'), black: buildTree(pool, 'black') },
  };
}

// ---------- playing ----------
// Returns the bot's distribution over moves for this position: [{ san, uci, p, wp?, source }]
async function botDistribution(model, chess, ply, ctx, engine) {
  const color = chess.turn() === 'w' ? 'white' : 'black';
  const node = model.trees[color].get(chess.fen().split(' ').slice(0, 4).join(' '));
  const ms = sortedMoves(node);
  if (ms.length && node.n >= BOOK_MIN) {
    return { source: 'book', n: node.n, moves: ms.map(m => ({ san: m.san, p: m.n / node.n, games: m.n, score: nodeScore(m) })) };
  }
  const r = await engine.analyse(chess.fen(), BOT_DEPTH, 2000, BOT_K);
  const cands = (r.lines || []).filter(l => l.best).map(l => [l.best, l.cp, l.mate]);
  if (!cands.length) return { source: 'model', moves: [] };
  const d = buildDecision(chess, ply, cands, { lastMove: ctx.lastMove, myLastMove: ctx.myLastMove, tt: false });
  const p = decisionProbs(d, model.theta);
  const moves = d.alts.map((a, i) => ({ san: a.san, uci: a.uci, p: p[i], loss: a.loss, wp: a.wp })).sort((a, b) => b.p - a.p);
  return { source: 'model', moves, outside: moves.filter(m => m.loss == null).reduce((s, m) => s + m.p, 0) };
}

function chooseMove(dist, mode) {
  if (!dist.moves.length) return null;
  if (mode !== 'sample') return dist.moves[0];
  let r = Math.random();
  for (const m of dist.moves) { r -= m.p; if (r <= 0) return m; }
  return dist.moves[0];
}
