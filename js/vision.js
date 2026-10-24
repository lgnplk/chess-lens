// Vision: board-vision drills against a 30-second clock, on a board without coordinates.
//   Squares: a square is named; click it.
//   Moves: an arrow shows a move in a position from a real game (the puzzle set); type it (Nf3, exd5, O-O, e8=Q).
//   Colours: a square is named and the board is hidden; is it light or dark?
// Each run scores right answers; a miss shows the answer and moves on. Best scores and the last runs are kept per
// mode and side (stored on this computer).
const VZ_KEY = 'cl:vision:v1', VZ_SECS = 30;
const VZ_MODES = { squares: 'Squares', moves: 'Moves', colors: 'Colours' };
const vz = { mode: 'squares', side: 'white', coords: false, run: null, board: null, built: false };
const vzStore = () => store.get(VZ_KEY, {});
const vzKey = () => `${vz.mode}:${vz.side}`;
const vzRandSq = (not) => { let s; do s = FILES[Math.floor(Math.random() * 8)] + (1 + Math.floor(Math.random() * 8)); while (s === not); return s; };
const vzLight = sq => (FILES.indexOf(sq[0]) + +sq[1]) % 2 === 0;   // a1 (0 + 1, odd) is dark, h1 light

function renderVision(sec) {
  if (!vz.built) {
    sec.innerHTML = `<div class="rv">
      <div class="rv-board"><div class="board-wrap" id="vzWrap"><div class="board no-coords" id="vzBoard"></div></div></div>
      <div class="rv-panel"><div class="rv-head" id="vzHead"></div><div class="rv-body" id="vzBody"></div></div></div>`;
    vz.board = new BoardView($('#vzBoard', sec), { onSquare: sq => vzClick(sq) });
    vz.built = true;
    document.addEventListener('keydown', e => {
      if (S.tab !== 'vision' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (!vz.run && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); vzStart(); }
      if (vz.run && vz.mode === 'colors' && (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'l')) vzAnswerColor(true);
      if (vz.run && vz.mode === 'colors' && (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd')) vzAnswerColor(false);
    });
  }
  vzDraw();
}

function vzStart() {
  vzStop();
  const orientation = vz.side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : vz.side;
  vz.run = { orientation, score: 0, misses: [], t0: performance.now(), left: VZ_SECS, target: null, over: false, times: [], asked: performance.now() };
  vz.run.timer = setInterval(() => {
    const r = vz.run; if (!r || r.over) return;
    r.left = Math.max(0, VZ_SECS - (performance.now() - r.t0) / 1000);
    const c = $('#vzClock'); if (c) { c.textContent = r.left.toFixed(r.left < 10 ? 1 : 0); c.classList.toggle('low', r.left < 5); }
    if (r.left <= 0) vzEnd();
  }, 100);
  vzNext();
}
function vzStop() { if (vz.run) clearInterval(vz.run.timer); vz.run = null; }

async function vzNext() {
  const r = vz.run; if (!r || r.over) return;
  r.asked = performance.now();
  if (vz.mode === 'moves') {
    // a real position (a puzzle's start) with the side to move matching the board's bottom, and one of its legal moves
    const P = await getPuzzles();
    for (let k = 0; k < 50; k++) {
      const p = P[Math.floor(Math.random() * P.length)], c = new Chess(p.fen);
      c.move(uciMoveObj(p.moves[0]));
      if (c.turn() !== r.orientation[0] || c.game_over()) continue;
      const moves = c.moves({ verbose: true });
      r.target = { fen: c.fen(), mv: moves[Math.floor(Math.random() * moves.length)] };
      break;
    }
  } else r.target = vzRandSq(r.target);
  if (vz.run !== r) return;
  vzDraw();
}

function vzRecord(ok, given) {
  const r = vz.run; if (!r || r.over) return;
  r.times.push(performance.now() - r.asked);
  if (ok) { r.score++; Sound.play('move'); }
  else { r.misses.push({ want: vz.mode === 'moves' ? r.target.mv.san : r.target, given }); Sound.play('capture'); }
  r.flash = { ok, want: vz.mode === 'moves' ? r.target.mv.san : r.target, given };
}

function vzClick(sq) {
  const r = vz.run;
  if (!r || r.over || vz.mode !== 'squares') return;
  const want = r.target, ok = sq === want;
  vzRecord(ok, sq);
  // the clicked square ticked or crossed, and on a miss the right one circled, while the next square is asked
  vz.board.drawn.circles = [];
  vz.board.set({ ...vz.board.state, badge: { sq, cls: ok ? 'best' : 'blunder', text: ok ? '✓' : '✗' } });
  if (!ok) { vz.board.drawn.circles = [{ from: want, to: want, color: cssVar('--good') }]; vz.board.render(); }
  vzNext();
}

function vzAnswerColor(light) {
  const r = vz.run;
  if (!r || r.over || vz.mode !== 'colors') return;
  vzRecord(vzLight(r.target) === light, light ? 'light' : 'dark');
  vzNext();
}

function vzAnswerMove(text) {
  const r = vz.run;
  if (!r || r.over || vz.mode !== 'moves' || !text.trim()) return;
  const c = new Chess(r.target.fen), mv = moveTyped(c, text);
  const want = r.target.mv;
  vzRecord(!!mv && mv.from === want.from && mv.to === want.to && (mv.promotion || '') === (want.promotion || ''), text.trim());
  vzNext();
}

function vzEnd() {
  const r = vz.run; if (!r || r.over) return;
  clearInterval(r.timer); r.over = true;
  const st = vzStore(), k = vzKey(), rec = st[k] ||= { best: 0, last: [] };
  r.best = r.score > rec.best;
  rec.best = Math.max(rec.best, r.score);
  rec.last = [r.score, ...rec.last].slice(0, 10);
  store.set(VZ_KEY, st);
  Sound.play(r.best ? 'good' : 'move');
  vzDraw();
}

function vzDraw() {
  if (!vz.built) return;
  const r = vz.run, playing = r && !r.over, orientation = r?.orientation || (vz.side === 'black' ? 'black' : 'white');
  $('#vzBoard').classList.toggle('no-coords', !vz.coords);
  $('#vzWrap').classList.toggle('vz-hidden', vz.mode === 'colors' && !!playing);
  if (vz.mode === 'moves' && r?.target?.fen) {
    const m = r.target.mv;
    vz.board.jump({ fen: r.target.fen, orientation, arrows: playing ? [{ from: m.from, to: m.to, color: cssVar('--s1'), width: 0.2, opacity: 0.9 }] : [], lastMove: playing ? { from: m.from, to: m.from } : null });
  } else if (!playing || vz.mode !== 'squares' || !vz.board.state.badge) vz.board.jump({ fen: '8/8/8/8/8/8/8/8 w - - 0 1', orientation });

  const rec = vzStore()[vzKey()];
  $('#vzHead').innerHTML = `<div class="row-between"><b>Vision</b><div class="seg">${Object.entries(VZ_MODES).map(([k, l]) => `<button data-vzmode="${k}" class="${vz.mode === k ? 'active' : ''}" ${playing ? 'disabled' : ''}>${l}</button>`).join('')}</div></div>
    <div class="prep-opts"><div class="seg">${[['white', 'White'], ['black', 'Black'], ['random', 'Random']].map(([k, l]) => `<button data-vzside="${k}" class="${vz.side === k ? 'active' : ''}" ${playing ? 'disabled' : ''}>${l}</button>`).join('')}</div>
      <label><input type="checkbox" id="vzCoords" ${vz.coords ? 'checked' : ''}> Coordinates</label>
      <span class="muted small">Best ${rec?.best || 0}</span></div>`;
  $$('[data-vzmode]').forEach(b => b.onclick = () => { vz.mode = b.dataset.vzmode; vzStop(); vzDraw(); });
  $$('[data-vzside]').forEach(b => b.onclick = () => { vz.side = b.dataset.vzside; vzStop(); vzDraw(); });
  $('#vzCoords').onchange = e => { vz.coords = e.target.checked; vzDraw(); };

  const how = { squares: 'A square is named: click it.', moves: 'An arrow shows a move: type it (Nf3, exd5, O-O, e8=Q).', colors: 'A square is named: is it light or dark? (← light, → dark)' }[vz.mode];
  const body = $('#vzBody');
  if (!r) {
    body.innerHTML = `<p class="small">${how} You have ${VZ_SECS} seconds; a miss shows the answer and moves on.</p>
      ${rec?.last?.length ? `<p class="muted small">Your last runs: ${rec.last.join(', ')}</p>` : ''}
      <button class="btn primary" id="vzGo">Start</button> <span class="muted small">or press Space</span>`;
    $('#vzGo').onclick = vzStart;
    return;
  }
  if (r.over) {
    const n = r.score + r.misses.length, avg = r.times.length ? r.times.reduce((a, b) => a + b, 0) / r.times.length / 1000 : 0;
    body.innerHTML = `<div class="vz-prompt">${r.score}</div><p class="small" style="text-align:center">${r.best ? 'A new best!' : `Best ${rec?.best || 0}`} · ${n ? Math.round(100 * r.score / n) : 0}% right · ${avg.toFixed(1)} s each</p>
      ${r.misses.length ? `<p class="small muted">Missed: ${r.misses.slice(0, 12).map(m => `${esc(m.want)} <span class="vz-flash-bad">(${esc(String(m.given))})</span>`).join(', ')}</p>` : ''}
      ${rec?.last?.length > 1 ? `<p class="muted small">Your last runs: ${rec.last.join(', ')}</p>` : ''}
      <button class="btn primary" id="vzGo">Again</button> <span class="muted small">or press Space</span>`;
    $('#vzGo').onclick = vzStart;
    return;
  }
  const flash = r.flash;   // the last answer, until the next one
  const prompt = vz.mode === 'moves' ? '' : `<div class="vz-prompt">${r.target || ''}</div>`;
  body.innerHTML = `<div class="vz-bar"><span class="vz-score">${r.score}</span><span class="vz-clock" id="vzClock">${r.left.toFixed(0)}</span></div>
    ${prompt}
    ${vz.mode === 'moves' ? `<input class="vz-type" id="vzType" placeholder="Type the move" autocomplete="off" spellcheck="false">` : ''}
    ${vz.mode === 'colors' ? '<div class="vz-colors"><button class="vz-light" id="vzL">Light</button><button class="vz-dark" id="vzD">Dark</button></div>' : ''}
    <p class="small" style="text-align:center;min-height:1.4em">${flash ? (flash.ok ? '<span class="vz-flash-ok">✓</span>' : `<span class="vz-flash-bad">✗ ${esc(String(flash.given))}</span> · it was <b>${esc(flash.want)}</b>`) : ''}</p>
    <button class="btn small-btn" id="vzQuit">End run</button>`;
  const t = $('#vzType');
  if (t) { t.focus(); t.onkeydown = e => { if (e.key === 'Enter') vzAnswerMove(t.value); }; }
  $('#vzL')?.addEventListener('click', () => vzAnswerColor(true));
  $('#vzD')?.addEventListener('click', () => vzAnswerColor(false));
  $('#vzQuit').onclick = vzEnd;
}
