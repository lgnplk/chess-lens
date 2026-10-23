// Builds js/puzzles.json from the lichess puzzle database (public domain, database.lichess.org): node tools/build-puzzles.js
// Streams the ~300 MB archive, keeps well-tested puzzles (500+ plays, popularity 80+, rating settled), and samples
// up to PER_BUCKET of them uniformly at random from every 100-point rating bucket between 400 and 2900, so every
// level has plenty and the file stays small. Each puzzle: [id, fen, moves (uci, the first is the opponent's), rating, themes].
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const PER_BUCKET = 1600, LO = 400, HI = 2900, MIN_PLAYS = 500, MIN_POP = 80, MAX_RD = 90;
const buckets = new Map();   // bucket → { seen, kept: [] } (reservoir sampling)
let rnd = 12345;
const random = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);

https.get(URL, res => {
  if (res.statusCode !== 200) { console.error('HTTP', res.statusCode); process.exit(1); }
  const total = +res.headers['content-length'];
  let got = 0, lines = 0;
  res.on('data', c => { got += c.length; });
  const tick = setInterval(() => process.stdout.write(`\r${(100 * got / total).toFixed(1)}% · ${lines.toLocaleString()} puzzles read`), 2000);
  // The archive is zstd 'seekable': data frames with skippable frames (seek-table markers) around them, which Node's
  // decoder rejects. Walk the frame structure (headers and block sizes, no decompression) and pass on only data frames.
  const { Transform } = require('stream');
  let buf = Buffer.alloc(0);
  function frameEnd(b) {   // the length of the frame at the start of b, or 0 if it isn't all there yet
    if (b.length < 8) return 0;
    const magic = b.readUInt32LE(0);
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) { const n = 8 + b.readUInt32LE(4); return b.length >= n ? -n : 0; }   // skippable: negative
    if (magic !== 0xFD2FB528) throw new Error('not a zstd frame at offset');
    const d = b[4], fcsFlag = d >> 6, single = (d >> 5) & 1, checksum = (d >> 2) & 1, did = d & 3;
    let p = 5 + (single ? 0 : 1) + [0, 1, 2, 4][did] + (fcsFlag === 0 ? (single ? 1 : 0) : [1, 2, 4, 8][fcsFlag]);
    for (;;) {
      if (b.length < p + 3) return 0;
      const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16), last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
      p += 3 + (type === 1 ? 1 : size);
      if (last) break;
    }
    p += checksum ? 4 : 0;
    return b.length >= p ? p : 0;
  }
  const frames = new Transform({ transform(chunk, enc, cb) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const n = frameEnd(buf);
      if (!n) break;
      if (n > 0) this.push(buf.subarray(0, n));
      buf = buf.subarray(Math.abs(n));
    }
    cb();
  } });
  const dec = zlib.createZstdDecompress();
  dec.on('error', e => { console.error(e.message); process.exit(1); });
  const rl = readline.createInterface({ input: res.pipe(frames).pipe(dec) });
  rl.on('line', line => {
    if (lines++ === 0) return;   // header: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
    const f = line.split(',');
    const rating = +f[3], rd = +f[4], pop = +f[5], plays = +f[6];
    if (rating < LO || rating >= HI || rd > MAX_RD || pop < MIN_POP || plays < MIN_PLAYS) return;
    const b = Math.floor(rating / 100) * 100, x = buckets.get(b) || { seen: 0, kept: [] };
    buckets.set(b, x);
    x.seen++;
    const item = [f[0], f[1], f[2], rating, f[7]];
    if (x.kept.length < PER_BUCKET) x.kept.push(item);
    else { const j = Math.floor(random() * x.seen); if (j < PER_BUCKET) x.kept[j] = item; }
  });
  rl.on('close', () => {
    clearInterval(tick);
    const out = [...buckets.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, x]) => x.kept);
    fs.writeFileSync(path.join(__dirname, '..', 'js', 'puzzles.json'), JSON.stringify(out));
    console.log(`\n${out.length} puzzles kept from ${lines.toLocaleString()}; per bucket: ${[...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, x]) => `${b}:${x.kept.length}`).join(' ')}`);
  });
}).on('error', e => { console.error(e.message); process.exit(1); });
