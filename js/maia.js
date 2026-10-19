// Maia-3: a neural network trained on Lichess games to predict the move a human of a given rating plays
// (github.com/CSSLab/maia3, weights huggingface.co/UofTCSSLab, AGPL-3.0). Runs in js/maia-worker.js
// with onnxruntime-web; models/*.onnx are built from the official checkpoints by tools/maia-export.py.
//
// Input: the last 8 positions (oldest first), each as 64 squares (a1 = 0 … h8 = 63) x 12 one-hot pieces
// (P N B R Q K for the side to move in that position, then the other side's), with the board mirrored
// when Black is to move. Plus the mover's and the opponent's Lichess-scale rating (any number 0–5000).
// Output: one logit per move in a 4352-move vocabulary (from x 64 + to, then 256 promotions), from the
// mover's point of view, and loss/draw/win logits.

const MAIA_MODELS = { '5m': 'models/maia3-5m.onnx', '23m': 'models/maia3-23m.onnx' };
const MAIA_PIECES = 'PNBRQKpnbrqk';
const MAIA_HIST = 8;

// Board planes for one position, from its own mover's point of view
function maiaBoardPlanes(fen) {
  const [placement, turn] = fen.split(' ');
  const flip = turn === 'b';
  const out = new Int8Array(64).fill(-1); // piece index per square
  const rows = placement.split('/');
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r;
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { file += +ch; continue; }
      let idx = MAIA_PIECES.indexOf(ch);
      if (flip) idx = (idx + 6) % 12; // swap colors
      const sq = (flip ? 7 - rank : rank) * 8 + file;
      out[sq] = idx;
      file++;
    }
  }
  return out;
}

// Network input for a position given the FENs before it (oldest first, current last)
function maiaInput(fens, target = new Float32Array(64 * 96), offset = 0) {
  const hist = fens.slice(-MAIA_HIST);
  while (hist.length < MAIA_HIST) hist.unshift(hist[0]);
  for (let s = 0; s < MAIA_HIST; s++) {
    const b = maiaBoardPlanes(hist[s]);
    for (let sq = 0; sq < 64; sq++) if (b[sq] >= 0) target[offset + sq * 96 + s * 12 + b[sq]] = 1;
  }
  return target;
}

const maiaSq = s => (s.charCodeAt(0) - 97) + 8 * (+s[1] - 1);
// Vocabulary index of a legal move (uci string, e.g. e7e8q) for the side to move
function maiaMoveIndex(uci, black) {
  let from = maiaSq(uci.slice(0, 2)), to = maiaSq(uci.slice(2, 4));
  if (black) { from ^= 56; to ^= 56; } // mirror ranks
  const promo = uci[4];
  if (promo) return 4096 + ((from & 7) * 8 + (to & 7)) * 4 + 'qrbn'.indexOf(promo);
  return from * 64 + to;
}

class Maia {
  // ep: 'wasm' (CPU, works everywhere) or 'webgpu' (much faster for the bigger model where available)
  constructor(size = '5m', { ep = 'wasm' } = {}) {
    this.size = size;
    this.worker = new Worker('js/maia-worker.js' + (ep === 'webgpu' ? '?ep=webgpu' : ''));
    this.pending = new Map();
    this.nextId = 1;
    this.ms = 0; this.runs = 0;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') { this.loadMs = m.ms; this.bytes = m.bytes; this.ep = m.ep; resolve(this); return; }
        const p = this.pending.get(m.id);
        if (m.type === 'error') { if (p) { this.pending.delete(m.id); p.reject(new Error(m.message)); } else reject(new Error(m.message)); return; }
        if (m.type === 'result' && p) { this.pending.delete(m.id); this.ms += m.ms; this.runs++; p.resolve({ move: new Float32Array(m.move), value: new Float32Array(m.value) }); }
      };
      this.worker.onerror = e => reject(new Error(e.message || 'Maia worker failed'));
    });
    this.worker.postMessage({ type: 'init', url: new URL(MAIA_MODELS[size], location.href).href });
  }

  _run(history, eloSelf, eloOppo, n) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, history: history.buffer, eloSelf: eloSelf.buffer, eloOppo: eloOppo.buffer, n },
        [history.buffer, eloSelf.buffer, eloOppo.buffer]);
    });
  }

  // items: [{ fens: [..., current FEN], eloSelf, eloOppo }] (Lichess-scale ratings).
  // Returns per item { moves: [{ uci, san, p, logit }] sorted by p, value: mover's expected score }.
  async predict(items, { batch = 32 } = {}) {
    await this.ready;
    const out = [];
    for (let s = 0; s < items.length; s += batch) {
      const chunk = items.slice(s, s + batch), n = chunk.length;
      const hist = new Float32Array(n * 64 * 96), es = new Float32Array(n), eo = new Float32Array(n);
      chunk.forEach((it, i) => { maiaInput(it.fens, hist, i * 64 * 96); es[i] = it.eloSelf; eo[i] = it.eloOppo; });
      const { move, value } = await this._run(hist, es, eo, n);
      chunk.forEach((it, i) => {
        const fen = it.fens[it.fens.length - 1];
        const black = fen.split(' ')[1] === 'b';
        const legal = new Chess(fen).moves({ verbose: true });
        const lo = legal.map(m => { const uci = m.from + m.to + (m.promotion || ''); return { uci, san: m.san, logit: move[i * 4352 + maiaMoveIndex(uci, black)] }; });
        const mx = Math.max(...lo.map(m => m.logit));
        let z = 0;
        for (const m of lo) { m.p = Math.exp(m.logit - mx); z += m.p; }
        for (const m of lo) m.p /= z;
        lo.sort((a, b) => b.p - a.p);
        const v = value.subarray(i * 3, i * 3 + 3), vm = Math.max(...v), ev = [...v].map(x => Math.exp(x - vm)), ez = ev[0] + ev[1] + ev[2];
        out.push({ moves: lo, value: (ev[2] + 0.5 * ev[1]) / ez });
      });
    }
    return out;
  }

  terminate() { this.worker.terminate(); }
}

// chess.com ratings run lower than Lichess ones, most of all at club level; Maia-3 was trained on Lichess.
// Rough blitz conversion (published rating-comparison surveys), linear between points.
const CC_TO_LICHESS = [[0, 650], [500, 1000], [1000, 1350], [1500, 1700], [2000, 2050], [2500, 2450], [3300, 3150]];
function chesscomToLichess(r) {
  if (r == null || isNaN(r)) return 1500;
  const t = CC_TO_LICHESS;
  if (r <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (r <= t[i][0]) { const [x0, y0] = t[i - 1], [x1, y1] = t[i]; return y0 + (y1 - y0) * (r - x0) / (x1 - x0); }
  return t[t.length - 1][1] + (r - t[t.length - 1][0]);
}
