// Bot games: player bots (each: their own opening book + Maia-3 at their fitted strength) play each other.
// Used by the Bot arena for matches and tournaments (js/arena.js).
//
// Moves are sampled from each bot's plausible moves ("like them"), or its single most likely move, and go
// through the blunder check in js/bot.js (guardMove). All games run in lockstep and each step's Maia calls
// are batched. Each bot's Maia call assumes an equal-strength opponent: Maia learned from Lichess, where huge
// rating gaps barely exist, and its win estimate is dominated by the rating gap rather than the position.
// With equal ratings the estimate reflects the position. A bot resigns when that estimate stays under 5%
// for 3 of its moves and, after allowing for the rating gap, it's still under 5%.
const RESIGN_BELOW = 0.05, RESIGN_AFTER = 3;
const THROW_GUARD_RATING = 1800; // Lichess-scale; weaker bots keep their (realistic) stalemate habits
const MATCH_MAX_PLIES = 300;

function drawsGame(g, san) {
  if (!g.chess.move(san)) return false;
  const d = g.chess.in_stalemate() || g.chess.in_threefold_repetition();
  g.chess.undo();
  return d;
}

function sampleBy(items, weight) {
  let r = Math.random() * sum(items.map(weight));
  for (const it of items) { r -= weight(it); if (r <= 0) return it; }
  return items[0];
}

function newGame(i, white, black, meta = {}) {
  const c = new Chess();
  return { i, white, black, meta, chess: c, fens: [c.fen()], sans: [], result: null, reason: null, lowValue: { w: 0, b: 0 } };
}

function finishIfOver(g) {
  const c = g.chess;
  if (c.in_checkmate()) { g.result = c.turn() === 'w' ? '0-1' : '1-0'; g.reason = 'checkmate'; }
  else if (c.in_stalemate()) { g.result = '1/2-1/2'; g.reason = 'stalemate'; }
  else if (c.insufficient_material()) { g.result = '1/2-1/2'; g.reason = 'insufficient material'; }
  else if (c.in_threefold_repetition()) { g.result = '1/2-1/2'; g.reason = 'repetition'; }
  else if (c.in_draw()) { g.result = '1/2-1/2'; g.reason = '50-move rule'; }
  else if (g.sans.length >= MATCH_MAX_PLIES) { g.result = '1/2-1/2'; g.reason = 'move limit'; }
}

function playMatchMove(g, san) {
  g.chess.move(san);
  g.sans.push(san);
  g.fens.push(g.chess.fen());
  finishIfOver(g);
}

// Play every pairing ([{ white, black, meta }]) at once. Bots must share the same Maia pool.
async function playGames(pairs, maia, { onStep, onGameEnd, shouldAbort } = {}) {
  const games = pairs.map((p, i) => newGame(i, p.white, p.black, p.meta));
  const ended = new Set();
  while (games.some(g => !g.result)) {
    if (shouldAbort?.()) throw new Error('Stopped.');
    const need = [];
    for (const g of games) {
      if (g.result) continue;
      const turn = g.chess.turn(), bot = turn === 'w' ? g.white : g.black, opp = turn === 'w' ? g.black : g.white;
      const fen = g.fens.at(-1);
      const node = bot.trees[turn === 'w' ? 'white' : 'black'].get(fen.split(' ').slice(0, 4).join(' '));
      const book = sortedMoves(node);
      if (book.length && node.n >= BOOK_MIN) { playMatchMove(g, (bot.mode === 'likely' ? book[0] : sampleBy(book, m => m.n)).san); continue; }
      need.push({ g, turn, bot, opp, item: { fens: g.fens.slice(-8), eloSelf: bot.playRating, eloOppo: bot.playRating } });
    }
    if (need.length) {
      const preds = await maia.predict(need.map(x => x.item), { shouldAbort });
      const engines = getEnginePool();
      await Promise.all(need.map(async ({ g, turn, bot, opp }, j) => {
        const pred = preds[j];
        // resign when the position is hopeless (Maia's equal-strength estimate) AND the bot isn't so much
        // stronger that it's still favored — a GM down a queen against a beginner plays on
        const lg = Math.log(pred.value / (1 - pred.value)) + (bot.playRating - opp.playRating) * Math.LN10 / 400;
        const withGap = 1 / (1 + Math.exp(-lg));
        g.lowValue[turn] = pred.value < RESIGN_BELOW && withGap < RESIGN_BELOW ? g.lowValue[turn] + 1 : 0;
        if (g.lowValue[turn] >= RESIGN_AFTER) { g.result = turn === 'w' ? '0-1' : '1-0'; g.reason = 'resignation'; return; }
        const fen = g.fens.at(-1), engine = engines[j % engines.length];
        let mv, pool;
        if (bot.fidelity) ({ move: mv, ranked: pool } = await fidChoose(bot, pred.moves, fen, engine, bot.mode === 'likely' ? 'likely' : 'sample'));
        else {
          pool = humanPool(pred.moves, fen);
          mv = await guardMove(bot, fen, bot.mode === 'likely' ? pred.moves[0] : humanSample(pred.moves, fen), pool, engine);
        }
        // strong players don't throw a won game into a draw: no stalemate or threefold repetition while clearly winning
        if (bot.playRating >= THROW_GUARD_RATING && pred.value >= 0.85 && drawsGame(g, mv.san)) {
          const alt = [...pool, ...pred.moves].find(m => !drawsGame(g, m.san));
          if (alt) mv = alt;
        }
        playMatchMove(g, mv.san);
      }));
    }
    for (const g of games) if (g.result && !ended.has(g)) { ended.add(g); onGameEnd?.(g); }
    onStep?.(games);
    await nextFrame();
  }
  return games;
}

// n games between A and B, colors alternating (A has White first)
function playMatch(A, B, maia, n, opts) {
  return playGames(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? { white: A, black: B } : { white: B, black: A })), maia, opts);
}

// Score for bot A in one game
const scoreForA = (g, A) => g.result === '1/2-1/2' ? 0.5 : ((g.result === '1-0') === (g.white === A) ? 1 : 0);

function matchSummary(games, A, B) {
  const done = games.filter(g => g.result);
  const s = done.map(g => scoreForA(g, A));
  const n = s.length, score = n ? mean(s) : null;
  const se = n > 1 ? Math.sqrt(s.reduce((v, x) => v + (x - score) ** 2, 0) / (n - 1) / n) : null;
  const asWhite = done.filter(g => g.white === A), asBlack = done.filter(g => g.white !== A);
  const tally = gs => ({ n: gs.length, w: gs.filter(g => scoreForA(g, A) === 1).length, d: gs.filter(g => scoreForA(g, A) === 0.5).length, l: gs.filter(g => scoreForA(g, A) === 0).length });
  const reasons = {};
  done.forEach(g => reasons[g.reason] = (reasons[g.reason] || 0) + 1);
  return {
    n, score, ci: se != null ? [Math.max(0, score - 1.96 * se), Math.min(1, score + 1.96 * se)] : null,
    all: tally(done), asWhite: tally(asWhite), asBlack: tally(asBlack), reasons,
    avgMoves: n ? mean(done.map(g => Math.ceil(g.sans.length / 2))) : null,
    expected: eloExpected(A.playRating - B.playRating),
  };
}

// A bot game as a game record the Review tab can open
function matchGameRecord(g) {
  const res = g.result === '1-0' ? 'win' : g.result === '0-1' ? 'loss' : g.result ? 'draw' : null;
  return {
    id: g.recordId ||= `match:${g.white.label}:${g.black.label}:${Date.now()}:${g.i}`, sans: [...g.sans], clocks: [], base: null, color: 'white',
    me: { name: `${g.white.label} bot`, rating: g.white.playRating }, opp: { name: `${g.black.label} bot`, rating: g.black.playRating },
    result: res, reason: null, opening: g.opening || '', eco: '', url: null, end: new Date(), timeClass: 'bot game',
  };
}

async function labelOpenings(games) {
  const book = await getBook();
  if (!book) return;
  for (const g of games) {
    if (g.opening !== undefined) continue;
    let name = null;
    for (const f of g.fens.slice(1, 25)) { const hit = bookHit(book, f); if (hit) name = hit; }
    g.opening = name ? name.name : '';
    g.family = name ? name.name.split(':')[0] : 'Unknown';
  }
}
