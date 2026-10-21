// Prepare tab: play against a player: their opening repertoire, built from their games, and once they're out of
// book, their player bot (js/bot.js: Maia-3 fitted to their strength, with a blunder check set to their own
// blunder rate), so the whole game is played the way they play. Stockfish or stopping are the alternatives.
const prep = {
  pick: { kind: 'chesscom', user: '', months: 3, title: 'GM', max: 300 },
  src: null, data: null, loading: false, error: null,
  color: 'white', tc: 'all', mode: 'top', hints: true, fallback: 'bot',   // out of book: 'bot' | 'engine' | 'off'
  line: [], idx: 0, flipped: false, sub: 'position',
  trees: null, games: [], book: null,
  board: null, live: null, liveFen: null, liveLines: [], liveDone: false, botTimer: null, built: false,
};

function prepGames() {
  const gs = prep.data ? prep.data.games : [];
  return prep.tc === 'all' ? gs : gs.filter(g => g.timeClass === prep.tc);
}

function rebuildTrees() {
  prep.games = prepGames();
  prep.trees = { white: buildTree(prep.games, 'white'), black: buildTree(prep.games, 'black') };
}

async function setPrepSource(src, { color, line } = {}) {
  const token = prep.token = (prep.token || 0) + 1; // a slower earlier load must not overwrite a newer one
  clearTimeout(prep.botTimer);
  prep.src = src; prep.loading = true; prep.error = null;
  if (color) prep.color = color;
  prep.line = line ? [...line] : []; prep.idx = prep.line.length;
  refreshPrepare();
  try {
    const data = await loadSource(src, msg => { const s = $('#prepStatus'); if (s && token === prep.token) showStatus(s, msg); });
    if (token !== prep.token) return;
    prep.data = data;
    const tcs = new Set(prep.data.games.map(g => g.timeClass));
    if (prep.tc !== 'all' && !tcs.has(prep.tc)) prep.tc = 'all';
    rebuildTrees();
    if (prep.fallback === 'bot') ensurePrepBot();   // built in the background, ready by the time they leave book
  } catch (e) {
    if (token !== prep.token) return;
    prep.error = e.message || String(e); prep.data = null; prep.trees = null;
  }
  prep.loading = false;
  refreshPrepare();
  maybeBotMove();
}

// Open the Prepare tab on a specific source/color/line (used by Head to head)
function prepareLine(src, color, sans) {
  switchTab('prepare');
  setPrepSource(src, { color, line: sans });
}

// ---------- position helpers ----------
function prepChess(upto = prep.idx) {
  const c = new Chess();
  for (const s of prep.line.slice(0, upto)) c.move(s);
  return c;
}
const keyOf = fen => fen.split(' ').slice(0, 4).join(' ');
const targetTurn = c => c.turn() === prep.color[0];
const userColor = () => prep.color === 'white' ? 'black' : 'white';

// ---------- markup (built once; panels refresh in place) ----------
function renderPrepare(sec) {
  if (!prep.built) {
    sec.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="row-between"><div style="max-width:780px"><h3>Prepare against a player</h3>
          <div class="sub">Plays a player's openings at you, then plays on as their bot.</div></div></div>
        ${sourcePickerHtml('prepPicker', prep.pick, { button: 'Build tree' })}
        <div class="prep-opts">
          <button class="btn small-btn" id="prepMe">Use my games</button>
          <label>They play <select id="prepColor"><option value="white">White</option><option value="black">Black</option></select></label>
          <label>Time control <select id="prepTc"></select></label>
          <label>Their moves <select id="prepMode"><option value="top">Most common</option><option value="weighted">Weighted by frequency</option></select></label>
          <label><input type="checkbox" id="prepHints"> Engine hints</label>
          <label>Out of their book <select id="prepFallback"><option value="bot">Their bot plays on</option><option value="engine">Stockfish plays on</option><option value="off">Stop</option></select></label>
        </div>
        <div class="muted small" id="prepStatus" style="margin-top:6px"></div>
        <div class="muted small" id="prepBotStatus"></div>
      </div>
      <div class="rv prep">
        <div class="rv-board">
          <div class="player-line" id="prepTop"></div>
          <div class="board-wrap">
            <div class="evalbar" id="prepEvalbar"><div class="evalfill" id="prepEvalfill"></div><span id="prepEvaltext"></span></div>
            <div class="board" id="prepBoard"></div>
          </div>
          <div class="player-line" id="prepBottom"></div>
          <div class="controls">
            <button class="btn" data-pnav="start" title="Start">⏮</button>
            <button class="btn" data-pnav="prev" title="Back (←)">◀</button>
            <button class="btn" data-pnav="next" title="Forward (→)">▶</button>
            <button class="btn" data-pnav="takeback" title="Take back your last move">↶</button>
            <button class="btn" data-pnav="reset" title="New game">↺</button>
            <button class="btn" data-pnav="flip" title="Flip board">⇅</button>
          </div>
        </div>
        <div class="rv-panel">
          <div class="rv-head" id="prepHead"></div>
          <div class="rv-tabs"><button data-pv="position" class="active">This position</button><button data-pv="repertoire">Their repertoire</button></div>
          <div class="rv-body scroll" id="prepPosition"></div>
          <div class="rv-body scroll hidden" id="prepRepertoire"></div>
        </div>
      </div>`;
    prep.built = true;
    if (!prep.src && S.username) { prep.pick.user = S.username; prep.pick.months = S.months; }
    bindSourcePicker($('#prepPicker'), prep.pick, src => setPrepSource(src));
    $('#prepMe').onclick = () => setPrepSource(mySource(prep.pick));
    $('#prepColor').onchange = e => { prep.color = e.target.value; prep.line = []; prep.idx = 0; refreshPrepare(); maybeBotMove(); };
    $('#prepTc').onchange = e => { prep.tc = e.target.value; rebuildTrees(); if (prep.fallback === 'bot') ensurePrepBot(); refreshPrepare(); maybeBotMove(); };
    $('#prepMode').onchange = e => prep.mode = e.target.value;
    $('#prepHints').onchange = e => { prep.hints = e.target.checked; refreshPrepare(); };
    $('#prepFallback').onchange = e => { prep.fallback = e.target.value; prep.botError = null; if (prep.fallback === 'bot' && prep.data) ensurePrepBot(); refreshPrepare(); maybeBotMove(); };
    $$('[data-pnav]').forEach(b => b.onclick = () => prepNav(b.dataset.pnav));
    $$('[data-pv]').forEach(b => b.onclick = () => { prep.sub = b.dataset.pv; refreshPrepare(); });
    prep.board = new BoardView($('#prepBoard'), { onMove: mv => prepPlay(mv.san) });
    document.addEventListener('keydown', e => {
      if (S.tab !== 'prepare' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); prepNav('prev'); }
      if (e.key === 'ArrowRight') { e.preventDefault(); prepNav('next'); }
    });
    // default: your own repertoire as White, you play Black
    if (!prep.src && S.username) setPrepSource({ kind: 'chesscom', user: S.username, months: S.months });
  }
  refreshPrepare();
}

function hidePrepare() {
  clearTimeout(prep.botTimer);
  prep.live?.stopAll();
}

// ---------- moves ----------
function prepPlay(san) {
  clearTimeout(prep.botTimer);
  prep.line = prep.line.slice(0, prep.idx);
  prep.line.push(san);
  prep.idx = prep.line.length;
  refreshPrepare();
  maybeBotMove();
}

function prepNav(cmd) {
  clearTimeout(prep.botTimer);
  if (cmd === 'start') prep.idx = 0;
  else if (cmd === 'prev') prep.idx = Math.max(0, prep.idx - 1);
  else if (cmd === 'next') prep.idx = Math.min(prep.line.length, prep.idx + 1);
  else if (cmd === 'reset') { prep.line = []; prep.idx = 0; }
  else if (cmd === 'flip') prep.flipped = !prep.flipped;
  else if (cmd === 'takeback') {
    prep.line = prep.line.slice(0, prep.idx);
    // back to the last position where it was your move
    do { prep.line.pop(); } while (prep.line.length && targetTurn(prepChess(prep.line.length)));
    prep.idx = prep.line.length;
  }
  refreshPrepare();
  if (cmd === 'reset' || cmd === 'takeback') maybeBotMove();
}

function maybeBotMove() {
  clearTimeout(prep.botTimer);
  if (!prep.trees || S.tab !== 'prepare' || prep.idx !== prep.line.length) return;
  const c = prepChess();
  if (c.game_over() || !targetTurn(c)) return;
  const node = prep.trees[prep.color].get(keyOf(c.fen()));
  const m = pickMove(node, prep.mode);
  const tok = prep.token, at = prep.line.length; // drop the move if the source or position changed meanwhile
  const play = san => { if (tok === prep.token && prep.line.length === at && prep.idx === at) prepPlay(san); };
  if (m) { prep.botTimer = setTimeout(() => play(m.san), 450); return; }
  // out of book: their bot, or the engine once its search for this position finishes
  if (prep.fallback === 'bot') { prepBotMove(play); return; }
  if (prep.fallback === 'engine' && prep.liveFen === c.fen() && prep.liveDone && prep.liveLines[0]) {
    const mv = uciMove(c.fen(), prep.liveLines[0].best);
    if (mv) prep.botTimer = setTimeout(() => play(mv.san), 300);
  }
}

// ---------- their bot ----------
// One bot at a time, for the loaded player and time control; the Your bot page's model is reused when it's the
// same player. Built quickly (no held-out test), with their measured blunder rate for the blunder check.
function ensurePrepBot() {
  if (!prep.src) return Promise.resolve(null);
  const key = sourceKey(prep.src) + '|' + prep.tc;
  if (prep.botKey === key) return prep.botP;
  if (prep.botModel && prep.botModel !== botv.model) prep.botModel.maia.terminate();
  Object.assign(prep, { botKey: key, botModel: null, botStatus: 'Building their bot…', botError: null });
  const reuse = botv.model && sourceKey(botv.model.src) === sourceKey(prep.src) && botv.model.tc === prep.tc ? botv.model : null;
  prep.botP = (reuse ? Promise.resolve(reuse) : trainPlayerBot(prep.src, {
    nGames: 80, tc: prep.tc, size: botModelSize(), evaluate: false,
    onStatus: m => { if (prep.botKey === key) { prep.botStatus = m; drawPrepBot(); } },
  })).then(model => {
    if (prep.botKey !== key) { if (model !== botv.model) model.maia.terminate(); return null; }
    Object.assign(prep, { botModel: model, botStatus: null });
    drawPrepBot(); maybeBotMove();
    return model;
  }, e => {
    if (prep.botKey !== key) return null;
    // no bot (too few games, say): Stockfish plays on instead
    Object.assign(prep, { botStatus: null, botError: e.message || String(e), fallback: 'engine' });
    refreshPrepare(); maybeBotMove();
    return null;
  });
  drawPrepBot();
  return prep.botP;
}

function drawPrepBot() {
  const el = $('#prepBotStatus');
  if (!el) return;
  const label = prep.data ? esc(prep.data.label) : 'Their';
  el.innerHTML = prep.botError ? `No bot for them (${esc(prep.botError)}): Stockfish plays on.`
    : prep.fallback !== 'bot' ? ''
    : prep.botModel ? `${label}'s bot is ready: Maia-3 at about ${prep.botModel.playRating} (Lichess scale), blundering about as often as they do.`
    : prep.botStatus || '';
}

// their bot's move for the current position (sampled like a human, or its likeliest move under "Most common")
async function prepBotMove(play) {
  const tok = prep.token, at = prep.line.length, job = tok + ':' + prep.line.join(' ');
  if (prep.botJob === job) return;   // already choosing a move for this position
  prep.botJob = job;
  const model = await ensurePrepBot();
  if (!model || tok !== prep.token || prep.line.length !== at || prep.idx !== at) return;
  const c = new Chess(), fens = [c.fen()];
  for (const s of prep.line) { c.move(s); fens.push(c.fen()); }
  try {
    const dist = await botDistribution(model, fens);
    const pick = await botPick(model, dist, prep.mode === 'top' ? 'likely' : 'sample', fens.at(-1), getEnginePool()[0]);
    if (pick) prep.botTimer = setTimeout(() => play(pick.san), 250);
  } catch (e) { prep.botError = 'the bot failed to move: ' + (e.message || e); drawPrepBot(); }
  finally { if (prep.botJob === job) prep.botJob = null; }
}

// ---------- engine ----------
function startPrepEngine(c) {
  const fen = c.fen();
  const outOfBook = prep.trees && targetTurn(c) && !sortedMoves(prep.trees[prep.color].get(keyOf(fen))).length;
  const need = !c.game_over() && (prep.hints || (prep.fallback === 'engine' && outOfBook));
  if (!need) { prep.live?.stopAll(); return; }
  if (prep.liveFen === fen) return;
  if (!prep.live) prep.live = new LiveEngine(1);
  prep.liveFen = fen; prep.liveLines = []; prep.liveDone = false;
  prep.live.start(fen, 14, (lines, done) => {
    if (prep.liveFen !== fen) return;
    prep.liveLines = lines; prep.liveDone = done;
    if (prep.hints) drawPrepEngine();
    if (done) maybeBotMove();
  });
}

function drawPrepEngine() {
  const box = $('#prepEngine');
  const l = prep.liveLines[0];
  const whiteBottom = (prep.flipped ? prep.color : userColor()) === 'white';
  if (!prep.hints || !l) { if (box) box.innerHTML = prep.hints ? '<span class="muted small">Engine thinking…</span>' : ''; paintEvalBar($('#prepEvalbar'), null, whiteBottom); return; }
  paintEvalBar($('#prepEvalbar'), l, whiteBottom);
  if (box) box.innerHTML = `<span class="ev ${evalToCp(l) >= 0 ? 'ev-w' : 'ev-b'}">${fmtEval(l)}</span> <span class="muted small">depth ${l.depth}</span> ${fmtLine(prep.liveFen, pvToSan(prep.liveFen, l.pv, 6))}`;
}

// ---------- panels ----------
function moveTable(moves, total, { clickable = true, bestTry = false } = {}) {
  if (!moves.length) return '';
  let best = null;
  if (bestTry) {
    const cands = moves.filter(m => m.n >= 3);
    if (cands.length) best = cands.reduce((a, b) => nodeScore(a) <= nodeScore(b) ? a : b);
  }
  return `<table class="tree-table"><thead><tr><th>Move</th><th class="num">Games</th><th>Share</th><th>Their result</th><th class="num">Score</th></tr></thead><tbody>
    ${moves.map(m => `<tr class="${clickable ? 'clickable' : ''}" data-san="${esc(m.san)}">
      <td><b>${esc(m.san)}</b>${m === best ? ' <span class="pill best-try">Best try</span>' : ''}</td>
      <td class="num">${m.n}</td>
      <td><div class="share"><div style="width:${Math.round(m.n / total * 100)}%"></div></div><span class="muted small">${Math.round(m.n / total * 100)}%</span></td>
      <td>${wdlBar(m)}</td><td class="num">${pct(nodeScore(m))}</td></tr>`).join('')}
  </tbody></table>`;
}

function refreshPrepare() {
  if (!prep.built) return;
  $('#prepColor').value = prep.color; $('#prepMode').value = prep.mode;
  $('#prepHints').checked = prep.hints; $('#prepFallback').value = prep.fallback;
  drawPrepBot();
  const tcs = prep.data ? [...new Set(prep.data.games.map(g => g.timeClass))] : [];
  $('#prepTc').innerHTML = `<option value="all">All</option>` + tcs.map(t => `<option value="${t}" ${prep.tc === t ? 'selected' : ''}>${t}</option>`).join('');
  $$('[data-pv]').forEach(b => b.classList.toggle('active', b.dataset.pv === prep.sub));
  $('#prepPosition').classList.toggle('hidden', prep.sub !== 'position');
  $('#prepRepertoire').classList.toggle('hidden', prep.sub !== 'repertoire');

  const status = $('#prepStatus');
  if (prep.error) status.innerHTML = `<span style="color:var(--critical)">${prep.error}</span>`;
  else if (prep.loading) { /* loader writes progress */ }
  else if (prep.data) status.textContent = `${prep.data.label}: ${prep.games.length} games${prep.tc !== 'all' ? ` (${prep.tc})` : ''} · ${prep.games.filter(g => g.color === prep.color).length} as ${prep.color}`;
  else status.textContent = '';

  const c = prepChess();
  const fen = c.fen();
  const last = prep.idx > 0 ? (() => { const cc = prepChess(prep.idx - 1); return cc.move(prep.line[prep.idx - 1]); })() : null;
  const label = prep.data ? prep.data.label : (prep.src ? sourceLabel(prep.src) : 'Opponent');
  prep.board.set({ fen, orientation: prep.flipped ? prep.color : userColor(), lastMove: last });
  const theirSide = prep.flipped ? 'bottom' : 'top';
  $(theirSide === 'top' ? '#prepTop' : '#prepBottom').innerHTML = `<span class="pl"><span class="dot ${prep.color}"></span><b>${esc(label)}</b> <span class="muted">${prep.fallback === 'bot' ? 'their repertoire, then their bot' : 'their repertoire'}</span></span>`;
  $(theirSide === 'top' ? '#prepBottom' : '#prepTop').innerHTML = `<span class="pl"><span class="dot ${userColor()}"></span><b>You</b></span>`;

  // header: opening name + clickable line
  const toks = prep.line.map((s, i) => `<span class="mv ${i + 1 === prep.idx ? 'cur' : ''}" data-pi="${i + 1}">${i % 2 === 0 ? `${i / 2 + 1}.` : ''}${esc(s)}</span>`).join(' ');
  $('#prepHead').innerHTML = `<div class="rv-meta"><b>${esc(label)}</b> as ${prep.color} <span class="muted small" id="prepOpening"></span></div>
    <div class="var-line small">${toks || '<span class="muted">Start position — ' + (targetTurn(c) ? 'they move first' : 'your move') + '</span>'}</div>`;
  $$('#prepHead [data-pi]').forEach(e => e.onclick = () => { prep.idx = +e.dataset.pi; refreshPrepare(); });
  (prep.book ? Promise.resolve(prep.book) : getBook().then(b => (prep.book = b))).then(book => {
    if (!book) return;
    let name = null;
    const cc = new Chess();
    for (const s of prep.line.slice(0, prep.idx)) { cc.move(s); const hit = bookHit(book, cc.fen()); if (hit) name = hit; }
    const el = $('#prepOpening'); if (el) el.textContent = name ? `· ${name.eco} ${name.name}` : '';
  });

  // position panel
  const pos = $('#prepPosition');
  if (!prep.data) {
    pos.innerHTML = prep.loading ? '<p class="muted">Loading games…</p>' : '<p class="muted">Pick a player above and press <b>Build tree</b>.</p>';
    $('#prepRepertoire').innerHTML = '';
    startPrepEngine(c); drawPrepEngine();
    return;
  }
  const tree = prep.trees[prep.color];
  const node = tree.get(keyOf(fen));
  const ms = sortedMoves(node);
  let html = '';
  if (c.game_over()) html += `<p><b>${c.in_checkmate() ? 'Checkmate' : 'Draw'}</b></p>`;
  else if (targetTurn(c)) {
    html += ms.length
      ? `<h3>What ${esc(label)} plays here</h3><div class="sub">${node.n} games reached this position · click a move to make them play it</div>${moveTable(ms, node.n)}`
      : `<p class="out-of-book">Out of ${esc(label)}'s book — they never reached this position as ${prep.color}. ${prep.fallback === 'bot' ? `Their bot plays for them from here${prep.botModel ? ` (about ${prep.botModel.playRating} on Lichess's scale)` : ''}.` : prep.fallback === 'engine' ? 'Stockfish plays for them from here.' : 'Choose who plays on under “Out of their book”.'}</p>`;
  } else {
    html += ms.length
      ? `<h3>What their opponents tried here</h3><div class="sub">${node.n} games · “their result” is ${esc(label)}'s score — low is good for you</div>${moveTable(ms, node.n, { bestTry: true })}`
      : `<p class="muted">Out of their book.</p>`;
  }
  html += `<div class="prep-engine" id="prepEngine"></div>`;
  // example games
  if (node) {
    const games = [...new Map(ms.flatMap(m => m.games).map(g => [g.id, g])).values()].sort((a, b) => b.endTs - a.endTs).slice(0, 8);
    if (games.length) html += `<h3 style="margin-top:14px">Their games from here</h3>${games.map((g, i) => `<div class="km" data-gi="${i}">${resBadge(g.result)}<span>vs ${esc(g.opp.name || '?')} ${g.opp.rating ? `<span class="muted">(${g.opp.rating})</span>` : ''}</span><span class="muted small">${g.event && g.source === 'otb' ? esc(g.event) + ' · ' : ''}${g.end.getTime() ? g.end.getFullYear() === new Date().getFullYear() ? fmtDate(g.end) : g.end.getFullYear() : ''}</span></div>`).join('')}`;
    prep._exampleGames = games;
  }
  pos.innerHTML = html;
  $$('#prepPosition tr[data-san]').forEach(tr => tr.onclick = () => prepPlay(tr.dataset.san));
  // open the game at the ply where it reached this position (it may have arrived by transposition)
  $$('#prepPosition [data-gi]').forEach(e => e.onclick = () => { const g = prep._exampleGames[+e.dataset.gi]; const k = g.keys.indexOf(keyOf(fen)); openReview(g, k >= 0 ? k : prep.idx); });

  // repertoire panel
  const asColor = prep.games.filter(g => g.color === prep.color);
  const r = wdl(asColor);
  const lines = mainLines(prep.games, prep.color, 8, 8);
  const weak = treeSpots(tree, { weak: true }), strong = treeSpots(tree, { weak: false });
  const spot = (s, i, kind) => `<div class="km" data-spot="${kind}:${i}"><span class="small" style="flex:1">${lineText(s.path)}</span><span class="small">${s.n} games</span><span class="small ${kind === 'weak' ? 't-blunder' : ''}" style="min-width:42px;text-align:right">${pct(s.score)}</span></div>`;
  $('#prepRepertoire').innerHTML = `
    <div class="sub">${esc(label)} as ${prep.color}: ${r.n} games · ${r.w}W ${r.d}D ${r.l}L · ${pct(r.score)} score</div>
    <h3>Main lines</h3><div class="sub">Most common first 4 moves · click to set up the position</div>
    ${lines.map((l, i) => `<div class="km" data-ml="${i}"><span class="small" style="flex:1">${lineText(l.sans)}</span><span class="small">${l.n}</span>${wdlBar(l)}</div>`).join('') || '<p class="muted small">Not enough games.</p>'}
    <h3 style="margin-top:14px">Weak spots — aim for these</h3><div class="sub">Positions where they score 35% or less (4+ games)</div>
    ${weak.map((s, i) => spot(s, i, 'weak')).join('') || '<p class="muted small">No clear weak spots in this sample.</p>'}
    <h3 style="margin-top:14px">Strong spots — avoid these</h3><div class="sub">Positions where they score 70% or more (4+ games)</div>
    ${strong.map((s, i) => spot(s, i, 'strong')).join('') || '<p class="muted small">No clear strong spots in this sample.</p>'}`;
  $$('#prepRepertoire [data-ml]').forEach(e => e.onclick = () => { prep.line = [...lines[+e.dataset.ml].sans]; prep.idx = prep.line.length; prep.sub = 'position'; refreshPrepare(); maybeBotMove(); });
  $$('#prepRepertoire [data-spot]').forEach(e => e.onclick = () => {
    const [kind, i] = e.dataset.spot.split(':');
    prep.line = [...(kind === 'weak' ? weak : strong)[+i].path]; prep.idx = prep.line.length; prep.sub = 'position';
    refreshPrepare(); maybeBotMove();
  });

  startPrepEngine(c);
  drawPrepEngine();
}
