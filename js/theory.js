// Opening names and theory: each game is named by the deepest known line it follows (our own opening book, so a
// 1.Nf3 d5 2.e4 game is the Tennison Gambit, not just a Réti), and how long a player stays inside named lines is
// read as opening knowledge. "Known" here means a named line in the book; it is a measure of how far a player
// follows established theory, not of how good their moves are.

// "Zukertort Opening: Tennison Gambit, Brigg's Trap" → "Zukertort Opening: Tennison Gambit" (a named gambit is
// the opening a player thinks of); anything else → its main name ("Sicilian Defense: Najdorf Variation" → "Sicilian Defense")
function bookFamily(name) {
  const [main, sub = ''] = name.split(': ');
  const first = sub.split(',')[0];
  return /gambit/i.test(first) ? `${main}: ${first}` : main;
}

async function relabelOpenings(games) {
  const book = await getBook();
  if (!book) return;
  for (const g of games) {
    if (g._bk || !g.keys) continue;
    g._bk = true;
    let deep = 0, hit = null;
    for (let i = 1; i < g.keys.length; i++) { const h = bookHit(book, g.keys[i]); if (h) { deep = i; hit = h; } }
    if (hit) { g.ccOpening = g.opening; g.opening = hit.name; g.family = bookFamily(hit.name); g.eco = hit.eco; }
    g.bookPlies = deep;
    // who made the first move outside the line: only known if the game went on and the window wasn't exhausted
    const leaverWhite = deep % 2 === 0;
    g.bookLeaver = deep >= 1 && deep < g.keys.length - 1 && g.sans.length > deep ? ((g.color === 'white') === leaverWhite ? 'me' : 'opp') : null;
  }
}

// moves the player made inside the known line: white played ⌈plies/2⌉ of them, black ⌊plies/2⌋
const myBookMoves = g => (g.color === 'white' ? Math.ceil(g.bookPlies / 2) : Math.floor(g.bookPlies / 2));

function computeTheory(games) {
  const gs = games.filter(g => g.bookPlies != null);
  if (gs.length < 5) return null;
  const depth = mean(gs.map(myBookMoves));
  const known = gs.filter(g => g.bookLeaver);
  const leaveFirst = known.length >= 5 ? known.filter(g => g.bookLeaver === 'me').length / known.length : null;
  const early = gs.filter(g => myBookMoves(g) <= 2).length / gs.length;   // out of every named line within two moves
  const rows = [...groupBy(gs, g => `${g.color}|${g.family}`)].map(([k, list]) => {
    const kn = list.filter(g => g.bookLeaver);
    return { color: list[0].color, name: k.slice(k.indexOf('|') + 1), n: list.length, depth: mean(list.map(myBookMoves)),
      first: kn.length >= 3 ? kn.filter(g => g.bookLeaver === 'me').length / kn.length : null };
  }).filter(r => r.n >= 3).sort((a, b) => b.n - a.n).slice(0, 8);
  // plain reading: how deep, and who tends to leave first
  // calibrated on blitz games: 3000+ players average about 3 moves inside named lines, a 570 about 2.5, a 425 about 2
  const knowledge = depth >= 3 ? 'Deep in the known lines' : depth >= 2.2 ? 'Knows the main lines' : 'Improvises early';
  const habit = leaveFirst == null ? '' : leaveFirst >= 0.6 ? 'You usually leave the known lines first.' : leaveFirst <= 0.4 ? 'Your opponents usually leave the known lines first.' : 'You and your opponents leave the known lines about equally.';
  return { n: gs.length, depth, leaveFirst, early, rows, knowledge, habit };
}

function theoryCard(games) {
  const t = computeTheory(games);
  if (!t) return '';
  const ph = S.scanAgg?.phaseStats?.find(p => p.phase === 'opening' && p.n >= 30 && p.acc != null);
  const pct0 = x => pct(x, 0);
  return `<div class="card" style="margin-bottom:14px">
    <div class="row-between"><div><h3>Preparation</h3><div class="sub">How far you follow named opening lines (book of ~3,900 lines) · ${t.n} games</div></div></div>
    <div class="fp-title" style="font-size:26px;margin:2px 0 4px">${esc(t.knowledge)}</div>
    <p class="muted" style="margin:0 0 12px">${esc(t.habit)}</p>
    <div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:12px">
      ${tile('Moves in known lines', num(t.depth, 1), 'yours · strong players ≈ 3')}
      ${t.leaveFirst != null ? tile('You leave first', pct0(t.leaveFirst), 'of games') : ''}
      ${tile('Out of theory by move 2', pct0(t.early), 'of games')}
      ${ph ? tile('Opening accuracy', num(ph.acc, 1) + '%', 'from your scan') : ''}
    </div>
    <div class="table-wrap"><table><thead><tr><th>Opening</th><th class="num">Games</th><th class="num">Moves known</th><th class="num">You leave first</th></tr></thead><tbody>
      ${t.rows.map(r => `<tr><td>${colorDot(r.color)} ${esc(r.name.length > 44 ? r.name.slice(0, 42) + '…' : r.name)}</td><td class="num">${r.n}</td><td class="num">${num(r.depth, 1)}</td><td class="num">${r.first != null ? pct0(r.first) : '–'}</td></tr>`).join('')}
    </tbody></table></div>
  </div>`;
}
