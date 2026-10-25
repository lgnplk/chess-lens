// Blunder anatomy: what kind of blunders a player makes, when they make them, and how to stop making them.
//
// Every blunder in the engine scan (a move giving away 20+ win-% points, or failing to punish the opponent's
// mistake) is diagnosed from the position. The engine's refutation line is played out to see what falls and
// how — a loose piece, a fork, a pin, a discovered attack, a back-rank mate, a missed win — and the move is set
// against its situation: time spent, clock, phase, score, and what the opponent had just done. Each kind of
// blunder comes with how to prevent it, and the Blunder drill replays the player's own blunder positions.

const BL_FAMILIES = {
  loose:     { label: 'Loose pieces', prevent: 'Before letting go: is the moved piece safe, and what was it guarding?' },
  threats:   { label: "The opponent's threats", prevent: 'After every opponent move: what does it threaten?' },
  king:      { label: 'King safety', prevent: 'Give your king air and defenders; check every enemy check.' },
  chances:   { label: 'Missed chances', prevent: 'Checks, captures and threats for yourself, every move.' },
  technique: { label: 'Endgame technique', prevent: 'Few pieces left: slow down, count tempi, use your king.' },
  other:     { label: 'Strategy', prevent: 'Before a trade or pawn break: what does it give them?' },
};

const BL_CATS = {
  hung_moved:     { fam: 'loose', label: 'Moved a piece to an unsafe square', tip: 'Count attackers and defenders of the landing square.' },
  left_hanging:   { fam: 'loose', label: 'Left another piece undefended', tip: 'Ask what the moving piece was guarding.' },
  greedy:         { fam: 'loose', label: 'Took poisoned material', tip: 'Ask why it is free.' },
  ignored_threat: { fam: 'threats', label: 'Ignored a piece that was already attacked', tip: 'First ask: what is attacked now?' },
  fork:           { fam: 'threats', label: 'Walked into a fork', tip: 'Watch knight and queen squares that hit two targets.' },
  pin:            { fam: 'threats', label: 'Walked into a pin or skewer', tip: 'Keep king, queen and rooks off open lines.' },
  discovered:     { fam: 'threats', label: 'Walked into a discovered attack', tip: 'Imagine the blocking piece moving away.' },
  check_tactic:   { fam: 'threats', label: 'Missed a combination starting with a check', tip: 'Look at every check they have.' },
  quiet_tactic:   { fam: 'threats', label: 'Missed a quiet threat', tip: 'Give every piece a safe retreat.' },
  deep_tactic:    { fam: 'threats', label: 'Walked into a longer combination', tip: 'Follow their forcing lines further.' },
  mate_backrank:  { fam: 'king', label: 'Allowed a back-rank mate', tip: 'Make luft (h3) and guard the back rank.' },
  mate_allowed:   { fam: 'king', label: 'Allowed a mating attack', tip: 'Count attackers and defenders near your king.' },
  missed_mate:    { fam: 'chances', label: 'Missed a forced mate', tip: 'Exposed king: look at every check.' },
  missed_free:    { fam: 'chances', label: "Didn't take a free piece", tip: 'Look for undefended enemy pieces.' },
  missed_tactic:  { fam: 'chances', label: 'Missed a winning tactic', tip: 'Checks, captures, threats first.' },
  missed_punish:  { fam: 'chances', label: "Didn't punish the opponent's mistake", tip: 'After a surprise, ask what it allows.' },
  passed_pawn:    { fam: 'technique', label: 'Let a pawn through to promote', tip: 'Count the passed pawn\'s moves to queen.' },
  endgame:        { fam: 'technique', label: 'Miscalculated an endgame', tip: 'Count tempi before trading into it.' },
  bad_trade:      { fam: 'other', label: 'Traded into a worse position', tip: 'Compare what is left after the trade.' },
  opening_drift:  { fam: 'other', label: 'Lost time or the center in the opening', tip: 'Develop, castle, don\'t move a piece twice.' },
  positional:     { fam: 'other', label: 'Weakened the position without losing material', tip: 'Ask what the move weakens.' },
};

const BL_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const BL_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const blSq = (f, r) => 'abcdefgh'[f] + (r + 1);
const blXY = s => [s.charCodeAt(0) - 97, +s[1] - 1];
const blIn = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const BL_RAYS = { r: [[1, 0], [-1, 0], [0, 1], [0, -1]], b: [[1, 1], [1, -1], [-1, 1], [-1, -1]] };
BL_RAYS.q = [...BL_RAYS.r, ...BL_RAYS.b];
const BL_KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const BL_KG = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function blMap(fen) {
  const m = {};
  new Chess(fen).board().forEach((row, i) => row.forEach((p, f) => { if (p) m[blSq(f, 7 - i)] = p; }));
  return m;
}

// Squares attacked by the piece standing on s
function blAttacksFrom(map, s) {
  const p = map[s];
  if (!p) return [];
  const [x, y] = blXY(s), out = [];
  if (p.type === 'p') { const d = p.color === 'w' ? 1 : -1; for (const df of [-1, 1]) if (blIn(x + df, y + d)) out.push(blSq(x + df, y + d)); return out; }
  if (p.type === 'n' || p.type === 'k') { for (const [dx, dy] of p.type === 'n' ? BL_KN : BL_KG) if (blIn(x + dx, y + dy)) out.push(blSq(x + dx, y + dy)); return out; }
  for (const [dx, dy] of BL_RAYS[p.type]) {
    let f = x + dx, r = y + dy;
    while (blIn(f, r)) { out.push(blSq(f, r)); if (map[blSq(f, r)]) break; f += dx; r += dy; }
  }
  return out;
}

// Squares of `color`'s pieces that attack square s
function blAttackers(map, s, color) {
  return Object.keys(map).filter(q => map[q].color === color && q !== s && blAttacksFrom(map, q).includes(s));
}

// Can the opponent win the piece on s (undefended, or attacked by something cheaper)?
function blEnPrise(map, s) {
  const p = map[s];
  if (!p || p.type === 'k') return false;
  const att = blAttackers(map, s, p.color === 'w' ? 'b' : 'w');
  if (!att.length) return false;
  if (!blAttackers(map, s, p.color).length) return true;
  return Math.min(...att.map(a => BL_VAL[map[a].type])) < BL_VAL[p.type];
}

function blMaterial(fen, color) {
  let s = 0;
  for (const p of Object.values(blMap(fen))) if (p.type !== 'k') s += (p.color === color ? 1 : -1) * PIECE_VAL[p.type];
  return s;
}

function blPlay(fen, ucis, n) {
  const c = new Chess(fen), steps = [];
  for (const u of (ucis || []).slice(0, n)) {
    if (!u) break;
    const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
    if (!mv) break;
    steps.push({ mv, fen: c.fen() });
  }
  return { chess: c, steps };
}

// A bishop, rook or queen on s lining up two of `me`'s pieces: a pin (the back one is worth more) or a skewer
function blLineTactic(map, s, me) {
  const p = map[s];
  const [x, y] = blXY(s);
  for (const [dx, dy] of BL_RAYS[p.type] || []) {
    let f = x + dx, r = y + dy, first = null;
    while (blIn(f, r)) {
      const q = map[blSq(f, r)];
      if (q) {
        if (q.color !== me) break;
        if (!first) first = q;
        else { if ((q.type === 'k' || BL_VAL[q.type] > BL_VAL[first.type]) && first.type !== 'p') return true; if (BL_VAL[first.type] >= 5 && BL_VAL[first.type] > BL_VAL[q.type]) return true; break; }
      }
      f += dx; r += dy;
    }
  }
  return false;
}

// After the reply, does a different enemy piece newly attack one of `me`'s valuable pieces (or give check)?
function blDiscovered(before, after, reply, me) {
  for (const s of Object.keys(after)) {
    const t = after[s];
    if (t.color !== me || (t.type !== 'k' && BL_VAL[t.type] < 3)) continue;
    const now = blAttackers(after, s, reply.color).filter(a => a !== reply.to && 'brq'.includes(after[a].type));
    const was = new Set(blAttackers(before, s, reply.color));
    if (now.some(a => !was.has(a))) return true;
  }
  return false;
}

// Diagnose one blunder. fens: the game's positions (fens[ply] is before the move).
function classifyBlunder(m, fens) {
  const me = m.color, opp = me === 'w' ? 'b' : 'w', sign = me === 'w' ? 1 : -1;
  const fenB = fens[m.ply], fenA = fens[m.ply + 1];
  const evB = m.evalBefore || {}, evA = m.evalAfter || {};
  const ref = blPlay(fenA, evA.pv?.length ? evA.pv : [evA.best], 10);
  const mapB = blMap(fenB);
  const reply = ref.steps[0]?.mv || null;
  const out = { line: ref.steps.slice(0, 4).map(s => s.mv.san), reply: reply?.san || null, lost: null };
  const done = cat => ({ ...out, cat });

  // mate: missed one, or walked into one
  if (evB.mate != null && evB.mate * sign > 0 && !(evA.mate != null && evA.mate * sign > 0)) return done('missed_mate');
  if (evA.mate != null && evA.mate * sign < 0) {
    const full = blPlay(fenA, evA.pv, 20), last = full.steps.at(-1)?.mv;
    const back = me === 'w' ? '1' : '8';
    const kingSq = Object.entries(blMap(full.chess.fen())).find(([, p]) => p.type === 'k' && p.color === me)?.[0];
    const isBack = full.chess.in_checkmate() && last && 'rq'.includes(last.piece) && last.to[1] === back && kingSq?.[1] === back;
    return done(isBack ? 'mate_backrank' : 'mate_allowed');
  }

  // material: before the blunder vs after the refutation (up to 6 plies)
  const matB = blMaterial(fenB, me);
  const seg = ref.steps.slice(0, 6);
  const matEnd = blMaterial(seg.length ? seg.at(-1).fen : fenA, me);
  const net = matEnd - matB;
  const caps = seg.filter(s => s.mv.color === opp && s.mv.captured).map(s => s.mv).sort((a, b) => PIECE_VAL[b.captured] - PIECE_VAL[a.captured]);
  if (net <= -1 && reply) {
    out.lost = caps[0]?.captured || null;
    if (reply.captured) {
      if (reply.to === m.to) return done(m.captured ? 'greedy' : 'hung_moved');
      if (mapB[reply.to]?.color === me && blEnPrise(mapB, reply.to)) return done('ignored_threat');
      return done('left_hanging');
    }
    const mapA = blMap(fenA), mapR = blMap(ref.steps[0].fen);
    const targets = blAttacksFrom(mapR, reply.to).filter(s => {
      const t = mapR[s];
      return t && t.color === me && t.type !== 'p' && (t.type === 'k' || BL_VAL[t.type] > BL_VAL[reply.piece] || !blAttackers(mapR, s, me).length);
    });
    if (targets.length >= 2) return done('fork');
    if ('brq'.includes(reply.piece) && blLineTactic(mapR, reply.to, me)) return done('pin');
    if (blDiscovered(mapA, mapR, reply, me)) return done('discovered');
    if (reply.san.includes('+')) return done('check_tactic');
    const firstCap = caps.length ? seg.find(s => s.mv.color === opp && s.mv.captured)?.mv : null;
    if (firstCap && mapB[firstCap.to]?.color === me && blEnPrise(mapB, firstCap.to)) return done('ignored_threat');
    return done('quiet_tactic');
  }
  if (ref.steps.slice(0, 8).some(s => s.mv.color === opp && s.mv.promotion)) return done('passed_pawn');
  // the best move won material that the played move didn't: a free piece, or a tactic
  const bestLine = blPlay(fenB, evB.pv?.length ? evB.pv : [evB.best], 6);
  if (bestLine.steps.length && blMaterial(bestLine.steps.at(-1).fen, me) - Math.max(matB, matEnd) >= 1) {
    const first = bestLine.steps[0].mv;
    // (taking the same piece with a different one isn't missing it)
    return done(first.captured && first.to !== m.to && mapB[first.to] && blEnPrise(mapB, first.to) ? 'missed_free' : 'missed_tactic');
  }
  // material that falls later in the refutation
  if (ref.steps.length > 6 && blMaterial(ref.steps.at(-1).fen, me) - matB <= -2) return done('deep_tactic');
  if (m.cls === 'miss') return done('missed_punish');
  if (m.captured && reply?.captured && reply.to === m.to) return done('bad_trade');
  if (m.phase === 'opening') return done('opening_drift');
  if (m.phase === 'endgame') return done('endgame');
  return done('positional');
}

// ---------- the whole picture ----------
const BL_MIN_N = 25; // moves needed in a situation before comparing its blunder rate

function blunderAnatomy(myMoves) {
  // scans diagnose blunders in their analysis workers (m.diag); only an analysis made elsewhere needs a replay here
  const games = new Map();
  const fensOf = g => { if (!games.has(g)) games.set(g, replayFens(g.sans).fens); return games.get(g); };
  // time spent on each move, and the typical time per move in that game
  const spentOf = (g, ply) => {
    if (!g.clocks?.length || !g.base || g.clocks[ply] == null) return null;
    const prev = ply >= 2 ? g.clocks[ply - 2] : g.base;
    return prev == null ? null : Math.max(0, prev - g.clocks[ply] + (g.inc || 0));
  };
  const typical = new Map();
  const typicalOf = g => {
    if (!typical.has(g)) {
      const c = g.color[0], xs = [];
      for (let i = c === 'w' ? 0 : 1; i < g.sans.length; i += 2) { const s = spentOf(g, i); if (s != null) xs.push(s); }
      typical.set(g, xs.length >= 5 ? median(xs) : null);
    }
    return typical.get(g);
  };
  const moves = myMoves.filter(m => m.cls !== 'book' && m.cls !== 'forced').map(m => {
    const prev = m.game.sans[m.ply - 1] || '';
    const spent = spentOf(m.game, m.ply), typ = typicalOf(m.game);
    return {
      m, blunder: m.loss >= 20,   // a 'miss' only counts when it costs as much as a blunder
      fast: spent != null && typ != null ? spent <= Math.max(2, 0.35 * typ) : null, spent,
      trouble: m.clockFrac != null ? m.clockFrac < 0.1 : null,
      winning: m.wpB >= 75,   // (no "while losing": win-% losses shrink once a game is lost, so it'd measure the scale, not you)
      afterCapture: prev.includes('x'), afterCheck: prev.includes('+'),
    };
  });
  const list = moves.filter(x => x.blunder).map(x => {
    let d = x.m.diag;
    if (!d) {
      try { const fens = fensOf(x.m.game); d = { ...classifyBlunder(x.m, fens), fen: fens[x.m.ply] }; } catch { d = { cat: 'positional', line: [], reply: null, lost: null }; }
    }
    return { ...x, ...d };
  });
  const nGames = new Set(moves.map(x => x.m.game)).size;
  const byCat = {}, byFam = {};
  for (const b of list) {
    (byCat[b.cat] ||= []).push(b);
    (byFam[BL_CATS[b.cat].fam] ||= []).push(b);
  }
  const families = Object.entries(byFam).map(([fam, bs]) => ({
    fam, ...BL_FAMILIES[fam], n: bs.length, share: bs.length / list.length,
    cats: Object.entries(byCat).filter(([c]) => BL_CATS[c].fam === fam).map(([c, xs]) => ({ cat: c, ...BL_CATS[c], n: xs.length, examples: xs })).sort((a, b) => b.n - a.n),
  })).sort((a, b) => b.n - a.n);

  // situations: blunders per 100 moves when the condition holds vs when it doesn't
  const rate = xs => xs.length ? 100 * xs.filter(x => x.blunder).length / xs.length : null;
  const cond = (key, label, test) => {
    const yes = moves.filter(x => test(x) === true), no = moves.filter(x => test(x) === false);
    if (yes.length < BL_MIN_N || no.length < BL_MIN_N) return null;
    const ry = rate(yes), rn = rate(no);
    return { key, label, n: yes.length, nElse: no.length, blunders: yes.filter(x => x.blunder).length, rate: ry, base: rn, ratio: rn ? ry / rn : null, share: list.length ? yes.filter(x => x.blunder).length / list.length : 0 };
  };
  const situations = [
    cond('fast', 'Fast moves', x => x.fast),
    cond('trouble', 'Time trouble', x => x.trouble),
    cond('winning', 'Clearly winning', x => x.winning),
    cond('afterCapture', 'After a capture', x => x.afterCapture),
    cond('afterCheck', 'After a check', x => x.afterCheck),
    cond('opening', 'Opening', x => x.m.phase === 'opening'),
    cond('middlegame', 'Middlegame', x => x.m.phase === 'middlegame'),
    cond('endgame', 'Endgame', x => x.m.phase === 'endgame'),
  ].filter(Boolean).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));

  const lostPieces = {};
  list.filter(b => b.lost).forEach(b => { lostPieces[b.lost] = (lostPieces[b.lost] || 0) + 1; });

  // over time: the games in date order, cut into equal groups (calendar months can be very uneven), with
  // blunders per game by kind in each; and the older half of the games against the newer half
  const byDate = [...new Set(moves.map(x => x.m.game))].sort((a, b) => (a.end || 0) - (b.end || 0));
  const nb = clamp(Math.round(byDate.length / 12), 2, 10), size = Math.ceil(byDate.length / nb);
  const groupOf = new Map(byDate.map((g, i) => [g, Math.floor(i / size)]));
  const trend = Array.from({ length: Math.ceil(byDate.length / size) }, (_, k) => {
    const gs = byDate.slice(k * size, (k + 1) * size);
    return { k, games: gs.length, from: gs[0]?.end, to: gs.at(-1)?.end, fam: {}, total: 0 };
  });
  for (const b of list) { const e = trend[groupOf.get(b.m.game)], f = BL_CATS[b.cat].fam; e.fam[f] = (e.fam[f] || 0) + 1; e.total++; }
  const half = Math.floor(byDate.length / 2), older = new Set(byDate.slice(0, half)), count = new Map();
  list.forEach(b => count.set(b.m.game, (count.get(b.m.game) || 0) + 1));
  const perGameIn = gs => gs.length ? sum(gs.map(g => count.get(g) || 0)) / gs.length : null;
  const halves = byDate.length >= 20 ? { older: perGameIn(byDate.filter(g => older.has(g))), newer: perGameIn(byDate.filter(g => !older.has(g))), n: half } : null;

  return { list, moves: moves.length, nGames, families, situations, lostPieces, trend, halves, perGame: nGames ? list.length / nGames : 0, per100: rate(moves) };
}

// Three personal rules from the biggest kinds of blunder and the riskiest situations
function blunderRules(A) {
  const rules = [];
  const top = A.families[0], second = A.families[1];
  const pc = x => pct(x, 0);
  if (top) rules.push({ rule: top.prevent, why: `${pc(top.share)} of blunders · mostly ${top.cats[0].label.toLowerCase()}` });
  const sit = A.situations.find(s => ['fast', 'trouble', 'winning', 'afterCapture', 'afterCheck'].includes(s.key) && s.ratio >= 1.4 && s.blunders >= 3);
  const SIT_RULES = {
    fast: 'Pause on every capture, check or move into enemy range.',
    trouble: 'Keep a fifth of your clock for the endgame.',
    winning: 'When winning, keep blunder-checking.',
    afterCapture: 'After a capture, look for an in-between move before recapturing.',
    afterCheck: 'In check, compare all three ways out.',
  };
  const SIT_WHEN = { fast: 'when you move quickly', trouble: 'in time trouble', winning: 'when you are clearly winning', afterCapture: 'right after your opponent captures', afterCheck: 'right after a check' };
  if (sit) rules.push({ rule: SIT_RULES[sit.key], why: `${sit.ratio.toFixed(1)}× the blunder rate ${SIT_WHEN[sit.key]}` });
  if (second && rules.length < 3) rules.push({ rule: second.prevent, why: `${pc(second.share)} of blunders · mostly ${second.cats[0].label.toLowerCase()}` });
  const third = A.families[2];
  if (third && rules.length < 3) rules.push({ rule: third.prevent, why: `${pc(third.share)} of blunders` });
  return rules.slice(0, 3);
}

// ---------- tab ----------
const bdrill = { mode: 'safety', lists: null, idx: null, score: null, reveal: null, busy: false, board: null };

function blMoveLabel(m) { return `${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '…'}${m.san}`; }

function renderBlunders(sec, games) {
  const agg = S.scanAgg;
  if (!agg?.myMoves) { sec.innerHTML = ''; return; }
  if (S._blAgg !== agg) { S._blAgg = agg; S._bl = blunderAnatomy(agg.myMoves); bdrill.lists = null; bdrill.reveal = null; }
  const A = S._bl;
  if (!A.list.length) { sec.innerHTML = empty(`No blunders in ${agg.n} scanned games. Scan more games for a fuller picture.`); return; }
  const rules = blunderRules(A);
  const top = A.families[0];
  const lost = Object.entries(A.lostPieces).sort((a, b) => b[1] - a[1]);
  const fast = A.situations.find(s => s.key === 'fast');
  const diagnosis = `The biggest share of your blunders, ${pct(top.share)}, comes from ${top.label.toLowerCase()}${top.cats[0] ? ` — above all, you ${top.cats[0].label.charAt(0).toLowerCase() + top.cats[0].label.slice(1)}` : ''}.`;

  let html = `
    <div class="card bl-head">
      <div class="sub">${A.list.length} blunders in ${A.nGames} games · ${num(A.perGame, 1)} per game · ${num(A.per100, 1)} per 100 moves</div>
      <div class="bl-diagnosis">${esc(diagnosis)}</div>
      ${lost.length ? `<p class="small" style="margin:0">Pieces lost to blunders: ${lost.map(([p, n]) => `<b>${n}</b> ${BL_NAME[p]}${n > 1 ? 's' : ''}`).join(' · ')}${fast?.ratio ? ` · ${pct(fast.blunders / A.list.length)} of blunders were played quickly` : ''}.</p>` : ''}
    </div>
    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card"><h3>Your three rules</h3>
        <ol class="bl-rules">${rules.map(r => `<li><span class="bl-rule">${esc(r.rule)}</span><span class="bl-why">${esc(r.why)}</span></li>`).join('')}</ol></div>
      <div class="card"><h3>When you blunder</h3><div class="sub">Blunders per 100 moves</div>
        <table class="cmp"><thead><tr><th></th><th class="num">Moves</th><th class="num">Rate</th><th class="num">Else</th><th class="num">Risk</th></tr></thead><tbody>
          ${A.situations.map(s => `<tr><td class="wrap">${esc(s.label)}</td><td class="num">${s.n}</td><td class="num"><b>${num(s.rate, 1)}</b></td><td class="num">${num(s.base, 1)}</td><td class="num ${s.ratio >= 1.4 ? 'bl-hot' : s.ratio <= 0.7 ? 'bl-cool' : ''}">${s.ratio ? s.ratio.toFixed(1) + '×' : '–'}</td></tr>`).join('')}
        </tbody></table></div>
    </div>
    ${A.trend.length >= 3 ? `<div class="card" style="margin-bottom:14px">
      <div class="row-between"><div><h3>Are you blundering less?</h3><div class="sub">Per game, in groups of ${A.trend[0].games} games</div></div>
        ${A.halves ? `<div class="bl-trend-note">${trendSentence(A.halves)}</div>` : ''}</div>
      <div class="chart-box"><canvas id="blTrend"></canvas></div></div>` : ''}
    <h2 class="h2h-section">What goes wrong</h2>
    <div class="bl-families">${A.families.map(f => `
      <div class="card bl-family">
        <div class="row-between"><h3>${esc(f.label)}</h3><span class="bl-count">${f.n} <span class="muted small">· ${pct(f.share)}</span></span></div>
        <div class="bl-bar"><div style="width:${Math.round(f.share * 100)}%"></div></div>
        <p class="bl-prevent">${esc(f.prevent)}</p>
        ${f.cats.map(c => `<div class="bl-cat"><div class="row-between"><b>${esc(c.label)}</b><span class="num">${c.n}</span></div>
          <div class="small">${esc(c.tip)}</div>
          <div class="bl-examples">${c.examples.slice(0, 3).map(b => `<button class="bl-ex" data-blg="${A.list.indexOf(b)}" title="Open in Review">${esc(blMoveLabel(b.m))}${b.reply ? ` <span class="muted">→ ${esc(b.reply)}</span>` : ''}</button>`).join('')}</div></div>`).join('')}
      </div>`).join('')}</div>
    <div class="card" style="margin-top:14px" id="blDrill"></div>
    <div class="card" style="margin-top:14px"><h3>Every blunder</h3>
      <div class="table-wrap" style="max-height:440px;overflow-y:auto"><table><thead><tr><th>Game</th><th>Move</th><th>Kind</th><th>Refutation</th><th class="num">Win % lost</th><th class="num">Time</th></tr></thead><tbody>
      ${A.list.map((b, i) => [b, i]).sort((x, y) => y[0].m.loss - x[0].m.loss).map(([b, i]) => `<tr class="clickable" data-blg="${i}"><td>vs ${esc(b.m.game.opp.name)} <span class="muted">${fmtDate(b.m.game.end)}</span></td><td><b>${esc(blMoveLabel(b.m))}</b></td><td>${esc(BL_CATS[b.cat].label)}</td><td class="muted">${esc(b.line.join(' '))}</td><td class="num">${num(b.m.loss, 0)}</td><td class="num">${b.spent != null ? num(b.spent, b.spent < 10 ? 1 : 0) + ' s' : '–'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  sec.innerHTML = html;
  drawBlTrend(A);
  $$('[data-blg]', sec).forEach(el => el.addEventListener('click', () => { const b = A.list[+el.dataset.blg]; openReview(b.m.game, b.m.ply + 1); }));
  drawBlDrill(A);
}

function trendSentence(h) {
  if (h.older == null || h.newer == null) return '';
  const d = h.older ? (h.newer - h.older) / h.older : 0;
  const how = Math.abs(d) < 0.1 ? 'about the same as' : d < 0 ? `${pct(-d)} fewer than` : `${pct(d)} more than`;
  return `Your newer ${h.n} games: <b>${num(h.newer, 1)}</b> blunders per game, ${how} your older ${h.n} (${num(h.older, 1)}).`;
}

function drawBlTrend(A) {
  const canvas = $('#blTrend');
  if (!canvas) return;
  const groups = A.trend;
  const fams = A.families.map(f => f.fam);
  const colors = ['--s2', '--s1', '--s3', '--s4', '--s5', '--s6'];
  const day = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '?';
  makeChart(canvas, {
    type: 'bar',
    data: { labels: groups.map(t => `to ${day(t.to)}`), datasets: fams.map((f, i) => ({
      label: BL_FAMILIES[f].label, data: groups.map(t => (t.fam[f] || 0) / t.games), backgroundColor: cssVar(colors[i % colors.length]), maxBarThickness: 46,
    })) },
    options: {
      plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(2)} per game`, footer: items => { const t = groups[items[0].dataIndex]; return `${t.games} games, ${day(t.from)} – ${day(t.to)} · ${(t.total / t.games).toFixed(1)} blunders per game`; } } } },
      scales: baseScales({ stacked: true, title: { display: true, text: 'blunders per game' } }, { stacked: true }),
    },
  });
}

// ---------- the drill: your own positions, two ways ----------
// "Stay safe": positions where you gave something away — find any move that doesn't blunder.
// "Find the win": positions where you missed a win — find the winning move (or one nearly as good).
// The board behaves like a chess.com or lichess puzzle: it stays put between positions, each position arrives with
// the opponent's last move sliding in, your move stays on the board with a ✓ or ✗ on its square, a miss slides back
// with the engine's move as an arrow, and the engine's line can be played out on the board.
const BL_DRILL_MODES = {
  safety: { label: 'Stay safe', sub: 'Find a safe move.', pick: b => BL_CATS[b.cat].fam !== 'chances', ok: loss => loss < 12 },
  win:    { label: 'Find the win', sub: 'Find the move you missed.', pick: b => BL_CATS[b.cat].fam === 'chances', ok: loss => loss < 5 },
};

// the position before the blunder and the move into it: kept by the scan (b.fen, b.prev, b.last); replayed for an older analysis
function blPositions(b) {
  if (b.fen && b.prev !== undefined && b.last !== undefined) return;
  const fens = replayFens(b.m.game.sans.slice(0, b.m.ply)).fens;
  b.fen ||= fens[b.m.ply];
  b.prev = b.m.ply > 0 ? fens[b.m.ply - 1] : null;
  const pm = b.prev ? new Chess(b.prev).move(b.m.game.sans[b.m.ply - 1], { sloppy: true }) : null;
  b.last = pm ? { from: pm.from, to: pm.to } : null;
}

function drawBlDrill(A) {
  const box = $('#blDrill');
  if (!box) return;
  if (bdrill.forA !== A) { bdrill.forA = A; bdrill.lists = null; bdrill.reveal = null; }
  const mode = BL_DRILL_MODES[bdrill.mode] ? bdrill.mode : 'safety';
  const M = BL_DRILL_MODES[mode];
  bdrill.lists ||= {}; bdrill.idx ||= {}; bdrill.score ||= {};
  if (!bdrill.lists[mode]) { bdrill.lists[mode] = shuffle(A.list.filter(M.pick)); bdrill.idx[mode] = 0; bdrill.score[mode] = { n: 0, ok: 0 }; }
  const list = bdrill.lists[mode], sc = bdrill.score[mode], b = list[bdrill.idx[mode]];
  // the frame is built once per page render; afterwards positions and verdicts only change its contents
  if (!$('#blBoard', box)) {
    box.innerHTML = `<div class="row-between"><div><h3>Blunder drill</h3><div class="sub bl-sub"></div></div><div class="seg bl-modes" style="align-self:center"></div></div>
      <p class="small bl-score" style="margin:8px 0 0"></p>
      <div class="twin-stage bl-stage"><div><div class="muted small bl-meta" style="margin-bottom:6px"></div>
        <div class="match-board" style="--bs:min(380px, calc(var(--cw) - 60px))"><div class="board" id="blBoard"></div></div></div>
        <div class="twin-panel bl-panel"></div></div>`;
    bdrill.board = new BoardView($('#blBoard', box), { onMove: (mv, fenAfter) => blDrillAnswer(mv, fenAfter) });
    bdrill.shownKey = null;
  }
  $('.bl-sub', box).textContent = M.sub;
  $('.bl-modes', box).innerHTML = Object.entries(BL_DRILL_MODES).map(([k, v]) => `<button data-blmode="${k}" class="${k === mode ? 'active' : ''}">${v.label} <span class="muted">${A.list.filter(v.pick).length}</span></button>`).join('');
  $$('[data-blmode]', box).forEach(el => el.onclick = () => { if (bdrill.busy) return; bdrill.mode = el.dataset.blmode; bdrill.reveal = null; drawBlDrill(A); });
  $('.bl-score', box).innerHTML = sc.n ? `This session: <b>${sc.ok} of ${sc.n}</b> ${mode === 'win' ? 'found' : 'safe'}.` : '';
  $('.bl-stage', box).classList.toggle('hidden', !b);
  if (!b) { $('.bl-score', box).innerHTML += '<span class="muted"> No positions of this kind in the scanned games.</span>'; return; }
  blPositions(b);
  Object.assign(bdrill, { cur: b, curMode: mode });
  $('.bl-meta', box).textContent = `Position ${bdrill.idx[mode] + 1} of ${list.length} · vs ${b.m.game.opp.name} · ${fmtDate(b.m.game.end)} · move ${Math.floor(b.m.ply / 2) + 1}`;
  // a new position: shown before the opponent's last move, which then slides in
  const key = `${mode}:${bdrill.idx[mode]}`, orientation = b.m.color === 'w' ? 'white' : 'black';
  if (bdrill.shownKey !== key) {
    bdrill.shownKey = key;
    clearTimeout(bdrill.timer);
    if (b.prev && b.last) {
      bdrill.board.jump({ fen: b.prev, orientation });
      bdrill.timer = setTimeout(() => { if (bdrill.shownKey === key) bdrill.board.set({ fen: b.fen, orientation, lastMove: b.last }); }, 380);
    } else bdrill.board.jump({ fen: b.fen, orientation, lastMove: b.last });
  }
  blDrillPanel();
}

function blDrillPanel(extra = '') {
  const panel = $('#blDrill .bl-panel'), b = bdrill.cur, mode = bdrill.curMode;
  if (!panel || !b) return;
  const toMove = b.m.color === 'w' ? 'White' : 'Black', r = bdrill.reveal;
  const what = b.cat === 'missed_mate' ? 'there is a forced mate' : b.cat === 'missed_free' ? 'something is free' : 'there is a winning move';
  panel.innerHTML = (r ? r.html : mode === 'win'
    ? `<h3>${toMove} to move — ${what}</h3><p class="small">Find it on the board.</p><p class="muted small">Hint: ${esc(BL_CATS[b.cat].tip)}</p>`
    : `<h3>${toMove} to move</h3><p class="small">Make a safe move on the board.${b.m.clockFrac != null && b.m.clockFrac < 0.1 ? ' In the game you were short of time here.' : ''}</p>
       <p class="muted small">Hint: ${esc(BL_FAMILIES[BL_CATS[b.cat].fam].prevent)}</p>`) + extra;
  $('#blNext', panel)?.addEventListener('click', blDrillNext);
  $('#blLine', panel)?.addEventListener('click', blDrillLine);
}

function blDrillNext() {
  const mode = bdrill.curMode, list = bdrill.lists?.[mode];
  if (!list?.length) return;
  clearTimeout(bdrill.lineTimer);
  bdrill.idx[mode] = (bdrill.idx[mode] + 1) % list.length;
  bdrill.reveal = null;
  drawBlDrill(S._bl);
}

// the engine's line from the position, played out on the board a move at a time
function blDrillLine() {
  const b = bdrill.cur, pv = b?.m.evalBefore?.pv;
  if (!pv?.length) return;
  clearTimeout(bdrill.lineTimer);
  const steps = blPlay(b.fen, pv, 8).steps, orientation = b.m.color === 'w' ? 'white' : 'black';
  bdrill.board.set({ fen: b.fen, orientation, lastMove: b.last });
  let i = 0;
  const step = () => {
    if (bdrill.cur !== b || i >= steps.length) return;
    const s = steps[i++];
    bdrill.board.set({ fen: s.fen, orientation, lastMove: { from: s.mv.from, to: s.mv.to } });
    bdrill.lineTimer = setTimeout(step, 750);
  };
  bdrill.lineTimer = setTimeout(step, 450);
}

async function blDrillAnswer(mv, fenAfter) {
  const b = bdrill.cur, mode = bdrill.curMode, board = bdrill.board;
  if (!b || bdrill.reveal || bdrill.busy) return;
  bdrill.busy = true;
  const orientation = b.m.color === 'w' ? 'white' : 'black', moved = { from: mv.from, to: mv.to };
  // your move stays on the board while the engine checks it
  board.set({ fen: fenAfter, orientation, lastMove: moved });
  blDrillPanel('<p class="muted small">Checking…</p>');
  const uci = mv.from + mv.to + (mv.promotion || '');
  let loss = null;
  // judged exactly as the scan judged the original move, so the two agree: the position before as the scan saw
  // it (its top-3 search), your move scored from that search if it was one of the candidates, otherwise by the
  // scan's engine and depth on the position after it (an engine of its own, so a running scan doesn't hold it up)
  bdrill.engine ||= NATIVE_SF ? new Engine({ native: true }) : getEnginePool()[0];
  try {
    const sign = b.m.color === 'w' ? 1 : -1, evB = b.m.evalBefore, own = evB?.cands?.find(c => c[0] === uci);
    const after = own ? evalToCp({ cp: own[1], mate: own[2] }) * sign : evalToCp(await bdrill.engine.analyse(fenAfter, scanState.depth, 8000, 3)) * sign;
    loss = Math.max(0, winPct(clamp(evalToCp(evB) * sign, -1500, 1500)) - winPct(clamp(after, -1500, 1500)));
  } catch { /* engine unavailable */ }
  bdrill.busy = false;
  if (bdrill.cur !== b) return;
  const ok = loss != null && BL_DRILL_MODES[mode].ok(loss);
  const sc = bdrill.score[mode];
  if (loss != null) { sc.n++; sc.ok += ok ? 1 : 0; }
  // the verdict on the square; a miss slides back and the engine's move appears as an arrow
  const best = b.m.best && b.m.best !== uci ? { from: b.m.best.slice(0, 2), to: b.m.best.slice(2, 4), color: cssVar('--good'), width: 0.22 } : null;
  board.set({ fen: fenAfter, orientation, lastMove: moved, badge: { sq: mv.to, cls: ok ? 'best' : loss == null ? 'good' : 'blunder', text: ok ? '✓' : loss == null ? '?' : '✗' } });
  if (loss != null) Sound.play(ok ? 'good' : 'bad');
  if (!ok && loss != null) {
    clearTimeout(bdrill.timer);
    bdrill.timer = setTimeout(() => { if (bdrill.cur === b) board.set({ fen: b.fen, orientation, lastMove: b.last, arrows: best ? [best] : [] }); }, 650);
  }
  const bestSan = b.m.best ? uciMove(b.fen, b.m.best)?.san : null;
  const bestLine = b.m.evalBefore?.pv?.length ? blPlay(b.fen, b.m.evalBefore.pv, 6).steps.map(s => s.mv.san) : [];
  const lossTxt = loss != null ? ` <span class="muted">(${loss < 1 ? "the engine's choice" : `−${loss.toFixed(0)} win-%`})</span>` : '';
  let html;
  if (mode === 'win') {
    html = `<h3>${loss == null ? 'Checked.' : ok ? '✓ You found it.' : '✗ Not this time.'}</h3>
      <p class="small">You played <b>${esc(mv.san)}</b>${lossTxt}.${bestSan && (!ok || bestSan !== mv.san) ? ` The winning move: <b>${esc(bestSan)}</b>${bestLine.length > 1 ? ` <span class="muted">— ${esc(bestLine.join(' '))}</span>` : ''}.` : ''}</p>
      <p class="small">In the game you played <b>${esc(b.m.san)}</b>, which gave away ${b.m.loss.toFixed(0)} win-% points.</p>`;
  } else {
    const verdict = loss == null ? 'Checked.' : loss < 5 ? '✓ Safe — a good move.' : loss < 12 ? '✓ Safe enough — no blunder this time.' : loss < 20 ? 'A mistake, but not a blunder.' : '✗ That blunders too.';
    html = `<h3>${verdict}</h3>
      <p class="small">You played <b>${esc(mv.san)}</b>${lossTxt}.${bestSan && bestSan !== mv.san ? ` The engine's move: <b>${esc(bestSan)}</b>.` : ''}</p>
      <p class="small">In the game you played <b>${esc(b.m.san)}</b> — ${esc(BL_CATS[b.cat].label.toLowerCase())}${b.line.length ? `: <span class="muted">${esc(b.line.join(' '))}</span>` : ''}.</p>`;
  }
  bdrill.reveal = { html: html + `<p class="small"><i>${esc(BL_CATS[b.cat].tip)}</i></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${bestLine.length ? '<button class="btn" id="blLine">Show the engine\'s line</button>' : ''}<button class="btn primary" id="blNext">Next position →</button></div>` };
  $('#blDrill .bl-score').innerHTML = `This session: <b>${sc.ok} of ${sc.n}</b> ${mode === 'win' ? 'found' : 'safe'}.`;
  blDrillPanel();
}
