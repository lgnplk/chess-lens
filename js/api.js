// chess.com public API access + PGN parsing into feature-rich game records
const API = 'https://api.chess.com/pub';

async function fetchJSON(url) {
  const r = await fetch(url);
  if (r.status === 404) throw new Error('Not found');
  if (r.status === 429) { await sleep(1500); return fetchJSON(url); }
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function fetchPlayer(username) {
  const [profile, stats] = await Promise.all([
    fetchJSON(`${API}/player/${username}`),
    fetchJSON(`${API}/player/${username}/stats`).catch(() => ({})),
  ]);
  return { profile, stats };
}

async function fetchGames(username, months, onProgress) {
  const { archives } = await fetchJSON(`${API}/player/${username}/games/archives`);
  const urls = archives.slice(-months);
  const all = [];
  let done = 0;
  // small concurrency to be polite to the API
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      try {
        const { games } = await fetchJSON(u);
        all.push(...games);
      } catch (e) { console.warn('archive failed', u, e); }
      onProgress?.(++done, urls.length);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return all;
}

// --- PGN helpers ---
function parseHeaders(pgn) {
  const h = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(pgn))) h[m[1]] = m[2];
  return h;
}

function clkToSec(s) {
  const p = s.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

// Returns { sans, clocks } from PGN movetext
function parseMovetext(pgn) {
  let body = pgn.replace(/\[[^\]]*\]\s*/g, m => m.startsWith('[%') ? m : '');
  // keep clocks: replace comments with a token
  const sans = [], clocks = [];
  const tokRe = /\{([^}]*)\}|(\d+\.(?:\.\.)?)|(1-0|0-1|1\/2-1\/2|\*)|(\$\d+)|([^\s{}]+)/g;
  let m;
  while ((m = tokRe.exec(body))) {
    if (m[1] !== undefined) {
      const c = m[1].match(/%clk\s+([\d:.]+)/);
      if (c && sans.length) clocks[sans.length - 1] = clkToSec(c[1]);
    } else if (m[5]) {
      const t = m[5].replace(/[?!]+$/, '');
      if (/^\d+\.+$/.test(t) || !t) continue;
      sans.push(t);
    }
  }
  return { sans, clocks };
}

function openingFromUrl(url, ecoHeader) {
  if (!url) return { name: ecoHeader || 'Unknown', family: ecoHeader || 'Unknown' };
  let slug = decodeURIComponent(url.split('/openings/')[1] || '');
  const words = slug.split('-');
  // drop trailing move sequences like "3...Nf6" / "4.Bc4"
  const cut = words.findIndex(w => /^\d+\./.test(w));
  const nameWords = cut === -1 ? words : words.slice(0, cut);
  // chess.com sends "Undefined" for lines it has no name for
  const name = nameWords.join(' ').replace(/\s+/g, ' ').trim().replace(/^Undefined$/, 'Unknown') || ecoHeader || 'Unknown';
  const stops = ['Defense', 'Opening', 'Game', 'Gambit', 'Attack', 'System', 'Countergambit'];
  let family = name;
  const idx = nameWords.findIndex(w => stops.includes(w));
  if (idx !== -1) family = nameWords.slice(0, idx + 1).join(' ');
  else if (nameWords.length > 3) family = nameWords.slice(0, 3).join(' ');
  return { name, family };
}

const DRAW_CODES = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

function classifyResult(meRes, oppRes) {
  if (meRes === 'win') return { result: 'win', reason: oppRes };
  if (DRAW_CODES.has(meRes)) return { result: 'draw', reason: meRes };
  return { result: 'loss', reason: meRes };
}

const REASON_LABEL = {
  checkmated: 'Checkmate', resigned: 'Resignation', timeout: 'Timeout', abandoned: 'Abandoned',
  agreed: 'Agreement', repetition: 'Repetition', stalemate: 'Stalemate', insufficient: 'Insufficient material',
  '50move': '50-move rule', timevsinsufficient: 'Timeout vs insufficient', lose: 'Other', kingofthehill: 'Other', threecheck: 'Other', bughousepartnerlose: 'Other',
};

function nonPawnMaterial(chess) {
  let t = 0;
  for (const row of chess.board()) for (const sq of row) if (sq && sq.type !== 'p' && sq.type !== 'k') t += PIECE_VAL[sq.type];
  return t;
}

// Build a game record with engine-free features
function buildGame(raw, username) {
  if (raw.rules !== 'chess' || !raw.pgn) return null;
  const uname = username.toLowerCase();
  const color = raw.white.username.toLowerCase() === uname ? 'white' : 'black';
  const me = raw[color], opp = raw[color === 'white' ? 'black' : 'white'];
  const { result, reason } = classifyResult(me.result, opp.result);
  const h = parseHeaders(raw.pgn);
  const { sans, clocks } = parseMovetext(raw.pgn);
  const op = openingFromUrl(raw.eco || h.ECOUrl, h.ECO);
  const [base, inc] = (raw.time_control || '0').split('+').map(Number);
  const end = new Date(raw.end_time * 1000);

  const g = {
    id: raw.url, url: raw.url, pgn: raw.pgn,
    end, endTs: raw.end_time, hour: end.getHours(), weekday: end.getDay(),
    timeClass: raw.time_class, timeControl: raw.time_control, base: raw.time_class === 'daily' ? null : base, inc: inc || 0,
    rated: raw.rated, color,
    me: { name: me.username, rating: me.rating }, opp: { name: opp.username, rating: opp.rating },
    diff: me.rating - opp.rating,
    result, reason,
    eco: h.ECO || '', opening: op.name, family: op.family,
    plies: sans.length, moves: Math.ceil(sans.length / 2),
    sans, clocks,
    ccAccuracy: raw.accuracies ? { me: raw.accuracies[color], opp: raw.accuracies[color === 'white' ? 'black' : 'white'] } : null,
  };
  g.firstMoves = sans.slice(0, 2).join(' ');
  g.myFirst = color === 'white' ? sans[0] : (sans[0] ? `1.${sans[0]} ${sans[1] || ''}` : '');
  return g;
}

const TREE_PLIES = 30;

// Replay with chess.js to extract move-level features (slower; done in workers)
function replayFeatures(g) {
  const chess = new Chess();
  const myTurn = g.color === 'white' ? 'w' : 'b';
  const f = {
    checks: 0, captures: 0, myMoves: 0, pawnMoves: 0, castle: null, castleMove: null, oppCastle: null, oppCastleMove: null,
    oppChecks: 0, oppCaptures: 0, oppMoves: 0, oppPawnMoves: 0, oppEarlyQueen: false,
    earlyQueen: false, queensOffPly: null, endgamePly: null, materialTimeline: [],
    kingMovesEarly: 0, promotions: 0, pieceMoves: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
  let mat = 0; // my material minus opponent's (captures + promotions)
  g.keys = []; // position keys before each of the first TREE_PLIES moves (for opening trees)
  for (let i = 0; i < g.sans.length; i++) {
    if (i < TREE_PLIES) g.keys.push(chess.fen().split(' ').slice(0, 4).join(' '));
    const mv = chess.move(g.sans[i], { sloppy: true });
    if (!mv) break;
    const mine = mv.color === myTurn;
    const moveNo = (i >> 1) + 1;
    if (mv.captured) mat += (mine ? 1 : -1) * PIECE_VAL[mv.captured];
    if (mv.promotion) mat += (mine ? 1 : -1) * (PIECE_VAL[mv.promotion] - 1);
    f.materialTimeline.push(mat);
    if (mine) {
      f.myMoves++;
      f.pieceMoves[mv.piece]++;
      if (mv.san.includes('+') || mv.san.includes('#')) f.checks++;
      if (mv.captured) f.captures++;
      if (mv.piece === 'p') f.pawnMoves++;
      if (mv.promotion) f.promotions++;
      if (mv.piece === 'q' && moveNo <= 6) f.earlyQueen = true;
      if (mv.flags.includes('k') || mv.flags.includes('q')) { f.castle = mv.flags.includes('k') ? 'K' : 'Q'; f.castleMove = moveNo; }
      else if (mv.piece === 'k' && !f.castle && moveNo <= 15) f.kingMovesEarly++;
    } else {
      f.oppMoves++;
      if (mv.san.includes('+') || mv.san.includes('#')) f.oppChecks++;
      if (mv.captured) f.oppCaptures++;
      if (mv.piece === 'p') f.oppPawnMoves++;
      if (mv.piece === 'q' && moveNo <= 6) f.oppEarlyQueen = true;
      if (mv.flags.includes('k') || mv.flags.includes('q')) { f.oppCastle = mv.flags.includes('k') ? 'K' : 'Q'; f.oppCastleMove = moveNo; }
    }
    if (f.queensOffPly === null || f.endgamePly === null) {
      const fen = chess.fen().split(' ')[0];
      if (f.queensOffPly === null && !fen.includes('q') && !fen.includes('Q')) f.queensOffPly = i + 1;
      if (f.endgamePly === null && nonPawnMaterial(chess) <= 26) f.endgamePly = i + 1;
    }
  }
  // sustained material swing: hold for 4 plies (filters out recapture blips)
  const tl = f.materialTimeline;
  let maxAdv = 0, maxDef = 0;
  for (let i = 0; i < tl.length; i++) { // windows at the end are shorter: the final position persists
    const w = tl.slice(i, i + 4);
    maxAdv = Math.max(maxAdv, Math.min(...w));
    maxDef = Math.min(maxDef, Math.max(...w));
  }
  f.maxAdv = maxAdv; f.maxDef = maxDef; f.finalMat = tl[tl.length - 1] || 0;
  f.oppositeCastling = !!(f.castle && f.oppCastle && f.castle !== f.oppCastle);

  // clocks
  if (g.base && g.clocks.length) {
    const myIdx = g.color === 'white' ? 0 : 1;
    const myClocks = [], spent = [];
    let prev = g.base;
    for (let i = myIdx; i < g.sans.length; i += 2) {
      const c = g.clocks[i];
      if (c == null) continue;
      myClocks.push(c);
      spent.push(Math.max(0, prev - c + g.inc));
      prev = c;
    }
    f.myClocks = myClocks;
    f.spent = spent;
    f.minClockFrac = myClocks.length ? Math.min(...myClocks) / g.base : null;
    f.timeTrouble = f.minClockFrac != null && f.minClockFrac < 0.1;
    const tot = sum(spent);
    f.openingTimeShare = tot ? sum(spent.slice(0, 10)) / tot : null;
    f.avgSpent = spent.length ? tot / spent.length : null;
    const oppClocks = [];
    for (let i = 1 - myIdx; i < g.sans.length; i += 2) if (g.clocks[i] != null) oppClocks.push(g.clocks[i]);
    f.oppMinClockFrac = oppClocks.length ? Math.min(...oppClocks) / g.base : null;
    f.finalClockDiff = (myClocks.at(-1) ?? 0) - (oppClocks.at(-1) ?? 0);
  }
  g.f = f;
  return g;
}

// Replay games in parallel Web Workers (falls back to the main thread)
function processInWorkers(raws, username, onProgress) {
  const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const size = Math.ceil(raws.length / n);
  let done = 0;
  return Promise.all(Array.from({ length: n }, (_, k) => new Promise((resolve, reject) => {
    const w = new Worker('js/worker.js');
    w.onmessage = e => {
      done += e.data.progress || 0;
      onProgress?.(done, raws.length);
      if (e.data.games) { w.terminate(); resolve(e.data.games); }
    };
    w.onerror = err => { w.terminate(); reject(err); };
    w.postMessage({ raws: raws.slice(k * size, (k + 1) * size), username });
  }))).then(parts => parts.flat());
}

async function processGames(raws, username, onProgress) {
  let games;
  try {
    games = await processInWorkers(raws, username, onProgress);
  } catch (e) {
    console.warn('worker processing failed, using main thread', e);
    games = [];
    for (let i = 0; i < raws.length; i++) {
      const g = buildGame(raws[i], username);
      if (g) {
        try { replayFeatures(g); games.push(g); } catch (err) { console.warn('replay failed', g.url, err); }
      }
      if (i % 40 === 0) { onProgress?.(i, raws.length); await nextFrame(); }
    }
  }
  games.sort((a, b) => b.endTs - a.endTs);
  // session index: games within 30 min of the previous one form a session
  const asc = [...games].reverse();
  let sessionIdx = 0, prevEnd = 0, prev = null;
  for (const g of asc) {
    if (g.endTs - prevEnd > 1800) sessionIdx = 0;
    g.sessionIdx = ++sessionIdx;
    g.prevResult = (prev && g.endTs - prevEnd <= 1800) ? prev.result : null;
    prevEnd = g.endTs; prev = g;
  }
  return games;
}

// Fetch + process a player's games. Cached per username/period so other tabs can reuse them.
const PLAYER_CACHE = new Map();
function loadPlayerData(username, months, onStatus) {
  username = username.trim().toLowerCase();
  const key = `${username}:${months}`;
  if (PLAYER_CACHE.has(key)) return PLAYER_CACHE.get(key);
  const p = (async () => {
    onStatus?.(`Looking up <b>${esc(username)}</b>…`);
    const player = await fetchPlayer(username).catch(e => { throw new Error(e.message === 'Not found' ? `No chess.com player named “${esc(username)}”.` : e.message); });
    onStatus?.(`Downloading ${esc(username)}'s game archives…`);
    const raws = await fetchGames(username, months, (d, n) => onStatus?.(`Downloading ${esc(username)}'s game archives… ${d}/${n} months`));
    if (!raws.length) throw new Error(`No games found for ${esc(username)} in that period.`);
    onStatus?.(`Processing ${raws.length} games…`);
    const games = await processGames(raws, username, (d, n) => onStatus?.(`Processing ${esc(username)}'s games… ${d}/${n}`));
    if (!games.length) throw new Error(`No standard chess games found for ${esc(username)} in that period.`);
    return { username, player, games, months };
  })();
  PLAYER_CACHE.set(key, p);
  p.catch(() => PLAYER_CACHE.delete(key));
  return p;
}

// ---------- Generic PGN sources (Lichess exports, OTB databases) ----------
function splitPgns(text) {
  return text.replace(/\r/g, '').split(/\n\s*\n(?=\[Event )/).map(s => s.trim()).filter(s => s.startsWith('['));
}

const nameKey = n => (n || '').split(',')[0].trim().toLowerCase();

// Which player a multi-game PGN file is about: the surname that appears in the most games
function dominantName(pgns) {
  const counts = new Map();
  for (const p of pgns) {
    const w = /\[White "([^"]*)"\]/.exec(p), b = /\[Black "([^"]*)"\]/.exec(p);
    for (const m of [w, b]) if (m) { const k = nameKey(m[1]); counts.set(k, (counts.get(k) || 0) + 1); }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function speedFromEvent(event, source) {
  const e = (event || '').toLowerCase();
  for (const s of ['ultrabullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence']) if (e.includes(s)) return s === 'ultrabullet' ? 'bullet' : s === 'correspondence' ? 'daily' : s;
  // PGN Mentor mixes in online events (e.g. "1st 3-0 Thu ..." = 3+0 blitz, "Titled Tuesday")
  if (source === 'otb') return /\b[1-5]-[0-5]\b/.test(e) ? 'blitz' : /titled|arena|online|chess\.com|lichess|bullet/.test(e) ? 'online' : 'classical';
  return 'other';
}

// spec: { mode: 'exact' | 'surname', value } identifies the target player in White/Black headers
function buildPgnGame(pgn, spec, source) {
  const h = parseHeaders(pgn);
  if ((h.Variant && h.Variant !== 'Standard') || h.FEN || h.SetUp === '1') return null;
  const match = n => spec.mode === 'exact' ? (n || '').toLowerCase() === spec.value : nameKey(n) === spec.value;
  const wT = match(h.White), bT = match(h.Black);
  if (wT === bT) return null;
  if (!['1-0', '0-1', '1/2-1/2'].includes(h.Result)) return null;
  const color = wT ? 'white' : 'black';
  const result = h.Result === '1/2-1/2' ? 'draw' : ((h.Result === '1-0') === (color === 'white') ? 'win' : 'loss');
  const { sans } = parseMovetext(pgn);
  if (sans.length < 2) return null;
  const ds = (h.UTCDate || h.Date || '').replace(/\?\?/g, '01').replace(/\./g, '-');
  let end = new Date(ds);
  if (isNaN(end)) end = new Date(0);
  const opp = color === 'white' ? 'Black' : 'White', me = color === 'white' ? 'White' : 'Black';
  const name = h.Opening || '';
  return {
    id: (h.Site && h.Site.startsWith('http') ? h.Site : '') || `${source}:${h.White}:${h.Black}:${h.Date}:${h.Round}:${sans.length}`,
    url: h.Site && h.Site.startsWith('http') ? h.Site : null, source,
    end, endTs: end.getTime() / 1000, color, result, sans, clocks: [],
    me: { name: h[me], rating: +h[me + 'Elo'] || null }, opp: { name: h[opp], rating: +h[opp + 'Elo'] || null },
    eco: h.ECO || '', opening: name || h.ECO || 'Unknown', family: name ? name.split(':')[0].trim() : (h.ECO || 'Unknown'),
    timeClass: speedFromEvent(h.Event, source), event: h.Event || '', year: end.getFullYear(),
  };
}

// Light replay: only position keys for the opening tree
function replayKeys(g) {
  const chess = new Chess();
  g.keys = [];
  for (let i = 0; i < g.sans.length && i < TREE_PLIES; i++) {
    g.keys.push(chess.fen().split(' ').slice(0, 4).join(' '));
    if (!chess.move(g.sans[i], { sloppy: true })) { g.sans = g.sans.slice(0, i); break; }
  }
  return g;
}

// Parse PGNs in parallel workers into light game records (opening-tree use)
function processPgnsInWorkers(pgns, spec, source, onProgress) {
  const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const size = Math.ceil(pgns.length / n);
  let done = 0;
  return Promise.all(Array.from({ length: n }, (_, k) => new Promise((resolve, reject) => {
    const w = new Worker('js/worker.js');
    w.onmessage = e => {
      done += e.data.progress || 0;
      onProgress?.(done, pgns.length);
      if (e.data.games) { w.terminate(); resolve(e.data.games); }
    };
    w.onerror = err => { w.terminate(); reject(err); };
    w.postMessage({ type: 'pgn', pgns: pgns.slice(k * size, (k + 1) * size), spec, source });
  }))).then(parts => parts.flat().sort((a, b) => b.endTs - a.endTs));
}
