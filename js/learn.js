// Learn an opening: its named lines (lichess's public-domain opening list, js/lines.json) drilled one at a time,
// the way Chessable or lichess practice does it. You play your side's moves and the board plays the other side's;
// a wrong move slides back with the right one as an arrow (another known line of the same opening is pointed out,
// not counted wrong). Each line returns on a spaced-repetition schedule (Leitner boxes: a few minutes after a slip,
// then 1, 3, 7, 14 and 30 days after clean runs), so practice goes to the lines you don't know yet. Progress is kept
// on this computer.
const learn = { name: null, color: 'white', board: null, line: null, ply: 0, slips: 0, busy: false, timer: null, skipped: new Set() };
const LEARN_KEY = 'cl:learn:v1', LEARN_DAYS = [0, 1, 3, 7, 14, 30], LEARN_RETRY_MIN = 3, LEARN_START = new Chess().fen();
const POPULAR = ['Italian Game', 'Ruy Lopez', 'Sicilian Defense', 'French Defense', 'Caro-Kann Defense', "Queen's Gambit Declined", "Queen's Pawn Game: London System", "King's Indian Defense", 'Scandinavian Defense', 'English Opening'];
let _lines = null;
const getLines = () => _lines ||= fetch('js/lines.json').then(r => r.json())
  .then(L => L.map(([eco, name, s]) => ({ eco, name, sans: s.split(' ') }))).catch(() => []);

// an opening and everything under it ("Italian Game" → "Italian Game: Two Knights Defense, …"), minus the lines
// that are only the start of a longer one (nothing of their own to learn)
function learnLines(L, name) {
  const set = L.filter(l => l.name === name || l.name.startsWith(name + ':') || l.name.startsWith(name + ','));
  const inner = new Set();
  for (const l of set) for (let i = 1; i < l.sans.length; i++) inner.add(l.sans.slice(0, i).join(' '));
  return set.filter(l => !inner.has(l.sans.join(' ')));
}
const lineKey = (color, l) => `${color}|${l.sans.join(' ')}`;
const learnProgress = () => store.get(LEARN_KEY, {});

// what's due: lines that slipped or whose interval has passed first (oldest first), then new ones: the lines your own
// games reach most, then main lines before sidelines: a line's weight is how much named theory surrounds its first 12
// moves (Σ log2 of the number of named lines through each of its positions), since main lines run through crowded
// branches and sidelines leave them early; shorter first among equals
function learnQueue(lines, color, skip = learn.skipped) {
  const P = learnProgress(), now = Date.now();
  const due = [], fresh = [];
  let learned = 0, nextDue = Infinity;
  for (const l of lines) {
    const p = P[lineKey(color, l)];
    if (!p) { if (!skip.has(l)) fresh.push(l); }
    else if (p.due <= now) { if (!skip.has(l)) due.push([p.due, l]); }
    else { learned += p.box > 0; nextDue = Math.min(nextDue, p.due); }
  }
  due.sort((a, b) => a[0] - b[0]);
  const seen = l => learn.seen?.get(l) || 0, weight = l => learn.weight?.get(l) || 0;
  fresh.sort((a, b) => seen(b) - seen(a) || weight(b) - weight(a) || a.sans.length - b.sans.length || a.name.localeCompare(b.name));
  return { next: due[0]?.[1] || fresh[0] || null, due: due.length, fresh: fresh.length, learned, nextDue, total: lines.length };
}

function learnRecord(line, clean) {
  const P = learnProgress(), k = lineKey(learn.color, line), box = clean ? Math.min(LEARN_DAYS.length - 1, (P[k]?.box || 0) + 1) : 0;
  P[k] = { box, due: Date.now() + (box ? LEARN_DAYS[box] * 864e5 : LEARN_RETRY_MIN * 6e4) };
  store.set(LEARN_KEY, P);
}

// your openings from the loaded games, each with how far you follow known lines (js/theory.js)
function learnSuggestions() {
  if (!S.games.length) return [];
  return computeOpenings(S.games).filter(r => r.n >= 3 && r.name).slice(0, 8)
    .map(r => ({ name: r.name, color: r.color, n: r.n, score: r.score, known: mean(r.games.filter(g => g.bookPlies != null).map(myBookMoves)) }));
}

async function renderLearn(sec) {
  const L = await getLines();
  if (!$('#learnBoard', sec)) {
    sec.innerHTML = `<div class="card" style="margin-bottom:14px">
        <div class="row-between"><div><h3>Learn an opening</h3><div class="sub">Its named lines, one at a time: you play your side, the board plays the other. Lines you miss come back sooner.</div></div></div>
        <div class="learn-pick">
          <input id="learnQuery" list="learnNames" placeholder="Opening, e.g. Italian Game" spellcheck="false">
          <datalist id="learnNames"></datalist>
          <div class="seg learn-color"></div>
          <button class="btn primary" id="learnGo">Learn</button>
        </div>
        <div class="learn-chips"></div>
      </div>
      <div class="card learn-stage-card">
        <div class="twin-stage" style="margin-top:0">
          <div><div class="muted small learn-meta" style="margin-bottom:6px"></div>
            <div class="match-board" style="--bs:min(420px, calc(var(--cw) - 60px))"><div class="board" id="learnBoard"></div></div></div>
          <div class="twin-panel learn-panel"></div>
        </div>
      </div>`;
    $('#learnNames', sec).innerHTML = [...new Set(L.map(l => l.name))].sort().map(n => `<option value="${esc(n)}">`).join('');
    learn.board = new BoardView($('#learnBoard', sec), { onMove: (mv, fenAfter) => learnAnswer(mv, fenAfter) });
    const go = () => { const q = $('#learnQuery', sec).value.trim(); if (q) learnStart(sec, q, learn.color); };
    $('#learnGo', sec).onclick = go;
    $('#learnQuery', sec).onkeydown = e => { if (e.key === 'Enter') go(); };
    const last = store.get('cl:learn:last');
    if (last && !learn.name) Object.assign(learn, { name: last.name, color: last.color });
    learn.line = null;
  }
  $('.learn-color', sec).innerHTML = ['white', 'black'].map(c => `<button data-lcolor="${c}" class="${c === learn.color ? 'active' : ''}">As ${colorName(c)}</button>`).join('');
  $$('[data-lcolor]', sec).forEach(b => b.onclick = () => { learn.color = b.dataset.lcolor; if (learn.name) learnStart(sec, learn.name, learn.color); else renderLearn(sec); });
  // quick picks: your own openings (with how far you follow theory), else the popular ones
  const mine = learnSuggestions();
  $('.learn-chips', sec).innerHTML = mine.length
    ? `<div class="sub" style="margin:10px 0 6px">From your games</div>${mine.map(s => `<button class="learn-chip" data-lname="${esc(s.name)}" data-lc="${s.color}">${colorDot(s.color)} ${esc(s.name)} <span class="muted">${s.n} games · ${pct(s.score)} · ${num(s.known, 1)} moves known</span></button>`).join('')}`
    : `<div class="sub" style="margin:10px 0 6px">Popular</div>${POPULAR.map(n => `<button class="learn-chip" data-lname="${esc(n)}">${esc(n.replace("Queen's Pawn Game: ", ''))}</button>`).join('')}`;
  $$('[data-lname]', sec).forEach(b => b.onclick = () => learnStart(sec, b.dataset.lname, b.dataset.lc || learn.color));
  if (learn.name && !learn.line) return learnStart(sec, learn.name, learn.color);
  if (!learn.name) {
    $('.learn-stage-card', sec).classList.add('hidden');
    return;
  }
  learnPanel();
}

async function learnStart(sec, name, color) {
  const L = await getLines();
  // a typed name that isn't exact: the closest opening name containing it
  if (!L.some(l => l.name === name)) {
    const q = name.toLowerCase(), hit = [...new Set(L.map(l => l.name))].filter(n => n.toLowerCase().includes(q)).sort((a, b) => a.length - b.length)[0];
    if (!hit) { $('.learn-meta', sec).textContent = ''; $('.learn-stage-card', sec).classList.remove('hidden'); $('.learn-panel', sec).innerHTML = `<p class="muted">No opening called “${esc(name)}”.</p>`; return; }
    name = hit;
  }
  Object.assign(learn, { name, color, lines: learnLines(L, name) });
  // how many of your games (as this colour) followed each line all the way
  const mine = S.games.filter(g => g.color === color).map(g => g.sans.join(' ') + ' ');
  learn.seen = new Map(learn.lines.map(l => { const k = l.sans.join(' ') + ' '; return [l, mine.filter(s => s.startsWith(k)).length]; }));
  const through = new Map();
  for (const l of L.filter(l => l.name === name || l.name.startsWith(name + ':') || l.name.startsWith(name + ',')))
    for (let i = 1; i <= l.sans.length; i++) { const k = l.sans.slice(0, i).join(' '); through.set(k, (through.get(k) || 0) + 1); }
  // (in steps of 6, so a shorter line wins between two of about the same weight)
  learn.weight = new Map(learn.lines.map(l => [l, Math.round(sum(l.sans.slice(0, 12).map((_, i) => Math.log2(through.get(l.sans.slice(0, i + 1).join(' ')) || 1))) / 6)]));
  store.set('cl:learn:last', { name, color });
  $('#learnQuery', sec).value = name;
  $$('[data-lcolor]', sec).forEach(b => b.classList.toggle('active', b.dataset.lcolor === color));
  $('.learn-stage-card', sec).classList.remove('hidden');
  learnNext();
}

function learnNext() {
  clearTimeout(learn.timer);
  const q = learnQueue(learn.lines, learn.color);
  learn.queue = q;
  learn.line = q.next;
  Object.assign(learn, { ply: 0, slips: 0, busy: false, done: false, msg: null });
  learn.board.jump({ fen: LEARN_START, orientation: learn.color });
  if (learn.line) learnAdvance();
  learnPanel();
}

const learnTurn = ply => (ply % 2 === 0 ? 'white' : 'black');
// the position after the first `ply` moves of the line
function learnFen(ply) { const c = new Chess(); learn.line.sans.slice(0, ply).forEach(s => c.move(s)); return c; }

// the other side's moves play themselves, then it's your turn (or the line is over)
function learnAdvance() {
  const line = learn.line;
  if (learn.ply >= line.sans.length) return learnFinish();
  if (learnTurn(learn.ply) === learn.color) { learnPanel(); return; }
  learn.busy = true;
  learn.timer = setTimeout(() => {
    if (learn.line !== line) return;
    const c = learnFen(learn.ply), mv = c.move(line.sans[learn.ply]);
    learn.board.set({ fen: c.fen(), orientation: learn.color, lastMove: { from: mv.from, to: mv.to } });
    learn.ply++; learn.busy = false;
    learnAdvance();
  }, learn.ply === 0 ? 450 : 380);
}

async function learnAnswer(mv, fenAfter) {
  const line = learn.line;
  if (!line || learn.busy || learn.done || learnTurn(learn.ply) !== learn.color) return;
  const want = line.sans[learn.ply];
  if (mv.san === want) {
    learn.board.set({ fen: fenAfter, orientation: learn.color, lastMove: { from: mv.from, to: mv.to } });
    learn.ply++; learn.msg = null;
    return learnAdvance();
  }
  // wrong for this line; another known line of the same opening is pointed out without counting it as a slip
  learn.busy = true;
  learn.board.set({ fen: fenAfter, orientation: learn.color, lastMove: { from: mv.from, to: mv.to } });
  const book = await getBook(), hit = book && bookHit(book, fenAfter);
  const sibling = hit && (hit.name === learn.name || hit.name.startsWith(learn.name + ':') || hit.name.startsWith(learn.name + ','));
  if (!sibling) learn.slips++;
  const c = learnFen(learn.ply), right = c.move(want);
  learn.board.set({ fen: fenAfter, orientation: learn.color, lastMove: { from: mv.from, to: mv.to }, badge: { sq: mv.to, cls: sibling ? 'good' : 'blunder', text: sibling ? '~' : '✗' } });
  if (!sibling) Sound.play('bad');
  learn.msg = sibling ? `${esc(mv.san)} is also theory (${esc(hit.name)}), but this line plays <b>${esc(want)}</b>.` : `Not ${esc(mv.san)}: this line plays <b>${esc(want)}</b>.`;
  learnPanel();
  learn.busy = true;
  clearTimeout(learn.timer);
  learn.timer = setTimeout(() => {
    if (learn.line !== line) return;
    c.undo();
    const prev = learn.ply ? (() => { const p = learnFen(learn.ply - 1).move(line.sans[learn.ply - 1]); return { from: p.from, to: p.to }; })() : null;
    learn.board.set({ fen: c.fen(), orientation: learn.color, lastMove: prev, arrows: [{ from: right.from, to: right.to, color: cssVar('--good'), width: 0.22 }] });
    learn.busy = false;
  }, 650);
}

function learnHint() {
  const line = learn.line;
  if (!line || learn.done || learnTurn(learn.ply) !== learn.color) return;
  learn.slips++;
  const c = learnFen(learn.ply), mv = c.move(line.sans[learn.ply]);
  c.undo();
  learn.board.set({ fen: c.fen(), orientation: learn.color, lastMove: learn.board.state.lastMove, arrows: [{ from: mv.from, to: mv.to, color: cssVar('--good'), width: 0.22, opacity: 0.6 }] });
  learn.msg = 'Hint shown: this line comes back sooner.';
  learnPanel();
}

function learnFinish() {
  learn.done = true;
  learnRecord(learn.line, learn.slips === 0);
  Sound.play(learn.slips ? 'bad' : 'good');
  learn.queue = learnQueue(learn.lines, learn.color);
  learnPanel();
}

function learnPanel() {
  const panel = $('.learn-panel'), meta = $('.learn-meta');
  if (!panel) return;
  const line = learn.line, q = learn.queue || learnQueue(learn.lines || [], learn.color);
  const days = q.nextDue < Infinity ? Math.max(1, Math.round((q.nextDue - Date.now()) / 864e5)) : null;
  meta.innerHTML = `${esc(learn.name || '')} · as ${colorName(learn.color)} · <b>${q.learned}</b> of ${q.total} lines learned${q.due ? ` · ${q.due} due` : ''}`;
  if (!line) {
    panel.innerHTML = `<h3>All ${q.total} lines learned</h3><p class="small">Next review ${days ? `in ${days} day${days > 1 ? 's' : ''}` : 'soon'}.</p>
      <button class="btn" id="learnAnyway">Practise a line anyway</button>`;
    $('#learnAnyway', panel).onclick = () => { learn.line = learn.lines[Math.floor(Math.random() * learn.lines.length)]; Object.assign(learn, { ply: 0, slips: 0, done: false, msg: null }); learn.board.jump({ fen: LEARN_START, orientation: learn.color }); learnAdvance(); learnPanel(); };
    return;
  }
  // the moves so far, and the name of the deepest known position reached (the line's own name only at the end)
  const moves = line.sans.slice(0, learn.ply).map((s, i) => `${i % 2 === 0 ? `<span class="muted">${i / 2 + 1}.</span>` : ''}<span class="${learnTurn(i) === learn.color ? 'learn-mine' : ''}">${esc(s)}</span>`).join(' ');
  const yourTurn = !learn.done && learnTurn(learn.ply) === learn.color;
  const isNew = !learnProgress()[lineKey(learn.color, line)];
  const head = learn.done
    ? `<h3>${learn.slips ? 'Line complete' : '✓ Line learned'}</h3><p class="small"><b>${esc(line.name)}</b> <span class="muted">${line.eco}</span></p>
       <p class="small">${learn.slips ? `${learn.slips} slip${learn.slips > 1 ? 's' : ''}: it comes back in a few minutes.` : `Next review in ${LEARN_DAYS[learnProgress()[lineKey(learn.color, line)]?.box || 1]} day${(learnProgress()[lineKey(learn.color, line)]?.box || 1) > 1 ? 's' : ''}.`}</p>`
    : `<h3>${yourTurn ? 'Your move' : '…'}</h3><p class="small muted">${isNew ? 'A new line' : 'A review'} · ${line.sans.length} moves${learn.seen?.get(line) ? ` · reached in ${learn.seen.get(line)} of your games` : ''}</p>`;
  panel.innerHTML = `${head}
    <div class="learn-moves">${moves || '<span class="muted">Starting position</span>'}</div>
    ${learn.msg ? `<p class="small">${learn.msg}</p>` : ''}
    <div class="learn-actions">
      ${learn.done ? '<button class="btn primary" id="learnNextBtn">Next line →</button>' : `<button class="btn" id="learnHintBtn" ${yourTurn ? '' : 'disabled'}>Hint</button><button class="btn" id="learnSkip">Skip line</button>`}
    </div>`;
  $('#learnNextBtn', panel)?.addEventListener('click', learnNext);
  $('#learnHintBtn', panel)?.addEventListener('click', learnHint);
  $('#learnSkip', panel)?.addEventListener('click', () => { learn.skipped.add(line); learnNext(); });
}
