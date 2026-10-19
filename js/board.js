// Board view: squares, pieces, last-move highlight, arrows, move-quality badge,
// and click/drag move input with legal-move dots.
const PIECE_IMG = 'https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/';
const FILES = 'abcdefgh';

class BoardView {
  constructor(el, { onMove } = {}) {
    this.el = el;
    this.onMove = onMove;
    this.state = { fen: new Chess().fen(), orientation: 'white', arrows: [] };
    this.selected = null; this.dests = [];
    this.drag = null;
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', () => this.cancelDrag());
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  set(state) {
    this.state = Object.assign({ arrows: [] }, state);
    this.selected = null; this.dests = [];
    this.render();
  }

  squareAt(e) {
    const r = this.el.getBoundingClientRect();
    const c = Math.floor((e.clientX - r.left) / r.width * 8), row = Math.floor((e.clientY - r.top) / r.height * 8);
    if (c < 0 || c > 7 || row < 0 || row > 7) return null;
    const flip = this.state.orientation === 'black';
    return FILES[flip ? 7 - c : c] + (flip ? row + 1 : 8 - row);
  }

  pieceAt(sq) { return new Chess(this.state.fen).get(sq); }

  select(sq) {
    this.selected = sq;
    this.dests = new Chess(this.state.fen).moves({ square: sq, verbose: true }).map(m => ({ to: m.to, capture: !!m.captured }));
    this.render();
  }

  tryMove(from, to) {
    if (!this.dests.some(d => d.to === to)) return false;
    const c = new Chess(this.state.fen);
    const mv = c.move({ from, to, promotion: 'q' });
    if (!mv) return false;
    this.selected = null; this.dests = [];
    this.onMove?.(mv, c.fen());
    return true;
  }

  down(e) {
    if (e.button !== 0) return;
    const sq = this.squareAt(e);
    if (!sq) return;
    if (this.selected && this.tryMove(this.selected, sq)) return;
    const p = this.pieceAt(sq);
    const turn = this.state.fen.split(' ')[1];
    if (p && p.color === turn) {
      this.select(sq);
      const img = this.el.querySelector(`[data-sq="${sq}"] img`);
      if (img) {
        const r = this.el.getBoundingClientRect();
        const ghost = img.cloneNode();
        ghost.className = 'ghost';
        ghost.style.width = ghost.style.height = (r.width / 8) + 'px';
        this.el.appendChild(ghost);
        img.style.opacity = '0.3';
        this.drag = { from: sq, ghost, moved: false, x: e.clientX, y: e.clientY };
        this.positionGhost(e);
        this.el.setPointerCapture(e.pointerId);
      }
    } else if (this.selected) { this.selected = null; this.dests = []; this.render(); }
  }

  positionGhost(e) {
    const r = this.el.getBoundingClientRect(), s = r.width / 8;
    this.drag.ghost.style.transform = `translate(${e.clientX - r.left - s / 2}px, ${e.clientY - r.top - s / 2}px)`;
  }

  move(e) {
    if (!this.drag) return;
    if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4) this.drag.moved = true;
    this.positionGhost(e);
  }

  up(e) {
    if (!this.drag) return;
    const { from, moved } = this.drag;
    const to = this.squareAt(e);
    this.cancelDrag();
    if (moved && to && to !== from) {
      this.dropped = { from, to }; // already where the hand put it: no slide
      if (this.tryMove(from, to)) return;
      this.dropped = null;
    }
    this.render(); // keep selection (click-to-move) and restore the piece
  }

  cancelDrag() {
    if (!this.drag) return;
    this.drag.ghost.remove();
    this.drag = null;
  }

  render() {
    const { fen, orientation, lastMove, arrows, badge } = this.state;
    const flip = orientation === 'black';
    const grid = [];
    fen.split(' ')[0].split('/').forEach((row, r) => {
      let c = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { for (let k = 0; k < +ch; k++) grid[r * 8 + c++] = null; }
        else grid[r * 8 + c++] = ch;
      }
    });
    const hl = new Set(lastMove ? [lastMove.from, lastMove.to] : []);
    const dests = new Map(this.dests.map(d => [d.to, d.capture]));
    // king in check
    const chk = new Chess(fen);
    let checkSq = null;
    if (chk.in_check()) {
      const k = chk.turn() === 'w' ? 'K' : 'k';
      const idx = grid.indexOf(k);
      if (idx >= 0) checkSq = FILES[idx % 8] + (8 - Math.floor(idx / 8));
    }
    let html = '';
    for (let vr = 0; vr < 8; vr++) {
      for (let vc = 0; vc < 8; vc++) {
        const r = flip ? 7 - vr : vr, c = flip ? 7 - vc : vc;
        const sq = FILES[c] + (8 - r);
        const light = (r + c) % 2 === 0;
        const p = grid[r * 8 + c];
        let inner = '';
        if (vc === 0) inner += `<span class="coord r">${8 - r}</span>`;
        if (vr === 7) inner += `<span class="coord f">${FILES[c]}</span>`;
        if (sq === checkSq) inner += '<span class="check"></span>';
        if (p) {
          const code = (p === p.toUpperCase() ? 'w' : 'b') + p.toUpperCase();
          inner += `<img src="${PIECE_IMG}${code}.svg" alt="${code}" draggable="false">`;
        }
        if (dests.has(sq)) inner += `<span class="${dests.get(sq) ? 'cap' : 'dot'}"></span>`;
        if (badge && badge.sq === sq) inner += `<span class="badge cls-${badge.cls}" title="${CLS[badge.cls]?.label || ''}">${badge.text}</span>`;
        const cls = ['sq', light ? 'l' : 'd'];
        if (hl.has(sq)) cls.push('hl');
        if (sq === this.selected) cls.push('sel');
        html += `<div class="${cls.join(' ')}" data-sq="${sq}">${inner}</div>`;
      }
    }
    html += arrowsSvg(arrows || [], flip);
    this.el.innerHTML = html;
    const prev = this.shown, placement = fen.split(' ')[0], now = performance.now();
    this.shown = { placement, flip, grid };
    const moved = !!prev && prev.flip === flip && prev.placement !== placement;
    this.el.classList.toggle('fresh', moved); // highlight/check fade in only when the position changed, not on every redraw
    if (moved) this.anims = this.planAnims(prev.grid, grid, flip, now);
    else if (prev && prev.flip !== flip) this.anims = null;
    // a redraw mid-animation (live engine lines, a click) picks each animation up where it was
    this.anims = this.anims?.filter(a => now < a.t0 + a.dur);
    this.anims?.forEach(a => this.playAnim(a, now));
    this.dropped = null;
  }

  // Lichess-style: pieces slide from where they stood, captured pieces fade out, returning ones fade in.
  // A piece the user just dragged is already in place, so it doesn't slide (the castling rook still does).
  // (Short and informative, so this runs even with the OS "reduce motion" setting, as lichess does.)
  planAnims(oldG, newG, flip, t0) {
    const gone = [], came = [];
    for (let i = 0; i < 64; i++) {
      if (oldG[i] === newG[i]) continue;
      if (oldG[i]) gone.push({ i, p: oldG[i] });
      if (newG[i]) came.push({ i, p: newG[i] });
    }
    if (gone.length + came.length > 24) return null; // an unrelated position: just show it
    const sqOf = i => FILES[i % 8] + (8 - Math.floor(i / 8));
    const dist = (a, b) => Math.hypot(a % 8 - b % 8, Math.floor(a / 8) - Math.floor(b / 8));
    const out = [];
    for (const c of came) {
      let from = null;
      for (const g of gone) if (!g.used && g.p === c.p && (!from || dist(g.i, c.i) < dist(from.i, c.i))) from = g;
      if (!from) { out.push({ sq: sqOf(c.i), kind: 'in', t0, dur: BOARD_ANIM_MS }); continue; }
      from.used = true;
      if (this.dropped?.from === sqOf(from.i) && this.dropped?.to === sqOf(c.i)) continue;
      const s = flip ? -100 : 100, dx = (from.i % 8 - c.i % 8) * s, dy = (Math.floor(from.i / 8) - Math.floor(c.i / 8)) * s;
      // longer slides take a little longer
      out.push({ sq: sqOf(c.i), kind: 'slide', dx, dy, t0, dur: BOARD_ANIM_MS * Math.min(1.4, 0.8 + dist(from.i, c.i) * 0.08) });
    }
    for (const g of gone) if (!g.used) out.push({ sq: sqOf(g.i), kind: 'out', piece: g.p, t0, dur: BOARD_ANIM_MS });
    return out;
  }

  playAnim(a, now) {
    const sq = this.el.querySelector(`[data-sq="${a.sq}"]`);
    if (!sq) return;
    let el = sq.querySelector('img');
    if (a.kind === 'out') {
      el = document.createElement('img');
      el.src = pieceSrc(a.piece); el.className = 'fading'; el.alt = ''; el.draggable = false;
      sq.appendChild(el);
    }
    if (!el) return;
    const frames = a.kind === 'slide' ? [{ transform: `translate(${a.dx}%, ${a.dy}%)` }, { transform: 'none' }]
      : a.kind === 'in' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
    if (a.kind === 'slide') sq.classList.add('moving');
    el.animate(frames, { duration: a.dur, delay: a.t0 - now, easing: a.kind === 'slide' ? 'cubic-bezier(.25, .8, .35, 1)' : 'ease-out', fill: a.kind === 'out' ? 'forwards' : 'none' })
      .finished.finally(() => { if (a.kind === 'out') el.remove(); else if (a.kind === 'slide') sq.classList.remove('moving'); }).catch(() => {});
  }
}

const BOARD_ANIM_MS = 200;
const pieceSrc = p => `${PIECE_IMG}${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}.svg`;

function sqXY(sq, flip) {
  const c = FILES.indexOf(sq[0]), r = 8 - +sq[1];
  return [(flip ? 7 - c : c) + 0.5, (flip ? 7 - r : r) + 0.5];
}

function arrowsSvg(arrows, flip) {
  if (!arrows.length) return '';
  let s = `<svg class="arrows" viewBox="0 0 8 8"><defs>`;
  arrows.forEach((a, i) => {
    s += `<marker id="ah${i}" markerWidth="3" markerHeight="3" refX="1.6" refY="1.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L3,1.5 L0,3 z" fill="${a.color}"/></marker>`;
  });
  s += '</defs>';
  arrows.forEach((a, i) => {
    const [x1, y1] = sqXY(a.from, flip), [x2, y2] = sqXY(a.to, flip);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    const ex = x2 - dx / len * 0.42, ey = y2 - dy / len * 0.42;
    s += `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${a.color}" stroke-width="${a.width ?? 0.2}" stroke-linecap="round" opacity="${a.opacity ?? 0.85}" marker-end="url(#ah${i})"/>`;
  });
  return s + '</svg>';
}

// Eval bar: the white share is White's win chance, anchored on White's side of the board.
// The number sits at the leading side's end, dark on the white part or light on the dark part.
function paintEvalBar(bar, ev, whiteBottom) {
  const fill = bar.querySelector('.evalfill'), txt = bar.querySelector('span');
  if (!ev) { fill.style.height = '50%'; fill.style.top = whiteBottom ? 'auto' : '0'; fill.style.bottom = whiteBottom ? '0' : 'auto'; txt.textContent = ''; return; }
  const cp = evalToCp(ev);
  const wp = winPct(clamp(cp, -1500, 1500));
  fill.style.height = wp + '%';
  fill.style.top = whiteBottom ? 'auto' : '0';
  fill.style.bottom = whiteBottom ? '0' : 'auto';
  txt.textContent = fmtEval(ev).replace('+', '');
  const whiteAhead = cp >= 0;
  bar.classList.toggle('lbl-top', whiteAhead !== whiteBottom);
  bar.classList.toggle('lbl-dark', whiteAhead);
}

// Material balance from a FEN: captured pieces per side and the point difference
function materialInfo(fen) {
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const have = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const l = ch.toLowerCase();
    if (have.w[l] === undefined) continue;
    have[ch === l ? 'b' : 'w'][l]++;
  }
  const pts = c => sum(Object.entries(have[c]).map(([k, n]) => n * PIECE_VAL[k]));
  // pieces captured BY white are black's missing pieces
  const missing = c => Object.entries(start).flatMap(([k, n]) => Array(Math.max(0, n - have[c][k])).fill(k));
  return { capturedByW: missing('b'), capturedByB: missing('w'), diff: pts('w') - pts('b') };
}
