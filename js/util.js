// Small shared helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, html) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const pct = (x, d = 0) => (x == null || isNaN(x)) ? '–' : x === 0 ? '0%' : (x * 100).toFixed(d) + '%';
const num = (x, d = 1) => (x == null || isNaN(x)) ? '–' : Number(x).toFixed(d);
const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => a.length ? sum(a) / a.length : null;
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (k === undefined || k === null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// Score from the player's perspective: win=1, draw=.5, loss=0
const scoreOf = g => g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0;

function wdl(games) {
  const w = games.filter(g => g.result === 'win').length;
  const d = games.filter(g => g.result === 'draw').length;
  const l = games.length - w - d;
  const n = games.length;
  return { n, w, d, l, score: n ? (w + d / 2) / n : null };
}

// Elo expected score
const eloExpected = diff => 1 / (1 + Math.pow(10, -diff / 400));

// Lichess win% model from centipawns (mover's perspective)
const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtClock(sec) {
  if (sec == null) return '';
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = s < 10 && sec < 20 ? s.toFixed(1) : Math.floor(s).toString();
  if (h) return `${h}:${String(m).padStart(2, '0')}:${ss.padStart(2, '0')}`;
  return `${m}:${ss.padStart(2, '0')}`;
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// The opening book mixes two conventions for the en-passant square: listed only when a pawn can actually capture
// there (standard EPD), or as chess.js writes it, after every double pawn step. bookHit tries both.
function bookKey(fen) {
  const p = fen.split(' ');
  if (p[3] && p[3] !== '-') {
    const f = p[3].charCodeAt(0) - 97, rank = p[3][1], rows = p[0].split('/');
    // the capturing pawn stands beside the pushed one: rank 4 (black to move, ep on 3) or rank 5 (white to move, ep on 6)
    const row = rows[rank === '3' ? 4 : 3].replace(/d/g, n => '.'.repeat(+n)), pawn = p[1] === 'b' ? 'p' : 'P';
    if (![f - 1, f + 1].some(x => x >= 0 && x < 8 && row[x] === pawn)) p[3] = '-';
  }
  return p.slice(0, 4).join(' ');
}
// the book entry for a position (a full FEN or its first four fields), whichever convention the book used
const bookHit = (book, fen) => book.get(fen.split(' ').slice(0, 4).join(' ')) || book.get(bookKey(fen));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => setTimeout(r, 0));

const store = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

function wdlBar(r) {
  if (!r.n) return '<div class="wdl"></div>';
  return `<div class="wdl" title="${r.w}W / ${r.d}D / ${r.l}L">` +
    (r.w ? `<div class="w" style="flex:${r.w}"></div>` : '') +
    (r.d ? `<div class="d" style="flex:${r.d}"></div>` : '') +
    (r.l ? `<div class="l" style="flex:${r.l}"></div>` : '') + '</div>';
}

const PIECE_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Loader messages ("… 3/12 months", "… 40 of 100 found") as text plus a progress bar.
// Downloading fills the first 60%, processing the rest. The bar element persists so its width animates.
function statusFraction(msg) {
  const t = String(msg).replace(/<[^>]+>/g, ''), m = /(\d+)\s*(?:\/|of)\s*(\d+)/.exec(t);
  if (!m || +m[2] <= 0) return null;
  const f = Math.min(1, +m[1] / +m[2]);
  return /^Processing/.test(t) ? 0.6 + 0.4 * f : 0.6 * f;
}
function showStatus(el, msg) {
  if (!el) return;
  if (!msg) { el.innerHTML = ''; return; }
  let txt = el.querySelector(':scope > .st-msg'), bar = el.querySelector(':scope > .progress');
  if (!txt || !bar) { el.innerHTML = '<span class="st-msg"></span><div class="progress hidden"><div></div></div>'; txt = el.firstElementChild; bar = el.lastElementChild; }
  txt.innerHTML = msg;
  const f = statusFraction(msg);
  bar.classList.toggle('hidden', f == null);
  if (f != null) bar.firstElementChild.style.width = (f * 100).toFixed(1) + '%';
}
