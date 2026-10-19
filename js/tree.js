// Opening trees: for one player and one color, every position reached in the first 30 plies,
// what was played there, how often, and how the tree's owner scored afterwards.
// Positions are keyed by FEN (first 4 fields), so transpositions merge.
const START_KEY = new Chess().fen().split(' ').slice(0, 4).join(' ');

function buildTree(games, color) {
  const tree = new Map();
  for (const g of games) {
    if (g.color !== color || !g.keys) continue;
    let parent = null;
    const seen = new Set();
    for (let i = 0; i < g.keys.length; i++) {
      const k = g.keys[i];
      if (seen.has(k)) break; // a repetition inside the opening: stop so the game isn't double-counted
      seen.add(k);
      let node = tree.get(k);
      if (!node) { node = { key: k, n: 0, w: 0, d: 0, l: 0, moves: new Map(), path: g.sans.slice(0, i), parent }; tree.set(k, node); }
      node.n++; node[g.result[0]]++;
      const san = g.sans[i];
      let m = node.moves.get(san);
      if (!m) { m = { san, n: 0, w: 0, d: 0, l: 0, last: 0, games: [] }; node.moves.set(san, m); }
      m.n++; m[g.result[0]]++; m.last = Math.max(m.last, g.endTs);
      if (m.games.length < 30) m.games.push(g);
      parent = k;
    }
  }
  return tree;
}

const nodeScore = x => x.n ? (x.w + x.d / 2) / x.n : null;
const sortedMoves = node => node ? [...node.moves.values()].sort((a, b) => b.n - a.n) : [];

// Pick the tree owner's move: the most common one, or weighted by how often each was played
function pickMove(node, mode) {
  const ms = sortedMoves(node);
  if (!ms.length) return null;
  if (mode !== 'weighted') return ms[0];
  let r = Math.random() * sum(ms.map(m => m.n));
  for (const m of ms) { r -= m.n; if (r <= 0) return m; }
  return ms[0];
}

// The owner's most frequent opening sequences (first `plies` half-moves)
function mainLines(games, color, plies = 8, top = 8) {
  const groups = groupBy(games.filter(g => g.color === color && g.sans.length >= plies), g => g.sans.slice(0, plies).join(' '));
  return [...groups].map(([line, gs]) => ({ sans: line.split(' '), ...wdl(gs) }))
    .sort((a, b) => b.n - a.n).slice(0, top);
}

// Positions where the owner's results are unusually bad (weak) or good (strong).
// Reported at the point where those games branched off, so one line isn't listed many times.
function treeSpots(tree, { minN = 4, weak = true } = {}) {
  const out = [];
  for (const node of tree.values()) {
    if (node.n < minN || node.path.length < 2) continue;
    const par = node.parent && tree.get(node.parent);
    if (par && par.n === node.n) continue;
    const s = nodeScore(node);
    if (weak ? s <= 0.35 : s >= 0.7) out.push({ ...node, score: s, weight: node.n * Math.abs(s - 0.5) });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 8);
}

// Walk two repertoires against each other: White's choices from `whiteTree`, Black's from `blackTree`
function predictClash(whiteTree, blackTree, { maxPlies = 16, minN = 2 } = {}) {
  const c = new Chess();
  const line = [];
  for (let i = 0; i < maxPlies; i++) {
    const turn = c.turn();
    const node = (turn === 'w' ? whiteTree : blackTree).get(c.fen().split(' ').slice(0, 4).join(' '));
    const m = sortedMoves(node)[0];
    if (!m || m.n < minN) break;
    if (!c.move(m.san)) break;
    line.push({ san: m.san, turn, share: m.n / node.n, n: node.n });
  }
  return line;
}

function lineText(sans) {
  return sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ');
}
