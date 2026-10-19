// Bot arena: a roster of player bots (built-in legends + bots you create), matches by dragging bots onto
// White and Black, and round-robin tournaments with pre-tournament odds and friends' predictions.
const arena = {
  roster: store.get('cl:arena:roster', []),          // your bots: { id, name, src, nGames, mode, fid, img }
  facts: store.get('cl:arena:facts', {}),             // what we learned building each bot: rating, style title
  models: new Map(),                                  // build cache: source+games -> Promise<model>
  size: 'auto', maia: null,
  view: 'match', white: null, black: null, nGames: 20,
  form: null,                                         // create/edit form state
  running: false, abort: false, status: '', progress: 0, error: null,
  match: null,                                        // { A, B, games, watch }
  tour: { entrants: [], perPair: 2, predictions: [], odds: null, result: null, live: null },
  history: store.get('cl:arena:history', []),
  board: null, built: false,
};

const arenaSize = () => arena.size !== 'auto' ? arena.size : (navigator.gpu ? '23m' : '5m');
const saveRoster = () => { store.set('cl:arena:roster', arena.roster); store.set('cl:arena:facts', arena.facts); };

// ---------- bots ----------
function botInfo(id) {
  if (id?.startsWith('f:')) {
    const f = FAMOUS.find(x => x.id === id.slice(2));
    return f && { id, name: f.name, src: famousSource(f), nGames: 120, mode: 'sample', fid: 'high', hue: f.hue, legend: true, era: f.era, note: f.note, crown: /World Champion/.test(f.era) };
  }
  const r = arena.roster.find(x => x.id === id);
  return r && { ...r, hue: hueOf(r.name), legend: false };
}
const allBotIds = () => [...FAMOUS.map(f => 'f:' + f.id), ...arena.roster.map(r => r.id)];

function sourceText(src, nGames) {
  if (!src) return '';
  if (src.famous) return `${src.tc} OTB games`;
  const where = src.kind === 'otb' ? 'OTB database' : src.kind === 'lichess' ? 'Lichess' : 'chess.com';
  const tc = src.tc && src.tc !== 'all' ? ` · ${src.tc}` : '';
  const n = src.recent ? ` · last ${src.recent}` : src.max ? ` · last ${src.max}` : src.months ? ` · ${src.months} mo` : '';
  return `${where}${tc}${n}`;
}

// Build (or reuse) a bot. Each bot in a game is its own instance: shared model, own name/mode/blunder counters.
async function ensureBot(id, onStatus) {
  const r = botInfo(id);
  if (!r) throw new Error('Unknown bot');
  const size = arenaSize();
  if (!arena.maia || arena.maia.size !== size) {
    arena.maia?.terminate(); arena.models.clear();
    onStatus?.(`Loading Maia-3 ${size.toUpperCase()}…`);
    arena.maia = await openMaia(size);
  }
  const fid = r.fid !== 'standard';
  const key = JSON.stringify([r.src, r.nGames || 80, fid]);
  if (!arena.models.has(key)) {
    const pre = r.legend && fid ? await legendFidelity(r.id.slice(2), size) : null; // precomputed for the legends
    const p = trainPlayerBot(r.src, { nGames: r.nGames || 80, evaluate: false, fidelity: pre || fid, maia: arena.maia, onStatus: m => onStatus?.(`${r.name}: ${String(m).replace(/<[^>]+>/g, '')}`) });
    arena.models.set(key, p);
    p.catch(() => arena.models.delete(key));
  }
  const model = await arena.models.get(key);
  // remember what we learned for the card
  const facts = arena.facts[id] ||= {};
  facts.rating = model.playRating;
  if (!facts.style) facts.style = await botStyle(r).catch(() => null);
  if (!r.legend && !r.img) {
    const d = await loadSource(r.src).catch(() => null);
    const img = d?.player?.profile?.avatar;
    if (img) { const rr = arena.roster.find(x => x.id === id); if (rr) rr.img = img; }
  }
  saveRoster();
  const inst = Object.create(model);
  Object.assign(inst, { label: r.name, mode: r.mode || 'sample', guard: { moves: 0, flagged: 0, kept: 0 }, arenaId: id });
  return inst;
}

// Legends' high-fidelity weights, precomputed per Maia size (js/legend-fidelity.json), so building a legend
// needs no Stockfish pass
let _legendFid = null;
async function legendFidelity(id, size) {
  _legendFid ||= fetch('js/legend-fidelity.json').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  const f = (await _legendFid)[id]?.[size];
  return f ? { ...f, report: null, precomputed: true } : null;
}

// Style title for a bot card: legends from their precomputed fingerprints, others from their games' habits
async function botStyle(r) {
  if (r.legend) {
    const p = (await getFamousProfiles()).find(x => x.id === r.id.slice(2));
    return p ? styleTitle(styleDims(p.counts)).title : null;
  }
  const d = await loadSource(r.src);
  const hc = habitCounts(d.games.slice(0, 150));
  return hc ? styleTitle(styleDims(hc)).title : null;
}

function botCard(id, { compact = false, slot = null } = {}) {
  const r = botInfo(id);
  if (!r) return '';
  const f = arena.facts[id] || {};
  const style = r.legend ? arena.legendStyles?.[id] : f.style;
  const actions = compact ? (slot ? `<button class="icon-btn" data-unslot="${slot}" title="Remove">✕</button>` : '') : `
    <div class="bc-actions">
      <button class="icon-btn" data-dup="${id}" title="Duplicate">⧉</button>
      ${r.legend ? '' : `<button class="icon-btn" data-edit="${id}" title="Edit">✎</button><button class="icon-btn" data-del="${id}" title="Delete">×</button>`}
      <button class="icon-btn" data-add="${id}" title="Add to the match or tournament">+</button>
    </div>`;
  return `<div class="bot-card ${compact ? 'compact' : ''}" draggable="true" data-bot="${id}" title="Drag onto White, Black or the tournament">
    ${avatarHtml({ name: r.name, img: r.img, hue: r.hue, size: compact ? 38 : 46, crown: r.crown })}
    <div class="bc-body">
      <div class="bc-name">${esc(r.name)}${r.mode === 'likely' ? ' <span class="pill">most likely</span>' : ''}${r.fid === 'standard' ? ' <span class="pill" title="Maia only, not calibrated to their accuracy">standard</span>' : ''}</div>
      <div class="bc-sub">${r.legend ? esc(r.era) : esc(sourceText(r.src, r.nGames))}</div>
      ${compact ? '' : `${r.legend ? `<div class="bc-note">${esc(r.note)}</div>` : ''}
        <div class="bc-meta">${f.rating ? `<span class="bc-rating" title="The bot's playing strength (Lichess scale)">~${f.rating}</span>` : r.legend ? '' : '<span class="muted">not built yet</span>'}${style ? `<span class="bc-style" title="Style fingerprint vs their own opponents">${esc(style)}</span>` : ''}</div>`}
    </div>
    ${actions}
  </div>`;
}

// ---------- tab ----------
function renderArena(sec) {
  if (!arena.built) {
    sec.innerHTML = `
      <div class="arena-head card">
        <div><h2>Bot arena</h2><div class="sub">Drag bots in, or tap +.</div></div>
        <label class="muted small">Model <select id="arSize"><option value="auto">Auto</option><option value="5m">Standard (5M)</option><option value="23m">Large (23M)</option></select></label>
      </div>
      <div class="arena">
        <aside class="roster" id="arRoster"></aside>
        <section class="stage">
          <div class="seg" id="arViews"><button data-view="match">Match</button><button data-view="tournament">Tournament</button><button data-view="history">History</button></div>
          <div class="progress hidden" id="arProg"><div></div></div>
          <div class="muted small" id="arStatus"></div>
          <div id="arStage"></div>
        </section>
      </div>`;
    arena.built = true;
    // legends' style titles come from their precomputed fingerprints, no build needed
    getFamousProfiles().then(ps => {
      arena.legendStyles = Object.fromEntries(ps.map(p => ['f:' + p.id, styleTitle(styleDims(p.counts)).title]));
      drawRoster();
    });
    $('#arSize').value = arena.size;
    $('#arSize').onchange = e => { arena.size = e.target.value; };
    $$('#arViews button').forEach(b => b.onclick = () => { arena.view = b.dataset.view; drawStage(); });
    // drag & drop (delegated)
    sec.addEventListener('dragstart', e => { const c = e.target.closest?.('[data-bot]'); if (c) { e.dataTransfer.setData('text/bot', c.dataset.bot); e.dataTransfer.effectAllowed = 'copy'; c.classList.add('dragging'); } });
    sec.addEventListener('dragend', e => e.target.closest?.('[data-bot]')?.classList.remove('dragging'));
    sec.addEventListener('dragover', e => { const z = e.target.closest?.('[data-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } });
    sec.addEventListener('dragleave', e => { const z = e.target.closest?.('[data-drop]'); if (z) z.classList.remove('over'); });
    sec.addEventListener('drop', e => {
      const z = e.target.closest?.('[data-drop]'); if (!z) return;
      e.preventDefault(); z.classList.remove('over');
      const id = e.dataTransfer.getData('text/bot'); if (id) dropBot(z.dataset.drop, id);
    });
    sec.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.dup) duplicateBot(t.dataset.dup);
      else if (t.dataset.edit) openBotForm(t.dataset.edit);
      else if (t.dataset.del) deleteBot(t.dataset.del);
      else if (t.dataset.add) { dropBot(arena.view === 'match' ? (arena.white ? 'black' : 'white') : 'tour', t.dataset.add); }
      else if (t.dataset.unslot) { const s = t.dataset.unslot; if (s === 'white' || s === 'black') arena[s] = null; else arena.tour.entrants = arena.tour.entrants.filter(x => x !== s.slice(5)); arena.tour.odds = null; drawStage(); }
    });
  }
  drawRoster();
  drawStage();
}

function dropBot(zone, id) {
  if (arena.running) return;
  if (zone === 'white' || zone === 'black') { arena[zone] = id; arena.view = 'match'; }
  else if (zone === 'tour') { if (!arena.tour.entrants.includes(id)) arena.tour.entrants.push(id); arena.tour.odds = null; arena.view = 'tournament'; }
  drawStage();
}

function duplicateBot(id) {
  const r = botInfo(id);
  const copy = { id: 'u:' + Math.random().toString(36).slice(2, 9), name: `${r.name} (copy)`, src: r.src, nGames: r.nGames || 80, mode: r.mode || 'sample', fid: r.fid || 'high', img: r.img };
  arena.roster.push(copy); saveRoster();
  openBotForm(copy.id);
}

function deleteBot(id) {
  if (!confirm('Delete this bot?')) return;
  arena.roster = arena.roster.filter(r => r.id !== id);
  delete arena.facts[id];
  if (arena.white === id) arena.white = null;
  if (arena.black === id) arena.black = null;
  arena.tour.entrants = arena.tour.entrants.filter(x => x !== id);
  saveRoster(); drawRoster(); drawStage();
}

// ---------- roster + create/edit form ----------
function drawRoster() {
  const el = $('#arRoster');
  if (!el) return;
  const form = arena.form;
  el.innerHTML = `
    <div class="roster-head"><h3>Your bots</h3><button class="btn primary small-btn" id="arNew">Create a bot</button></div>
    ${form ? `<div class="bot-form card">
      <h3>${form.id ? 'Edit bot' : 'Create a bot'}</h3>
      <label class="field">Name<input id="bfName" value="${esc(form.name || '')}" placeholder="Defaults to the player's name"></label>
      <div class="field">Player ${form.src ? `<span class="pill">${esc(sourceLabel(form.src))} · ${esc(sourceText(form.src))}</span>` : '<span class="muted small">pick below, then press Use</span>'}</div>
      ${sourcePickerHtml('bfPicker', form.pick, { button: 'Use' })}
      <div class="prep-opts">
        ${S.username ? '<button class="btn small-btn" id="bfMe">Use my games</button>' : ''}
        <label>Learn from <select id="bfN">${[40, 80, 160, 300].map(n => `<option ${n === (form.nGames || 80) ? 'selected' : ''}>${n}</option>`).join('')}</select> games</label>
        <label>Fidelity <select id="bfFid"><option value="high" ${form.fid !== 'standard' ? 'selected' : ''}>High</option><option value="standard" ${form.fid === 'standard' ? 'selected' : ''}>Standard</option></select></label>
        <label>Plays <select id="bfMode"><option value="sample" ${form.mode !== 'likely' ? 'selected' : ''}>Like them</option><option value="likely" ${form.mode === 'likely' ? 'selected' : ''}>Most likely move</option></select></label>
      </div>
      <div class="row-between" style="margin-top:8px"><button class="btn" id="bfCancel">Cancel</button><button class="btn primary" id="bfSave" ${form.src ? '' : 'disabled'}>Save bot</button></div>
    </div>` : ''}
    <div class="bot-list">${arena.roster.map(r => botCard(r.id)).join('') || '<p class="muted small">No bots yet.</p>'}</div>
    <h3 style="margin-top:16px">Legends <span class="muted small">from their classical OTB games</span></h3>
    <div class="bot-list">${FAMOUS.map(f => botCard('f:' + f.id)).join('')}</div>`;
  $('#arNew').onclick = () => openBotForm(null);
  if (form) {
    bindSourcePicker($('#bfPicker'), form.pick, src => { form.src = src; form.name = $('#bfName').value; drawRoster(); });
    if ($('#bfMe')) $('#bfMe').onclick = () => { form.src = mySource(form.pick); form.name = $('#bfName').value || S.username; drawRoster(); };
    $('#bfN').onchange = e => form.nGames = +e.target.value;
    $('#bfMode').onchange = e => form.mode = e.target.value;
    $('#bfFid').onchange = e => form.fid = e.target.value;
    $('#bfCancel').onclick = () => { arena.form = null; drawRoster(); };
    $('#bfSave').onclick = () => {
      const name = $('#bfName').value.trim() || (form.src.kind === 'otb' ? form.src.name : form.src.user);
      const rec = { id: form.id || 'u:' + Math.random().toString(36).slice(2, 9), name, src: form.src, nGames: form.nGames || 80, mode: form.mode || 'sample', fid: form.fid || 'high' };
      const i = arena.roster.findIndex(r => r.id === rec.id);
      if (i >= 0) { const old = arena.roster[i]; if (JSON.stringify(old.src) !== JSON.stringify(rec.src)) { delete arena.facts[rec.id]; } else rec.img = old.img; arena.roster[i] = rec; }
      else arena.roster.push(rec);
      arena.form = null; saveRoster(); drawRoster(); drawStage();
    };
  }
}

function openBotForm(id) {
  const r = id ? arena.roster.find(x => x.id === id) : null;
  arena.form = r ? { id: r.id, name: r.name, src: r.src, nGames: r.nGames, mode: r.mode, fid: r.fid, pick: { kind: 'chesscom', user: r.src?.user || '', tc: r.src?.tc || 'all', recent: r.src?.recent || 100, title: 'GM', max: 300 } }
    : { pick: { kind: 'chesscom', user: '', tc: 'all', recent: 100, title: 'GM', max: 300 }, nGames: 80, mode: 'sample' };
  drawRoster();
  $('#arRoster').scrollTop = 0;
}

// ---------- stage ----------
function arenaStatus(msg, f) {
  if (msg != null) arena.status = msg;
  if (f != null) arena.progress = f;
  const st = $('#arStatus'), pr = $('#arProg');
  if (!st) return;
  st.innerHTML = arena.error ? `<span style="color:var(--critical)">${esc(arena.error)}</span>` : esc(arena.status);
  pr.classList.toggle('hidden', !arena.running);
  pr.firstElementChild.style.width = (arena.progress * 100) + '%';
}

function drawStage() {
  if (!arena.built) return;
  $$('#arViews button').forEach(b => b.classList.toggle('active', b.dataset.view === arena.view));
  arenaStatus();
  if (arena.view === 'match') drawMatchStage();
  else if (arena.view === 'tournament') drawTourStage();
  else drawHistory();
}

function slotHtml(side) {
  const id = arena[side];
  return `<div class="slot ${side}" data-drop="${side}">
    <div class="slot-label"><span class="dot ${side}"></span>${side === 'white' ? 'White' : 'Black'}</div>
    ${id ? botCard(id, { compact: true, slot: side }) : '<div class="slot-empty">Drag a bot here or tap +</div>'}
  </div>`;
}

function drawMatchStage() {
  const st = $('#arStage');
  const m = arena.match;
  st.innerHTML = `
    <div class="versus">
      ${slotHtml('white')}
      <button class="icon-btn swap" id="arSwap" title="Swap colors">⇄</button>
      ${slotHtml('black')}
    </div>
    <div class="prep-opts" style="justify-content:center">
      <label>Games <select id="arN">${[2, 10, 20, 50, 100].map(n => `<option ${n === arena.nGames ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <span class="muted small">colors alternate each game</span>
      <button class="btn primary" id="arPlay" ${arena.white && arena.black || arena.running ? '' : 'disabled'}>${arena.running ? 'Stop' : 'Play match'}</button>
    </div>
    <div id="arMatch"></div>`;
  $('#arSwap').onclick = () => { [arena.white, arena.black] = [arena.black, arena.white]; drawStage(); };
  $('#arN').onchange = e => arena.nGames = +e.target.value;
  $('#arPlay').onclick = () => { if (arena.running) arena.abort = true; else runArenaMatch(); };
  if (m) drawMatchResult(true);
}

async function runArenaMatch() {
  Object.assign(arena, { running: true, abort: false, error: null });
  arena.match = null; drawStage();
  const stop = () => arena.abort;
  try {
    arenaStatus('Building bots…', 0.02);
    const A = await ensureBot(arena.white, m => arenaStatus(m, 0.05));
    const B = await ensureBot(arena.black, m => arenaStatus(m, 0.2));
    drawRoster();
    arena.match = { A, B, games: [], watch: 0 };
    arenaStatus(`Playing ${arena.nGames} games: ${A.label} (~${A.playRating}) vs ${B.label} (~${B.playRating})…`, 0.35);
    let last = 0;
    const games = await playMatch(A, B, arena.maia, arena.nGames, {
      shouldAbort: stop,
      onStep: gs => {
        arena.match.games = gs;
        const done = gs.filter(g => g.result).length;
        arenaStatus(`Playing: ${done} of ${gs.length} games finished…`, 0.35 + 0.65 * done / gs.length);
        if (performance.now() - last > 150) { last = performance.now(); drawMatchResult(false); }
      },
    });
    await labelOpenings(games);
    const sm = matchSummary(games, A, B);
    arenaStatus(`Match finished: ${A.label} ${fmtScore(sm.score * sm.n)} – ${fmtScore((1 - sm.score) * sm.n)} ${B.label}.`, 1);
    arena.history.unshift({ type: 'match', date: Date.now(), a: A.label, b: B.label, aId: arena.white, bId: arena.black, n: sm.n, scoreA: sm.score * sm.n });
    arena.history = arena.history.slice(0, 30); store.set('cl:arena:history', arena.history);
  } catch (e) { arena.error = e.message || String(e); }
  arena.running = false;
  arenaStatus();
  if (arena.view === 'match') drawStage();
}

const fmtScore = x => (Math.round(x * 2) / 2).toString().replace('.5', '½').replace(/^0½/, '½');

function drawMatchResult(full) {
  const box = $('#arMatch');
  const m = arena.match;
  if (!box || !m || !m.games.length) return;
  const { A, B, games } = m;
  const sm = matchSummary(games, A, B);
  const g0 = games[Math.min(m.watch, games.length - 1)];
  if (full || !$('#arBoard')) {
    box.innerHTML = `
      <div class="scoreboard">
        <div class="sb-side">${avatarHtml({ name: A.label, img: botInfo(A.arenaId)?.img, hue: botInfo(A.arenaId)?.hue, size: 52 })}<div><b>${esc(A.label)}</b><div class="muted small">~${A.playRating}</div></div></div>
        <div class="sb-score" id="arScore"></div>
        <div class="sb-side right"><div><b>${esc(B.label)}</b><div class="muted small">~${B.playRating}</div></div>${avatarHtml({ name: B.label, img: botInfo(B.arenaId)?.img, hue: botInfo(B.arenaId)?.hue, size: 52 })}</div>
      </div>
      <div class="sb-bar" id="arBar"></div>
      <div class="muted small" id="arSbNote" style="text-align:center;margin:6px 0 14px"></div>
      <div class="grid cols-2">
        <div class="card"><div class="row-between"><h3 id="arWatchTitle"></h3><span class="muted small">click a game to watch it</span></div>
          <div class="match-board" style="--bs:min(360px, calc(100vw - 80px))"><div class="board" id="arBoard"></div></div>
          <div class="var-line small" id="arMoves"></div></div>
        <div class="card"><h3>Games</h3><div class="table-wrap" style="max-height:470px;overflow-y:auto"><table><thead><tr><th>#</th><th>White</th><th>Black</th><th>Result</th><th class="num">Moves</th><th>Ended by</th><th>Opening</th></tr></thead><tbody id="arRows"></tbody></table></div></div>
      </div>`;
    arena.board = new BoardView($('#arBoard'), { onMove: () => {} });
  }
  const a = sm.score != null ? sm.score * sm.n : 0, b = sm.n - a;
  $('#arScore').innerHTML = `${fmtScore(a)}<span class="muted"> – </span>${fmtScore(b)}`;
  $('#arBar').innerHTML = `<div style="flex:${a || 0.0001};background:var(--s1)"></div><div style="flex:${b || 0.0001};background:var(--s2)"></div>`;
  $('#arSbNote').textContent = sm.n ? `${sm.n} of ${games.length} games · ${sm.all.w}W ${sm.all.d}D ${sm.all.l}L for ${A.label} · ratings predicted ${pct(sm.expected)} for ${A.label}${sm.ci ? ` · result range ${pct(sm.ci[0])}–${pct(sm.ci[1])}` : ''}` : 'Starting…';
  const last = g0.sans.length ? new Chess(g0.fens.at(-2)).move(g0.sans.at(-1)) : null;
  arena.board.set({ fen: g0.fens.at(-1), orientation: g0.white === A ? 'white' : 'black', lastMove: last });
  $('#arWatchTitle').textContent = `Game ${g0.i + 1}: ${g0.white.label} vs ${g0.black.label}${g0.result ? ` — ${g0.result}` : ''}`;
  $('#arMoves').innerHTML = g0.sans.map((s, i) => (i % 2 === 0 ? `<span class="muted">${i / 2 + 1}.</span>` : '') + esc(s)).join(' ') + (g0.result ? ` <b>${g0.result}</b>${g0.reason ? ` <span class="muted">(${g0.reason})</span>` : ''}` : ' …');
  $('#arRows').innerHTML = games.map(g => `<tr class="clickable ${g === g0 ? 'sel-row' : ''}" data-mg="${g.i}"><td>${g.i + 1}</td><td>${esc(g.white.label)}</td><td>${esc(g.black.label)}</td>
    <td>${g.result ? `<b>${g.result}</b>` : '<span class="muted">playing…</span>'}</td><td class="num">${Math.ceil(g.sans.length / 2)}</td><td>${g.reason || ''}</td><td>${esc(g.opening || '')}</td></tr>`).join('');
  $$('#arRows [data-mg]').forEach(tr => tr.onclick = () => {
    const g = games[+tr.dataset.mg];
    if (!arena.running && g.result) { openReview(matchGameRecord(g)); return; }
    m.watch = g.i; drawMatchResult(false);
  });
}

// ---------- tournaments ----------
// Pre-tournament odds: simulate the round robin many times from the bots' ratings
function tourOdds(bots, perPair, sims = 4000) {
  const n = bots.length, wins = new Array(n).fill(0), pts = new Array(n).fill(0);
  for (let s = 0; s < sims; s++) {
    const score = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = 0; k < perPair; k++) {
      const e = eloExpected(bots[i].playRating - bots[j].playRating);
      const pd = 0.25 * 4 * e * (1 - e); // draws are likeliest between equals
      const r = Math.random();
      const x = r < e - pd / 2 ? 1 : r < e + pd / 2 ? 0.5 : 0;
      score[i] += x; score[j] += 1 - x;
    }
    const top = Math.max(...score), leaders = score.map((v, i) => v === top ? i : -1).filter(i => i >= 0);
    leaders.forEach(i => wins[i] += 1 / leaders.length);
    score.forEach((v, i) => pts[i] += v);
  }
  return bots.map((b, i) => ({ id: b.arenaId, name: b.label, rating: b.playRating, win: wins[i] / sims, expPts: pts[i] / sims }));
}

function standings(entrants, games) {
  const rows = new Map(entrants.map(b => [b.arenaId, { id: b.arenaId, name: b.label, rating: b.playRating, pts: 0, w: 0, d: 0, l: 0, n: 0, sb: 0, vs: {} }]));
  for (const g of games) {
    if (!g.result) continue;
    const w = rows.get(g.white.arenaId), b = rows.get(g.black.arenaId);
    const sw = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
    for (const [me, opp, s] of [[w, b, sw], [b, w, 1 - sw]]) {
      me.pts += s; me.n++; me[s === 1 ? 'w' : s === 0 ? 'l' : 'd']++;
      me.vs[opp.id] = (me.vs[opp.id] || 0) + s;
    }
  }
  const list = [...rows.values()];
  for (const r of list) r.sb = sum(Object.entries(r.vs).map(([o, s]) => s * rows.get(o).pts)); // Sonneborn–Berger
  return list.sort((a, b) => b.pts - a.pts || b.sb - a.sb);
}

// Placement points against the final standings (tiebreaks included): 5 / 3 / 2 for calling 1st / 2nd / 3rd
// exactly, 1 for a pick that finishes in the top 3 but in a different place. Tied friends share a rank.
const PRED_POINTS = [5, 3, 2];
function scorePredictions(preds, table) {
  const place = new Map(table.map((r, i) => [r.id, i]));
  const scored = preds.map(p => {
    const points = sum(p.picks.map((x, k) => { const pl = place.get(x); return pl == null ? 0 : pl === k ? PRED_POINTS[k] : pl < 3 ? 1 : 0; }));
    return { ...p, points, gotWinner: place.get(p.picks[0]) === 0 };
  }).sort((a, b) => b.points - a.points);
  scored.forEach(p => p.rank = 1 + scored.filter(q => q.points > p.points).length);
  return scored;
}

function drawTourStage() {
  const st = $('#arStage');
  const t = arena.tour;
  const ents = t.entrants.map(botInfo).filter(Boolean);
  const nGames = ents.length * (ents.length - 1) / 2 * t.perPair;
  const opt = sel => ents.map(e => `<option value="${e.id}" ${sel === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
  st.innerHTML = `
    <div class="card">
      <h3>Round robin</h3>
      <div class="sub">Everyone plays everyone.</div>
      <div class="dropzone" data-drop="tour">${ents.length ? ents.map(e => botCard(e.id, { compact: true, slot: 'tour:' + e.id })).join('') : '<div class="slot-empty">Drag bots here or tap + · 3–10 is best</div>'}</div>
      <div class="prep-opts">
        <label>Games per pairing <select id="tpPer">${[2, 4, 6, 10].map(n => `<option ${n === t.perPair ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <span class="muted small">${ents.length >= 2 ? `${nGames} games in total` : ''}</span>
        <button class="btn" id="tpOdds" ${ents.length >= 2 && !arena.running ? '' : 'disabled'}>Build bots & show odds</button>
        <button class="btn primary" id="tpGo" ${(ents.length >= 2 && !arena.running) || arena.running ? '' : 'disabled'}>${arena.running ? 'Stop' : 'Start tournament'}</button>
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>Odds</h3>
        ${t.odds ? `<div class="sub">4,000 simulations from ratings</div><table class="cmp"><thead><tr><th>Bot</th><th class="num">Rating</th><th class="num">Win chance</th><th class="num">Expected points</th></tr></thead><tbody>
          ${t.odds.slice().sort((a, b) => b.win - a.win).map(o => `<tr><td>${esc(o.name)}</td><td class="num">~${o.rating}</td><td class="num"><b>${pct(o.win, o.win < 0.1 ? 1 : 0)}</b></td><td class="num">${num(o.expPts, 1)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted small">Press “Build bots & show odds” to see each bot\'s chances before the games start.</p>'}
      </div>
      <div class="card"><h3>Predictions</h3><div class="sub">5 / 3 / 2 for an exact place, 1 for top 3</div>
        <div class="pred-form">
          <input id="pdName" placeholder="Friend's name">
          <select id="pd1"><option value="">Winner…</option>${opt()}</select>
          <select id="pd2"><option value="">2nd…</option>${opt()}</select>
          <select id="pd3"><option value="">3rd…</option>${opt()}</select>
          <button class="btn small-btn" id="pdAdd" ${ents.length >= 2 ? '' : 'disabled'}>Add</button>
        </div>
        ${t.predictions.length ? `<table><tbody>${t.predictions.map((p, i) => `<tr><td><b>${esc(p.name)}</b></td><td>${p.picks.map(x => esc(botInfo(x)?.name || '–')).join(' › ')}</td><td><button class="icon-btn" data-delpred="${i}">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No predictions yet.</p>'}
      </div>
    </div>
    <div id="tpResult"></div>`;
  $('#tpPer').onchange = e => { t.perPair = +e.target.value; t.odds = null; drawStage(); };
  $('#tpOdds').onclick = () => buildTourOdds();
  $('#tpGo').onclick = () => { if (arena.running) arena.abort = true; else runTournament(); };
  $('#pdAdd').onclick = () => {
    const name = $('#pdName').value.trim(); const picks = [$('#pd1').value, $('#pd2').value, $('#pd3').value];
    if (!name || !picks[0]) return;
    t.predictions.push({ name, picks }); drawStage();
  };
  $$('[data-delpred]').forEach(b => b.onclick = () => { t.predictions.splice(+b.dataset.delpred, 1); drawStage(); });
  if (t.result || t.live) drawTourResult();
}

async function buildEntrants(onStatus) {
  const bots = [];
  for (let i = 0; i < arena.tour.entrants.length; i++) {
    bots.push(await ensureBot(arena.tour.entrants[i], m => onStatus(m, 0.3 * i / arena.tour.entrants.length)));
  }
  drawRoster();
  return bots;
}

async function buildTourOdds() {
  Object.assign(arena, { running: true, abort: false, error: null });
  drawStage();
  try {
    const bots = await buildEntrants((m, f) => arenaStatus(m, f));
    arena.tour.odds = tourOdds(bots, arena.tour.perPair);
    arenaStatus('Odds ready — add predictions, then start the tournament.', 1);
  } catch (e) { arena.error = e.message || String(e); }
  arena.running = false; drawStage();
}

async function runTournament() {
  Object.assign(arena, { running: true, abort: false, error: null });
  const t = arena.tour;
  t.result = null; drawStage();
  try {
    const bots = await buildEntrants((m, f) => arenaStatus(m, f));
    if (!t.odds) t.odds = tourOdds(bots, t.perPair);
    const pairs = [];
    for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) for (let k = 0; k < t.perPair; k++) {
      pairs.push(k % 2 === 0 ? { white: bots[i], black: bots[j] } : { white: bots[j], black: bots[i] });
    }
    t.live = { bots, games: [] };
    arenaStatus(`Playing ${pairs.length} games…`, 0.32);
    let last = 0;
    const games = await playGames(pairs, arena.maia, {
      shouldAbort: () => arena.abort,
      onStep: gs => {
        t.live.games = gs;
        const done = gs.filter(g => g.result).length;
        arenaStatus(`Round robin: ${done} of ${gs.length} games finished…`, 0.32 + 0.68 * done / gs.length);
        if (performance.now() - last > 300) { last = performance.now(); drawTourResult(); }
      },
    });
    await labelOpenings(games);
    const table = standings(bots, games);
    t.result = { table, games, bots, predictions: scorePredictions(t.predictions, table), odds: t.odds, date: Date.now(), perPair: t.perPair };
    t.live = null;
    arenaStatus(`Tournament finished: ${table[0].name} wins with ${fmtScore(table[0].pts)} points.`, 1);
    arena.history.unshift({ type: 'tournament', date: Date.now(), perPair: t.perPair, table: table.map(r => ({ name: r.name, pts: r.pts, w: r.w, d: r.d, l: r.l })), predictions: t.result.predictions.map(p => ({ name: p.name, points: p.points, picks: p.picks.map(x => botInfo(x)?.name) })) });
    arena.history = arena.history.slice(0, 30); store.set('cl:arena:history', arena.history);
  } catch (e) { arena.error = e.message || String(e); }
  arena.running = false;
  if (arena.view === 'tournament') drawStage(); else arenaStatus();
}

function drawTourResult() {
  const box = $('#tpResult');
  if (!box) return;
  const t = arena.tour;
  const src = t.result || (t.live && { table: standings(t.live.bots, t.live.games), games: t.live.games, bots: t.live.bots, live: true });
  if (!src) return;
  const { table, bots, games } = src;
  const done = games.filter(g => g.result).length;
  const cross = `<table class="crosstable"><thead><tr><th></th>${table.map((r, i) => `<th class="num" title="${esc(r.name)}">${i + 1}</th>`).join('')}<th class="num">Pts</th></tr></thead><tbody>
    ${table.map((r, i) => `<tr><td><b>${i + 1}.</b> ${esc(r.name)}</td>${table.map(c => c.id === r.id ? '<td class="x"></td>' : `<td class="num">${r.vs[c.id] != null ? fmtScore(r.vs[c.id]) : ''}</td>`).join('')}<td class="num"><b>${fmtScore(r.pts)}</b></td></tr>`).join('')}
  </tbody></table>`;
  const preds = t.result?.predictions || [];
  box.innerHTML = `
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>${src.live ? `Standings (live, ${done} of ${games.length} games)` : 'Final standings'}</h3>
        <table class="standings"><thead><tr><th>#</th><th>Bot</th><th class="num">Pts</th><th class="num">W–D–L</th><th class="num">SB</th><th class="num">Pre-odds</th></tr></thead><tbody>
          ${table.map((r, i) => { const o = t.odds?.find(x => x.id === r.id); const b = botInfo(r.id);
            return `<tr class="${i === 0 && !src.live ? 'winner' : ''}"><td>${i === 0 && !src.live ? '<span class="crown" title="Winner">♛</span>' : i + 1}</td><td><span class="who">${avatarHtml({ name: r.name, img: b?.img, hue: b?.hue, size: 26 })}${esc(r.name)}</span></td><td class="num"><b>${fmtScore(r.pts)}</b></td><td class="num">${r.w}–${r.d}–${r.l}</td><td class="num">${num(r.sb, 1)}</td><td class="num">${o ? pct(o.win) : '–'}</td></tr>`; }).join('')}
        </tbody></table></div>
      <div class="card"><h3>Crosstable</h3><div class="table-wrap">${cross}</div></div>
    </div>
    ${!src.live && preds.length ? `<div class="card" style="margin-top:14px"><h3>Prediction results</h3><table class="standings"><thead><tr><th>#</th><th>Friend</th><th>Picks</th><th class="num">Points</th></tr></thead><tbody>
      ${preds.map(p => `<tr class="${p.rank === 1 ? 'winner' : ''}"><td>${p.rank === 1 ? '<span class="crown" title="Best prediction">♛</span>' : p.rank}</td><td><b>${esc(p.name)}</b>${p.gotWinner ? ' <span class="pill best-try">called it</span>' : ''}</td><td>${p.picks.map(x => esc(botInfo(x)?.name || '–')).join(' › ')}</td><td class="num"><b>${p.points}</b></td></tr>`).join('')}
    </tbody></table><button class="btn small-btn" id="tpShare" style="margin-top:8px">Copy results to share</button></div>` : ''}
    ${!src.live ? `<div class="card" style="margin-top:14px"><h3>All games</h3><div class="table-wrap" style="max-height:360px;overflow-y:auto"><table><thead><tr><th>White</th><th>Black</th><th>Result</th><th class="num">Moves</th><th>Ended by</th><th>Opening</th></tr></thead><tbody>
      ${games.map(g => `<tr class="clickable" data-tg="${g.i}"><td>${esc(g.white.label)}</td><td>${esc(g.black.label)}</td><td><b>${g.result}</b></td><td class="num">${Math.ceil(g.sans.length / 2)}</td><td>${g.reason || ''}</td><td>${esc(g.opening || '')}</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}`;
  $$('#tpResult [data-tg]').forEach(tr => tr.onclick = () => openReview(matchGameRecord(games[+tr.dataset.tg])));
  const share = $('#tpShare');
  if (share) share.onclick = async () => {
    const txt = `Chess Lens bot tournament (${t.result.perPair} games per pairing)\n` + table.map((r, i) => `${i + 1}. ${r.name} — ${fmtScore(r.pts)} (${r.w}W ${r.d}D ${r.l}L)`).join('\n')
      + (preds.length ? '\n\nPredictions:\n' + preds.map(p => `${p.name}: ${p.points} pts (${p.picks.map(x => botInfo(x)?.name || '–').join(' › ')})`).join('\n') : '');
    try { await navigator.clipboard.writeText(txt); share.textContent = 'Copied!'; } catch { share.textContent = 'Could not copy'; }
  };
}

function drawHistory() {
  const st = $('#arStage');
  st.innerHTML = `<div class="card"><h3>History</h3>${arena.history.length ? arena.history.map(h => h.type === 'match'
    ? `<div class="hist"><span class="pill">Match</span> <b>${esc(h.a)}</b> ${fmtScore(h.scoreA)} – ${fmtScore(h.n - h.scoreA)} <b>${esc(h.b)}</b> <span class="muted small">${h.n} games · ${new Date(h.date).toLocaleString()}</span></div>`
    : `<div class="hist"><span class="pill">Tournament</span> <span class="crown">♛</span> <b>${esc(h.table[0].name)}</b> (${fmtScore(h.table[0].pts)}) <span class="muted small">${h.table.length} bots · ${new Date(h.date).toLocaleString()}</span>
        <div class="small muted">${h.table.map((r, i) => `${i + 1}. ${esc(r.name)} ${fmtScore(r.pts)}`).join(' · ')}</div>
        ${h.predictions?.length ? `<div class="small">Predictions: ${h.predictions.map(p => `${esc(p.name)} ${p.points} pts`).join(' · ')}</div>` : ''}</div>`).join('')
    : '<p class="muted small">Matches and tournaments you run appear here.</p>'}</div>`;
}
