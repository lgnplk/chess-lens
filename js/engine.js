// Stockfish 10 (WebAssembly build, falls back to asm.js) running in a Web Worker
const SF_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/';

// In the desktop app (desktop/preload.js), analysis runs on native Stockfish 19 processes instead.
const NATIVE_SF = typeof window !== 'undefined' && window.chessLensNative?.available ? window.chessLensNative : null;

// A native process dressed as a Worker (postMessage / onmessage / terminate), so the classes below don't care
function nativeStockfish() {
  const w = { onmessage: null };
  const id = NATIVE_SF.spawn(lines => { for (const line of lines) w.onmessage?.({ data: line }); });
  w.postMessage = cmd => NATIVE_SF.send(id, cmd);
  w.terminate = () => NATIVE_SF.kill(id);
  return w;
}

function spawnStockfish(native = false) {
  if (native && NATIVE_SF) return nativeStockfish();
  // The wasm loader fetches "stockfish.wasm" relative to the worker, which is a blob: URL,
  // so redirect that request to the CDN.
  const src = typeof WebAssembly === 'object'
    ? `const _f = self.fetch.bind(self); self.fetch = (u, o) => _f(/\\.wasm$/.test(String(u)) ? '${SF_BASE}stockfish.wasm' : u, o); importScripts('${SF_BASE}stockfish.wasm.js');`
    : `importScripts('${SF_BASE}stockfish.js');`;
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
}

// Parse a UCI "info ... pv ..." line; returns null for bound/partial lines
function parseInfo(line) {
  if (!line.startsWith('info') || !line.includes(' pv ') || line.includes('lowerbound') || line.includes('upperbound')) return null;
  const cp = line.match(/score cp (-?\d+)/);
  const mt = line.match(/score mate (-?\d+)/);
  return {
    depth: +(line.match(/ depth (\d+)/) || [0, 0])[1],
    multipv: +(line.match(/ multipv (\d+)/) || [0, 1])[1],
    cp: cp ? +cp[1] : null, mate: mt ? +mt[1] : null,
    pv: line.split(' pv ')[1].trim().split(' '),
  };
}

// Side-to-move score -> white POV
const toWhite = (l, whiteToMove) => {
  const s = whiteToMove ? 1 : -1;
  return { cp: l.cp != null ? l.cp * s : null, mate: l.mate != null ? l.mate * s : null, pv: l.pv, depth: l.depth, best: l.pv[0] };
};

class Engine {
  // native: use desktop Stockfish when available (analysis). Bots keep the browser engine their calibration was
  // fitted with. tag goes into cache keys so evaluations from the two engines never mix.
  constructor({ native = false } = {}) {
    this.native = !!(native && NATIVE_SF);
    this.tag = this.native ? 'sf19:' : '';
    this.worker = spawnStockfish(this.native);
    this.listeners = [];
    this.worker.onmessage = e => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.chain = Promise.resolve();
    this.multipv = 1;
    this.ready = this.waitFor('uciok', 'uci').then(() => this.waitFor('readyok', 'isready'));
  }

  send(cmd) { this.worker.postMessage(cmd); }

  waitFor(token, cmd) {
    return new Promise(resolve => {
      const fn = line => {
        if (line.startsWith(token)) { this.listeners = this.listeners.filter(f => f !== fn); resolve(); }
      };
      this.listeners.push(fn);
      if (cmd) this.send(cmd);
    });
  }

  newGame() {
    this.chain = this.chain.then(() => this.ready).then(() => { this.send('ucinewgame'); return this.waitFor('readyok', 'isready'); });
    return this.chain;
  }

  // Evaluate a FEN. Returns { cp, mate, best, pv, depth, lines } with scores from WHITE's perspective.
  // lines[1] (when multipv > 1) is the runner-up move, used to detect "only moves".
  // searchmoves (uci) restricts the search to that one move, to score a specific move.
  analyse(fen, depth = 12, movetime = 4000, multipv = 1, searchmoves = null) {
    const whiteToMove = fen.split(' ')[1] === 'w';
    // The browser Stockfish never answers a search of a finished game, which would stall the queue for good.
    // (Native Stockfish answers at once, and this check costs a full move generation per search, so it's skipped.)
    const over = this.native ? null : new Chess(fen);
    if (over && !over.moves().length) {
      const mated = over.in_checkmate();
      return Promise.resolve({ cp: mated ? null : 0, mate: mated ? (whiteToMove ? -0.5 : 0.5) : null, best: null, pv: [], depth: 0, sd: 0, lines: [] });
    }
    const job = () => new Promise(resolve => {
      const lines = [];
      const bestByDepth = []; // top move at each completed depth -> how hard the move was to find
      // watchdog: if a search overruns its time limit, ask for the best move found so far
      const dog = setTimeout(() => this.send('stop'), movetime + 3000);
      const fn = line => {
        const info = parseInfo(line);
        if (info) { lines[info.multipv - 1] = info; if (info.multipv === 1) bestByDepth[info.depth] = info.pv[0]; return; }
        if (line.startsWith('bestmove')) {
          clearTimeout(dog);
          this.listeners = this.listeners.filter(f => f !== fn);
          const best = line.split(' ')[1];
          const main = lines[0] ? toWhite(lines[0], whiteToMove) : { cp: 0, mate: null, pv: [], depth: 0 };
          // stable depth: shallowest depth from which the engine never changed its mind
          let sd = bestByDepth.length;
          for (let d = bestByDepth.length - 1; d >= 1; d--) { if (bestByDepth[d] === undefined) continue; if (bestByDepth[d] !== best) break; sd = d; }
          resolve({ ...main, sd, best: best && best !== '(none)' ? best : null, lines: lines.filter(Boolean).map(l => toWhite(l, whiteToMove)) });
        }
      };
      this.listeners.push(fn);
      if (multipv !== this.multipv) { this.send(`setoption name MultiPV value ${multipv}`); this.multipv = multipv; }
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth} movetime ${movetime}${searchmoves ? ' searchmoves ' + searchmoves : ''}`);
    });
    const p = this.chain.then(() => this.ready).then(job);
    this.chain = p.catch(() => {});
    return p;
  }

  stop() { this.send('stop'); }
  terminate() { this.worker.terminate(); }
}

let _engine = null;
function getEngine() {
  if (!_engine) _engine = new Engine({ native: true });
  return _engine;
}
// Abort everything queued (used when the user switches games mid-analysis)
function resetEngine() {
  if (_engine) _engine.terminate();
  _engine = null;
}

// Separate Stockfish workers for big batch scans (one per spare core), so scans run in parallel and
// never queue behind (or block) the review engine
let _pool = [];
// ?threads=N overrides the default (useful for one-off batch jobs such as tools/build-ladder.js)
const scanThreads = () => +new URLSearchParams(location.search).get("threads") || Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 2) - 2));
function getEnginePool(n = scanThreads()) {
  while (_pool.length < n) _pool.push(new Engine());
  return _pool.slice(0, n);
}
// Engines for game analysis (scans): native in the desktop app, else the same browser pool the bots use
let _apool = [];
// (native processes are light, so they may use most of the cores; browser workers stay capped at 12)
const analysisThreads = () => NATIVE_SF ? (+new URLSearchParams(location.search).get('threads') || Math.max(1, Math.min(24, (navigator.hardwareConcurrency || 2) - 2))) : scanThreads();
const ANALYSIS_SPEED = NATIVE_SF ? 1.8 : 1; // positions per second relative to the browser engine, same depth
function getAnalysisPool(n = analysisThreads()) {
  if (!NATIVE_SF) return getEnginePool(n);
  while (_apool.length < n) _apool.push(new Engine({ native: true }));
  return _apool.slice(0, n);
}
function resetEnginePool() { _pool.forEach(e => e.terminate()); _pool = []; _apool.forEach(e => e.terminate()); _apool = []; }

// Interactive engine for the review board: streams the top N lines for whatever position
// is on screen, and abandons the old search as soon as the position changes.
class LiveEngine {
  constructor(multipv = 3) {
    this.worker = spawnStockfish(true);
    this.worker.onmessage = e => this.onLine(String(e.data));
    this.searching = false;
    this.pending = null;
    this.cur = null;
    this.send('uci');
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send('isready');
  }
  send(cmd) { this.worker.postMessage(cmd); }

  start(fen, depth, onUpdate) {
    this.pending = { fen, depth, onUpdate, lines: [] };
    if (this.searching) this.send('stop'); // the bestmove reply kicks off the pending search
    else this.go();
  }
  stopAll() { this.pending = null; if (this.searching) this.send('stop'); }

  go() {
    const p = this.pending; this.pending = null;
    if (!p) return;
    this.cur = p; this.searching = true;
    this.send(`position fen ${p.fen}`);
    this.send(`go depth ${p.depth}`);
  }

  onLine(line) {
    if (line.startsWith('bestmove')) {
      this.searching = false;
      if (this.cur && !this.pending) this.cur.onUpdate(this.cur.lines, true);
      this.go();
      return;
    }
    const info = parseInfo(line);
    if (!info || !this.cur || this.pending) return;
    const wtm = this.cur.fen.split(' ')[1] === 'w';
    const l = toWhite(info, wtm);
    this.cur.lines[info.multipv - 1] = l;
    this.cur.onUpdate(this.cur.lines.filter(Boolean), false);
  }
  terminate() { this.worker.terminate(); }
}

// Convert a white-POV eval to a single number (mate -> large cp)
function evalToCp(ev) {
  if (!ev) return 0;
  if (ev.mate != null) return ev.mate > 0 ? 10000 - ev.mate * 10 : -10000 - ev.mate * 10;
  return ev.cp ?? 0;
}

function fmtEval(ev) {
  if (!ev) return '';
  if (ev.mate != null && Math.abs(ev.mate) < 1) return ev.mate > 0 ? '1-0' : '0-1';
  if (ev.mate != null) return (ev.mate > 0 ? '' : '-') + 'M' + Math.abs(ev.mate);
  const v = (ev.cp ?? 0) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}
