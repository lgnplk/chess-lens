// Board view: squares, pieces, last-move highlight, arrows, move-quality badge, click/drag move input with
// legal-move dots, a promotion choice, and the user's own right-click arrows and circles.
// the piece set and motion speed follow Settings (js/shell.js)
let PIECE_IMG = 'https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/';
const FILES = 'abcdefgh';

class BoardView {
  static all = new Set();   // every board, so a settings change (pieces, colours) redraws them all
  // onSquare: a left click on any square goes there instead of moving pieces (the Vision trainer)
  constructor(el, { onMove, onSquare } = {}) {
    this.el = el;
    BoardView.all.add(this);
    this.onMove = onMove;
    this.onSquare = onSquare;
    this.state = { fen: new Chess().fen(), orientation: 'white', arrows: [] };
    this.selected = null; this.dests = [];
    this.drag = null;
    this.drawn = { arrows: [], circles: [] };   // the user's own right-click arrows and circles
    el.classList.toggle('interactive', !!(onMove || onSquare));
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', () => { this.cancelDrag(); this.render(); });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  set(state) {
    if (state.fen !== this.state.fen) this.drawn = { arrows: [], circles: [] }; // drawings belong to a position
    this.state = Object.assign({ arrows: [] }, state);
    this.selected = null; this.dests = [];
    this.promo?.remove(); this.promo = null;
    this.render();
  }

  // show an unrelated position at once (a new puzzle, a new game): no slides, no sound
  jump(state) { this.shown = null; this.anims = null; this.set(state); }

  squareAt(e) {
    const r = this.el.getBoundingClientRect();
    const c = Math.floor((e.clientX - r.left) / r.width * 8), row = Math.floor((e.clientY - r.top) / r.height * 8);
    if (c < 0 || c > 7 || row < 0 || row > 7) return null;
    const flip = this.state.orientation === 'black';
    return FILES[flip ? 7 - c : c] + (flip ? row + 1 : 8 - row);
  }

  // the top-left corner of a square, in px from the board's corner
  squareXY(sq) {
    const s = this.el.clientWidth / 8, [x, y] = sqXY(sq, this.state.orientation === 'black');
    return [(x - 0.5) * s, (y - 0.5) * s];
  }

  pieceAt(sq) { return new Chess(this.state.fen).get(sq); }

  select(sq) {
    this.selected = sq;
    this.dests = new Chess(this.state.fen).moves({ square: sq, verbose: true }).map(m => ({ to: m.to, capture: !!m.captured, promo: !!m.promotion }));
    this.render();
  }

  tryMove(from, to, promotion) {
    const d = this.dests.find(x => x.to === to);
    if (!d) return false;
    // a pawn reaching the last rank: choose the piece, as on lichess (dropping it there doesn't move it yet)
    if (d.promo && !promotion) { this.askPromotion(from, to); return true; }
    const c = new Chess(this.state.fen);
    const mv = c.move({ from, to, promotion: promotion || 'q' });
    if (!mv) return false;
    this.selected = null; this.dests = [];
    const before = this.state.fen;
    this.onMove?.(mv, c.fen());
    // a page that doesn't take the move (not its turn, a puzzle already solved): the piece goes back home
    queueMicrotask(() => { if (this.state.fen === before && !this.promo) { this.dropped = null; this.render(); } });
    return true;
  }

  // Lichess-style input: press on a piece picks it up (centred on the pointer, slightly lifted); drop on a legal
  // square to move, anywhere else and it glides back; or click the piece, then the square. Clicking a selected
  // piece again lets it go. Right-drag draws an arrow, right-click a circle (shift: red); any left click clears them.
  down(e) {
    if (this.edit) return this.editDown(e);
    if (this.onSquare && e.button === 0) { const sq = this.squareAt(e); if (sq) this.onSquare(sq); return; }
    if (e.button === 2) { this.drawFrom = this.squareAt(e); return; }
    if (e.button !== 0) return;
    if (this.drawn.arrows.length || this.drawn.circles.length) { this.drawn = { arrows: [], circles: [] }; this.render(); }
    const sq = this.squareAt(e);
    if (!sq || !this.onMove || this.promo) return;
    if (this.selected && this.selected !== sq && this.tryMove(this.selected, sq)) return;
    const p = this.pieceAt(sq), turn = this.state.fen.split(' ')[1];
    if (!(p && p.color === turn)) { if (this.selected) { this.selected = null; this.dests = []; this.render(); } return; }
    const wasSelected = this.selected === sq;
    if (!wasSelected) this.select(sq);
    const img = this.el.querySelector(`[data-sq="${sq}"] img`);
    if (!img) return;
    const ghost = img.cloneNode();
    ghost.className = 'ghost';
    ghost.style.width = ghost.style.height = (this.el.clientWidth / 8) + 'px';
    this.el.appendChild(ghost);
    this.drag = { from: sq, ghost, moved: false, wasSelected, x: e.clientX, y: e.clientY, over: sq };
    this.positionGhost(e);
    this.el.classList.add('dragging');
    this.el.setPointerCapture(e.pointerId);
    this.render();
  }

  positionGhost(e) {
    const r = this.el.getBoundingClientRect(), s = this.el.clientWidth / 8;
    // the lift is part of the same transform, after the move, so the piece stays centred under the pointer
    // (the board's own border, if any, is left out of the offset)
    const x = e.clientX - r.left - this.el.clientLeft - s / 2, y = e.clientY - r.top - this.el.clientTop - s / 2;
    this.drag.gx = x; this.drag.gy = y;
    this.drag.ghost.style.transform = `translate(${x}px, ${y}px) scale(1.12)`;
  }

  // Board editor (this.edit = { tool(), place(sq, piece|null), move(from, to) }): with the hand tool any piece can be
  // dragged anywhere, and dropping it off the board removes it; with a piece or the eraser, pressing and sweeping
  // over squares sets them. Right-click always clears a square.
  editDown(e) {
    const sq = this.squareAt(e);
    if (!sq) return;
    if (e.button === 2) { this.edit.place(sq, null); return; }
    if (e.button !== 0) return;
    const tool = this.edit.tool();
    if (tool !== 'hand') {
      this.edit.place(sq, tool === 'erase' ? null : tool);
      this.paint = { tool, last: sq };
      this.el.setPointerCapture(e.pointerId);
      return;
    }
    const img = this.el.querySelector(`[data-sq="${sq}"] img`);
    if (!img) return;
    const ghost = img.cloneNode();
    ghost.className = 'ghost';
    ghost.style.width = ghost.style.height = (this.el.clientWidth / 8) + 'px';
    this.el.appendChild(ghost);
    this.drag = { from: sq, ghost, moved: false, x: e.clientX, y: e.clientY, over: sq, edit: true };
    this.positionGhost(e);
    this.el.classList.add('dragging');
    this.el.setPointerCapture(e.pointerId);
    this.render();
  }

  move(e) {
    if (this.paint) {
      const sq = this.squareAt(e);
      if (sq && sq !== this.paint.last) { this.paint.last = sq; this.edit.place(sq, this.paint.tool === 'erase' ? null : this.paint.tool); }
      return;
    }
    if (this.drag?.edit) {
      if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 3) this.drag.moved = true;
      this.positionGhost(e);
      const over = this.squareAt(e);
      if (over !== this.drag.over) {
        this.el.querySelector('.sq.over')?.classList.remove('over');
        if (over) this.el.querySelector(`[data-sq="${over}"]`)?.classList.add('over');
        this.drag.over = over;
      }
      return;
    }
    if (!this.drag) return;
    if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 3) this.drag.moved = true;
    this.positionGhost(e);
    // the square under the pointer is outlined while dragging
    const over = this.squareAt(e);
    if (over !== this.drag.over) {
      this.el.querySelector('.sq.over')?.classList.remove('over');
      if (over && this.dests.some(d => d.to === over)) this.el.querySelector(`[data-sq="${over}"]`)?.classList.add('over');
      this.drag.over = over;
    }
  }

  up(e) {
    if (e.button === 2) {
      const from = this.drawFrom, to = this.squareAt(e);
      this.drawFrom = null;
      if (from && to) {
        const color = e.shiftKey ? 'rgba(200, 40, 40, .8)' : 'rgba(21, 120, 27, .8)';
        const list = from === to ? this.drawn.circles : this.drawn.arrows;
        const i = list.findIndex(x => x.from === from && x.to === to);
        if (i >= 0) list.splice(i, 1); else list.push({ from, to, color, width: 0.18, opacity: 1 });
        this.render();
      }
      return;
    }
    if (this.paint) { this.paint = null; return; }
    if (this.drag?.edit) {
      const { from, moved } = this.drag, to = this.squareAt(e);
      this.cancelDrag();
      if (!moved) return this.render();
      if (!to) return this.edit.place(from, null);
      if (to === from) return this.render();
      this.dropped = { from, to };
      return this.edit.move(from, to);
    }
    if (!this.drag) return;
    const { from, moved, wasSelected, gx, gy, ghost } = this.drag;
    const to = this.squareAt(e);
    if (moved && to && to !== from && this.dests.some(d => d.to === to)) {
      this.cancelDrag();
      this.dropped = { from, to }; // already where the hand put it: no slide
      if (this.tryMove(from, to)) return;
      this.dropped = null;
      return this.render();
    }
    if (moved) {
      // dropped off the board or on an illegal square: the piece glides home
      this.drag = null;
      this.el.classList.remove('dragging');
      const [hx, hy] = this.squareXY(from);
      const home = ghost.animate([{ transform: `translate(${gx}px, ${gy}px) scale(1.12)` }, { transform: `translate(${hx}px, ${hy}px) scale(1)` }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
      home.finished.then(() => { ghost.remove(); this.selected = null; this.dests = []; this.render(); }).catch(() => ghost.remove());
      return;
    }
    // a click: a second click on the selected piece lets it go; otherwise it stays selected for click-to-move
    this.cancelDrag();
    if (wasSelected) { this.selected = null; this.dests = []; }
    this.render();
  }

  cancelDrag() {
    if (!this.drag) return;
    this.drag.ghost.remove();
    this.drag = null;
    this.el.classList.remove('dragging');
  }

  // the promotion choice: four pieces over the promotion square, toward the middle of the board; click
  // elsewhere to take the move back
  askPromotion(from, to) {
    const color = this.state.fen.split(' ')[1], s = 100 / 8, flip = this.state.orientation === 'black';
    const [cx, cy] = sqXY(to, flip), down = cy < 4;
    const box = document.createElement('div');
    box.className = 'promo';
    box.innerHTML = ['q', 'n', 'r', 'b'].map((p, i) => `<button data-p="${p}" style="left:${(cx - 0.5) * s}%;top:${(cy - 0.5 + (down ? i : -i)) * s}%;width:${s}%;height:${s}%"><img src="${pieceSrc(color === 'w' ? p.toUpperCase() : p)}" alt="${p}" draggable="false"></button>`).join('');
    box.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-p]');
      box.remove(); this.promo = null;
      if (b) this.tryMove(from, to, b.dataset.p);
      else { this.selected = null; this.dests = []; this.render(); }
    });
    this.promo = box;
    this.el.appendChild(box);
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
        if (p && (this.edit ? this.edit.tool() === 'hand' : this.onMove && (p === p.toUpperCase() ? 'w' : 'b') === fen.split(' ')[1])) cls.push('mov');
        if (hl.has(sq)) cls.push('hl');
        if (sq === this.selected) cls.push('sel');
        html += `<div class="${cls.join(' ')}" data-sq="${sq}">${inner}</div>`;
      }
    }
    html += arrowsSvg([...(arrows || []), ...this.drawn.arrows], flip, this.drawn.circles);
    this.el.innerHTML = html;
    // a redraw mid-drag keeps the lifted piece, its faded twin at home and the outlined target; and a pending promotion choice
    if (this.drag) {
      this.el.appendChild(this.drag.ghost);
      const home = this.el.querySelector(`[data-sq="${this.drag.from}"] img`);
      if (home) home.style.opacity = '0.3';
      if (this.dests.some(d => d.to === this.drag.over)) this.el.querySelector(`[data-sq="${this.drag.over}"]`)?.classList.add('over');
    }
    if (this.promo) this.el.appendChild(this.promo);
    const prev = this.shown, placement = fen.split(' ')[0], now = performance.now();
    this.shown = { placement, flip, grid };
    const moved = !!prev && prev.flip === flip && prev.placement !== placement;
    this.el.classList.toggle('fresh', moved); // highlight/check fade in only when the position changed, not on every redraw
    if (moved) {
      this.anims = this.planAnims(prev.grid, grid, flip, now);
      if (this.anims?.length) Sound.play(this.anims.some(a => a.kind === 'out') ? 'capture' : 'move');
    }
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

let BOARD_ANIM_MS = 200;
let SOUND_VOL = 1;

// Board sounds, synthesised (no audio files): a short wooden tap for a move, a heavier double tap for a capture,
// and two notes for a drill verdict. The header's speaker button turns them off (remembered).
const Sound = (() => {
  let ctx = null;
  const on = () => store.get('cl:sound') !== 'off';
  const tap = (c, t, freq, gain) => {
    const n = Math.floor(c.sampleRate * 0.07), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 5;
    const src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    src.buffer = buf; bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.4; g.gain.value = gain * SOUND_VOL;
    src.connect(bp).connect(g).connect(c.destination); src.start(t);
  };
  const tone = (c, t, freq, dur, gain) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain * SOUND_VOL, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  };
  return {
    on,
    toggle() { store.set('cl:sound', on() ? 'off' : 'on'); return on(); },
    play(kind) {
      if (!on()) return;
      try {
        const c = ctx ||= new (window.AudioContext || window.webkitAudioContext)();
        if (c.state === 'suspended') c.resume();
        const t = c.currentTime + 0.005;
        if (kind === 'move') tap(c, t, 1500, 0.9);
        else if (kind === 'capture') { tap(c, t, 1000, 1.2); tap(c, t + 0.035, 1300, 0.7); }
        else if (kind === 'good') { tone(c, t, 660, 0.14, 0.12); tone(c, t + 0.1, 990, 0.22, 0.12); }
        else if (kind === 'bad') { tone(c, t, 330, 0.16, 0.12); tone(c, t + 0.12, 247, 0.26, 0.12); }
      } catch { /* no audio */ }
    },
  };
})();
const pieceSrc = p => `${PIECE_IMG}${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}.svg`;

function sqXY(sq, flip) {
  const c = FILES.indexOf(sq[0]), r = 8 - +sq[1];
  return [(flip ? 7 - c : c) + 0.5, (flip ? 7 - r : r) + 0.5];
}

// Each arrow is a shaft and a triangular head in one group, so the head is drawn with the arrow itself. (SVG markers
// were looked up by id across the whole page: every board after the first got another board's heads, often from a
// hidden page, so they went missing or took the wrong colour.) The group's opacity keeps the overlap from darkening.
function arrowsSvg(arrows, flip, circles = []) {
  if (!arrows.length && !circles.length) return '';
  let s = '<svg class="arrows" viewBox="0 0 8 8">';
  for (const a of arrows) {
    if (!a.from || !a.to || a.from === a.to) continue;
    const [x1, y1] = sqXY(a.from, flip), [x2, y2] = sqXY(a.to, flip);
    const w = a.width ?? 0.2, len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const hl = Math.max(0.34, 3 * w), hw = Math.max(0.17, 1.5 * w);   // head length and half-width
    const tx = x2 - ux * (0.42 - 1.4 * w), ty = y2 - uy * (0.42 - 1.4 * w);   // tip, short of the square's centre
    const bx = tx - ux * hl, by = ty - uy * hl;
    const f = n => +n.toFixed(3);
    s += `<g opacity="${a.opacity ?? 0.85}"><line x1="${f(x1)}" y1="${f(y1)}" x2="${f(bx)}" y2="${f(by)}" stroke="${a.color}" stroke-width="${w}" stroke-linecap="round"/>`
      + `<polygon points="${f(tx)},${f(ty)} ${f(bx - uy * hw)},${f(by + ux * hw)} ${f(bx + uy * hw)},${f(by - ux * hw)}" fill="${a.color}"/></g>`;
  }
  circles.forEach(c => { const [x, y] = sqXY(c.from, flip); s += `<circle cx="${x}" cy="${y}" r="0.44" fill="none" stroke="${c.color}" stroke-width="0.07"/>`; });
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

// A move typed by hand, as chess.js reads SAN (lenient: "e2e4", "0-0"), also with a lowercase piece letter ("nf3")
function moveTyped(c, text) {
  const t = text.trim().replace(/0/g, 'O');
  if (!t) return null;
  return c.move(t, { sloppy: true }) || (/^[nbrqk]/.test(t) ? c.move(t[0].toUpperCase() + t.slice(1), { sloppy: true }) : null);
}
