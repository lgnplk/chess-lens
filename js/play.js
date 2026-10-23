// Play: a game against a bot at any rating (Maia-3 set to that chess.com rating, keeping its blunders to the rate
// players at that rating make them, from the ladder), a legend, or one of your arena bots. With the coach on,
// Stockfish grades every move of yours the way Review does and stops the game on a mistake or blunder, so you can
// take it back or play on. Hints circle the piece to move, then show the move.
const pl = {
  opp: 'rating', rating: 1200, color: 'white', coach: true,
  userColor: 'white', line: [], idx: 0, marks: {}, flipped: false,
  bot: null, botKey: null, thinking: false, judging: false, hold: null, hint: 0, pre: null,
  token: 0, status: '', error: null, engine: null, board: null, built: false,
};
const PL_DEPTH = () => (NATIVE_SF ? 16 : 11);

// how often players at a chess.com rating (rapid) make a 20+ win-% blunder, per move: the ladder's typical player
function plBlunderRate(L, r) {
  const T = L?.tc.rapid, a = LADDER_PERF.find(x => x.key === 'blunders');
  const pts = T ? ladderCurve(T, a).map(([x, y]) => [x, -y]) : [];
  if (!pts.length) return null;
  const i = pts.findIndex(p => p[0] >= r);
  const y = i < 0 ? pts.at(-1)[1] : i === 0 ? pts[0][1] : pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (r - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
  return y / 100;
}

async function plEnsureBot() {
  const key = pl.opp === 'rating' ? 'r:' + pl.rating : pl.opp;
  if (pl.bot && pl.botKey === key && pl.bot.maia === arena.maia) return pl.bot;
  const say = m => { pl.status = String(m).replace(/<[^>]+>/g, ''); plDrawStatus(); };
  let bot;
  if (pl.opp === 'rating') {
    const maia = await arenaMaia(say);
    bot = { label: `Maia ${pl.rating}`, maia, playRating: capRating(chesscomToLichess(pl.rating)), shownRating: pl.rating, trees: { white: new Map(), black: new Map() },
      blunderTarget: plBlunderRate(await getLadder(), pl.rating), guardLoss: 20, guard: { moves: 0, flagged: 0, kept: 0 }, mode: 'sample' };
  } else {
    bot = await ensureBot(pl.opp, say);
    bot.shownRating = bot.playRating;
  }
  pl.status = '';
  if (key !== (pl.opp === 'rating' ? 'r:' + pl.rating : pl.opp)) return plEnsureBot();   // settings changed meanwhile
  return Object.assign(pl, { bot, botKey: key }).bot;
}

const plChess = (upto = pl.idx) => { const c = new Chess(); pl.line.slice(0, upto).forEach(s => c.move(s)); return c; };
const plFens = (upto = pl.idx) => { const c = new Chess(), f = [c.fen()]; pl.line.slice(0, upto).forEach(s => { c.move(s); f.push(c.fen()); }); return f; };
const plYourTurn = () => { const c = plChess(pl.line.length); return !c.game_over() && c.turn() === pl.userColor[0]; };

function renderPlay(sec) {
  if (!pl.built) {
    sec.innerHTML = `<div class="rv prep">
      <div class="rv-board">
        <div class="player-line" id="plTop"></div>
        <div class="board-wrap"><div class="evalbar" style="visibility:hidden" aria-hidden="true"></div><div class="board" id="plBoard"></div></div>
        <div class="player-line" id="plBottom"></div>
        <div class="controls">
          <button class="btn" data-plnav="prev" title="Back (←)">◀</button>
          <button class="btn" data-plnav="next" title="Forward (→)">▶</button>
          <button class="btn" data-plnav="takeback" title="Take back your last move">↶</button>
          <button class="btn" data-plnav="hint" title="Hint: the piece, then the move">Hint</button>
          <button class="btn" data-plnav="flip" title="Flip board">⇅</button>
          <button class="btn" data-plnav="new" title="New game">↺</button>
        </div>
      </div>
      <div class="rv-panel">
        <div class="rv-head" id="plHead"></div>
        <div class="rv-body scroll" id="plBody"></div>
      </div></div>`;
    pl.built = true;
    pl.board = new BoardView($('#plBoard', sec), { onMove: mv => plUserMove(mv) });
    $$('[data-plnav]', sec).forEach(b => b.onclick = () => plNav(b.dataset.plnav));
    document.addEventListener('keydown', e => {
      if (S.tab !== 'play' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); plNav('prev'); }
      if (e.key === 'ArrowRight') { e.preventDefault(); plNav('next'); }
    });
    pl.engine ||= NATIVE_SF ? new Engine({ native: true }) : getEnginePool()[0];
    return plNew();
  }
  plDraw(); plTurn();
}

function plNew() {
  pl.token++;
  Object.assign(pl, { line: [], idx: 0, marks: {}, hold: null, hint: 0, pre: null, thinking: false, judging: false, error: null, flipped: false,
    userColor: pl.color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : pl.color });
  plDraw(); plTurn();
}

// whose move: the bot's (it thinks), or yours (the coach looks at the position meanwhile)
function plTurn() {
  if (S.tab !== 'play' || pl.hold || pl.thinking || pl.judging) return;
  const c = plChess(pl.line.length);
  if (c.game_over()) return plDraw();
  if (c.turn() !== pl.userColor[0]) plBotMove();
  else if (pl.coach) plBefore(c.fen());
}
const plBefore = fen => (pl.pre?.fen === fen ? pl.pre : (pl.pre = { fen, p: pl.engine.analyse(fen, PL_DEPTH(), 3000, 1) })).p;

async function plBotMove() {
  const token = ++pl.token;
  pl.thinking = true; pl.error = null; plDraw();
  try {
    const bot = await plEnsureBot();
    if (token !== pl.token) return;
    const fens = plFens(pl.line.length), fen = fens.at(-1);
    const dist = await botDistribution(bot, fens);
    if (token !== pl.token) return;
    const mode = bot.mode || 'sample';
    const pick = bot.fidelity && dist.source === 'maia' ? (await fidChoose(bot, dist.moves, fen, pl.engine, mode)).move : await botPick(bot, dist, mode, fen, pl.engine);
    if (token !== pl.token) return;
    await sleep(250 + Math.random() * 350);
    if (token !== pl.token) return;
    if (pick) { pl.line.push(pick.san); pl.idx = pl.line.length; }
  } catch (e) {
    if (token !== pl.token) return;
    pl.error = 'The bot failed to move: ' + (e.message || e);
  }
  pl.thinking = false; pl.status = '';
  plDraw(); plTurn();
}

async function plUserMove(mv) {
  if (pl.thinking || pl.judging || pl.hold || pl.idx !== pl.line.length || !plYourTurn()) return plDraw();
  const ply = pl.line.length, fenB = plChess(ply).fen();
  pl.line.push(mv.san); pl.idx = pl.line.length; pl.hint = 0;
  plDraw();
  if (pl.coach) await plJudge(ply, fenB, mv);
  plTurn();
}

// grade your move like Review: win-% lost against the engine's best, from the position before it
async function plJudge(ply, fenB, mv) {
  const token = pl.token;
  pl.judging = true; plDraw();
  const fens = plFens(ply + 1), fenA = fens[ply + 1], sign = pl.userColor === 'white' ? 1 : -1;
  const [evB, book] = await Promise.all([plBefore(fenB), getBook()]);
  const evA = await pl.engine.analyse(fenA, PL_DEPTH(), 3000, 1);
  if (token !== pl.token) return;
  pl.judging = false;
  const uci = mv.from + mv.to + (mv.promotion || ''), wp = ev => winPct(clamp(evalToCp(ev) * sign, -1500, 1500));
  const loss = uci === evB.best ? 0 : Math.max(0, wp(evB) - wp(evA));
  const opening = book && bookHit(book, fenA);
  let cls = uci === evB.best ? 'best' : loss < 2 ? 'excellent' : loss < 5 ? 'good' : loss < 10 ? 'inaccuracy' : loss < 20 ? 'mistake' : 'blunder';
  if (new Chess(fenB).moves().length === 1) cls = 'forced';
  else if (opening && loss < 10) cls = 'book';
  const m = { ply, color: pl.userColor[0], san: mv.san, piece: mv.piece, from: mv.from, to: mv.to, cls, loss, best: evB.best, opening, evalBefore: evB, evalAfter: evA };
  const a = { moves: [m], fens: [fenB, fenA], evals: [evB, evA] };
  m.text = explainMove(a, 0) + coachDiagnosis({ fens }, m);
  pl.marks[ply] = m;
  if (cls === 'mistake' || cls === 'blunder') pl.hold = { ply };
  if (pl.hold) Sound.play('bad');
  plDraw();
}

function plTakeback() {
  pl.token++;
  Object.assign(pl, { thinking: false, judging: false, hold: null, hint: 0, error: null });
  do { pl.line.pop(); } while (pl.line.length && plChess(pl.line.length).turn() !== pl.userColor[0]);
  pl.idx = pl.line.length;
  for (const k of Object.keys(pl.marks)) if (+k >= pl.idx) delete pl.marks[k];
  plDraw(); plTurn();
}

async function plHint() {
  if (!plYourTurn() || pl.thinking || pl.judging || pl.hold) return;
  pl.idx = pl.line.length;
  const fen = plChess().fen(), ev = await plBefore(fen);
  if (plChess(pl.line.length).fen() !== fen || !ev.best) return;
  pl.hint = Math.min(2, pl.hint + 1);
  plDraw();
}

function plNav(cmd) {
  if (cmd === 'prev') pl.idx = Math.max(0, pl.idx - 1);
  else if (cmd === 'next') pl.idx = Math.min(pl.line.length, pl.idx + 1);
  else if (cmd === 'flip') pl.flipped = !pl.flipped;
  else if (cmd === 'new') return plNew();
  else if (cmd === 'takeback') return plTakeback();
  else if (cmd === 'hint') return plHint();
  plDraw();
}

// the game as a record the Review tab can open (the id follows the moves, so a replay reuses its analysis)
function plRecord() {
  const sans = [...pl.line], me = pl.userColor, c = plChess(sans.length), name = pl.bot?.label || 'Bot';
  return {
    id: 'play:' + hashStr(`${name}|${me}|${sans.join(' ')}`), sans, clocks: [], base: null, color: me,
    me: { name: S.player?.profile?.username || S.username || 'You', rating: null }, opp: { name, rating: pl.bot?.shownRating || null },
    result: c.in_checkmate() ? (c.turn() === me[0] ? 'loss' : 'win') : c.game_over() ? 'draw' : null,
    reason: c.in_checkmate() ? 'checkmated' : c.in_stalemate() ? 'stalemate' : null,
    opening: '', eco: '', url: null, end: new Date(), timeClass: 'bot game',
  };
}

function plDrawStatus() { const el = $('#plStatus'); if (el) el.textContent = pl.status || ''; }

function plDraw() {
  if (!pl.built) return;
  const c = plChess();
  const last = pl.idx > 0 ? plChess(pl.idx - 1).move(pl.line[pl.idx - 1]) : null;
  const mark = pl.marks[pl.idx - 1];
  const orientation = pl.flipped ? (pl.userColor === 'white' ? 'black' : 'white') : pl.userColor;
  const state = { fen: c.fen(), orientation, lastMove: last && { from: last.from, to: last.to }, arrows: [] };
  if (mark) state.badge = { sq: mark.to, cls: mark.cls, text: CLS[mark.cls].sym };
  // the reply your mistake allows, in red, while the game waits
  if (pl.hold && mark?.evalAfter?.best && pl.idx === pl.line.length) state.arrows.push({ from: mark.evalAfter.best.slice(0, 2), to: mark.evalAfter.best.slice(2, 4), color: cssVar('--critical'), width: 0.18 });
  pl.board.set(state);
  if (pl.hint && pl.idx === pl.line.length) {
    pl.pre?.p.then(e => {
      if (!e.best || pl.pre?.fen !== pl.board.state.fen) return;
      if (pl.hint >= 2) pl.board.set({ ...pl.board.state, arrows: [{ from: e.best.slice(0, 2), to: e.best.slice(2, 4), color: cssVar('--good'), width: 0.22 }] });
      pl.board.drawn.circles = [{ from: e.best.slice(0, 2), to: e.best.slice(0, 2), color: cssVar('--good') }]; pl.board.render();
    });
  }

  const bot = pl.bot && pl.botKey === (pl.opp === 'rating' ? 'r:' + pl.rating : pl.opp) ? pl.bot : null;
  const botName = esc(bot?.label || (pl.opp === 'rating' ? `Maia ${pl.rating}` : botInfo(pl.opp)?.name || 'Bot'));
  const side = col => col !== pl.userColor
    ? `<span class="pl"><span class="dot ${col}"></span><b>${botName}</b> <span class="muted">${bot?.shownRating ? '~' + bot.shownRating : ''}${pl.thinking ? ' · thinking…' : ''}</span></span>`
    : `<span class="pl"><span class="dot ${col}"></span><b>You</b>${pl.judging ? ' <span class="muted">· the coach is looking…</span>' : ''}</span>`;
  const topCol = orientation === 'white' ? 'black' : 'white';
  $('#plTop').innerHTML = side(topCol);
  $('#plBottom').innerHTML = side(topCol === 'white' ? 'black' : 'white');

  const legends = FAMOUS.map(f => `<option value="f:${f.id}" ${pl.opp === 'f:' + f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const mine = arena.roster.map(r => `<option value="${esc(r.id)}" ${pl.opp === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const toks = pl.line.map((s, i) => { const mk = pl.marks[i]; return `<span class="mv ${i + 1 === pl.idx ? 'cur' : ''}" data-pli="${i + 1}">${i % 2 === 0 ? `${i / 2 + 1}.` : ''}${esc(s)}${mk && ERROR_CLS.has(mk.cls) ? `<span class="t-${mk.cls}">${CLS[mk.cls].sym}</span>` : ''}</span>`; }).join(' ');
  $('#plHead').innerHTML = `<div class="prep-opts" style="margin-top:0">
      <label>Opponent <select id="plOpp"><option value="rating" ${pl.opp === 'rating' ? 'selected' : ''}>Bot at a rating</option><optgroup label="Legends">${legends}</optgroup>${mine ? `<optgroup label="Your bots">${mine}</optgroup>` : ''}</select></label>
      ${pl.opp === 'rating' ? `<label>Rating <input type="range" id="plRating" min="400" max="2600" step="50" value="${pl.rating}"><b id="plRatingVal">${pl.rating}</b></label>` : ''}
      <label>You play <select id="plColor">${[['white', 'White'], ['black', 'Black'], ['random', 'Random']].map(([v, l]) => `<option value="${v}" ${pl.color === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="plCoach" ${pl.coach ? 'checked' : ''}> Coach</label>
    </div>
    <div class="muted small" id="plStatus">${esc(pl.status || '')}</div>
    <div class="var-line small">${toks || `<span class="muted">New game: ${pl.userColor === 'white' ? 'your move' : 'the bot moves first'}</span>`}</div>`;
  $('#plOpp').onchange = e => { pl.opp = e.target.value; plNew(); };
  const rr = $('#plRating');
  if (rr) { rr.oninput = e => { $('#plRatingVal').textContent = e.target.value; }; rr.onchange = e => { pl.rating = +e.target.value; plNew(); }; }
  $('#plColor').onchange = e => { pl.color = e.target.value; plNew(); };
  $('#plCoach').onchange = e => { pl.coach = e.target.checked; pl.hold = null; plDraw(); plTurn(); };
  $$('#plHead [data-pli]').forEach(e => e.onclick = () => { pl.idx = +e.dataset.pli; plDraw(); });

  const end = plChess(pl.line.length);
  let html = '';
  if (pl.error) html += `<p class="bad">${esc(pl.error)}</p>`;
  if (end.game_over()) {
    const res = end.in_checkmate() ? (end.turn() === pl.userColor[0] ? 'Checkmate: the bot wins.' : 'Checkmate: you win!') : end.in_stalemate() ? 'Stalemate: a draw.' : 'Draw.';
    html += `<div class="bot-over"><b>${res}</b><button class="btn primary" id="plReview">Review the game</button></div>`;
  }
  if (mark) {
    const moveNo = `${Math.floor(mark.ply / 2) + 1}${mark.color === 'w' ? '.' : '...'}`;
    html += `<div class="coach-head"><span class="cls-big cls-${mark.cls}">${CLS[mark.cls].sym}</span>
      <div><b>${moveNo} ${esc(mark.san)}</b> is ${/^[aeiou]/i.test(CLS[mark.cls].label) ? 'an' : 'a'} <b class="t-${mark.cls}">${CLS[mark.cls].label.toLowerCase()}</b> move</div></div>
      <p class="coach-text">${mark.text}</p>`;
    if (pl.hold && pl.idx === pl.line.length) html += `<div class="learn-actions"><button class="btn primary" id="plBack">Take back</button><button class="btn" id="plOn">Play on</button></div>`;
  } else if (pl.coach && !end.game_over()) html += `<p class="muted small">The coach grades each of your moves and stops the game on a mistake.</p>`;
  if (pl.hint && plYourTurn()) html += `<p class="small">${pl.hint >= 2 ? 'The engine\'s move is shown.' : 'The piece to move is circled. Hint again to see the move.'}</p>`;
  const nYours = Object.values(pl.marks);
  if (nYours.length >= 3) {
    const counts = ['blunder', 'mistake', 'inaccuracy'].map(k => [k, nYours.filter(m => m.cls === k).length]).filter(([, n]) => n);
    html += `<p class="muted small" style="margin-top:10px">Your game so far: ${counts.length ? counts.map(([k, n]) => `${n} ${n > 1 ? { blunder: 'blunders', mistake: 'mistakes', inaccuracy: 'inaccuracies' }[k] : k}`).join(', ') : 'no errors'}.</p>`;
  }
  $('#plBody').innerHTML = html;
  $('#plReview')?.addEventListener('click', () => openReview(plRecord(), 0));
  $('#plBack')?.addEventListener('click', plTakeback);
  $('#plOn')?.addEventListener('click', () => { pl.hold = null; plDraw(); plTurn(); });
}
