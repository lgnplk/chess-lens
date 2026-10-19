// Engine-backed analysis of a single game: evals, move classification, accuracy, phases, explanations

const CLS = {
  brilliant:  { label: 'Brilliant',  sym: '!!' },
  great:      { label: 'Great',      sym: '!' },
  best:       { label: 'Best',       sym: '★' },
  excellent:  { label: 'Excellent',  sym: '✓' },
  good:       { label: 'Good',       sym: '·' },
  book:       { label: 'Book',       sym: '≡' },
  forced:     { label: 'Forced',     sym: '→' },
  inaccuracy: { label: 'Inaccuracy', sym: '?!' },
  mistake:    { label: 'Mistake',    sym: '?' },
  miss:       { label: 'Miss',       sym: '✗' },
  blunder:    { label: 'Blunder',    sym: '??' },
};
const CLS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const ERROR_CLS = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);
const posKey = fen => fen.split(' ').slice(0, 4).join(' ');

// ---------- Opening book (lichess chess-openings, precomputed by tools/build-book.js) ----------
let _book = null;
function getBook() {
  if (!_book) _book = fetch(typeof document === 'undefined' ? 'book.json' : 'js/book.json').then(r => r.json())
    .then(o => new Map(Object.entries(o).map(([k, [eco, name]]) => [k, { eco, name }])))
    .catch(() => null);
  return _book;
}

// Replay SANs, returning fens and verbose moves
function replay(sans) {
  const chess = new Chess();
  const fens = [chess.fen()], moves = [], phases = [], legal = [];
  for (const san of sans) {
    const npm = nonPawnMaterial(chess);
    const ply = moves.length;
    phases.push(npm <= 26 ? 'endgame' : ply < 20 ? 'opening' : 'middlegame');
    legal.push(chess.moves().length);
    const mv = chess.move(san, { sloppy: true });
    if (!mv) break;
    moves.push(mv);
    fens.push(chess.fen());
  }
  const end = { mate: chess.in_checkmate(), draw: chess.in_draw() || chess.in_stalemate() };
  return { fens, moves, phases, legal, end };
}

// v2: evals carry top-3 candidates and the engine's stable depth
try { Object.keys(localStorage).filter(k => k.startsWith('cl:ev:') && !k.startsWith('cl:ev:v2:')).forEach(k => localStorage.removeItem(k)); } catch {}
function cacheKey(id, depth, multipv, tag = '') { return `cl:ev:v2:${tag}${depth}${multipv > 1 ? 'm' + multipv : ''}:${id}`; }

// Engine evaluations live in IndexedDB (hundreds of MB) rather than localStorage (~5 MB, about 150 games).
// Older localStorage entries are moved across the first time they're read.
const evalDB = (() => {
  let dbp = null;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('chess-lens', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('evals');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(() => null);
  const tx = async (mode, fn) => {
    const db = await open();
    if (!db) return undefined;
    return new Promise(res => {
      try {
        const t = db.transaction('evals', mode), req = fn(t.objectStore('evals'));
        t.oncomplete = () => res(mode === 'readonly' ? req.result : true);
        t.onerror = t.onabort = () => res(undefined);
      } catch { res(undefined); }
    });
  };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)) };
})();

async function evalCacheGet(key) {
  const v = await evalDB.get(key);
  if (v) return v;
  const old = store.get(key);
  if (old && await evalDB.set(key, old)) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  return old;
}
async function evalCacheSet(key, evals) {
  if (await evalDB.set(key, evals)) return;
  if (!store.set(key, evals)) { pruneEvalCache(); store.set(key, evals); } // no IndexedDB: fall back
}

// Positions of a game, without the legal-move counts replay() also collects
function replayFens(sans) {
  const c = new Chess(), fens = [c.fen()];
  for (const san of sans) { if (!c.move(san, { sloppy: true })) break; fens.push(c.fen()); }
  return { fens, end: { mate: c.in_checkmate(), draw: c.in_draw() || c.in_stalemate() } };
}

// Stockfish evaluation of every position in a game (top `multipv` lines), from the cache when possible
async function gameEvals({ id, sans }, depth, onProgress, shouldAbort, { multipv = 3, engine = null } = {}) {
  const eng = engine || getEngine();
  const key = id ? cacheKey(id, depth, multipv, eng.tag) : null;
  const cached = key ? await evalCacheGet(key) : null;
  if (cached && cached.length === sans.length + 1) { onProgress?.(1, 1); return cached; }
  const { fens, end } = replayFens(sans);
  if (cached && cached.length === fens.length) { onProgress?.(1, 1); return cached; }
  await eng.newGame();
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    if (shouldAbort?.()) return null;
    const isLast = i === fens.length - 1;
    if (isLast && end.mate) {
      const whiteMated = fens[i].split(' ')[1] === 'w';
      evals.push({ cp: null, mate: whiteMated ? -0.5 : 0.5, best: null });
    } else if (isLast && end.draw) {
      evals.push({ cp: 0, mate: null, best: null });
    } else {
      const r = await eng.analyse(fens[i], depth, depth >= 16 ? 8000 : 4000, multipv);
      const ev = { cp: r.cp, mate: r.mate, best: r.best, pv: (r.pv || []).slice(0, 10), sd: r.sd };
      // top engine candidates: [uci, cp, mate] (white POV), used for only-move and style-opportunity detection
      if (r.lines && r.lines.length > 1) ev.cands = r.lines.map(l => [l.best, l.cp, l.mate]);
      evals.push(ev);
    }
    onProgress?.(i + 1, fens.length);
  }
  if (key) await evalCacheSet(key, evals);
  return evals;
}

async function analyzeGame(game, depth, onProgress, shouldAbort, opts = {}) {
  const bookP = getBook();
  const evals = await gameEvals(game, depth, onProgress, shouldAbort, opts);
  if (!evals) return null;
  const a = scoreMoves({ ...replay(game.sans), evals, clocks: game.clocks, base: game.base, book: await bookP });
  return verifyBrilliants(a, opts.engine || getEngine(), ply => a.fens[ply]);
}

// Per-game classification and style detection are chess.js-heavy (~0.25 s a game). In big scans they run in
// background workers (js/analysis-worker.js), so the page only feeds the Stockfish workers.
class AnalysisWorkers {
  constructor(n) {
    this.ws = Array.from({ length: n }, () => new Worker('js/analysis-worker.js'));
    this.jobs = new Map(); this.seq = 0;
    this.ws.forEach(w => {
      w.onmessage = e => {
        const j = this.jobs.get(e.data.id); if (!j) return;
        this.jobs.delete(e.data.id); j.w.load--;
        e.data.error ? j.reject(new Error(e.data.error)) : j.resolve(e.data.a);
      };
      w.load = 0;
    });
  }
  run(payload) {
    const w = this.ws.reduce((a, b) => (b.load < a.load ? b : a)); // least busy
    const id = ++this.seq;
    w.load++;
    return new Promise((resolve, reject) => { this.jobs.set(id, { resolve, reject, w }); w.postMessage({ id, ...payload }); });
  }
  terminate() { this.ws.forEach(w => w.terminate()); }
}

// Analyze many games: several Stockfish workers evaluate positions, analysis workers score each finished
// game. onResult(game, analysis) fires as each completes (analysis has no per-position FENs).
// verify: false skips the deeper brilliant-move check, and multipv: 1 the runner-up lines (bulk jobs that only
// need accuracy and blunders: 2.5× faster, same numbers)
async function analyzeGamesParallel(games, depth, { onResult, onProgress, shouldAbort, engines: pool, verify = true, multipv = 3 } = {}) {
  const engines = pool || getAnalysisPool();
  const procs = new AnalysisWorkers(Math.max(1, Math.min(4, Math.ceil(engines.length / 3))));
  const partial = new Map(), pending = [];
  let next = 0, done = 0;
  const tick = () => onProgress?.((done + sum([...partial.values()])) / Math.max(1, games.length), done, engines.length);
  try {
    await Promise.all(engines.map(async eng => {
      while (next < games.length && !shouldAbort?.()) {
        const g = games[next++];
        partial.set(g, 0);
        const evals = await gameEvals(g, depth, (d, n) => { partial.set(g, 0.95 * d / n); tick(); }, shouldAbort, { engine: eng, multipv });
        if (!evals) { partial.delete(g); return; }
        pending.push(procs.run({ sans: g.sans, clocks: g.clocks, base: g.base, evals })
          .then(a => (verify ? verifyBrilliants(a, eng, ply => a.candidateFens[ply]) : a)).then(
          a => { partial.delete(g); done++; onResult?.(g, a); tick(); },
          err => { partial.delete(g); console.warn('analysis failed for', g.id, err); },
        ));
      }
    }));
    await Promise.all(pending);
  } finally { procs.terminate(); }
  if (shouldAbort?.()) resetEnginePool();
}

function pruneEvalCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('cl:ev:'));
  keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => localStorage.removeItem(k));
}

// Was the piece on `sq` already lost where it stood (attacked by the opponent at a net loss)? Moving such a
// piece somewhere else en prise is a "desperado", not a sacrifice.
function pieceWasHanging(fen, sq) {
  const p = fen.split(' ');
  const piece = new Chess(fen).get(sq);
  if (!piece) return false;
  p[1] = p[1] === 'w' ? 'b' : 'w'; p[3] = '-';
  let c;
  try { c = new Chess(p.join(' ')); } catch { return false; }
  const caps = c.moves({ verbose: true }).filter(m => m.to === sq);
  for (const cap of caps) {
    c.move(cap);
    const recap = c.moves({ verbose: true }).some(m => m.to === sq);
    c.undo();
    if (PIECE_VAL[piece.type] - (recap ? PIECE_VAL[cap.piece] : 0) >= 2) return true;
  }
  return false;
}

// Second-stage check for brilliant candidates. The quick rule runs at scan depth; a deeper search (top 3
// lines, depth 14+) must agree the move is within 3 win-% points of the best and leaves the mover at least
// equal. Results are cached by position + move.
const BRILLIANT_DEPTH = 14;
async function confirmBrilliant(engine, fen, uci) {
  const key = `cl:br:v1:${engine.tag || ''}${BRILLIANT_DEPTH}:${fen}|${uci}`;
  const hit = await evalDB.get(key);
  if (hit !== undefined && hit !== null) return hit;
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  const wp = l => winPct(clamp(evalToCp(l) * sign, -1500, 1500));
  const r = await engine.analyse(fen, BRILLIANT_DEPTH, 8000, 3);
  const mine = (r.lines || []).find(l => l.best === uci);
  const ok = !!(mine && r.lines[0] && wp(r.lines[0]) - wp(mine) <= 3 && wp(mine) >= 50);
  await evalDB.set(key, ok);
  return ok;
}

// Apply the deep check to an analysis: unconfirmed candidates become best/excellent moves.
// fenOf(ply) returns the position before that move. Records how many were confirmed.
async function verifyBrilliants(a, engine, fenOf) {
  const cands = a.moves.filter(m => m.cls === 'brilliant');
  a.brilliantCheck = { candidates: cands.length, confirmed: 0 };
  for (const m of cands) {
    if (await confirmBrilliant(engine, fenOf(m.ply), m.uci)) { a.brilliantCheck.confirmed++; continue; }
    m.cls = m.best === m.uci ? 'best' : 'excellent';
    const s = a.summary[m.color]; s.counts.brilliant--; s.counts[m.cls]++;
    for (const recs of Object.values(a._style || {})) { const r = recs.find(x => x.ply === m.ply); if (r) r.brilliant = false; }
  }
  return a;
}

// Did this move put material en prise that the opponent can't simply be punished for? (rough SEE on the target square)
function isSacrifice(fenAfter, mv) {
  const v = PIECE_VAL[mv.piece];
  if (v < 3 || mv.promotion) return false;
  const gained = mv.captured ? PIECE_VAL[mv.captured] : 0;
  const c = new Chess(fenAfter);
  const caps = c.moves({ verbose: true }).filter(m => m.to === mv.to);
  if (!caps.length) return false;
  let worst = -Infinity;
  for (const cap of caps) {
    c.move(cap);
    const recap = c.moves({ verbose: true }).some(m => m.to === mv.to);
    c.undo();
    worst = Math.max(worst, v - (recap ? PIECE_VAL[cap.piece] : 0) - gained);
  }
  return worst >= 2;
}

const altOf = ev => ev?.cands?.[1] ? { best: ev.cands[1][0], cp: ev.cands[1][1], mate: ev.cands[1][2] } : null;
const wpFor = (ev, sign) => winPct(clamp(evalToCp(ev) * sign, -1500, 1500));

function scoreMoves({ fens, moves, phases, legal, evals, clocks, base, book }) {
  const out = [];
  let inBook = !!book, opening = null;
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    const sign = mv.color === 'w' ? 1 : -1;
    const uci = mv.from + mv.to + (mv.promotion || '');
    const before = evalToCp(evals[i]) * sign;
    let after = evalToCp(evals[i + 1]) * sign;
    // If the played move was one of the engine's top candidates, score it from that same search.
    // Comparing two separate searches (before vs after) adds noise that swamps strong players' real errors.
    const own = evals[i].cands?.find(c => c[0] === uci);
    if (own) after = evalToCp({ cp: own[1], mate: own[2] }) * sign;
    const wpB = winPct(clamp(before, -1500, 1500)), wpA = winPct(clamp(after, -1500, 1500));
    const loss = Math.max(0, wpB - wpA);
    const cpLoss = clamp(Math.max(0, before - after), 0, 1000);
    const best = evals[i].best;
    const hitHere = book && bookHit(book, fens[i + 1]);
    if (hitHere) opening = hitHere;
    let cls;
    if (best && uci === best) cls = 'best';
    else if (loss < 2) cls = 'excellent';
    else if (loss < 5) cls = 'good';
    else if (loss < 10) cls = 'inaccuracy';
    else if (loss < 20) cls = 'mistake';
    else cls = 'blunder';
    const prev = out[i - 1];
    if (prev && (prev.cls === 'mistake' || prev.cls === 'blunder') && loss >= 10 && wpB > 60) cls = 'miss';

    if (inBook && hitHere) cls = 'book';
    else {
      inBook = false;
      if (legal[i] === 1) cls = 'forced';
      else if (loss < 2 && wpA >= 50 && wpB < 92 && isSacrifice(fens[i + 1], mv) && !pieceWasHanging(fens[i], mv.from)) cls = 'brilliant';
      else if (cls === 'best' && altOf(evals[i])) {
        const gap = wpFor(evals[i], sign) - wpFor(altOf(evals[i]), sign);
        const recapture = prev && prev.captured && prev.to === mv.to && mv.captured;
        if (gap >= 20 && wpA >= 40 && !recapture) cls = 'great';
      }
    }
    // book moves aren't held against accuracy
    const acc = cls === 'book' ? 100 : clamp(103.1668 * Math.exp(-0.04354 * loss) - 3.1669 + 1, 0, 100);
    let clockBefore = null;
    if (clocks && base) clockBefore = (i >= 2 ? clocks[i - 2] : base) ?? null;
    out.push({
      ply: i, san: mv.san, color: mv.color, uci, from: mv.from, to: mv.to, piece: mv.piece, captured: mv.captured,
      cls, loss, cpLoss, acc, best, phase: phases[i], opening,
      evalBefore: evals[i], evalAfter: evals[i + 1], wpB, wpA,
      clockBefore, clockFrac: clockBefore != null && base ? clockBefore / base : null,
    });
  }
  const summary = {};
  for (const c of ['w', 'b']) {
    const ms = out.filter(m => m.color === c);
    const counts = Object.fromEntries(CLS_ORDER.map(k => [k, 0]));
    ms.forEach(m => counts[m.cls]++);
    const phaseAcc = {};
    for (const p of ['opening', 'middlegame', 'endgame']) {
      const pm = ms.filter(m => m.phase === p);
      phaseAcc[p] = pm.length ? { acc: gameAccuracy(pm.map(m => m.acc)), n: pm.length } : null;
    }
    summary[c] = { accuracy: gameAccuracy(ms.map(m => m.acc)), acpl: mean(ms.map(m => m.cpLoss)) ?? 0, counts, n: ms.length, phaseAcc };
  }
  return { fens, moves: out, evals, summary };
}

function gameAccuracy(accs) {
  if (!accs.length) return null;
  const am = mean(accs);
  const hm = accs.length / sum(accs.map(a => 1 / Math.max(a, 5)));
  return (am + hm) / 2;
}

function uciMove(fen, uci) {
  if (!uci) return null;
  const c = new Chess(fen);
  return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
}
function uciToSan(fen, uci) { const m = uciMove(fen, uci); return m ? m.san : (uci || ''); }

function pvToSan(fen, pv, max = 6) {
  const c = new Chess(fen);
  const out = [];
  for (const u of (pv || []).slice(0, max)) {
    const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
    if (!m) break;
    out.push(m.san);
  }
  return out;
}

// Numbered SAN line, e.g. "14...Nf6 15.Bg5 h6"
function fmtLine(fen, sans) {
  const parts = fen.split(' ');
  let white = parts[1] === 'w', n = +parts[5];
  return sans.map((s, i) => {
    const t = white ? `${n}.${s}` : (i === 0 ? `${n}...${s}` : s);
    if (!white) n++;
    white = !white;
    return t;
  }).join(' ');
}

const article = p => (p === 'p' ? 'a pawn' : p === 'k' ? 'the king' : (PIECE_NAMES[p] === 'Bishop' ? 'a bishop' : PIECE_NAMES[p] === 'Rook' ? 'a rook' : PIECE_NAMES[p] === 'Queen' ? 'the queen' : 'a knight'));

// Plain-language explanation of move i
function explainMove(a, i) {
  const m = a.moves[i];
  const fenB = a.fens[i], fenA = a.fens[i + 1];
  const evB = a.evals[i], evA = a.evals[i + 1];
  const sign = m.color === 'w' ? 1 : -1;
  const bestMv = m.best ? uciMove(fenB, m.best) : null;
  const reply = evA?.best ? uciMove(fenA, evA.best) : null;
  const bestTxt = bestMv ? `<b>${bestMv.san}</b>` : '';
  const out = [];
  const mateFor = (ev, s) => ev?.mate != null && Math.abs(ev.mate) >= 1 && ev.mate * s > 0;
  switch (m.cls) {
    case 'book': out.push(`A known opening move${m.opening ? ` — <i>${esc(m.opening.name)}</i>` : ''}.`); break;
    case 'forced': out.push('The only legal move.'); break;
    case 'brilliant': out.push(`A brilliant sacrifice! ${article(m.piece).replace(/^a /, 'The ').replace(/^the /, 'The ')} can be taken, but the engine confirms it works.`); break;
    case 'great': {
      const altEv = altOf(evB), alt = altEv ? uciToSan(fenB, altEv.best) : '';
      out.push(`The only good move here — the next best${alt ? `, <b>${alt}</b>,` : ''} is clearly worse${altEv ? ` (${fmtEval(altEv)})` : ''}.`);
      break;
    }
    case 'best': out.push(mateFor(evA, sign) ? `The engine's top choice — mate in ${Math.abs(evA.mate)} is on the board.` : "The engine's top choice."); break;
    case 'excellent': out.push(`An excellent move, almost as good as ${bestTxt}.`); break;
    case 'good': out.push(`A decent move, but ${bestTxt} was a bit stronger.`); break;
    default: {
      if (mateFor(evB, sign) && !mateFor(evA, sign)) out.push(`Misses a forced mate in ${Math.abs(evB.mate)}.`);
      else if (mateFor(evA, -sign) && !mateFor(evB, -sign)) out.push(`Allows mate in ${Math.abs(evA.mate)}${reply ? `, starting with <b>${reply.san}</b>` : ''}.`);
      else if (m.cls === 'miss' && bestMv?.captured) out.push(`The previous move left material loose — ${bestTxt} wins ${article(bestMv.captured)}.`);
      else if (m.cls === 'miss') out.push("The previous move was a mistake, but this doesn't punish it.");
      else if (reply?.captured && PIECE_VAL[reply.captured] >= (m.cls === 'inaccuracy' ? 1 : 3)) out.push(`Allows <b>${reply.san}</b>, which wins ${article(reply.captured)}.`);
      else if (reply) out.push(`After this, <b>${reply.san}</b> is a strong reply.`);
      out.push(`Costs about ${num(m.loss, 0)}% winning chances.`);
      if (bestMv) out.push(`Best was ${bestTxt}: ${fmtLine(fenB, pvToSan(fenB, evB.pv, 5))}`);
    }
  }
  return out.join(' ');
}

// ---------- Per-opportunity style records ----------
// For each move by `color`, record which *choices* the position offered (from the engine's top
// candidates) and what the player did. Only positions where a choice really existed count, so
// the rates don't depend on how sharp the opponent made the game.
const NEAR_EQUAL = 3;   // candidates within 3 win-% points of the best count as "equally good"
const CRITICAL_GAP = 10; // best move beats the runner-up by 10+ win-% points => one-move position
const HARD_DEPTH = 5;    // the engine only settled on the move at depth 5+ => hard to see

function moveTraits(fen, mv) {
  if (!mv) return null;
  const after = new Chess(fen); after.move(mv);
  const theirKing = (() => {
    const b = after.board();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = b[r][c]; if (p && p.type === 'k' && p.color !== mv.color) return { file: c, rank: 8 - r }; }
    return null;
  })();
  const toFile = FILES.indexOf(mv.to[0]), toRank = +mv.to[1];
  const advanced = mv.color === 'w' ? toRank >= 4 : toRank <= 5;
  return {
    forcing: mv.san.includes('+') || mv.san.includes('#') || !!mv.captured,
    trade: !!mv.captured && mv.piece !== 'p' && mv.captured !== 'p' && mv.piece !== 'k' && PIECE_VAL[mv.piece] === PIECE_VAL[mv.captured],
    storm: mv.piece === 'p' && advanced && !mv.captured && theirKing && (theirKing.file <= 2 || theirKing.file >= 5) && Math.abs(toFile - theirKing.file) <= 1,
    sac: isSacrifice(after.fen(), mv),
  };
}

// Is the piece on `sq` attacked by the side not to move? (flip the turn and look for captures)
function isAttacked(fen, sq) {
  const p = fen.split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w'; p[3] = '-';
  try { return new Chess(p.join(' ')).moves({ verbose: true }).some(m => m.to === sq); } catch { return false; }
}

function styleRecords(a, color) {
  if (a._style?.[color]) return a._style[color];
  const c = color === 'white' ? 'w' : 'b';
  const sign = c === 'w' ? 1 : -1;
  const recs = [];
  for (const m of a.moves) {
    if (m.color !== c || m.cls === 'book' || m.cls === 'forced') continue;
    const ev = a.evals[m.ply];
    const fen = a.fens[m.ply];
    const r = { ply: m.ply, phase: m.phase, cls: m.cls, san: m.san, loss: m.loss };
    const prev = a.moves[m.ply - 1];
    const bestMv = ev.best ? uciMove(fen, ev.best) : null;
    // "hard" = the engine needed depth 6+ to settle on the answer and it isn't a plain capture
    const hard = (ev.sd ?? 0) >= HARD_DEPTH && bestMv && !bestMv.captured;
    if (prev && (prev.cls === 'mistake' || prev.cls === 'blunder' || prev.cls === 'miss')) {
      r.punish = m.loss < 5;
      if (hard) r.punishHard = r.punish;
    }
    const cands = (ev.cands || []).filter(x => x[0]).map(([uci, cp, mate]) => ({ uci, wp: wpFor({ cp, mate }, sign) }));
    if (cands.length >= 2) {
      // Only-move positions, minus the trivial ones (escaping check, capturing, moving an attacked
      // piece to safety): those are decided by the position, not by the player's skill.
      const inCheck = new Chess(fen).in_check();
      const trivial = inCheck || !bestMv || !!bestMv.captured || isAttacked(fen, bestMv.from);
      if (cands[0].wp - cands[1].wp >= CRITICAL_GAP && cands[0].wp >= 30 && !trivial) {
        r.critical = m.loss < 3;
        if (hard) r.criticalHard = r.critical;
      }
      const good = cands.filter(x => cands[0].wp - x.wp <= NEAR_EQUAL);
      // right after a capture, recapturing is a reflex rather than a style choice
      const afterCapture = !!(prev && prev.captured);
      if (good.length >= 2 && !afterCapture) {
        const t = good.map(x => moveTraits(fen, uciMove(fen, x.uci))).filter(Boolean);
        const mine = moveTraits(fen, uciMove(fen, m.uci));
        for (const k of ['forcing', 'trade', 'storm']) {
          const share = t.filter(x => x[k]).length / t.length;
          // a real choice: both kinds of move were available and equally good, and the player picked a good move
          if (share > 0 && share < 1 && m.loss < NEAR_EQUAL) r[k] = { chose: mine[k], expected: share };
        }
        if (t.some(x => x.sac)) r.sacOpp = !!(mine.sac && m.loss < NEAR_EQUAL);
      } else if (cands.length && moveTraits(fen, uciMove(fen, cands[0].uci))?.sac) r.sacOpp = m.cls === 'best' || m.cls === 'brilliant';
      r.ahead = cands[0].wp >= 75;
    }
    const myTraits = moveTraits(fen, uciMove(fen, m.uci));
    if (myTraits?.sac) r.playedSac = m.loss < 5; // sound if it didn't cost much
    r.brilliant = m.cls === 'brilliant';
    recs.push(r);
  }
  (a._style ||= {})[color] = recs;
  return recs;
}
