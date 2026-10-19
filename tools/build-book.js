// Builds js/book.json from the lichess chess-openings dataset: node tools/build-book.js
// Keys are FEN positions (first 4 fields, as produced by chess.js 0.10.3) so transpositions match.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

(async () => {
  const lib = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js')).text();
  const ctx = {}; vm.createContext(ctx); vm.runInContext(lib + ';this.Chess=Chess;', ctx);
  const Chess = ctx.Chess;
  const texts = await Promise.all('abcde'.split('').map(c =>
    fetch(`https://cdn.jsdelivr.net/gh/lichess-org/chess-openings@master/${c}.tsv`).then(r => r.text())));
  const out = {};
  for (const t of texts) for (const row of t.split('\n').slice(1)) {
    const [eco, name, pgn] = row.split('\t');
    if (!pgn) continue;
    const c = new Chess();
    let ok = true;
    for (const tok of pgn.trim().split(/\s+/)) {
      if (/^\d+\./.test(tok)) continue;
      if (!c.move(tok, { sloppy: true })) { ok = false; break; }
    }
    if (ok) out[c.fen().split(' ').slice(0, 4).join(' ')] = [eco, name];
  }
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'book.json'), JSON.stringify(out));
  console.log(Object.keys(out).length, 'positions');
})();
