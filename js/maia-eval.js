// Held-out comparison of Maia-3 with the Player bot (js/bot.js) and "always play Stockfish's top move",
// on exactly the positions the Player bot holds out: every 5th of the player's most recent games.
// maia-eval.html?user=gogangoblin&tc=blitz&months=3&games=40&models=5m,23m runs it; progress and results
// are in window.MAIA_EVAL.
//
// Maia variants:
//   - rating: the player's and opponent's chess.com ratings converted to Lichess scale, or shifted by the
//     offset that best explains the player's training games (a one-number personalization)
//   - history: the current board only, or the real last 8 positions
//   - hybrid: the Player bot's choice model with Maia's log-probability as one more feature, fitted on the
//     training games (Maia as the prior, the bot's features as the player-specific correction)

const ME = window.MAIA_EVAL = { status: 'idle', progress: 0, log: [], results: {} };
const ELO_SHIFTS = [-800, -600, -400, -200, 0, 200, 400, 600];

// Several single-threaded Maia workers sharing one batch of positions
class MaiaPool {
  constructor(size, n, opts) { this.ms = [...Array(n)].map(() => new Maia(size, opts)); this.ready = Promise.all(this.ms.map(m => m.ready)); }
  get loadMs() { return Math.max(...this.ms.map(m => m.loadMs)); }
  get bytes() { return this.ms[0].bytes; }
  get inferMs() { return this.ms.reduce((s, m) => s + m.ms, 0); }
  async predict(items) {
    const k = Math.ceil(items.length / this.ms.length);
    const parts = await Promise.all(this.ms.map((m, i) => m.predict(items.slice(i * k, (i + 1) * k))));
    return parts.flat();
  }
  terminate() { this.ms.forEach(m => m.terminate()); }
}

function meLog(msg) { ME.status = msg; ME.log.push(`${new Date().toLocaleTimeString()} ${msg}`); drawMaiaEval(); }

function gameFens(g) {
  const c = new Chess(), fens = [c.fen()];
  for (const s of g.sans) { if (!c.move(s, { sloppy: true })) break; fens.push(c.fen()); }
  return fens;
}

// Top-1 / top-3 / log-likelihood of the played move under a distribution (array of {uci, p} sorted by p)
function scoreDist(moves, playedUci) {
  const r = moves.findIndex(m => m.uci === playedUci);
  return { top1: r === 0, top3: r >= 0 && r < 3, ll: Math.log(Math.max(r >= 0 ? moves[r].p : 0, 1e-9)) };
}

function summarize(rows) {
  const n = rows.length || 1;
  return { n: rows.length, top1: rows.filter(r => r.top1).length / n, top3: rows.filter(r => r.top3).length / n, ll: rows.reduce((s, r) => s + r.ll, 0) / n };
}

// Book lookup exactly as evaluateBot does it
function bookMoves(trees, d) {
  const node = trees[d.game.color].get(d.key);
  const ms = sortedMoves(node);
  return ms.length && node.n >= BOOK_MIN ? ms : null;
}

// Scored rows with the book's choice replacing the model's wherever the book applies
function withBook(rows, trees) {
  return rows.map(r => {
    const bm = bookMoves(trees, r.d);
    if (!bm) return r;
    const san = r.d.alts[r.d.played].san;
    return { ...r, top1: bm[0].san === san, top3: bm.slice(0, 3).some(m => m.san === san) };
  });
}

// ---- hybrid: bot utility + alpha * log p_maia, fitted by maximum likelihood (Adam, light ridge) ----
function hybridProbs(d, theta, lp) {
  const s = new Float64Array(d.n);
  let mx = -Infinity;
  for (let i = 0; i < d.n; i++) {
    let v = theta[P_DIM] * lp[i]; const o = i * P_DIM;
    for (let k = 0; k < P_DIM; k++) v += d.X[o + k] * theta[k];
    s[i] = v; if (v > mx) mx = v;
  }
  let z = 0;
  for (let i = 0; i < d.n; i++) { s[i] = Math.exp(s[i] - mx); z += s[i]; }
  for (let i = 0; i < d.n; i++) s[i] /= z;
  return s;
}

async function fitHybrid(decs, lps, { iters = 250, lr = 0.05, l2 = 0.002 } = {}) {
  const D = P_DIM + 1;
  const theta = new Float64Array(D); // start from "Maia alone"
  theta[P_DIM] = 1;
  const m = new Float64Array(D), v = new Float64Array(D), g = new Float64Array(D);
  for (let it = 1; it <= iters; it++) {
    g.fill(0);
    decs.forEach((d, j) => {
      const lp = lps[j], p = hybridProbs(d, theta, lp), o = d.played * P_DIM;
      for (let k = 0; k < P_DIM; k++) g[k] += d.X[o + k];
      g[P_DIM] += lp[d.played];
      for (let i = 0; i < d.n; i++) {
        const pi = p[i]; if (pi < 1e-7) continue;
        const oi = i * P_DIM;
        for (let k = 0; k < P_DIM; k++) g[k] -= pi * d.X[oi + k];
        g[P_DIM] -= pi * lp[i];
      }
    });
    for (let k = 0; k < D; k++) {
      const gk = g[k] / decs.length - (k === P_DIM ? 0 : l2 * theta[k]);
      m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk;
      theta[k] += lr * (m[k] / (1 - 0.9 ** it)) / (Math.sqrt(v[k] / (1 - 0.999 ** it)) + 1e-8);
    }
    if (it % 10 === 0) await nextFrame();
  }
  return theta;
}

async function runMaiaEval({ user, tc = 'blitz', months = 3, nGames = 40, models = ['5m'], workers = 4, maiaWorkers = 6, shifts = ELO_SHIFTS, ep = 'wasm' }) {
  const key = `${user}:${tc}`;
  const R = ME.results[key] = { user, tc, months, nGames, started: new Date().toISOString(), maia: {} };
  ME.running = true;
  try {
    // 1. the Player bot pipeline, as trainPlayerBot runs it
    const data = await loadSource({ kind: 'chesscom', user, months }, m => meLog(String(m).replace(/<[^>]+>/g, '')));
    const pool = data.games.filter(g => (tc === 'all' || g.timeClass === tc) && g.sans.length >= 16);
    const games = pool.slice(0, nGames);
    // analyzeForBot per game (same depth, candidates and cache), several Stockfish workers at once
    const engines = Array.from({ length: workers }, () => new Engine());
    const rowsByGame = new Array(games.length);
    let next = 0, done = 0;
    await Promise.all(engines.map(async engine => {
      while (next < games.length) {
        const gi = next++;
        rowsByGame[gi] = await analyzeForBot(games[gi], engine);
        ME.progress = ++done / games.length;
        meLog(`${user}: Stockfish candidates, ${done} of ${games.length} games`);
      }
    }));
    engines.forEach(e => e.terminate());
    const decsByGame = games.map((g, gi) => gameDecisions(g, rowsByGame[gi]));
    const isTest = i => games.length >= 10 && i % 5 === 4;
    const train = [], test = [];
    decsByGame.forEach((ds, i) => (isTest(i) ? test : train).push(...ds));
    const testGames = new Set(games.filter((g, i) => isTest(i)));
    meLog(`${user}: fitting the Player bot on ${train.length} positions`);
    const theta = await fitBot(train);
    const trees = { white: buildTree(pool.filter(g => !testGames.has(g)), 'white'), black: buildTree(pool.filter(g => !testGames.has(g)), 'black') };
    R.bot = evaluateBot(test, theta, trees);
    R.games = games.length; R.trainN = train.length; R.testN = test.length;
    const meRating = mean(games.map(g => g.me.rating).filter(Boolean));
    R.rating = Math.round(meRating); R.lichessRating = Math.round(chesscomToLichess(meRating));

    // out-of-book subset, where the model (not the book) decides
    const oob = test.filter(d => !bookMoves(trees, d));
    R.oobN = oob.length;
    R.botOob = summarize(oob.map(d => scoreDist([...decisionProbs(d, theta)].map((p, i) => ({ uci: d.alts[i].uci, p })).sort((a, b) => b.p - a.p), d.alts[d.played].uci)));
    R.sfOob = oob.filter(d => d.bestUci === d.alts[d.played].uci).length / (oob.length || 1);

    // 2. Maia on every decision (train for choosing the rating shift, test for scoring)
    const fensByGame = new Map(games.map(g => [g, gameFens(g)]));
    const all = [...train, ...test];
    const isTestDec = new Set(test);
    // the same split for offline experiments (tools/maia-finetune.py): games + [game, ply, Stockfish best, in book]
    const gIdx = new Map(games.map((g, i) => [g, i]));
    R.export = {
      games: games.map((g, i) => ({ id: g.id, color: g.color, sans: g.sans, me: g.me.rating, opp: g.opp.rating, test: isTest(i) })),
      decs: all.map(d => [gIdx.get(d.game), d.ply, d.bestUci, bookMoves(trees, d) ? 1 : 0]),
    };
    for (const size of models) {
      meLog(`${user}: loading Maia-3 ${size}`);
      const maia = new MaiaPool(size, maiaWorkers, { ep });
      await maia.ready;
      const res = R.maia[size] = { loadMs: Math.round(maia.loadMs), mb: +(maia.bytes / 1e6).toFixed(1), ep: maia.ms[0].ep, variants: {} };
      const predsByLabel = {};
      for (const hist of [false, true]) {
        for (const shift of shifts) {
          const label = `${hist ? 'hist' : 'board'}:${shift}`;
          meLog(`${user}: Maia-3 ${size}, ${hist ? 'last 8 positions' : 'current board'}, rating shift ${shift}`);
          const items = all.map(d => {
            const fens = fensByGame.get(d.game);
            return {
              fens: hist ? fens.slice(Math.max(0, d.ply - 7), d.ply + 1) : [fens[d.ply]],
              eloSelf: chesscomToLichess(d.game.me.rating) + shift, eloOppo: chesscomToLichess(d.game.opp.rating) + shift,
            };
          });
          const t0 = performance.now(), ms0 = maia.inferMs;
          const preds = await maia.predict(items);
          const perPos = (maia.inferMs - ms0) / items.length;
          const rows = all.map((d, j) => ({ d, j, ...scoreDist(preds[j].moves, d.alts[d.played].uci) }));
          const testRows = rows.filter(r => isTestDec.has(r.d));
          res.variants[label] = {
            hist, shift, msPerPos: +perPos.toFixed(2), wallS: +((performance.now() - t0) / 1000).toFixed(1),
            train: summarize(rows.filter(r => !isTestDec.has(r.d))), test: summarize(testRows),
            testBook: summarize(withBook(testRows, trees)), testOob: summarize(testRows.filter(r => !bookMoves(trees, r.d))),
          };
          predsByLabel[label] = preds; // kept for the hybrid fit below
          drawMaiaEval();
        }
      }
      // best rating shift on the training games, per history setting
      for (const hist of [false, true]) {
        const vs = shifts.map(s => res.variants[`${hist ? 'hist' : 'board'}:${s}`]);
        const best = vs.reduce((a, b) => (b.train.ll > a.train.ll ? b : a));
        res[hist ? 'bestHist' : 'bestBoard'] = `${hist ? 'hist' : 'board'}:${best.shift}`;
      }
      // hybrid on the best variant overall (by training log-likelihood)
      const bestLabel = [res.bestBoard, res.bestHist].reduce((a, b) => (res.variants[b].train.ll > res.variants[a].train.ll ? b : a));
      meLog(`${user}: fitting the hybrid (bot features + Maia-3 ${size} ${bestLabel})`);
      const preds = predsByLabel[bestLabel];
      const lpOf = (d, j) => { const byUci = new Map(preds[j].moves.map(m => [m.uci, Math.log(Math.max(m.p, 1e-9))])); return Float64Array.from(d.alts.map(a => byUci.get(a.uci) ?? -20)); };
      const lps = all.map(lpOf);
      const trainIdx = all.map((d, j) => j).filter(j => !isTestDec.has(all[j]));
      const ht = await fitHybrid(trainIdx.map(j => all[j]), trainIdx.map(j => lps[j]));
      const hRows = all.map((d, j) => j).filter(j => isTestDec.has(all[j])).map(j => {
        const d = all[j], p = hybridProbs(d, ht, lps[j]);
        const ms = [...p].map((pi, i) => ({ uci: d.alts[i].uci, p: pi })).sort((a, b) => b.p - a.p);
        return { d, ...scoreDist(ms, d.alts[d.played].uci) };
      });
      res.hybrid = { on: bestLabel, maiaWeight: +ht[P_DIM].toFixed(3), test: summarize(hRows), testBook: summarize(withBook(hRows, trees)), testOob: summarize(hRows.filter(r => !bookMoves(trees, r.d))) };
      maia.terminate();
    }
    R.done = new Date().toISOString();
    meLog(`${user}: done`);
  } catch (e) {
    R.error = e.message || String(e);
    meLog(`${user}: failed — ${R.error}`);
    console.error(e);
  } finally {
    ME.running = false;
    drawMaiaEval();
  }
  return R;
}

function drawMaiaEval() {
  const root = document.getElementById('maiaEval');
  if (!root) return;
  let html = `<p class="muted">${esc(ME.status)}</p>`;
  for (const R of Object.values(ME.results)) {
    html += `<h2>${esc(R.user)} — ${esc(R.tc)}${R.rating ? ` (chess.com ${R.rating} ≈ Lichess ${R.lichessRating})` : ''}</h2>`;
    if (R.error) html += `<p style="color:var(--critical)">${esc(R.error)}</p>`;
    if (!R.bot) continue;
    html += `<p class="small muted">${R.games} games, ${R.trainN} training / ${R.testN} held-out positions (${R.oobN} out of book).</p>`;
    html += '<table class="tree-table"><thead><tr><th>Predictor</th><th class="num">Top-1</th><th class="num">Top-3</th><th class="num">Top-1 out of book</th><th class="num">Log-lik</th></tr></thead><tbody>';
    html += `<tr><td>Stockfish top move</td><td class="num">${pct(R.bot.sfTop1, 1)}</td><td class="num">–</td><td class="num">${pct(R.sfOob, 1)}</td><td class="num">–</td></tr>`;
    html += `<tr><td>Player bot (book + model)</td><td class="num">${pct(R.bot.botTop1, 1)}</td><td class="num">${pct(R.bot.botTop3, 1)}</td><td class="num">${pct(R.botOob.top1, 1)}</td><td class="num">${num(R.bot.avgLogLik, 3)}</td></tr>`;
    for (const [size, res] of Object.entries(R.maia)) {
      for (const label of ['board:0', 'hist:0', res.bestBoard, res.bestHist].filter((x, i, a) => x && a.indexOf(x) === i)) {
        const v = res.variants[label];
        if (!v) continue;
        const name = `Maia-3 ${size}, ${v.hist ? 'last 8 positions' : 'board only'}, rating ${v.shift ? (v.shift > 0 ? '+' : '') + v.shift + ' (fitted)' : 'as converted'}`;
        html += `<tr><td>${name}</td><td class="num">${pct(v.test.top1, 1)}</td><td class="num">${pct(v.test.top3, 1)}</td><td class="num">${pct(v.testOob.top1, 1)}</td><td class="num">${num(v.test.ll, 3)}</td></tr>`;
        html += `<tr><td>&nbsp;&nbsp;book + that</td><td class="num">${pct(v.testBook.top1, 1)}</td><td class="num">${pct(v.testBook.top3, 1)}</td><td class="num">–</td><td class="num">–</td></tr>`;
      }
      if (res.hybrid) html += `<tr><td>Book + hybrid (bot features + Maia ${size}, weight ${res.hybrid.maiaWeight})</td><td class="num">${pct(res.hybrid.testBook.top1, 1)}</td><td class="num">${pct(res.hybrid.testBook.top3, 1)}</td><td class="num">${pct(res.hybrid.testOob.top1, 1)}</td><td class="num">${num(res.hybrid.test.ll, 3)}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  html += `<details><summary>Log</summary><pre class="small">${esc(ME.log.slice(-40).join('\n'))}</pre></details>`;
  root.innerHTML = html;
}

(async () => {
  const q = new URLSearchParams(location.search);
  if (!q.get('user')) { drawMaiaEval(); return; }
  for (const user of q.get('user').split(',')) {
    await runMaiaEval({ user, tc: q.get('tc') || 'blitz', months: +(q.get('months') || 3), nGames: +(q.get('games') || 40),
      models: (q.get('models') || '5m').split(','), workers: +(q.get('workers') || 4), maiaWorkers: +(q.get('maiaWorkers') || 6),
      shifts: q.get('shifts') ? q.get('shifts').split(',').map(Number) : ELO_SHIFTS, ep: q.get('ep') || 'wasm' });
  }
})();
