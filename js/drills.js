// Drills: the standard checkmates and endgames, played out against Stockfish at full strength (the native engine
// in the desktop app). Each has a goal: mate within a number of moves, win (mate, or promote into a won position),
// or hold the draw. After every move of yours the engine checks the position, so a slip shows at once ("the win
// slipped away") instead of twenty moves later. Every position was checked with the engine at depth 30 before it went in.
const DRILLS = [
  { id: 'kq', group: 'Checkmates', title: 'Queen mate', fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1', goal: 'mate', moves: 10, tip: 'Use the queen to box the king in a knight\'s move away, bring your king up, and never stalemate.' },
  { id: 'kr', group: 'Checkmates', title: 'Rook mate', fen: '8/8/8/4k3/8/8/8/R3K3 w - - 0 1', goal: 'mate', moves: 20, tip: 'Cut the king off with the rook, walk your king opposite theirs, then check.' },
  { id: 'krr', group: 'Checkmates', title: 'Two-rook ladder', fen: '8/8/8/4k3/8/8/8/R3K2R w - - 0 1', goal: 'mate', moves: 8, tip: 'The rooks take turns checking, one rank further each time; keep them far from the king.' },
  { id: 'kbb', group: 'Checkmates', title: 'Two bishops', fen: '8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1', goal: 'mate', moves: 25, tip: 'Side by side, the bishops make a wall; push the king to a corner with your king\'s help.' },
  { id: 'kp6', group: 'Pawn endgames', title: 'King in front of the pawn', fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1', goal: 'win', moves: 12, tip: 'With your king on the sixth in front of the pawn, it wins whoever moves. Keep the opposition.' },
  { id: 'kpopp', group: 'Pawn endgames', title: 'Take the opposition', fen: '8/8/3k4/8/3K4/8/3P4/8 w - - 0 1', goal: 'win', moves: 20, tip: 'The kings face each other and it is your move: spend the pawn\'s spare tempo (d3) to hand them the move and keep the opposition.' },
  { id: 'kpdraw', group: 'Pawn endgames', title: 'Hold the draw', fen: '8/8/8/8/4k3/8/4P3/4K3 b - - 0 1', side: 'b', goal: 'draw', moves: 20, tip: 'Block the pawn with your king and keep the opposition; when it reaches the seventh, stay in front.' },
  { id: 'qvp', group: 'Queen endgames', title: 'Queen against a pawn', fen: '8/6K1/8/8/8/8/2kp4/7Q w - - 0 1', goal: 'win', moves: 20, tip: 'Check or pin until the king has to stand in front of its pawn, then bring your king one step closer.' },
  { id: 'lucena', group: 'Rook endgames', title: 'Lucena: build a bridge', fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1', goal: 'win', moves: 20, tip: 'Check the king away, put your rook on the fourth rank, walk your king out and block checks with the rook.' },
  { id: 'philidor', group: 'Rook endgames', title: 'Philidor: hold the draw', fen: '4k3/7r/8/3KP3/8/8/8/R7 b - - 0 1', side: 'b', goal: 'draw', moves: 25, tip: 'Rook on the sixth rank until the pawn advances, then check from behind.' },
];
const DR_KEY = 'cl:drills:v1';
const dr = { cur: null, board: null, engine: null, line: [], busy: false, over: null, built: false };
const drStore = () => store.get(DR_KEY, {});

function renderDrills(sec) {
  if (!$('#drBoard', sec)) {
    sec.innerHTML = `<div class="card">
      <div><h3>Drills</h3><div class="sub">Standard checkmates and endgames against Stockfish at full strength.</div></div>
      <div class="dr-list"></div>
      <div class="twin-stage dr-stage hidden"><div><div class="muted small dr-meta" style="margin-bottom:6px"></div>
        <div class="match-board" style="--bs:min(440px, calc(100vw - 60px))"><div class="board" id="drBoard"></div></div></div>
        <div class="twin-panel dr-panel"></div></div></div>`;
    dr.board = new BoardView($('#drBoard', sec), { onMove: (mv, fenAfter) => drMove(mv, fenAfter) });
  }
  drList();
}

function drList() {
  const done = drStore(), el = $('.dr-list');
  if (!el) return;
  el.innerHTML = [...groupBy(DRILLS, d => d.group)].map(([g, ds]) => `<div class="dr-group"><div class="sub">${g}</div>${ds.map(d => `<button class="learn-chip ${dr.cur?.id === d.id ? 'active' : ''}" data-dr="${d.id}">${done[d.id] ? '✓ ' : ''}${esc(d.title)}</button>`).join('')}</div>`).join('');
  $$('[data-dr]', el).forEach(b => b.onclick = () => drStart(DRILLS.find(d => d.id === b.dataset.dr)));
}

const drSide = d => d.side || d.fen.split(' ')[1];
const drFen = () => { const c = new Chess(dr.cur.fen); dr.line.forEach(s => c.move(s)); return c; };
const drYourMoves = () => Math.ceil(dr.line.length / 2);

function drStart(d) {
  Object.assign(dr, { cur: d, line: [], busy: false, over: null, msg: null, evalTxt: '' });
  dr.engine ||= NATIVE_SF ? new Engine({ native: true }) : getEnginePool()[0];
  $('.dr-stage').classList.remove('hidden');
  dr.board.jump({ fen: d.fen, orientation: drSide(d) === 'w' ? 'white' : 'black' });
  drList(); drPanel();
  if (new Chess(d.fen).turn() !== drSide(d)) drReply();
}

// the engine's view after your move: White-POV {cp, mate} → for you
async function drEval(fen) {
  const r = await dr.engine.analyse(fen, 18, 6000, 1);
  const sign = drSide(dr.cur) === 'w' ? 1 : -1;
  return { cp: r.mate != null ? Math.sign(r.mate) * sign * 10000 : (r.cp ?? 0) * sign, mate: r.mate != null ? r.mate * sign : null, best: r.best };
}

async function drMove(mv, fenAfter) {
  const d = dr.cur;
  if (!d || dr.busy || dr.over || new Chess(drFen().fen()).turn() !== drSide(d)) return;
  dr.line.push(mv.san);
  const orientation = dr.board.state.orientation;
  dr.board.set({ fen: fenAfter, orientation, lastMove: { from: mv.from, to: mv.to } });
  const c = new Chess(fenAfter);
  if (c.in_checkmate()) return drEnd(true, `Checkmate in ${drYourMoves()} moves${drYourMoves() <= d.moves ? '' : ` (target ${d.moves})`}.`);
  if (c.in_draw() || c.in_stalemate() || c.in_threefold_repetition()) return d.goal === 'draw' ? drEnd(true, 'Drawn.') : drEnd(false, c.in_stalemate() ? 'Stalemate: the win slipped away.' : 'The game is drawn.');
  dr.busy = true; drPanel('Checking…');
  const e = await drEval(fenAfter);
  if (dr.cur !== d) return;
  dr.evalTxt = e.mate != null ? (e.mate > 0 ? `mate in ${Math.abs(e.mate)}` : `mated in ${Math.abs(e.mate)}`) : `${e.cp >= 0 ? '+' : '−'}${(Math.abs(e.cp) / 100).toFixed(1)}`;
  // a slip ends the drill at once
  if (d.goal !== 'draw' && e.cp < 300) return drEnd(false, `That move lets the win slip (${dr.evalTxt} for you).`);
  if (d.goal === 'draw' && e.cp < -300) return drEnd(false, `That move loses (${dr.evalTxt}).`);
  if (d.goal === 'mate' && drYourMoves() >= d.moves) return drEnd(false, `Out of moves: ${d.moves} were allowed.`);
  if (d.goal === 'win' && /=Q/.test(mv.san) && e.cp >= 500) return drEnd(true, 'Promoted with a winning position.');
  // their last pawn gone while you keep a queen or rook: the rest is a basic mate
  const pieces = c.board().flat().filter(Boolean);
  if (d.goal === 'win' && e.cp >= 500 && pieces.filter(p => p.color !== drSide(d)).length === 1 && pieces.some(p => p.color === drSide(d) && 'qr'.includes(p.type)))
    return drEnd(true, 'Only their king is left: the rest is a basic mate.');
  if (d.goal === 'draw' && drYourMoves() >= d.moves) return drEnd(true, `Held for ${d.moves} moves.`);
  if (d.goal === 'win' && drYourMoves() >= d.moves) return drEnd(false, `Still not won after ${d.moves} moves.`);
  drReply();
}

async function drReply() {
  const d = dr.cur, c = drFen();
  dr.busy = true; drPanel();
  const r = await dr.engine.analyse(c.fen(), 18, 6000, 1);
  if (dr.cur !== d) return;
  const mv = r.best && c.move({ from: r.best.slice(0, 2), to: r.best.slice(2, 4), promotion: r.best[4] });
  if (!mv) return drEnd(false, 'The engine has no move.');
  await sleep(250);
  dr.line.push(mv.san);
  dr.board.set({ fen: c.fen(), orientation: dr.board.state.orientation, lastMove: { from: mv.from, to: mv.to } });
  if (c.in_checkmate()) return drEnd(false, 'You were mated.');
  if (c.in_draw() || c.in_stalemate() || c.in_threefold_repetition()) return d.goal === 'draw' ? drEnd(true, 'Drawn.') : drEnd(false, 'The game is drawn.');
  if (d.goal === 'win' && /=Q/.test(mv.san)) return drEnd(false, 'They promoted.');
  dr.busy = false; drPanel();
}

function drEnd(ok, msg) {
  Object.assign(dr, { over: ok ? 'won' : 'lost', busy: false, msg });
  Sound.play(ok ? 'good' : 'bad');
  if (ok) { const s = drStore(); s[dr.cur.id] = { done: true, best: Math.min(s[dr.cur.id]?.best || 99, drYourMoves()) }; store.set(DR_KEY, s); drList(); }
  drPanel();
}

async function drHint() {
  if (!dr.cur || dr.busy || dr.over) return;
  dr.busy = true; drPanel('Thinking…');
  const r = await dr.engine.analyse(drFen().fen(), 18, 6000, 1);
  dr.busy = false;
  if (r.best) dr.board.set({ ...dr.board.state, arrows: [{ from: r.best.slice(0, 2), to: r.best.slice(2, 4), color: cssVar('--good'), width: 0.22 }] });
  drPanel();
}

function drPanel(working) {
  const panel = $('.dr-panel'), meta = $('.dr-meta'), d = dr.cur;
  if (!panel || !d) return;
  const goal = d.goal === 'mate' ? `Mate in ${d.moves} moves or fewer` : d.goal === 'win' ? 'Win: mate, or promote into a won position' : `Hold the draw for ${d.moves} moves`;
  const best = drStore()[d.id]?.best;
  meta.textContent = `${d.group} · ${d.title}${best && best < 99 ? ` · your best: ${best} moves` : ''}`;
  panel.innerHTML = `<h3>${dr.over ? (dr.over === 'won' ? '✓ Done' : '✗ Not this time') : `You play ${drSide(d) === 'w' ? 'White' : 'Black'}`}</h3>
    <p class="small"><b>${goal}</b></p>
    ${dr.msg ? `<p class="small">${esc(dr.msg)}</p>` : ''}
    <p class="small muted">Moves: ${drYourMoves()}${dr.evalTxt ? ` · engine: ${dr.evalTxt}` : ''}${working ? ` · ${working}` : ''}</p>
    <p class="small muted"><i>${esc(d.tip)}</i></p>
    <div class="learn-actions">${dr.over ? '<button class="btn primary" id="drAgain">Try again</button>' : '<button class="btn" id="drHint">Hint</button><button class="btn" id="drRestart">Restart</button>'}
      <button class="btn" id="drNext">Next drill →</button></div>`;
  $('#drAgain', panel)?.addEventListener('click', () => drStart(d));
  $('#drRestart', panel)?.addEventListener('click', () => drStart(d));
  $('#drHint', panel)?.addEventListener('click', drHint);
  $('#drNext', panel)?.addEventListener('click', () => drStart(DRILLS[(DRILLS.indexOf(d) + 1) % DRILLS.length]));
}
