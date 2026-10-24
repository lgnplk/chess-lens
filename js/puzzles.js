// Puzzles: lichess's public-domain puzzle set (js/puzzles.json, built by tools/build-puzzles.js): about 40,000
// well-tested puzzles from 400 to 2900. Rated mode keeps a puzzle rating (Elo, kept on this computer) and serves
// puzzles near it, optionally by theme; Puzzle Rush is 3 or 5 minutes (or untimed Survival) of puzzles that get
// harder as you go, ended by three wrong answers. The board behaves like the drill: the opponent's move slides in,
// a right move stays, a wrong one gets a cross and slides back with the answer as an arrow.
const pz = { mode: 'rated', theme: '', board: null, cur: null, step: 0, busy: false, failed: false, done: false, rush: null, seen: new Set() };
const PZ_KEY = 'cl:pz:v1', PZ_START = 800;
const PZ_THEMES = { '': 'All themes', mateIn1: 'Mate in 1', mateIn2: 'Mate in 2', mateIn3: 'Mate in 3', fork: 'Fork', pin: 'Pin', skewer: 'Skewer',
  discoveredAttack: 'Discovered attack', hangingPiece: 'Hanging piece', trappedPiece: 'Trapped piece', backRankMate: 'Back-rank mate', sacrifice: 'Sacrifice',
  deflection: 'Deflection', attraction: 'Attraction', promotion: 'Promotion', defensiveMove: 'Defensive move', quietMove: 'Quiet move', zugzwang: 'Zugzwang',
  opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' };
const PZ_RUSH = { rush3: { label: 'Rush 3 min', secs: 180 }, rush5: { label: 'Rush 5 min', secs: 300 }, survival: { label: 'Survival', secs: 0 } };
let _puzzles = null;
const getPuzzles = () => _puzzles ||= fetch('js/puzzles.json').then(r => r.json())
  .then(a => a.map(([id, fen, moves, rating, themes]) => ({ id, fen, moves: moves.split(' '), rating, themes: themes.split(' ') }))).catch(() => []);
const pzStats = () => store.get(PZ_KEY, { rating: PZ_START, n: 0, solved: 0, best: {} });

// a puzzle near a rating (widening the window if a theme leaves too few), not one seen this session
async function pzPick(rating, theme) {
  const P = await getPuzzles();
  for (const w of [75, 150, 300, 600, 3000]) {
    const pool = P.filter(p => Math.abs(p.rating - rating) <= w && (!theme || p.themes.includes(theme)) && !pz.seen.has(p.id));
    if (pool.length >= 5 || w === 3000) { const p = pool[Math.floor(Math.random() * pool.length)]; if (p) pz.seen.add(p.id); return p || null; }
  }
  return null;
}

function renderPuzzles(sec) {
  if (!$('#pzBoard', sec)) {
    sec.innerHTML = `<div class="card">
      <div class="row-between"><div><h3>Puzzles</h3><div class="sub">From lichess's public puzzle database: real positions, tested by thousands of players.</div></div><div class="seg pz-modes"></div></div>
      <div class="twin-stage"><div><div class="muted small pz-meta" style="margin-bottom:6px"></div>
        <div class="match-board" style="--bs:min(440px, calc(100vw - 60px))"><div class="board" id="pzBoard"></div></div></div>
        <div class="twin-panel pz-panel"></div></div></div>`;
    pz.board = new BoardView($('#pzBoard', sec), { onMove: (mv, fenAfter) => pzAnswer(mv, fenAfter) });
  }
  $('.pz-modes', sec).innerHTML = [['rated', 'Rated'], ['daily', 'Daily'], ...Object.entries(PZ_RUSH).map(([k, v]) => [k, v.label])].map(([k, l]) => `<button data-pzmode="${k}" class="${pz.mode === k ? 'active' : ''}">${l}</button>`).join('');
  $$('[data-pzmode]', sec).forEach(b => b.onclick = () => { pzStopRush(); pz.mode = b.dataset.pzmode; pz.cur = null; renderPuzzles(sec); });
  if (!pz.cur && !pz.rush?.over) (pz.mode === 'rated' || pz.mode === 'daily' ? pzNext() : pzPanel());
  else pzPanel();
}

async function pzNext() {
  const st = pzStats();
  const target = pz.rush ? 500 + pz.rush.solved * 55 : st.rating;
  const p = pz.mode === 'daily' ? await pzDailyPuzzle() : await pzPick(target, pz.mode === 'rated' ? pz.theme : '');
  Object.assign(pz, { cur: p, step: 0, busy: true, failed: false, done: false, hinted: false, msg: null, delta: null });
  if (!p) { pzPanel(); return; }
  // the position before the opponent's move; their move slides in, then it's yours
  const c = new Chess(p.fen), orientation = c.turn() === 'w' ? 'black' : 'white';
  pz.board.jump({ fen: p.fen, orientation });
  pzPanel();
  setTimeout(() => {
    if (pz.cur !== p) return;
    const mv = c.move(uciMoveObj(p.moves[0]));
    pz.board.set({ fen: c.fen(), orientation, lastMove: { from: mv.from, to: mv.to } });
    Object.assign(pz, { step: 1, busy: false });
    pzPanel();
  }, 550);
}
const uciMoveObj = u => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
const pzFen = upto => { const c = new Chess(pz.cur.fen); pz.cur.moves.slice(0, upto).forEach(u => c.move(uciMoveObj(u))); return c; };

function pzAnswer(mv, fenAfter) {
  const p = pz.cur;
  if (!p || pz.busy || pz.done || pz.step % 2 === 0) return;
  const uci = mv.from + mv.to + (mv.promotion || ''), want = p.moves[pz.step];
  const orientation = pz.board.state.orientation;
  // the expected move, or any checkmate (puzzles accept every mate)
  const mate = new Chess(fenAfter).in_checkmate();
  if (uci === want || (want.length === 4 && uci === want + 'q' && mv.promotion === 'q') || mate) {
    pz.board.set({ fen: fenAfter, orientation, lastMove: { from: mv.from, to: mv.to } });
    pz.step++;
    if (pz.step >= p.moves.length || mate) return pzSolved();
    pz.busy = true;
    setTimeout(() => {
      if (pz.cur !== p) return;
      const c = pzFen(pz.step), r = c.move(uciMoveObj(p.moves[pz.step]));
      pz.board.set({ fen: c.fen(), orientation, lastMove: { from: r.from, to: r.to } });
      pz.step++; pz.busy = false;
      pzPanel();
    }, 380);
    pzPanel();
    return;
  }
  // wrong: a cross on the square, then back, with the answer shown
  pz.board.set({ fen: fenAfter, orientation, lastMove: { from: mv.from, to: mv.to }, badge: { sq: mv.to, cls: 'blunder', text: '✗' } });
  Sound.play('bad');
  pz.busy = true;
  const c = pzFen(pz.step), right = c.move(uciMoveObj(want)); c.undo();
  setTimeout(() => {
    if (pz.cur !== p) return;
    pz.board.set({ fen: c.fen(), orientation, lastMove: pz.step > 0 ? (() => { const b = pzFen(pz.step - 1).move(uciMoveObj(p.moves[pz.step - 1])); return { from: b.from, to: b.to }; })() : null,
      arrows: pz.rush ? [] : [{ from: right.from, to: right.to, color: cssVar('--good'), width: 0.22 }] });
    pz.busy = false;
    if (pz.rush) pzRushMiss();
    else { if (!pz.failed) pzRate(0); pz.failed = true; pz.msg = `Not ${mv.san}. The move was <b>${right.san}</b>: play it to go on.`; pzPanel(); }
  }, 600);
}

function pzSolved() {
  pz.done = true; pz.msg = null;
  Sound.play('good');
  if (pz.rush) { pz.rush.solved++; pzPanel(); setTimeout(() => { if (pz.rush && !pz.rush.over) pzNext(); }, 450); return; }
  if (!pz.failed) pzRate(1);
  pzPanel();
}

// rated: Elo against the puzzle's rating; bigger steps for the first 20 puzzles
function pzRate(score) {
  if (pz.mode === 'daily') return pzDailyResult(score);
  const st = pzStats(), exp = 1 / (1 + Math.pow(10, (pz.cur.rating - st.rating) / 400)), k = st.n < 20 ? 40 : 20;
  const delta = Math.round(k * (score - exp));
  Object.assign(st, { rating: st.rating + delta, n: st.n + 1, solved: st.solved + score });
  store.set(PZ_KEY, st);
  pz.delta = delta;
}

function pzHint() {
  if (!pz.cur || pz.busy || pz.done || pz.step % 2 === 0) return;
  const c = pzFen(pz.step), m = c.move(uciMoveObj(pz.cur.moves[pz.step])); c.undo();
  if (!pz.failed && !pz.hinted && !pz.rush) pzRate(0);
  pz.hinted = pz.failed = true;
  pz.board.set({ ...pz.board.state, arrows: [] });
  pz.board.drawn.circles = [{ from: m.from, to: m.from, color: cssVar('--good') }]; pz.board.render();
  pz.msg = 'The piece to move is circled.'; pzPanel();
}

// the rest of the solution, played out
function pzSolution() {
  const p = pz.cur;
  if (!p || pz.done) return;
  if (!pz.failed && !pz.rush) pzRate(0);
  pz.failed = true; pz.busy = true;
  const orientation = pz.board.state.orientation;
  const step = () => {
    if (pz.cur !== p) return;
    if (pz.step >= p.moves.length) { pz.busy = false; pz.done = true; pz.msg = 'Solution shown.'; pzPanel(); return; }
    const c = pzFen(pz.step), m = c.move(uciMoveObj(p.moves[pz.step]));
    pz.board.set({ fen: c.fen(), orientation, lastMove: { from: m.from, to: m.to } });
    pz.step++;
    setTimeout(step, 650);
  };
  step();
}

// ---------- the daily puzzle ----------
// One puzzle a day (1200–1900, the same for everyone on that date), unrated; the first try counts toward the streak
// of days solved in a row (kept on this computer).
const PZ_DAILY_KEY = 'cl:pz:daily';
const pzToday = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
async function pzDailyPuzzle() {
  const pool = (await getPuzzles()).filter(p => p.rating >= 1200 && p.rating < 1900);
  let h = 0; for (const ch of pzToday()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length] || null;
}
function pzDaily() {
  const days = store.get(PZ_DAILY_KEY, {}), d = new Date();
  // today counts once played; until then the streak runs to yesterday
  if (days[pzToday(d)] !== 'solved') d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days[pzToday(d)] === 'solved') { streak++; d.setDate(d.getDate() - 1); }
  return { streak, today: days[pzToday()] || null };
}
function pzDailyResult(score) {
  const days = store.get(PZ_DAILY_KEY, {}), t = pzToday();
  if (!days[t]) { days[t] = score ? 'solved' : 'missed'; store.set(PZ_DAILY_KEY, days); }
  pz.delta = null;
}

// ---------- Puzzle Rush ----------
function pzStartRush() {
  const cfg = PZ_RUSH[pz.mode];
  pzStopRush();
  pz.rush = { solved: 0, misses: 0, secs: cfg.secs, left: cfg.secs, over: false, t0: performance.now() };
  if (cfg.secs) pz.rush.timer = setInterval(() => {
    const r = pz.rush; if (!r) return;
    r.left = Math.max(0, cfg.secs - (performance.now() - r.t0) / 1000);
    const t = $('.pz-clock'); if (t) t.textContent = pzClock(r.left);
    if (r.left <= 0) pzEndRush();
  }, 250);
  pzNext();
}
const pzClock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function pzRushMiss() { pz.rush.misses++; if (pz.rush.misses >= 3) return pzEndRush(); pzPanel(); setTimeout(() => { if (pz.rush && !pz.rush.over) pzNext(); }, 350); }
function pzEndRush() {
  const r = pz.rush; if (!r || r.over) return;
  clearInterval(r.timer); r.over = true; pz.busy = true;
  const st = pzStats(); st.best ||= {};
  r.best = r.solved > (st.best[pz.mode] || 0);
  if (r.best) { st.best[pz.mode] = r.solved; store.set(PZ_KEY, st); }
  pzPanel();
}
function pzStopRush() { if (pz.rush) clearInterval(pz.rush.timer); pz.rush = null; }

function pzPanel() {
  const panel = $('.pz-panel'), meta = $('.pz-meta');
  if (!panel) return;
  const st = pzStats(), p = pz.cur, yourTurn = p && !pz.busy && !pz.done && pz.step % 2 === 1;
  const toMove = p ? (new Chess(p.fen).turn() === 'w' ? 'Black' : 'White') : '';
  if (pz.mode !== 'rated' && pz.mode !== 'daily') {
    const r = pz.rush, best = st.best?.[pz.mode] || 0;
    meta.textContent = `${PZ_RUSH[pz.mode].label} · best ${best}`;
    if (!r) { panel.innerHTML = `<h3>${PZ_RUSH[pz.mode].label}</h3><p class="small">${PZ_RUSH[pz.mode].secs ? `Solve as many as you can in ${PZ_RUSH[pz.mode].secs / 60} minutes.` : 'No clock: keep going until your third mistake.'} Three mistakes end the run; puzzles get harder as you go.</p>
      <p class="small">Your best: <b>${best}</b></p><button class="btn primary" id="pzGo">Start</button>`; $('#pzGo', panel).onclick = pzStartRush; return; }
    const strikes = [0, 1, 2].map(i => `<span class="pz-strike ${i < r.misses ? 'on' : ''}">✗</span>`).join('');
    panel.innerHTML = r.over
      ? `<h3>${r.solved} solved</h3><p class="small">${r.best ? 'A new best!' : `Your best: ${st.best[pz.mode]}`}</p><button class="btn primary" id="pzGo">Again</button>`
      : `<div class="pz-rush"><span class="pz-score">${r.solved}</span>${r.secs ? `<span class="pz-clock">${pzClock(r.left)}</span>` : ''}<span>${strikes}</span></div>
         <p class="small">${p ? `${toMove} to move · puzzle ${p.rating}` : ''}</p><button class="btn" id="pzQuit">End run</button>`;
    $('#pzGo', panel)?.addEventListener('click', pzStartRush);
    $('#pzQuit', panel)?.addEventListener('click', pzEndRush);
    return;
  }
  if (pz.mode === 'daily') { const d = pzDaily(); meta.innerHTML = `Daily puzzle · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · streak <b>${d.streak}</b> day${d.streak === 1 ? '' : 's'}${d.today ? ` · today: ${d.today === 'solved' ? '✓ solved' : 'missed'}` : ''}`; }
  else meta.innerHTML = `Puzzle rating <b>${st.rating}</b>${st.n ? ` · ${st.n} played · ${Math.round(100 * st.solved / st.n)}% solved` : ''}`;
  const theme = pz.mode === 'daily' ? '' : `<select class="pz-theme">${Object.entries(PZ_THEMES).map(([k, l]) => `<option value="${k}" ${k === pz.theme ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  if (!p) { panel.innerHTML = `<p class="muted">Loading puzzles…</p>${theme}`; bindPz(panel); return; }
  const head = pz.done
    ? (pz.failed ? `<h3>Solved after a slip</h3>` : `<h3>✓ Solved</h3>`) + (pz.delta != null ? `<p class="small">Rating ${pz.delta >= 0 ? '+' : ''}${pz.delta} → <b>${st.rating}</b></p>` : '')
    : `<h3>${toMove} to move</h3><p class="small muted">Find the best move${p.moves.length > 2 ? ` · ${Math.ceil((p.moves.length - 1) / 2)} moves to find` : ''}</p>`;
  const themes = p.themes.filter(t => PZ_THEMES[t]).map(t => PZ_THEMES[t]);
  panel.innerHTML = `${head}${pz.msg ? `<p class="small">${pz.msg}</p>` : ''}
    ${pz.done ? `<p class="small muted">Puzzle ${p.rating}${themes.length ? ` · ${themes.join(', ')}` : ''} · <a href="https://lichess.org/training/${p.id}" target="_blank" rel="noopener">lichess #${p.id}</a></p>` : ''}
    <div class="learn-actions">${pz.done ? (pz.mode === 'daily' ? '<span class="muted small">A new one tomorrow.</span>' : '<button class="btn primary" id="pzNextBtn">Next puzzle →</button>') : `<button class="btn" id="pzHint" ${yourTurn ? '' : 'disabled'}>Hint</button><button class="btn" id="pzSol">Solution</button>`}</div>
    <div style="margin-top:12px">${theme}</div>`;
  bindPz(panel);
}
function bindPz(panel) {
  $('#pzNextBtn', panel)?.addEventListener('click', pzNext);
  $('#pzHint', panel)?.addEventListener('click', pzHint);
  $('#pzSol', panel)?.addEventListener('click', pzSolution);
  const t = $('.pz-theme', panel);
  if (t) t.onchange = e => { pz.theme = e.target.value; pzNext(); };
}
