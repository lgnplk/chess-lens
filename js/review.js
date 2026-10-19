// Game review: board + side panel with eval graph, coach, live engine lines, move list, and report
const review = {
  game: null, fens: [], moves: [], analysis: null, ply: 0, orientation: 'white', busy: false, token: 0,
  variation: null,           // { base, fens: [...], moves: [...], idx }
  live: null, liveLines: [], liveFen: null, liveOn: store.get('cl:liveOn', true), sub: 'analysis',
};
let boardView = null;

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'pgn:' + h; }

function openReview(game, ply) {
  if (!game) return;
  review.game = game;
  const r = replay(game.sans);
  review.fens = r.fens;
  review.moves = r.moves.map(m => ({ san: m.san, color: m.color, from: m.from, to: m.to, promotion: m.promotion }));
  review.analysis = null;
  review.variation = null;
  review.ply = ply ?? 0;
  review.orientation = game.color || 'white';
  review.token++;
  if (S.tab !== 'review') switchTab('review');
  renderReviewHead();
  renderMoveList();
  renderReviewReport();
  drawEvalChart();
  drawReview();
  startReviewAnalysis();
}

// ---------- current position helpers ----------
function curFen() {
  const v = review.variation;
  return v ? v.fens[v.idx] : review.fens[review.ply];
}
function curLastMove() {
  const v = review.variation;
  if (v) return v.idx > 0 ? v.moves[v.idx - 1] : (v.base > 0 ? review.moves[v.base - 1] : null);
  return review.ply > 0 ? review.moves[review.ply - 1] : null;
}

// ---------- header with game picker ----------
function renderReviewHead() {
  const g = review.game;
  const list = S.filtered.length ? S.filtered : S.games;
  const idx = g ? list.findIndex(x => x.id === g.id) : -1;
  const opts = list.slice(0, 400).map((x, i) => `<option value="${i}" ${i === idx ? 'selected' : ''}>${x.result === 'win' ? 'W' : x.result === 'draw' ? 'D' : 'L'} · vs ${esc(x.opp.name)} (${x.opp.rating}) · ${fmtDate(x.end)} · ${x.timeClass}</option>`).join('');
  const w = g ? (g.color === 'white' ? g.me : g.opp) : null, b = g ? (g.color === 'white' ? g.opp : g.me) : null;
  $('#rvHead').innerHTML = `
    ${list.length ? `<div class="rv-picker">
      <button class="btn icon" id="rvPrevGame" title="Previous game" ${idx <= 0 && g ? 'disabled' : ''}>‹</button>
      <select id="rvGameSel">${idx === -1 ? '<option value="">— Pick a game —</option>' : ''}${opts}</select>
      <button class="btn icon" id="rvNextGame" title="Next game" ${idx >= list.length - 1 ? 'disabled' : ''}>›</button>
    </div>` : ''}
    ${g ? `<div class="rv-meta"><b>${esc(w.name)}</b> ${w.rating ?? ''} vs <b>${esc(b.name)}</b> ${b.rating ?? ''} ${g.result ? resBadge(g.result) : ''}
      <div class="muted small">${g.timeClass ? tcLabel(g) + ' · ' : ''}${g.reason ? (REASON_LABEL[g.reason] || g.reason) + ' · ' : ''}${g.end ? fmtDate(g.end) : ''}${g.url ? ` · <a href="${esc(g.url)}" target="_blank" rel="noopener">chess.com ↗</a>` : ''}</div></div>`
      : '<p class="muted small">Pick a game above, click one in the Games tab, or paste a PGN in the Report tab.</p>'}`;
  const sel = $('#rvGameSel');
  if (sel) sel.onchange = () => sel.value !== '' && openReview(list[+sel.value]);
  const pv = $('#rvPrevGame'), nx = $('#rvNextGame');
  if (pv) pv.onclick = () => openReview(list[Math.max(0, idx - 1)]);
  if (nx) nx.onclick = () => openReview(list[idx + 1]);
}

// ---------- analysis ----------
async function startReviewAnalysis() {
  const g = review.game;
  const token = review.token;
  const depth = +$('#reviewDepth').value;
  const prog = $('#reviewProgress');
  if (review.busy) resetEngine();
  review.busy = true;
  prog.classList.remove('hidden');
  prog.firstElementChild.style.width = '0%';
  renderCoach();
  const a = await analyzeGame({ id: g.id, sans: g.sans, clocks: g.clocks, base: g.base }, depth,
    (d, n) => {
      if (token !== review.token) return;
      prog.firstElementChild.style.width = (d / n * 100) + '%';
      review.progress = d / n;
      if (!review.analysis) renderCoach();
    },
    () => token !== review.token);
  if (token !== review.token) return;
  review.busy = false;
  prog.classList.add('hidden');
  if (!a) return;
  review.analysis = a;
  renderMoveList(); renderReviewReport(); drawEvalChart(); drawReview();
}

// ---------- drawing ----------
function drawReview() {
  if (!boardView || !review.game) return;
  const a = review.analysis, v = review.variation, p = review.ply;
  const fen = curFen();
  const opts = { fen, orientation: review.orientation, lastMove: curLastMove(), arrows: [] };
  if (!v && a) {
    const mv = p > 0 ? a.moves[p - 1] : null;
    if (mv) opts.badge = { sq: mv.to, cls: mv.cls, text: CLS[mv.cls].sym };
    if (mv && ERROR_CLS.has(mv.cls) && mv.best) opts.arrows.push({ from: mv.best.slice(0, 2), to: mv.best.slice(2, 4), color: cssVar('--good') });
    else if (a.evals[p]?.best) opts.arrows.push({ from: a.evals[p].best.slice(0, 2), to: a.evals[p].best.slice(2, 4), color: cssVar('--s1'), opacity: 0.7 });
    setEvalBar(a.evals[p]);
  } else if (review.liveLines[0] && review.liveFen === fen) {
    const l = review.liveLines[0];
    opts.arrows.push({ from: l.best.slice(0, 2), to: l.best.slice(2, 4), color: cssVar('--s1'), opacity: 0.7 });
    setEvalBar(l);
  } else setEvalBar(null);
  boardView.set(opts);
  drawPlayers(fen);
  $$('#moveList .mv').forEach(e => e.classList.toggle('cur', !v && +e.dataset.ply === p));
  const cur = !v && $(`#moveList .mv[data-ply="${p}"]`);
  if (cur) {
    const box = $('#moveList'), t = cur.offsetTop - box.offsetTop;
    if (t < box.scrollTop + 10 || t > box.scrollTop + box.clientHeight - 40) box.scrollTop = t - box.clientHeight / 2;
  } else if (!v && p === 0) $('#moveList').scrollTop = 0;
  renderCoach();
  startLive();
  const ch = charts.evalChart; if (ch) ch.update('none');
}

function drawPlayers(fen) {
  const g = review.game;
  const top = review.orientation === 'white' ? 'black' : 'white';
  const mat = materialInfo(fen);
  const p = review.variation ? review.variation.base : review.ply;
  const line = c => {
    const pl = c === g.color ? g.me : g.opp;
    const caps = c === 'white' ? mat.capturedByW : mat.capturedByB;
    const capColor = c === 'white' ? 'b' : 'w';
    const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
    const capHtml = [...caps].sort((x, y) => order[x] - order[y]).map(k => `<img src="${PIECE_IMG}${capColor}${k.toUpperCase()}.svg" alt="">`).join('');
    const adv = c === 'white' ? mat.diff : -mat.diff;
    const ck = clockAt(c === 'white' ? 0 : 1, p);
    return `<span class="pl"><span class="dot ${c}"></span><b>${esc(pl?.name || c)}</b> <span class="muted">${pl?.rating ?? ''}</span>
      <span class="caps">${capHtml}${adv > 0 ? `<span class="adv">+${adv}</span>` : ''}</span></span>${ck != null ? `<span class="clock">${fmtClock(ck)}</span>` : ''}`;
  };
  $('#topPlayer').innerHTML = line(top);
  $('#bottomPlayer').innerHTML = line(top === 'white' ? 'black' : 'white');
}

function clockAt(colorIdx, ply) {
  const g = review.game;
  if (!g.base || !g.clocks?.length) return null;
  for (let i = ply - 1; i >= 0; i--) if (i % 2 === colorIdx && g.clocks[i] != null) return g.clocks[i];
  return g.base;
}

function setEvalBar(ev) {
  paintEvalBar($('#evalbar'), ev, review.orientation === 'white');
}

// ---------- coach box ----------
// For mistakes and blunders: what kind it was (js/blunders.js) and the habit that prevents it
function coachDiagnosis(a, m) {
  if (!['mistake', 'miss', 'blunder'].includes(m.cls) || typeof classifyBlunder !== 'function') return '';
  if (m._bl === undefined) { try { m._bl = classifyBlunder(m, a.fens); } catch { m._bl = null; } }
  const d = m._bl, c = d && BL_CATS[d.cat];
  if (!c) return '';
  return `<div class="coach-diag"><div><span class="diag-kind">${esc(BL_FAMILIES[c.fam].label)}</span> <b>${esc(c.label)}</b>${d.line.length ? ` <span class="muted">— ${esc(d.line.slice(0, 3).join(' '))}</span>` : ''}</div>
    <div class="diag-tip">${esc(c.tip)}</div></div>`;
}

function renderCoach() {
  const box = $('#coach');
  if (!review.game) { box.innerHTML = ''; return; }
  const a = review.analysis, v = review.variation, p = review.ply;
  if (v) {
    const sans = v.moves.map(m => m.san);
    const toks = fmtLine(v.fens[0], sans).split(' ');
    box.innerHTML = `<div class="coach-head"><span class="cls-big cls-explore">⎇</span><div><b>Exploring a variation</b>
      <div class="muted small">from move ${Math.floor(v.base / 2) + 1}${v.base % 2 ? '...' : '.'}</div></div>
      <button class="btn small-btn" id="backToGame">Back to game</button></div>
      <div class="var-line">${toks.map((t, i) => `<span class="mv ${i + 1 === v.idx ? 'cur' : ''}" data-vi="${i + 1}">${t}</span>`).join(' ')}</div>`;
    $('#backToGame').onclick = exitVariation;
    $$('#coach [data-vi]').forEach(e => e.onclick = () => { v.idx = +e.dataset.vi; drawReview(); });
    return;
  }
  const opening = a && p > 0 ? a.moves[Math.min(p, a.moves.length) - 1].opening : null;
  const openTxt = opening ? `<div class="opening">${esc(opening.eco)} · ${esc(opening.name)}</div>` : (review.game.opening && p <= 12 ? `<div class="opening">${esc(review.game.opening)}</div>` : '');
  if (!a) {
    box.innerHTML = `<div class="coach-head"><span class="cls-big cls-wait">⋯</span><div><b>Analyzing with Stockfish…</b>
      <div class="muted small">${Math.round((review.progress || 0) * 100)}%</div></div></div>${openTxt}`;
    return;
  }
  if (p === 0) {
    const w = a.summary.w.accuracy, b = a.summary.b.accuracy;
    box.innerHTML = `<div class="coach-head"><span class="cls-big cls-start">♟</span><div><b>Game analyzed</b>
      <div class="muted small">Accuracy: White ${num(w, 1)} · Black ${num(b, 1)}</div></div></div>`;
    return;
  }
  const m = a.moves[p - 1];
  const moveNo = `${Math.floor((p - 1) / 2) + 1}${m.color === 'w' ? '.' : '...'}`;
  box.innerHTML = `${openTxt}<div class="coach-head"><span class="cls-big cls-${m.cls}">${CLS[m.cls].sym}</span>
    <div><b>${moveNo} ${m.san}</b> is ${/^[aeiou]/i.test(CLS[m.cls].label) ? 'an' : 'a'} <b class="t-${m.cls}">${CLS[m.cls].label.toLowerCase()}</b> move
    <div class="muted small">Eval ${fmtEval(m.evalBefore)} → ${fmtEval(m.evalAfter)}</div></div></div>
    <p class="coach-text">${explainMove(a, p - 1)}</p>
    ${coachDiagnosis(a, m)}
    ${ERROR_CLS.has(m.cls) && m.best ? `<button class="btn small-btn" id="showBest">Show best line on board</button>` : ''}`;
  const sb = $('#showBest');
  if (sb) sb.onclick = () => {
    const pv = a.evals[p - 1].pv || [m.best];
    review.ply = p - 1;
    playUcis(pv.slice(0, 8), true);
    review.variation && (review.variation.idx = 1);
    drawReview();
  };
}

// ---------- live engine lines ----------
function startLive() {
  const box = $('#engineLines');
  if (!review.liveOn || !review.game || S.tab !== 'review') { review.live?.stopAll(); box.innerHTML = review.liveOn ? '' : '<div class="muted small">Engine lines off</div>'; return; }
  const fen = curFen();
  const c = new Chess(fen);
  if (c.game_over()) {
    review.live?.stopAll();
    box.innerHTML = `<div class="muted small">${c.in_checkmate() ? 'Checkmate' : c.in_stalemate() ? 'Stalemate' : 'Draw'}</div>`;
    return;
  }
  if (review.liveFen === fen && review.liveLines.length) { renderLiveLines(); return; }
  if (!review.live) review.live = new LiveEngine(3);
  review.liveFen = fen; review.liveLines = [];
  box.innerHTML = '<div class="muted small">Thinking…</div>';
  review.live.start(fen, 22, (lines) => {
    if (review.liveFen !== fen) return;
    review.liveLines = lines;
    if (!review._liveRaf) review._liveRaf = requestAnimationFrame(() => {
      review._liveRaf = null;
      renderLiveLines();
      if (review.variation || !review.analysis) { // eval bar + arrow follow the live engine off the main line
        const l = review.liveLines[0];
        if (l) { setEvalBar(l); }
      }
    });
  });
}

function renderLiveLines() {
  const fen = review.liveFen, lines = review.liveLines;
  if (!lines.length) return;
  $('#engineLines').innerHTML = `<div class="lines-head muted small">Stockfish 10 · depth ${lines[0].depth}</div>` + lines.map((l, i) => {
    const sans = pvToSan(fen, l.pv, 10);
    const toks = fmtLine(fen, sans).split(' ');
    const cp = evalToCp(l);
    return `<div class="line"><span class="ev ${cp >= 0 ? 'ev-w' : 'ev-b'}">${fmtEval(l)}</span><span class="pv">${toks.map((t, k) => `<span class="mv" data-li="${i}" data-k="${k}">${t}</span>`).join(' ')}</span></div>`;
  }).join('');
  $$('#engineLines [data-li]').forEach(e => e.onclick = () => {
    const l = review.liveLines[+e.dataset.li];
    playUcis(l.pv.slice(0, +e.dataset.k + 1));
  });
}

// ---------- variations ----------
function playUcis(ucis, fresh = false) {
  for (const u of ucis) {
    const c = new Chess(curFen());
    const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
    if (!mv) break;
    applyMove(mv, c.fen(), true, fresh);
    fresh = false;
  }
  drawReview();
}

function applyMove(mv, fen, silent = false, forceVariation = false) {
  const v = review.variation;
  const main = review.moves[review.ply];
  if (!v && !forceVariation && main && main.from === mv.from && main.to === mv.to) {
    review.ply++;
  } else if (!v) {
    review.variation = { base: review.ply, fens: [review.fens[review.ply], fen], moves: [mv], idx: 1 };
  } else {
    v.fens = v.fens.slice(0, v.idx + 1); v.moves = v.moves.slice(0, v.idx);
    v.fens.push(fen); v.moves.push(mv); v.idx++;
  }
  if (!silent) drawReview();
}

function exitVariation() {
  if (!review.variation) return;
  review.ply = review.variation.base;
  review.variation = null;
  drawReview();
}

// ---------- move list ----------
function renderMoveList() {
  const a = review.analysis;
  const noisy = new Set(['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder']);
  let h = '<table>';
  for (let i = 0; i < review.moves.length; i += 2) {
    const cell = j => {
      if (j >= review.moves.length) return '<td></td>';
      const m = a ? a.moves[j] : null;
      return `<td><span class="mv ${m && noisy.has(m.cls) ? 't-' + m.cls : ''}" data-ply="${j + 1}">${m ? `<span class="cls cls-${m.cls}" title="${CLS[m.cls].label}">${CLS[m.cls].sym}</span>` : ''}${review.moves[j].san}</span></td>`;
    };
    h += `<tr><td class="mn">${i / 2 + 1}.</td>${cell(i)}${cell(i + 1)}</tr>`;
  }
  $('#moveList').innerHTML = h + '</table>';
  $$('#moveList .mv').forEach(e => e.addEventListener('click', () => { review.variation = null; review.ply = +e.dataset.ply; drawReview(); }));
}

// ---------- report sub-tab ----------
function renderReviewReport() {
  const a = review.analysis, g = review.game;
  const box = $('#reviewSummary');
  if (!g) { box.innerHTML = ''; $('#keyMoments').innerHTML = ''; return; }
  if (!a) { box.innerHTML = '<p class="muted">The report appears once Stockfish finishes.</p>'; $('#keyMoments').innerHTML = ''; return; }
  const W = a.summary.w, B = a.summary.b;
  const wName = g.color === 'white' ? g.me.name : g.opp.name, bName = g.color === 'white' ? g.opp.name : g.me.name;
  const ph = (s, p) => s.phaseAcc[p] ? num(s.phaseAcc[p].acc, 0) : '–';
  box.innerHTML = `<div class="acc-grid">
    <div></div><div class="hdr">${esc(wName)}</div><div class="hdr">${esc(bName)}</div>
    <div class="lbl"><b>Accuracy</b></div><div class="acc">${num(W.accuracy, 1)}</div><div class="acc">${num(B.accuracy, 1)}</div>
    ${CLS_ORDER.map(k => `<div class="lbl"><span class="cls cls-${k}">${CLS[k].sym}</span>${CLS[k].label}</div><div class="n t-${k}">${W.counts[k]}</div><div class="n t-${k}">${B.counts[k]}</div>`).join('')}
    <div class="lbl muted sep">Opening accuracy</div><div class="n sep">${ph(W, 'opening')}</div><div class="n sep">${ph(B, 'opening')}</div>
    <div class="lbl muted">Middlegame accuracy</div><div class="n">${ph(W, 'middlegame')}</div><div class="n">${ph(B, 'middlegame')}</div>
    <div class="lbl muted">Endgame accuracy</div><div class="n">${ph(W, 'endgame')}</div><div class="n">${ph(B, 'endgame')}</div>
    <div class="lbl muted">Avg centipawn loss</div><div class="n">${num(W.acpl, 0)}</div><div class="n">${num(B.acpl, 0)}</div>
  </div>`;
  const key = a.moves.filter(m => ['brilliant', 'great', 'mistake', 'miss', 'blunder'].includes(m.cls));
  $('#keyMoments').innerHTML = `<h3 style="margin-top:14px">Key moments</h3>` + (key.length ? key.map(m =>
    `<div class="km" data-ply="${m.ply + 1}"><span class="cls cls-${m.cls}">${CLS[m.cls].sym}</span>
      <span><b>${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '...'} ${m.san}</b> <span class="muted">${m.color === 'w' ? wName : bName}</span></span>
      <span class="t-${m.cls} small">${CLS[m.cls].label}</span></div>`).join('') : '<p class="muted small">No major swings in this game.</p>');
  $$('#keyMoments .km').forEach(e => e.onclick = () => { review.variation = null; review.ply = +e.dataset.ply; setReviewSub('analysis'); drawReview(); });
}

function setReviewSub(sub) {
  review.sub = sub;
  $$('.rv-tabs button').forEach(b => b.classList.toggle('active', b.dataset.rv === sub));
  $('#rvAnalysis').classList.toggle('hidden', sub !== 'analysis');
  $('#rvReport').classList.toggle('hidden', sub !== 'report');
}

// ---------- eval graph ----------
const curPlyPlugin = {
  id: 'curPly',
  afterDatasetsDraw(chart) {
    if (chart.canvas.id !== 'evalChart') return;
    const x = chart.scales.x.getPixelForValue(review.variation ? review.variation.base : review.ply);
    const { top, bottom } = chart.chartArea, ctx = chart.ctx;
    ctx.save(); ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
  },
};

function drawEvalChart() {
  const a = review.analysis;
  const canvas = $('#evalChart');
  if (!a) { if (charts.evalChart) { charts.evalChart.destroy(); delete charts.evalChart; } return; }
  const data = a.evals.map(e => winPct(clamp(evalToCp(e), -1500, 1500)));
  const mark = { mistake: cssVar('--serious'), miss: cssVar('--serious'), blunder: cssVar('--critical'), brilliant: '#26c2a3', great: '#5b8bd6' };
  makeChart(canvas, {
    type: 'line',
    data: { labels: data.map((_, i) => i), datasets: [{
      label: 'White win chance', data, borderColor: '#9a9893', borderWidth: 1.5,
      fill: { target: { value: 50 }, above: '#f1f1ee', below: '#3d3a36' },
      pointRadius: data.map((_, i) => i > 0 && mark[a.moves[i - 1].cls] ? 3.5 : 0),
      pointBackgroundColor: data.map((_, i) => i > 0 ? mark[a.moves[i - 1].cls] : null),
      pointBorderColor: '#00000044', pointBorderWidth: 1, pointHoverRadius: 5, tension: 0.15,
    }] },
    options: {
      animation: false,
      layout: { padding: 0 },
      interaction: { mode: 'index', intersect: false },
      onClick: (e, els) => { if (els.length) { review.variation = null; review.ply = els[0].index; drawReview(); } },
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: it => { const i = it[0].dataIndex; return i === 0 ? 'Start' : `${Math.ceil(i / 2)}${i % 2 ? '.' : '...'} ${a.moves[i - 1].san}`; },
        label: it => { const i = it.dataIndex; return [`Eval ${fmtEval(a.evals[i])}`, i > 0 ? CLS[a.moves[i - 1].cls].label : ''].filter(Boolean); },
      } } },
      scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } },
    },
    plugins: [curPlyPlugin],
  });
}

// ---------- navigation ----------
function navReview(cmd) {
  const v = review.variation;
  const n = review.fens.length - 1;
  if (cmd === 'flip') review.orientation = review.orientation === 'white' ? 'black' : 'white';
  else if (v) {
    if (cmd === 'prev') { if (v.idx > 1) v.idx--; else { exitVariation(); return; } }
    else if (cmd === 'next') v.idx = Math.min(v.fens.length - 1, v.idx + 1);
    else if (cmd === 'start') { review.variation = null; review.ply = 0; }
    else if (cmd === 'end') v.idx = v.fens.length - 1;
  } else {
    if (cmd === 'start') review.ply = 0;
    else if (cmd === 'prev') review.ply = Math.max(0, review.ply - 1);
    else if (cmd === 'next') review.ply = Math.min(n, review.ply + 1);
    else if (cmd === 'end') review.ply = n;
  }
  drawReview();
}

function initReview() {
  boardView = new BoardView($('#board'), { onMove: (mv, fen) => applyMove(mv, fen) });
  boardView.set({ fen: new Chess().fen(), orientation: 'white' });
  $$('[data-nav]').forEach(b => b.addEventListener('click', () => navReview(b.dataset.nav)));
  document.addEventListener('keydown', e => {
    if (S.tab !== 'review' || !review.game || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const map = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'start', End: 'end', ArrowUp: 'start', ArrowDown: 'end', f: 'flip' };
    if (map[e.key]) { e.preventDefault(); navReview(map[e.key]); }
    if (e.key === 'Escape') exitVariation();
  });
  $$('.rv-tabs button').forEach(b => b.addEventListener('click', () => setReviewSub(b.dataset.rv)));
  $('#analyzeBtn').addEventListener('click', () => { if (review.game) startReviewAnalysis(); });
  const lt = $('#liveToggle');
  lt.checked = review.liveOn;
  lt.addEventListener('change', () => { review.liveOn = lt.checked; store.set('cl:liveOn', lt.checked); review.liveFen = null; startLive(); });
  $('#pgnLoad').addEventListener('click', () => {
    const pgn = $('#pgnInput').value.trim();
    if (!pgn) return;
    const h = parseHeaders(pgn);
    const { sans, clocks } = parseMovetext(pgn);
    const test = new Chess();
    const ok = sans.length && sans.every(s => test.move(s, { sloppy: true }));
    if (!ok) { alert('Could not parse that PGN.'); return; }
    const tc = (h.TimeControl || '').split('+').map(Number);
    openReview({
      id: hashStr(pgn), pgn, sans, clocks, base: tc[0] || null, inc: tc[1] || 0, color: 'white',
      me: { name: h.White || 'White', rating: h.WhiteElo }, opp: { name: h.Black || 'Black', rating: h.BlackElo },
      opening: h.Opening || openingFromUrl(h.ECOUrl, h.ECO).name, eco: h.ECO || '', url: h.Link || null,
    });
  });
  renderReviewHead();
}

// Called when the review tab becomes visible
function showReview() {
  renderReviewHead();
  if (review.game) drawReview();
  Object.values(charts).forEach(c => c.resize());
}
function hideReview() { review.live?.stopAll(); }
