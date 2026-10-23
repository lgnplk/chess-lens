// Builds js/explorer-masters.json: an opening explorer of over-the-board master games (PGN Mentor's player files,
// the same source as the legends): node tools/build-explorer.js
// Every player file is downloaded and unzipped, games are de-duplicated (two listed players who met appear in
// both files), and the first MAX_PLIES moves are replayed on all CPU cores into a tree: position → moves played
// there with White wins / draws / Black wins, average rating and the latest year. Positions reached in fewer than
// MIN_GAMES games are dropped. Output: { built, games, pos: { fenKey: [[san, w, d, b, avgElo, lastYear], …] } }.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const MAX_PLIES = 20, MIN_GAMES = 5, PAR_DL = 6;

if (isMainThread) main(); else worker();

// the smallest zip reader that works here: central directory → each .pgn entry, inflated
function unzipPgn(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const count = buf.readUInt16LE(e + 10), cd = buf.readUInt32LE(e + 16), out = [];
  for (let i = 0, p = cd; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('latin1', p + 46, p + 46 + nlen);
    const lstart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(lstart, lstart + csize);
    if (/\.pgn$/i.test(name)) out.push((method === 8 ? zlib.inflateRawSync(data) : data).toString('latin1'));
    p += 46 + nlen + xlen + clen;
  }
  return out.join('\n');
}

// a game: headers we use, and the move text cleaned of comments, variations, NAGs and move numbers
function splitGames(pgn) {
  const games = [];
  for (const chunk of pgn.split(/\r?\n(?=\[Event )/)) {
    const h = {};
    for (const m of chunk.matchAll(/^\[(\w+) "([^"]*)"\]/gm)) h[m[1]] = m[2];
    let moves = chunk.replace(/^\[.*\]\s*$/gm, ' ').replace(/\{[^}]*\}/g, ' ');
    while (/\([^()]*\)/.test(moves)) moves = moves.replace(/\([^()]*\)/g, ' ');
    const sans = moves.replace(/\$\d+/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter(t => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
    if (!sans.length || !/^(1-0|0-1|1\/2-1\/2)$/.test(h.Result || '')) continue;
    games.push({ r: h.Result === '1-0' ? 0 : h.Result === '0-1' ? 2 : 1, elo: [+h.WhiteElo || 0, +h.BlackElo || 0], year: +(h.Date || '').slice(0, 4) || 0,
      key: `${h.White}|${h.Black}|${h.Date}|${h.Round}|${sans.slice(0, 30).join(' ')}`, sans: sans.slice(0, MAX_PLIES) });
  }
  return games;
}

async function main() {
  const t0 = Date.now();
  const html = await (await fetch('https://www.pgnmentor.com/files.html')).text();
  const files = [...new Set([...html.matchAll(/players\/([A-Za-z0-9_-]+)\.zip/g)].map(m => m[1]))];
  console.log(files.length, 'player files');
  const seen = new Set(), games = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: PAR_DL }, async () => {
    while (next < files.length) {
      const f = files[next++];
      try {
        const buf = Buffer.from(await (await fetch(`https://www.pgnmentor.com/players/${f}.zip`)).arrayBuffer());
        for (const g of splitGames(unzipPgn(buf))) if (!seen.has(g.key)) { seen.add(g.key); games.push(g); }
      } catch (e) { console.log('\n', f, e.message); }
      process.stdout.write(`\r${++done}/${files.length} files · ${games.length.toLocaleString()} games`);
    }
  }));
  // replay on every core
  const lib = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js')).text();
  const n = Math.max(1, os.cpus().length - 2), per = Math.ceil(games.length / n);
  console.log(`\nreplaying ${games.length.toLocaleString()} games on ${n} threads…`);
  const parts = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: { lib, games: games.slice(i * per, (i + 1) * per).map(g => [g.r, g.elo, g.year, g.sans]) } });
    w.on('message', res); w.on('error', rej);
  })));
  // merge: position → move → [w, d, b, eloSum, eloN, lastYear]
  const tree = new Map();
  for (const part of parts) for (const [k, moves] of part) {
    let t = tree.get(k);
    if (!t) tree.set(k, t = new Map());
    for (const [san, x] of moves) {
      const y = t.get(san);
      if (!y) t.set(san, x); else { for (let i = 0; i < 5; i++) y[i] += x[i]; y[5] = Math.max(y[5], x[5]); }
    }
  }
  const pos = {};
  let kept = 0;
  for (const [k, t] of tree) {
    const rows = [...t].map(([san, x]) => [san, x[0], x[1], x[2], x[4] ? Math.round(x[3] / x[4]) : 0, x[5]]);
    const total = rows.reduce((s, r) => s + r[1] + r[2] + r[3], 0);
    if (total < MIN_GAMES) continue;
    pos[k] = rows.filter(r => r[1] + r[2] + r[3] >= 2).sort((a, b) => (b[1] + b[2] + b[3]) - (a[1] + a[2] + a[3]));
    kept++;
  }
  const out = { built: new Date().toISOString().slice(0, 10), source: 'PGN Mentor player files (over-the-board games)', games: games.length, plies: MAX_PLIES, pos };
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'explorer-masters.json'), JSON.stringify(out));
  console.log(`${kept.toLocaleString()} positions kept of ${tree.size.toLocaleString()} · ${Math.round((Date.now() - t0) / 1000)} s`);
}

function worker() {
  const ctx = {}; vm.createContext(ctx); vm.runInContext(workerData.lib + ';this.Chess=Chess;', ctx);
  const tree = new Map();
  for (const [r, elo, year, sans] of workerData.games) {
    const c = new ctx.Chess();
    const avg = elo[0] && elo[1] ? (elo[0] + elo[1]) / 2 : 0;
    for (const san of sans) {
      const k = c.fen().split(' ').slice(0, 4).join(' ');
      const mv = c.move(san, { sloppy: true });
      if (!mv) break;
      let t = tree.get(k);
      if (!t) tree.set(k, t = new Map());
      let x = t.get(mv.san);
      if (!x) t.set(mv.san, x = [0, 0, 0, 0, 0, 0]);
      x[r]++;
      if (avg) { x[3] += avg; x[4]++; }
      x[5] = Math.max(x[5], year);
    }
  }
  parentPort.postMessage([...tree].map(([k, t]) => [k, [...t]]));
}
