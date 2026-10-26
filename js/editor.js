// Board editor: set up any position (drag pieces anywhere, paint from the palette, FEN in and out, side to move,
// castling), play moves from it, and ask any bot what it would play there: Stockfish, Maia at a rating, a legend,
// one of your arena bots, the Your bot tab's bot, or a new bot built from any player's games. Each answer stays as a
// card for that position, so several bots can be compared on the same position.
const ED_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const ed = {
  grid: {}, turn: 'w', castle: { K: true, Q: true, k: true, q: true }, ep: '-', clock: [0, 1], tool: 'hand', flipped: false,
  mode: 'edit', startFen: null, line: [], idx: 0,
  who: 'sf', rating: 1500, pick: { kind: 'chesscom', user: '', tc: 'all', recent: 100, title: 'GM', max: 300 },
  results: [], busy: false, token: 0, status: '', engine: null, board: null, built: false,
};
const ED_PIECES = ['k', 'q', 'r', 'b', 'n', 'p'];

function edLoadPlacement(fen) {
  const [place, turn = 'w', castle = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/), grid = {};
  const rows = place.split('/');
  if (rows.length !== 8) return false;
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (/[1-8]/.test(ch)) c += +ch;
      else if (/[kqrbnpKQRBNP]/.test(ch)) grid[FILES[c++] + (8 - r)] = ch;
      else return false;
    }
    if (c !== 8) return false;
  }
  Object.assign(ed, { grid, turn: turn === 'b' ? 'b' : 'w', castle: { K: castle.includes('K'), Q: castle.includes('Q'), k: castle.includes('k'), q: castle.includes('q') },
    ep: /^[a-h][36]$/.test(ep) ? ep : '-', clock: [+half || 0, Math.max(1, +full || 1)] });
  return true;
}

function edPlacement() {
  return [8, 7, 6, 5, 4, 3, 2, 1].map(r => {
    let row = '', gap = 0;
    for (const f of FILES) { const p = ed.grid[f + r]; if (p) { row += (gap || '') + p; gap = 0; } else gap++; }
    return row + (gap || '');
  }).join('/');
}

// castling only where the king and rook still stand at home
function edCastle() {
  const g = ed.grid, ok = { K: g.e1 === 'K' && g.h1 === 'R', Q: g.e1 === 'K' && g.a1 === 'R', k: g.e8 === 'k' && g.h8 === 'r', q: g.e8 === 'k' && g.a8 === 'r' };
  const s = 'KQkq'.split('').filter(k => ed.castle[k] && ok[k]).join('');
  return { s: s || '-', ok };
}
// (an en passant square from a pasted FEN lasts until the next change on the board)
const edSetupFen = () => `${edPlacement()} ${ed.turn} ${edCastle().s} ${ed.ep} ${ed.clock[0]} ${ed.clock[1]}`;

// what is wrong with the set-up position, if anything
function edProblem(fen) {
  const pieces = Object.values(ed.mode === 'edit' ? ed.grid : {});
  if (ed.mode === 'edit') {
    for (const [k, name] of [['K', 'White'], ['k', 'Black']]) {
      const n = pieces.filter(p => p === k).length;
      if (n !== 1) return `${name} needs exactly one king.`;
    }
    if (Object.entries(ed.grid).some(([sq, p]) => /p/i.test(p) && /[18]/.test(sq[1]))) return 'Pawns can\'t stand on the first or last rank.';
    if (pieces.filter(p => p === 'P').length > 8 || pieces.filter(p => p === 'p').length > 8) return 'More than eight pawns of one colour.';
  }
  const c = new Chess();
  if (!c.load(fen)) return 'Not a valid position.';
  // the side that just moved can't be in check
  const flipped = new Chess(); flipped.load(fen.replace(/ [wb] /, t => (t === ' w ' ? ' b ' : ' w ')));
  if (flipped.in_check()) return `${c.turn() === 'w' ? 'Black' : 'White'} is in check with ${c.turn() === 'w' ? 'White' : 'Black'} to move.`;
  if (c.game_over()) return c.in_checkmate() ? 'Checkmate: no moves to show.' : c.in_stalemate() ? 'Stalemate: no moves to show.' : null;
  return null;
}

const edChess = (upto = ed.idx) => { const c = new Chess(ed.startFen); ed.line.slice(0, upto).forEach(s => c.move(s)); return c; };
const edFen = () => (ed.mode === 'edit' ? edSetupFen() : edChess().fen());
const edFens = () => { if (ed.mode === 'edit') return [edSetupFen()]; const c = new Chess(ed.startFen), f = [c.fen()]; ed.line.slice(0, ed.idx).forEach(s => { c.move(s); f.push(c.fen()); }); return f; };

function renderEditor(sec) {
  if (!ed.built) {
    sec.innerHTML = `<div class="rv">
      <div class="rv-board">
        <div class="ed-palette" id="edPalTop"></div>
        <div class="board-wrap"><div class="board" id="edBoard"></div></div>
        <div class="ed-palette" id="edPalBottom"></div>
        <div class="controls">
          <button class="btn" data-ednav="prev" title="Back (←)">◀</button>
          <button class="btn" data-ednav="next" title="Forward (→)">▶</button>
          <button class="btn" data-ednav="flip" title="Flip board">⇅</button>
        </div>
      </div>
      <div class="rv-panel">
        <div class="rv-head" id="edHead"></div>
        <div class="rv-body scroll" id="edBody"></div>
      </div></div>`;
    ed.built = true;
    edLoadPlacement(ED_START + ' w KQkq');
    ed.board = new BoardView($('#edBoard', sec), { onMove: mv => edPlay(mv.san) });
    ed.board.edit = { tool: () => ed.tool, place: edPlace, move: edMovePiece };
    $$('[data-ednav]', sec).forEach(b => b.onclick = () => edNav(b.dataset.ednav));
    document.addEventListener('keydown', e => {
      if (S.tab !== 'editor' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); edNav('prev'); }
      if (e.key === 'ArrowRight') { e.preventDefault(); edNav('next'); }
    });
    ed.engine ||= NATIVE_SF ? new Engine({ native: true }) : getEnginePool()[0];
  }
  edDraw();
}

// open a position from elsewhere (Review's current position)
function openInEditor(fen) {
  switchTab('editor');
  edLoadPlacement(fen);
  edToEdit(true);
}

function edPlace(sq, piece) {
  ed.ep = '-';
  if (piece) ed.grid[sq] = piece; else delete ed.grid[sq];
  edDraw();
}
function edMovePiece(from, to) {
  ed.ep = '-';
  ed.grid[to] = ed.grid[from]; delete ed.grid[from];
  edDraw();
}
// keep: the grid was just loaded (a pasted FEN), so don't take the played position over it
function edToEdit(keep = false) {
  if (!keep && ed.mode === 'play') edLoadPlacement(edChess().fen());
  Object.assign(ed, { mode: 'edit', line: [], idx: 0, startFen: null });
  ed.board.edit = { tool: () => ed.tool, place: edPlace, move: edMovePiece };
  edDraw();
}
function edToPlay() {
  const fen = edSetupFen();
  if (edProblem(fen) && !/Checkmate|Stalemate/.test(edProblem(fen))) return;
  Object.assign(ed, { mode: 'play', startFen: fen, line: [], idx: 0 });
  ed.board.edit = null;
  edDraw();
}
function edPlay(san) {
  if (ed.mode !== 'play') return;
  ed.line = ed.line.slice(0, ed.idx); ed.line.push(san); ed.idx = ed.line.length;
  edDraw();
}
function edNav(cmd) {
  if (cmd === 'flip') ed.flipped = !ed.flipped;
  else if (ed.mode !== 'play') return;
  else if (cmd === 'prev') ed.idx = Math.max(0, ed.idx - 1);
  else if (cmd === 'next') ed.idx = Math.min(ed.line.length, ed.idx + 1);
  edDraw();
}

// ---------- asking a bot ----------
function edWhoLabel(who = ed.who) {
  if (who === 'sf') return 'Stockfish';
  if (who === 'rating') return `Maia ${ed.rating}`;
  if (who === 'yourbot') return botv.model ? `${botv.model.label} bot` : 'Your bot';
  if (who === 'player') return 'a new player bot';
  return botInfo(who)?.name || 'Bot';
}

async function edAsk() {
  const fen = edFen(), problem = edProblem(fen);
  if (problem || ed.busy) return;
  if (ed.who === 'player') return;   // the picker's button builds the bot first
  const token = ++ed.token, who = ed.who, fens = edFens(), say = m => { ed.status = String(m).replace(/<[^>]+>/g, ''); edDrawStatus(); };
  ed.busy = true; ed.status = ''; edDraw();
  try {
    if (who === 'sf') say('Stockfish is thinking…');
    const res = who === 'sf' ? await edAskStockfish(fen) : await edAskBot(who, fens, say);
    if (token !== ed.token) return;
    ed.results = ed.results.filter(r => !(r.fen === fen && r.key === res.key));
    ed.results.unshift({ ...res, fen });
  } catch (e) {
    if (token === ed.token) ed.status = 'Could not get a move: ' + (e.message || e);
  }
  if (token !== ed.token) return;
  ed.busy = false;
  if (!/^Could not/.test(ed.status)) ed.status = '';
  edDraw();
}

async function edAskStockfish(fen) {
  const depth = NATIVE_SF ? 20 : 15;   // five lines to depth 20 take about 4 s on the desktop engine
  const r = await ed.engine.analyse(fen, depth, 8000, 5);
  const rows = r.lines.filter(l => l.pv?.length).map(l => ({ san: uciToSan(fen, l.pv[0]), uci: l.pv[0], ev: l }));
  return { key: 'sf', name: 'Stockfish', note: `Stockfish ${NATIVE_SF ? 19 : 10} · depth ${r.lines[0]?.depth || depth} · its top ${rows.length} moves`, rows };
}

async function edAskBot(who, fens, say) {
  let bot;
  if (who === 'rating') {
    const maia = await arenaMaia(say);
    bot = { label: `Maia ${ed.rating}`, maia, playRating: capRating(chesscomToLichess(ed.rating)), trees: { white: new Map(), black: new Map() } };
  } else if (who === 'yourbot') {
    if (!botv.model) throw new Error('build a bot on Bots › Your bot first');
    bot = botv.model;
  } else bot = await ensureBot(who, say);
  const fen = fens.at(-1);
  say(`${bot.label}: thinking…`);
  const dist = await botDistribution(bot, fens);
  let rows = dist.moves, note;
  if (dist.source === 'book') note = `From their own games: reached here in ${dist.n} of them`;
  else if (bot.fidelity) { rows = await fidRanked(bot, dist.moves, fen, ed.engine); note = `Maia-3 at ~${bot.playRating}, weighted to how often they really err`; }
  else note = `Maia-3: how often a ${who === 'rating' ? ed.rating + ' (chess.com)' : '~' + bot.playRating + ' (Lichess)'} player picks each move`;
  const c = new Chess(fen);
  rows = rows.slice(0, 6).map(m => { const mv = c.move(m.san, { sloppy: true }); if (mv) c.undo(); return { san: m.san, uci: mv ? mv.from + mv.to + (mv.promotion || '') : m.uci, p: m.p, games: m.games }; }).filter(m => m.uci);
  return { key: who === 'rating' ? 'r:' + ed.rating : who, name: bot.label + (who === 'rating' ? '' : ' bot'), note, rows, rating: who === 'rating' ? ed.rating : null };
}

// a bot from any player's games: saved with your arena bots, then asked
function edBuildPlayer(src) {
  const name = src.kind === 'otb' ? src.name : src.user;
  const rec = { id: 'u:' + Math.random().toString(36).slice(2, 9), name, src, nGames: 80, mode: 'sample', fid: 'high' };
  arena.roster.push(rec); saveRoster();
  ed.who = rec.id;
  edDraw(); edAsk();
}

// ---------- drawing ----------
// a palette button: a click picks the tool (again: back to the hand); a piece dragged onto the board is placed there
function edPaletteDown(e, tool) {
  if (e.button !== 0) return;
  e.preventDefault();
  const toggle = () => { ed.tool = ed.tool === tool && tool !== 'hand' ? 'hand' : tool; edDraw(); };
  if (tool === 'hand' || tool === 'erase') return toggle();
  const s = ed.board.el.clientWidth / 8, img = document.createElement('img'), x0 = e.clientX, y0 = e.clientY;
  img.src = pieceSrc(tool); img.className = 'ed-ghost'; img.style.width = img.style.height = s + 'px';
  const pos = ev => { img.style.transform = `translate(${ev.clientX - s / 2}px, ${ev.clientY - s / 2}px) scale(1.12)`; };
  let moved = false;
  const mv = ev => { if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3) { moved = true; document.body.appendChild(img); } pos(ev); };
  const up = ev => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); img.remove();
    if (!moved) return toggle();
    const sq = ed.board.squareAt(ev);
    if (sq) { ed.tool = tool; edPlace(sq, tool); }
  };
  pos(e);
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

function edDrawStatus() { const el = $('#edStatus'); if (el) el.textContent = ed.status || ''; }

function edPalette(color) {
  const tools = color === 'w' ? `<button class="ed-tool ${ed.tool === 'hand' ? 'on' : ''}" data-edtool="hand" title="Move pieces (drag off the board to remove)">✥</button>`
    : `<button class="ed-tool ${ed.tool === 'erase' ? 'on' : ''}" data-edtool="erase" title="Erase (or right-click a square)">✕</button>`;
  return tools + ED_PIECES.map(p => { const code = color === 'w' ? p.toUpperCase() : p; return `<button class="ed-pc ${ed.tool === code ? 'on' : ''}" data-edtool="${code}" title="Place"><img src="${pieceSrc(code)}" alt="${code}" draggable="false"></button>`; }).join('');
}

function edDraw() {
  if (!ed.built) return;
  const fen = edFen(), problem = edProblem(fen), playing = ed.mode === 'play';
  const orientation = ed.flipped ? 'black' : 'white';
  const last = playing && ed.idx ? (() => { const m = edChess(ed.idx - 1).move(ed.line[ed.idx - 1]); return { from: m.from, to: m.to }; })() : null;
  const cards = ed.results.filter(r => r.fen === fen);
  const arrows = [];
  if (cards[0] && !problem) cards[0].rows.slice(0, 4).forEach((m, i) => arrows.push({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), color: cssVar(i ? '--s1' : '--good'), width: i ? 0.15 : 0.22, opacity: i ? Math.max(0.5, Math.min(0.8, (m.p ?? 0.5) * 1.5)) : 0.9 }));
  // edits show at once (no slides or sounds); played moves slide as anywhere else
  ed.board[playing ? 'set' : 'jump']({ fen, orientation, lastMove: last, arrows });
  // palettes: the colour at the top of the board above it
  const topCol = orientation === 'white' ? 'b' : 'w';
  $('#edPalTop').innerHTML = playing ? '' : edPalette(topCol);
  $('#edPalBottom').innerHTML = playing ? '' : edPalette(topCol === 'w' ? 'b' : 'w');
  $$('[data-edtool]').forEach(b => b.onpointerdown = e => edPaletteDown(e, b.dataset.edtool));

  const ok = edCastle().ok;
  const cb = (k, label) => `<label class="${ok[k] ? '' : 'muted'}"><input type="checkbox" data-edc="${k}" ${ed.castle[k] && ok[k] ? 'checked' : ''} ${ok[k] && !playing ? '' : 'disabled'}> ${label}</label>`;
  const toks = ed.line.map((s, i) => { const ply = i + (ed.startFen?.split(' ')[1] === 'b' ? 1 : 0), n = +(ed.startFen?.split(' ')[5] || 1) + Math.floor(ply / 2);
    return `<span class="mv ${i + 1 === ed.idx ? 'cur' : ''}" data-edi="${i + 1}">${ply % 2 === 0 ? `${n}.` : i === 0 ? `${n}...` : ''}${esc(s)}</span>`; }).join(' ');
  const legends = FAMOUS.map(f => `<option value="f:${f.id}" ${ed.who === 'f:' + f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const mine = arena.roster.map(r => `<option value="${esc(r.id)}" ${ed.who === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  $('#edHead').innerHTML = `<div class="row-between"><div class="seg"><button data-edmode="edit" class="${playing ? '' : 'active'}">Set up</button><button data-edmode="play" class="${playing ? 'active' : ''}" ${problem && !/Checkmate|Stalemate/.test(problem) && !playing ? 'disabled' : ''}>Play moves</button></div>
      ${playing ? '' : `<div class="seg"><button data-edturn="w" class="${ed.turn === 'w' ? 'active' : ''}">White to move</button><button data-edturn="b" class="${ed.turn === 'b' ? 'active' : ''}">Black to move</button></div>`}</div>
    ${playing ? `<div class="var-line small" style="margin-top:8px">${toks || '<span class="muted">Play a move on the board</span>'}</div>`
      : `<div class="prep-opts">${cb('K', 'White O-O')}${cb('Q', 'White O-O-O')}${cb('k', 'Black O-O')}${cb('q', 'Black O-O-O')}</div>
      <div class="prep-opts"><button class="btn small-btn" id="edStart">Starting position</button><button class="btn small-btn" id="edClear">Clear board</button></div>`}
    <div class="ed-fen"><input id="edFenIn" value="${esc(fen)}" spellcheck="false" ${playing ? 'readonly' : ''} title="FEN: paste one and press Enter"><button class="btn small-btn" id="edCopy">Copy</button></div>
    ${problem ? `<div class="small ${/Checkmate|Stalemate/.test(problem) ? 'muted' : 'bad'}">${esc(problem)}</div>` : ''}`;
  $$('[data-edmode]').forEach(b => b.onclick = () => (b.dataset.edmode === 'play' ? edToPlay() : edToEdit()));
  $$('[data-edturn]').forEach(b => b.onclick = () => { ed.turn = b.dataset.edturn; ed.ep = '-'; edDraw(); });
  $$('[data-edc]').forEach(x => x.onchange = () => { ed.castle[x.dataset.edc] = x.checked; edDraw(); });
  $('#edStart')?.addEventListener('click', () => { edLoadPlacement(ED_START + ' w KQkq'); edDraw(); });
  $('#edClear')?.addEventListener('click', () => { edLoadPlacement('8/8/8/8/8/8/8/8 w -'); edDraw(); });
  $('#edCopy').onclick = () => { navigator.clipboard?.writeText(fen); $('#edCopy').textContent = 'Copied'; };
  const fin = $('#edFenIn');
  const loadFen = () => { if (fin.value.trim() === fen) return; if (edLoadPlacement(fin.value)) edToEdit(true); else fin.classList.add('bad-input'); };
  fin.onkeydown = e => { if (e.key === 'Enter') loadFen(); };
  fin.onchange = loadFen;
  $$('#edHead [data-edi]').forEach(e => e.onclick = () => { ed.idx = +e.dataset.edi; edDraw(); });

  const whoOpts = `<option value="sf" ${ed.who === 'sf' ? 'selected' : ''}>Stockfish</option>
    <option value="rating" ${ed.who === 'rating' ? 'selected' : ''}>Maia at a rating</option>
    <optgroup label="Legends">${legends}</optgroup>
    <optgroup label="Player bots">${mine}${botv.model ? `<option value="yourbot" ${ed.who === 'yourbot' ? 'selected' : ''}>${esc(botv.model.label)} (Your bot)</option>` : ''}<option value="player" ${ed.who === 'player' ? 'selected' : ''}>Any player…</option></optgroup>`;
  let html = `<div class="ed-ask"><label class="small muted">Ask</label> <select id="edWho">${whoOpts}</select>
      ${ed.who === 'rating' ? `<span class="ed-rating"><input type="range" id="edRating" min="400" max="2600" step="50" value="${ed.rating}"><b id="edRatingVal">${ed.rating}</b></span>` : ''}
      ${ed.who !== 'player' ? `<button class="btn primary" id="edShow" ${problem || ed.busy ? 'disabled' : ''}>Show ${esc(edWhoLabel())}'s move</button>` : ''}</div>
    ${ed.who === 'player' ? `<div class="sub" style="margin-top:6px">Builds a bot from their games (high fidelity, 80 games: 1–5 minutes), saves it with your arena bots, then asks it.</div>
      ${sourcePickerHtml('edPicker', ed.pick, { button: 'Build and ask' })}${S.username ? '<button class="btn small-btn" id="edMe" style="margin-top:6px">Use my games</button>' : ''}` : ''}
    <div class="muted small" id="edStatus">${esc(ed.status || '')}</div>`;
  html += cards.map((r, i) => `<div class="ed-card ${i ? '' : 'latest'}">
      <div class="row-between"><b>${esc(r.name)}</b><button class="btn small-btn" data-eddel="${i}" title="Remove">✕</button></div>
      <div class="muted small">${esc(r.note)}</div>
      <table class="tree-table"><tbody>${r.rows.map(m => `<tr><td><b>${esc(m.san)}</b></td>
        <td>${m.ev ? `<span class="ev ${evalToCp(m.ev) >= 0 ? 'ev-w' : 'ev-b'}">${fmtEval(m.ev)}</span>` : `<div class="share"><div style="width:${Math.round(m.p * 100)}%"></div></div><span class="small">${pct(m.p, m.p < 0.1 ? 1 : 0)}</span>${m.games ? ` <span class="muted small">${m.games} games</span>` : ''}`}</td>
        <td class="num"><button class="btn small-btn" data-edplay="${esc(m.san)}">Play</button></td></tr>`).join('')}</tbody></table></div>`).join('');
  if (!cards.length && !problem) html += `<p class="muted small" style="margin-top:10px">Pick who to ask and press Show: their moves for this position appear here, with arrows on the board. Ask several to compare.</p>`;
  $('#edBody').innerHTML = html;
  $('#edWho').onchange = e => { ed.who = e.target.value; edDraw(); };
  const rr = $('#edRating');
  if (rr) { rr.oninput = e => { $('#edRatingVal').textContent = e.target.value; $('#edShow').textContent = `Show Maia ${e.target.value}'s move`; }; rr.onchange = e => { ed.rating = +e.target.value; edDraw(); }; }
  $('#edShow')?.addEventListener('click', edAsk);
  if (ed.who === 'player') {
    bindSourcePicker($('#edPicker'), ed.pick, edBuildPlayer);
    $('#edMe')?.addEventListener('click', () => edBuildPlayer(mySource(ed.pick)));
  }
  $$('[data-eddel]').forEach(b => b.onclick = () => { const r = cards[+b.dataset.eddel]; ed.results = ed.results.filter(x => x !== r); edDraw(); });
  $$('[data-edplay]').forEach(b => b.onclick = () => { if (ed.mode !== 'play') edToPlay(); if (ed.mode === 'play') edPlay(b.dataset.edplay); });
}
