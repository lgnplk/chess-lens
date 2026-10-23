// Opening explorer, full depth: from any position, the moves played there and how they scored. Sources: master
// games over the board (js/explorer-masters.json, built by tools/build-explorer.js from PGN Mentor's player files)
// and your own loaded games. Click a move (or play it on the board) to go deeper; the line above can be clicked
// to go back.
const ex = { line: [], idx: 0, flip: false, source: 'masters', board: null, mine: null, mineFor: null };
let _masters = null;
const getMasters = () => _masters ||= fetch('js/explorer-masters.json').then(r => r.json()).catch(() => null);
const exKey = c => c.fen().split(' ').slice(0, 4).join(' ');
const exChess = (upto = ex.idx) => { const c = new Chess(); ex.line.slice(0, upto).forEach(s => c.move(s)); return c; };

// your games as a tree: position → move → [white wins, draws, black wins, your rating sum, n, last year]
function exMine() {
  if (ex.mineFor === S.games) return ex.mine;
  const tree = new Map();
  for (const g of S.games) {
    const c = new Chess(), r = g.result === 'draw' ? 1 : (g.result === 'win') === (g.color === 'white') ? 0 : 2;
    for (const san of g.sans.slice(0, 30)) {
      const k = exKey(c), mv = c.move(san, { sloppy: true });
      if (!mv) break;
      let t = tree.get(k); if (!t) tree.set(k, t = new Map());
      let x = t.get(mv.san); if (!x) t.set(mv.san, x = [0, 0, 0, 0, 0, 0]);
      x[r]++; x[3] += g.me.rating || 0; x[4] += g.me.rating ? 1 : 0; x[5] = Math.max(x[5], g.end?.getFullYear?.() || 0);
    }
  }
  Object.assign(ex, { mine: tree, mineFor: S.games });
  return tree;
}

async function exRows(c) {
  const k = exKey(c);
  if (ex.source === 'mine') {
    const t = exMine().get(k);
    return t ? [...t].map(([san, x]) => [san, x[0], x[1], x[2], x[4] ? Math.round(x[3] / x[4]) : 0, x[5]]).sort((a, b) => (b[1] + b[2] + b[3]) - (a[1] + a[2] + a[3])) : [];
  }
  const M = await getMasters();
  return M?.pos[k] || [];
}

function renderExplorer(sec) {
  if (!$('#exBoard', sec)) {
    sec.innerHTML = `<div class="rv">
      <div class="rv-board">
        <div class="board-wrap"><div class="board" id="exBoard"></div></div>
        <div class="controls">
          <button class="btn" data-exnav="start" title="Start">⏮</button>
          <button class="btn" data-exnav="prev" title="Back (←)">◀</button>
          <button class="btn" data-exnav="next" title="Forward (→)">▶</button>
          <button class="btn" data-exnav="flip" title="Flip board">⇅</button>
        </div>
      </div>
      <div class="rv-panel">
        <div class="rv-head"><div class="row-between"><b>Opening explorer</b><div class="seg ex-src"></div></div>
          <div class="var-line small ex-line"></div><div class="muted small ex-name"></div></div>
        <div class="rv-body scroll ex-body"></div>
      </div></div>`;
    ex.board = new BoardView($('#exBoard', sec), { onMove: mv => exPlay(mv.san) });
    $$('[data-exnav]', sec).forEach(b => b.onclick = () => exNav(b.dataset.exnav));
    document.addEventListener('keydown', e => {
      if (S.tab !== 'explorer' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); exNav('prev'); }
      if (e.key === 'ArrowRight') { e.preventDefault(); exNav('next'); }
    });
  }
  exRefresh();
}

function exPlay(san) { ex.line = ex.line.slice(0, ex.idx); ex.line.push(san); ex.idx = ex.line.length; exRefresh(); }
function exNav(cmd) {
  if (cmd === 'start') ex.idx = 0;
  else if (cmd === 'prev') ex.idx = Math.max(0, ex.idx - 1);
  else if (cmd === 'next') ex.idx = Math.min(ex.line.length, ex.idx + 1);
  else if (cmd === 'flip') ex.flip = !ex.flip;
  exRefresh();
}

async function exRefresh() {
  const sec = $('#tab-explorer');
  if (!sec || !ex.board) return;
  const c = exChess(), last = ex.idx ? (() => { const p = exChess(ex.idx - 1).move(ex.line[ex.idx - 1]); return { from: p.from, to: p.to }; })() : null;
  ex.board.set({ fen: c.fen(), orientation: ex.flip ? 'black' : 'white', lastMove: last });
  $('.ex-src', sec).innerHTML = [['masters', 'Masters'], ['mine', 'Your games']].filter(([k]) => k !== 'mine' || S.games.length)
    .map(([k, l]) => `<button data-exsrc="${k}" class="${ex.source === k ? 'active' : ''}">${l}</button>`).join('');
  $$('[data-exsrc]', sec).forEach(b => b.onclick = () => { ex.source = b.dataset.exsrc; exRefresh(); });
  $('.ex-line', sec).innerHTML = ex.line.map((s, i) => `<span class="mv ${i + 1 === ex.idx ? 'cur' : ''}" data-exi="${i + 1}">${i % 2 === 0 ? `${i / 2 + 1}.` : ''}${esc(s)}</span>`).join(' ') || '<span class="muted">Starting position: play a move or pick one below</span>';
  $$('[data-exi]', sec).forEach(e => e.onclick = () => { ex.idx = +e.dataset.exi; exRefresh(); });
  // the deepest named position on the way here
  getBook().then(book => {
    let name = null; const cc = new Chess();
    for (const s of ex.line.slice(0, ex.idx)) { cc.move(s); const h = book && bookHit(book, cc.fen()); if (h) name = h; }
    const el = $('.ex-name', sec); if (el) el.textContent = name ? `${name.eco} ${name.name}` : '';
  });
  const body = $('.ex-body', sec), rows = await exRows(c), M = ex.source === 'masters' ? await getMasters() : null;
  if (!rows.length) { body.innerHTML = `<p class="muted">${ex.source === 'mine' ? 'You never reached this position.' : M ? 'No master games from here (positions in fewer than 5 games are left out).' : 'Explorer data unavailable.'}</p>`; return; }
  const total = rows.reduce((s, r) => s + r[1] + r[2] + r[3], 0);
  const pctOf = (x, n) => (n ? Math.round(100 * x / n) + '%' : '');
  const bar = r => { const n = r[1] + r[2] + r[3]; return `<div class="ex-bar"><div class="w" style="flex:${r[1]}">${r[1] / n >= 0.12 ? pctOf(r[1], n) : ''}</div><div class="d" style="flex:${r[2]}">${r[2] / n >= 0.12 ? pctOf(r[2], n) : ''}</div><div class="b" style="flex:${r[3]}">${r[3] / n >= 0.12 ? pctOf(r[3], n) : ''}</div></div>`; };
  body.innerHTML = `<table class="ex-table"><thead><tr><th>Move</th><th class="num">Games</th><th>White · draw · Black</th><th class="num">${ex.source === 'mine' ? 'Your rating' : 'Avg rating'}</th><th class="num">Last</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="clickable" data-exm="${esc(r[0])}"><td><b>${esc(r[0])}</b></td><td class="num">${(r[1] + r[2] + r[3]).toLocaleString()} <span class="muted small">${pctOf(r[1] + r[2] + r[3], total)}</span></td><td>${bar(r)}</td><td class="num">${r[4] || '–'}</td><td class="num">${r[5] || '–'}</td></tr>`).join('')}
    <tr class="ex-total"><td>Σ</td><td class="num">${total.toLocaleString()}</td><td>${bar(['', ...[1, 2, 3].map(i => rows.reduce((s, r) => s + r[i], 0))])}</td><td></td><td></td></tr></tbody></table>
    ${M ? `<p class="muted small" style="margin-top:8px">${M.games.toLocaleString()} over-the-board master games (PGN Mentor), first ${M.plies / 2} moves.</p>` : ''}`;
  $$('[data-exm]', body).forEach(tr => tr.onclick = () => exPlay(tr.dataset.exm));
}
