// Builds js/book.json and js/lines.json from the lichess chess-openings dataset (public domain): node tools/build-book.js
// book.json: FEN → [eco, name], for naming positions. Keys are FEN positions (first 4 fields, as produced by
// chess.js 0.10.3) so transpositions match. lines.json: [eco, name, "e4 e5 Nf3 …"], for learning openings.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

(async () => {
  const lib = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js')).text();
  const ctx = {}; vm.createContext(ctx); vm.runInContext(lib + ';this.Chess=Chess;', ctx);
  const Chess = ctx.Chess;
  const texts = await Promise.all('abcde'.split('').map(c =>
    fetch(`https://cdn.jsdelivr.net/gh/lichess-org/chess-openings@master/${c}.tsv`).then(r => r.text())));
  const out = {}, lines = [];
  for (const t of texts) for (const row of t.split('\n').slice(1)) {
    const [eco, name, pgn] = row.split('\t');
    if (!pgn) continue;
    const c = new Chess(), sans = [];
    let ok = true;
    for (const tok of pgn.trim().split(/\s+/)) {
      if (/^\d+\./.test(tok)) continue;
      const mv = c.move(tok, { sloppy: true });
      if (!mv) { ok = false; break; }
      sans.push(mv.san);
    }
    if (ok) { out[c.fen().split(' ').slice(0, 4).join(' ')] = [eco, name]; lines.push([eco, name, sans.join(' ')]); }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'book.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'lines.json'), JSON.stringify(lines));
  console.log(Object.keys(out).length, 'positions,', lines.length, 'lines');
})();
