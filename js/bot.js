// Player bot: plays the move a specific player would most likely make.
//
// Book: if the player reached the position in BOOK_MIN+ of their own games, it follows their choices there.
// Otherwise Maia-3 (js/maia.js): a neural net trained on Lichess games that predicts the move a human of a
// given rating plays, from the last 8 positions. It's personalised with one number: a rating offset fitted
// to the player's own games. Every 5th game is held out to report how often the bot predicts the player's
// real move, next to "always play Stockfish's top move". (The previous hand-built model is js/bot-legacy.js.)

const BOOK_MIN = 3;
const BOT_RATING_CAP = 2850;      // Maia gets worse above ~3000 (Lichess scale): little training data up there
const BOT_FIT_POSITIONS = 400;    // training positions used to fit the rating offset
const BOT_SF_DEPTH = 10;          // Stockfish baseline, as before

// A rating on Maia's (Lichess) scale
function toLichessScale(r, kind) {
  if (!r || isNaN(r)) return null;
  if (kind === 'lichess') return r;
  if (kind === 'otb') return r + 250; // FIDE runs below Lichess; the fitted offset corrects the rest
  return chesscomToLichess(r);
}
const capRating = r => clamp(Math.round(r), 400, BOT_RATING_CAP);

// Several Maia workers sharing one batch (single-threaded WASM), or one on the GPU
class BotMaiaPool {
  constructor(size, ep) {
    const n = ep === 'webgpu' ? 1 : Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    this.size = size;
    // start one worker first so the runtime and model download once; extra workers are a bonus
    this.ms = [new Maia(size, { ep })];
    this.ready = this.ms[0].ready.then(async () => {
      const rest = Array.from({ length: n - 1 }, () => new Maia(size, { ep }));
      const ok = await Promise.allSettled(rest.map(m => m.ready));
      rest.forEach((m, i) => { if (ok[i].status === 'fulfilled') this.ms.push(m); else m.terminate(); });
      return this;
    });
  }
  get backend() { return this.ms[0].ep; }
  async predict(items, { onProgress, shouldAbort } = {}) {
    const chunks = [];
    for (let i = 0; i < items.length; i += 32) chunks.push(items.slice(i, i + 32));
    const out = new Array(chunks.length);
    let next = 0, done = 0;
    await Promise.all(this.ms.map(async m => {
      while (next < chunks.length) {
        if (shouldAbort?.()) throw new Error('Training stopped.');
        const ci = next++;
        out[ci] = await m.predict(chunks[ci]);
        done += chunks[ci].length;
        onProgress?.(done / items.length);
      }
    }));
    return out.flat();
  }
  terminate() { this.ms.forEach(m => m.terminate()); }
}

async function openMaia(size) {
  const ep = navigator.gpu ? 'webgpu' : 'wasm';
  const pool = new BotMaiaPool(size, ep);
  try { return await pool.ready; } catch (e) {
    pool.terminate();
    if (ep === 'wasm') throw e;
    return new BotMaiaPool(size, 'wasm').ready; // GPU present but unusable: fall back to the CPU
  }
}

// The player's moves in one game, with what Maia needs to predict them
function botDecisions(g, kind) {
  const chess = new Chess();
  const fens = [chess.fen()];
  const out = [];
  const myTurn = g.color[0];
  for (let i = 0; i < g.sans.length && i < 120; i++) {
    const phase = nonPawnMaterial(chess) <= 26 ? 'endgame' : i < 20 ? 'opening' : 'middlegame';
    const mine = chess.turn() === myTurn && i >= 4;
    const mv = chess.move(g.sans[i], { sloppy: true });
    if (!mv) break;
    // time trouble: under 10% of the starting clock (at least 10 s) before this move
    const clk = i >= 2 ? g.clocks?.[i - 2] : g.base;
    const tp = !!(g.base && clk != null && clk < Math.max(10, 0.1 * g.base));
    if (mine) out.push({
      game: g, ply: i, phase, tp, fens: fens.slice(Math.max(0, i - 7), i + 1),
      key: fens[i].split(' ').slice(0, 4).join(' '), played: mv.from + mv.to + (mv.promotion || ''), san: mv.san,
      self: toLichessScale(g.me.rating, kind), oppo: toLichessScale(g.opp.rating, kind),
    });
    fens.push(chess.fen());
  }
  return out;
}

const botItems = (decs, shift) => decs.map(d => ({ fens: d.fens, eloSelf: capRating(d.self + shift), eloOppo: capRating(d.oppo + shift) }));
const playedLogLik = (pred, d) => Math.log(Math.max(pred.moves.find(m => m.uci === d.played)?.p ?? 0, 1e-9));

// One rating offset that best explains the player's own (training) moves: coarse grid, then refine
async function fitRatingShift(pool, decs, { onProgress, shouldAbort }) {
  const step = Math.max(1, Math.floor(decs.length / BOT_FIT_POSITIONS));
  const sample = decs.filter((d, i) => i % step === 0).slice(0, BOT_FIT_POSITIONS);
  const tried = new Map();
  const score = async shift => {
    if (!tried.has(shift)) {
      const preds = await pool.predict(botItems(sample, shift), { shouldAbort });
      tried.set(shift, mean(preds.map((p, i) => playedLogLik(p, sample[i]))));
      onProgress?.(tried.size / 6);
    }
    return tried.get(shift);
  };
  for (const s of [-600, -300, 0, 300]) await score(s);
  const best = [...tried].sort((a, b) => b[1] - a[1])[0][0];
  for (const s of [best - 150, best + 150]) await score(s);
  return [...tried].sort((a, b) => b[1] - a[1])[0][0];
}

// Stockfish's top move at each held-out position, for the baseline (cached; reuses older bot analysis)
async function stockfishBest(g, decs, engine, shouldAbort) {
  const key = `cl:sfb:v1:d${BOT_SF_DEPTH}:${g.id}:${g.color}`;
  const hit = store.get(key) || {};
  const old = store.get(`cl:bot:v1:10m8:${g.id}:${g.color}`);
  if (old) for (const r of old) if (r.c?.[0] && !hit[r.i]) hit[r.i] = r.c[0][0];
  for (const d of decs) {
    if (hit[d.ply]) continue;
    if (shouldAbort?.()) throw new Error('Training stopped.');
    hit[d.ply] = (await engine.analyse(d.fens.at(-1), BOT_SF_DEPTH, 2000, 1)).best;
  }
  store.set(key, hit);
  return hit;
}

// Load games → fit the rating offset on 80% → test on the other 20% → ready to play
async function trainPlayerBot(src, { nGames = 80, tc = 'all', size = '5m', evaluate = true, fidelity: wantFid = false, maia: shared = null, onStatus, shouldAbort }) {
  const kind = src.kind;
  const data = await loadSource(src, m => onStatus?.(m, 0.02));
  const pool = data.games.filter(g => (tc === 'all' || g.timeClass === tc) && g.sans.length >= 16);
  if (pool.length < 5) throw new Error(`Only ${pool.length} usable games${tc !== 'all' ? ' at ' + tc : ''} — need at least 5.`);
  const games = pool.slice(0, nGames);
  const isTest = i => evaluate && games.length >= 10 && i % 5 === 4;
  const testGames = new Set(games.filter((g, i) => isTest(i)));
  const decsByGame = games.map(g => botDecisions(g, kind));
  // fill missing ratings (old OTB games) with the player's typical rating
  const all = decsByGame.flat();
  const typical = median(all.map(d => d.self).filter(Boolean)) ?? (src.elo ? toLichessScale(src.elo, kind) : 1500);
  all.forEach(d => { d.self ??= typical; d.oppo ??= d.self; });
  const train = [], test = [];
  decsByGame.forEach((ds, i) => (isTest(i) ? test : train).push(...ds));
  if (train.length < 30) throw new Error('Not enough positions to learn from — try more games.');

  if (!shared) onStatus?.(`Loading Maia-3 ${size.toUpperCase()}…`, 0.08);
  const maia = shared || await openMaia(size);
  try {
    onStatus?.(`Fitting ${esc(data.label)}'s playing strength on their own moves…`, 0.12);
    const shift = await fitRatingShift(maia, train, { shouldAbort, onProgress: f => onStatus?.(`Fitting ${esc(data.label)}'s playing strength on their own moves… ${Math.round(f * 100)}%`, 0.12 + f * 0.45) });

    let evaluation = null;
    if (test.length) {
      onStatus?.(`Testing on ${test.length} moves from ${testGames.size} games it hasn't seen…`, 0.6);
      const preds = await maia.predict(botItems(test, shift), { shouldAbort, onProgress: f => onStatus?.(`Testing on ${test.length} held-out moves… ${Math.round(f * 100)}%`, 0.6 + f * 0.2) });
      const bookGames = pool.filter(g => !testGames.has(g));
      const trees = { white: buildTree(bookGames, 'white'), black: buildTree(bookGames, 'black') };
      // Stockfish baseline on the same positions
      const engines = [new Engine(), new Engine()];
      const sf = new Map();
      const tg = [...testGames];
      let next = 0, done = 0;
      try {
        await Promise.all(engines.map(async e => {
          while (next < tg.length) {
            const g = tg[next++];
            sf.set(g, await stockfishBest(g, test.filter(d => d.game === g), e, shouldAbort));
            onStatus?.(`Stockfish baseline: game ${++done} of ${tg.length}…`, 0.8 + 0.18 * done / tg.length);
          }
        }));
      } finally { engines.forEach(e => e.terminate()); }
      evaluation = scoreBot(test, preds, trees, sf);
    }
    const playRating = capRating(typical + shift);
    let fidelity = null, blunderTarget = null;
    if (wantFid?.w) fidelity = wantFid;                    // precomputed weights (the legends)
    else if (wantFid) {
      fidelity = await fitPlayerFidelity({ maia, shift, games, testGames, train, test, label: data.label, depth: wantFid === true ? FID_DEPTH : wantFid.depth, onStatus, shouldAbort });
    } else {
      onStatus?.('Measuring how often they blunder…', 0.97);
      blunderTarget = await realBlunderRate(games, { shouldAbort, onStatus: m => onStatus?.(m, 0.97) }).catch(() => null);
    }
    return {
      label: data.label, src, kind, tc, gamesTc: data.tc || 'all', size: maia.size, backend: maia.backend, maia, shift, typical: Math.round(typical), playRating, evaluation, blunderTarget, fidelity,
      stats: { games: games.length, decisions: all.length, train: train.length, test: test.length, poolGames: pool.length },
      trees: { white: buildTree(pool, 'white'), black: buildTree(pool, 'black') },
      games: pool,
    };
  } catch (e) { if (!shared) maia.terminate(); throw e; }
}

// High fidelity (js/fidelity.js): fit the move-quality calibration on the positions where the bot really uses
// Maia (out of its book), and check it on the held-out games if there are any
async function fitPlayerFidelity({ maia, shift, games, testGames, train, test, label, depth = FID_DEPTH, onStatus, shouldAbort }) {
  const trainGames = games.filter(g => !testGames.has(g));
  const tb = { white: buildTree(trainGames, 'white'), black: buildTree(trainGames, 'black') };
  const offBook = ds => ds.filter(d => { const n = tb[d.game.color].get(d.key); return !(n && n.n >= BOOK_MIN && sortedMoves(n).length); });
  const fTrain = offBook(train), fTest = offBook(test);
  const all = [...fTrain, ...fTest];
  const st = (m, f) => onStatus?.(m, 0.6 + 0.38 * f);
  st(`High fidelity: Maia's candidate moves in ${all.length} positions…`, 0);
  const preds = await maia.predict(botItems(all, shift), { shouldAbort });
  const rows = await fidRowsFor(all, preds, { depth, shouldAbort, onProgress: f => st(`High fidelity: Stockfish is scoring the candidate moves in ${esc(label)}'s positions… ${Math.round(f * 100)}%`, 0.05 + 0.9 * f) });
  const trainRows = rows.slice(0, fTrain.length), testRows = rows.slice(fTrain.length);
  st('High fidelity: fitting how accurately they really play…', 0.97);
  const fit = fitFidelity(trainRows);
  return { depth, w: fit.w, n: fit.n, report: fidReport(testRows.length >= 50 ? testRows : trainRows, fit.w), inSample: testRows.length < 50, trainReport: fidReport(trainRows, fit.w) };
}

function scoreBot(test, preds, trees, sf) {
  const phases = ['opening', 'middlegame', 'endgame'];
  const acc = () => ({ n: 0, bot: 0, sf: 0 });
  const byPhase = Object.fromEntries(phases.map(p => [p, acc()]));
  let n = 0, botTop1 = 0, botTop3 = 0, maiaTop1 = 0, sfTop1 = 0, book = 0, bookHits = 0, ll = 0;
  test.forEach((d, j) => {
    const ms = preds[j].moves;
    const rank = ms.findIndex(m => m.uci === d.played);
    ll += Math.log(Math.max(rank >= 0 ? ms[rank].p : 0, 1e-9));
    if (rank === 0) maiaTop1++;
    const node = trees[d.game.color].get(d.key);
    const bm = sortedMoves(node);
    let t1, t3;
    if (bm.length && node.n >= BOOK_MIN) { book++; t1 = bm[0].san === d.san; t3 = bm.slice(0, 3).some(m => m.san === d.san); bookHits += t1; }
    else { t1 = rank === 0; t3 = rank >= 0 && rank < 3; }
    const sfHit = sf.get(d.game)?.[d.ply] === d.played;
    n++; botTop1 += t1; botTop3 += t3; sfTop1 += sfHit;
    const ph = byPhase[d.phase]; ph.n++; ph.bot += t1; ph.sf += sfHit;
  });
  for (const p of phases) { const x = byPhase[p]; x.bot = x.n ? x.bot / x.n : null; x.sf = x.n ? x.sf / x.n : null; }
  return { n, botTop1: botTop1 / n, botTop3: botTop3 / n, maiaTop1: maiaTop1 / n, sfTop1: sfTop1 / n, bookShare: book / n, bookN: book, bookHits, avgLogLik: ll / n, byPhase };
}

// ---------- playing ----------
// The bot's distribution over moves, given the positions so far (oldest first, current last)
async function botDistribution(model, fens) {
  const fen = fens.at(-1);
  const color = fen.split(' ')[1] === 'w' ? 'white' : 'black';
  const node = model.trees[color].get(fen.split(' ').slice(0, 4).join(' '));
  const bm = sortedMoves(node);
  if (bm.length && node.n >= BOOK_MIN) {
    return { source: 'book', n: node.n, moves: bm.map(m => ({ san: m.san, p: m.n / node.n, games: m.n, score: nodeScore(m) })) };
  }
  const [pred] = await model.maia.ms[0].predict([{ fens: fens.slice(-8), eloSelf: model.playRating, eloOppo: model.playRating }]);
  return { source: 'maia', moves: pred.moves.map(m => ({ san: m.san, uci: m.uci, p: m.p })), value: pred.value };
}

// Sample like a human, but only among plausible moves: the smallest set covering 90% of Maia's probability,
// each with at least 2%, and never a stalemating move unless it's Maia's own top choice. Sampling the full
// tail lets 1-in-100 blunders (or a stalemate with mate on the board) slip in over a long game.
const SAMPLE_TOP_P = 0.9, SAMPLE_MIN_P = 0.02;
function humanPool(moves, fen) {
  const pool = [];
  let cum = 0;
  for (const m of moves) {
    if (pool.length && (cum >= SAMPLE_TOP_P || m.p < SAMPLE_MIN_P)) break;
    pool.push(m); cum += m.p;
  }
  const c = new Chess(fen);
  return pool.filter((m, i) => {
    if (i === 0) return true;
    c.move(m.san); const stale = c.in_stalemate(); c.undo();
    return !stale;
  });
}
function humanSample(moves, fen) {
  if (!moves.length) return null;
  const safe = humanPool(moves, fen);
  let r = Math.random() * sum(safe.map(m => m.p));
  for (const m of safe) { r -= m.p; if (r <= 0) return m; }
  return safe[0];
}

// ---------- blunder check ----------
// Maia picks moves by pattern without calculating, so at master level it sometimes plays a natural-looking
// move that loses to a simple tactic (a Hikaru bot hanging its queen) — far more often than strong humans do.
// So every Maia move gets a quick Stockfish check. A move that gives up 40+ win-% points (roughly a piece or
// worse) is kept only often enough that the bot makes such blunders at the player's real rate, measured on
// their own games in the same time control; otherwise the bot re-picks among its other plausible moves.
// The keep chance adapts to how often Maia tries to blunder. (Smaller slips are left to Maia: measured
// against real games, bots make them no more often than the players do.)
const BLUNDER_LOSS = 40, GUARD_DEPTH = 8;

async function realBlunderRate(games, { onStatus, shouldAbort } = {}) {
  const sample = games.filter(g => g.sans.length >= 20).slice(0, 30);
  let n = 0, bl = 0;
  await analyzeGamesParallel(sample, GUARD_DEPTH, {
    shouldAbort,
    onProgress: (f, d) => onStatus?.(`Measuring how often they blunder: ${d} of ${sample.length} games…`),
    onResult: (g, a) => {
      const ms = a.moves.filter(m => m.color === g.color[0] && m.cls !== 'book' && m.cls !== 'forced');
      n += ms.length; bl += ms.filter(m => m.loss >= BLUNDER_LOSS).length;
    },
  });
  return n >= 100 ? bl / n : null;
}

async function guardMove(bot, fen, pick, pool, engine) {
  const g = bot.guard ||= { moves: 0, flagged: 0, kept: 0 };
  if (bot.blunderTarget == null || !pick?.uci) return pick;
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  const wp = r => winPct(clamp(evalToCp(r) * sign, -1500, 1500));
  const best = await engine.analyse(fen, GUARD_DEPTH, 1500, 1);
  const wpBest = wp(best);
  const lossOf = async m => m.uci === best.best ? 0 : wpBest - wp(await engine.analyse(fen, GUARD_DEPTH, 1500, 1, m.uci));
  const lim = bot.guardLoss ?? BLUNDER_LOSS;   // the Play page's rating bots guard 20+ point blunders (the ladder's measure)
  g.moves++;
  if (await lossOf(pick) < lim) return pick;
  g.flagged++;
  const tryRate = (g.flagged + 0.5) / (g.moves + 10); // how often Maia tries to blunder, smoothed
  if (Math.random() < Math.min(1, bot.blunderTarget / tryRate)) { g.kept++; return pick; }
  for (const m of pool.filter(m => m !== pick).sort((a, b) => b.p - a.p)) if (await lossOf(m) < lim) return m;
  const mv = best.best && uciMove(fen, best.best);
  return mv ? { san: mv.san, uci: best.best, p: 0 } : pick;
}

// The bot's move for a distribution: book moves as-is, Maia moves through the blunder check
async function botPick(bot, dist, mode, fen, engine) {
  if (dist.source !== 'maia' || !dist.moves.length) return chooseMove(dist, mode, fen);
  if (bot.fidelity) return (await fidChoose(bot, dist.moves, fen, engine, mode === 'sample' ? 'sample' : 'likely')).move;
  const pool = humanPool(dist.moves, fen);
  const pick = mode === 'sample' ? humanSample(dist.moves, fen) : dist.moves[0];
  return guardMove(bot, fen, pick, pool, engine);
}

function chooseMove(dist, mode, fen) {
  if (!dist.moves.length) return null;
  if (mode !== 'sample') return dist.moves[0];
  if (dist.source === 'maia' && fen) return humanSample(dist.moves, fen);
  let r = Math.random();
  for (const m of dist.moves) { r -= m.p; if (r <= 0) return m; }
  return dist.moves[0];
}
