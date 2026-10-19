// Twin test: does the bot play like the real person? The player answers positions, and each answer is compared
// with the bot's prediction (made from the position alone). Two kinds of position:
//  - "yours": from the player's own games the bot didn't learn from, where we also know what they played back
//    then. How often people repeat their own move is the realistic ceiling for any bot.
//  - "new": from their recent opponents' games (chess.com bots), positions they've never seen.
// Answers are saved per bot source, so a test can be continued later.
const TWIN_N = 24;
const twin = { key: null, set: null, answers: [], i: 0, busy: false, board: null, reveal: null, error: null, status: '' };

const twinStoreKey = m => 'cl:twin:v1:' + sourceKey(m.src);

function twinPositionFrom(g, ply, kind) {
  const c = new Chess(), fens = [c.fen()];
  let last = null;
  for (let i = 0; i < ply; i++) { last = c.move(g.sans[i], { sloppy: true }); if (!last) return null; fens.push(c.fen()); }
  if (c.moves().length < 3) return null;
  const real = kind === 'yours' ? g.sans[ply] : null;
  return {
    kind, fen: fens.at(-1), fens: fens.slice(-8), real, lastMove: last && { from: last.from, to: last.to },
    history: g.sans.slice(Math.max(0, ply - 6), ply), startNo: Math.max(0, ply - 6),
    meta: kind === 'yours' ? `Your game vs ${g.opp?.name || '?'}${g.end ? ' · ' + fmtDate(g.end) : ''}` : `${g.me?.name || '?'} vs ${g.opp?.name || '?'}${g.end ? ' · ' + fmtDate(g.end) : ''}`,
  };
}

// a random decision point in a game: move 6 or later, someone with a real choice, not in the bot's book
function twinPick(model, g, kind) {
  const myTurn = g.color[0];
  for (let tries = 0; tries < 12; tries++) {
    const hi = Math.min(g.sans.length - 1, 90);
    if (hi < 12) return null;
    let ply = 12 + Math.floor(Math.random() * (hi - 11));
    if (kind === 'yours' && ((ply % 2 === 0 ? 'w' : 'b') !== myTurn)) ply++;
    if (ply >= g.sans.length) continue;
    const pos = twinPositionFrom(g, ply, kind);
    if (!pos) continue;
    const color = pos.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    const node = model.trees[color].get(pos.fen.split(' ').slice(0, 4).join(' '));
    if (node && node.n >= BOOK_MIN) continue;
    return pos;
  }
  return null;
}

async function buildTwinSet(model, onStatus) {
  const all = model.games || [];
  const learned = new Set(all.slice(0, model.stats.games).map(g => g.id));
  // "your" positions: games the bot never learned from, older ones first (less likely to be remembered)
  let pool = all;
  if (model.src.kind === 'chesscom') {
    onStatus?.('Finding your older games…');
    const d = await loadSource({ kind: 'chesscom', user: model.src.user, months: 12 }).catch(() => null);
    if (d?.games?.length) pool = d.games;
  }
  const older = pool.filter(g => !learned.has(g.id) && g.sans.length >= 24);
  const byAge = gs => [...gs].sort((a, b) => (a.end || 0) - (b.end || 0));
  const ownGames = older.length >= 12 ? shuffle(byAge(older).slice(0, Math.max(40, Math.ceil(older.length / 2))))
    : [...shuffle(older), ...byAge(all.filter(g => learned.has(g.id) && g.sans.length >= 24))];
  const wantOwn = model.src.kind === 'chesscom' ? TWIN_N / 2 : TWIN_N;
  const own = [];
  for (const g of ownGames) { if (own.length >= wantOwn) break; const p = twinPick(model, g, 'yours'); if (p) own.push(p); }
  const fresh = [];
  if (model.src.kind === 'chesscom') {
    const me = model.src.user.toLowerCase();
    const opps = [...new Set(all.map(g => g.opp?.name).filter(Boolean).map(s => s.toLowerCase()))].filter(o => o !== me).slice(0, 6);
    for (const o of opps) {
      if (fresh.length >= TWIN_N - own.length) break;
      onStatus?.(`Finding positions you've never seen: ${o}'s games…`);
      const d = await loadSource({ kind: 'chesscom', user: o, tc: 'all', recent: 12 }).catch(() => null);
      const gs = shuffle((d?.games || []).filter(g => g.sans.length >= 24 && g.opp?.name?.toLowerCase() !== me));
      let k = 0;
      for (const g of gs) { if (k >= 3 || fresh.length >= TWIN_N - own.length) break; const p = twinPick(model, g, 'new'); if (p) { fresh.push(p); k++; } }
    }
  }
  return shuffle([...own, ...fresh]);
}

function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// The bot's view of a position: its book, else Maia (and its high-fidelity reweighting when it has one)
async function twinPredict(model, item) {
  const dist = await botDistribution(model, item.fens);
  if (dist.source !== 'maia') return { source: 'book', ranked: dist.moves.map(m => ({ san: m.san, p: m.p })), maia: null };
  const maia = dist.moves.map(m => ({ san: m.san, uci: m.uci, p: m.p }));
  const ranked = model.fidelity ? await fidRanked(model, dist.moves, item.fen, getEnginePool()[0]) : maia;
  return { source: model.fidelity ? 'fidelity' : 'maia', ranked, maia };
}

function twinSave() { if (twin.key) store.set(twin.key, { set: twin.set, answers: twin.answers }); }

function openTwin(model) {
  twin.key = twinStoreKey(model);
  const saved = store.get(twin.key);
  Object.assign(twin, { set: saved?.set || null, answers: saved?.answers || [], reveal: null, error: null, status: '' });
  twin.i = twin.answers.length;
  drawTwin();
}

async function startTwin(fresh = false) {
  const m = botv.model;
  if (!m || twin.busy) return;
  if (fresh) { twin.set = null; twin.answers = []; twin.i = 0; twin.reveal = null; }
  if (!twin.set) {
    twin.busy = true; twin.status = 'Choosing positions…'; drawTwin();
    try { twin.set = await buildTwinSet(m, s => { twin.status = s; drawTwin(); }); twinSave(); }
    catch (e) { twin.error = e.message || String(e); }
    twin.busy = false; twin.status = '';
  }
  drawTwin();
}

async function twinAnswer(mv) {
  const m = botv.model, item = twin.set?.[twin.i];
  if (!m || !item || twin.reveal || twin.busy) return;
  twin.busy = true; twin.status = 'The bot is answering…'; drawTwin();
  try {
    const pred = await twinPredict(m, item);
    const uci = mv.from + mv.to + (mv.promotion || '');
    const sc = await scoreCandidates(getEnginePool()[0], item.fen, [...new Set([uci, ...pred.ranked.slice(0, 3).map(x => x.uci).filter(Boolean)])]);
    const rank = pred.ranked.findIndex(x => x.san === mv.san);
    const a = {
      i: twin.i, kind: item.kind, you: mv.san, real: item.real, source: pred.source,
      botTop: pred.ranked[0]?.san, pYou: rank >= 0 ? pred.ranked[rank].p : 0, rank,
      maiaTop: pred.maia?.[0]?.san ?? pred.ranked[0]?.san, pMaiaYou: (pred.maia || pred.ranked).find(x => x.san === mv.san)?.p ?? 0,
      lossYou: sc.loss[uci] ?? null,
      top: pred.ranked.slice(0, 6).map(x => ({ san: x.san, p: x.p, maiaP: x.maiaP ?? pred.maia?.find(y => y.san === x.san)?.p ?? null })),
    };
    twin.answers[twin.i] = a;
    twin.reveal = a;
    twinSave();
  } catch (e) { twin.error = 'The bot failed to answer: ' + (e.message || e); }
  twin.busy = false; twin.status = '';
  drawTwin();
}

function twinNext() { twin.reveal = null; twin.i++; drawTwin(); }

function twinSummary(ans) {
  const A = ans.filter(Boolean), n = A.length;
  if (!n) return null;
  const own = A.filter(a => a.kind === 'yours' && a.real);
  return {
    n, top1: A.filter(a => a.botTop === a.you).length, maiaTop1: A.filter(a => a.maiaTop === a.you).length,
    top3: A.filter(a => a.rank >= 0 && a.rank < 3).length,
    avgP: mean(A.map(a => a.pYou)), avgMaiaP: mean(A.map(a => a.pMaiaYou)),
    own: own.length, repeated: own.filter(a => a.you === a.real).length, botOnReal: own.filter(a => a.botTop === a.real).length,
    fresh: A.filter(a => a.kind === 'new').length, freshTop1: A.filter(a => a.kind === 'new' && a.botTop === a.you).length,
  };
}

function drawTwin() {
  const box = $('#botTwin'), m = botv.model;
  if (!box) return;
  if (!m) { box.innerHTML = ''; return; }
  const sm = twinSummary(twin.answers);
  const frac = (k, n) => n ? `${k}/${n} · ${pct(k / n)}` : '–';
  const intro = `<div class="row-between"><div><h3>Twin test — are you ${esc(m.label)}?</h3>
      <div class="sub">Play your real move; the bot answers blind.</div></div>
      <div class="prep-opts" style="margin:0">${twin.set ? `<button class="btn small-btn" id="twRestart">New positions</button>` : `<button class="btn primary" id="twStart" ${twin.busy ? 'disabled' : ''}>Start the twin test</button>`}</div></div>`;
  const tiles = sm ? `<div class="tiles" style="margin-top:12px">
      ${tile('Bot\'s first choice = your move', frac(sm.top1, sm.n), `plain Maia: ${frac(sm.maiaTop1, sm.n)}`)}
      ${tile('Your move in bot\'s top 3', frac(sm.top3, sm.n), '')}
      ${tile('Chance the bot gave your move', pct(sm.avgP), `plain Maia: ${pct(sm.avgMaiaP)}`)}
      ${sm.own ? tile('You repeated your past move', frac(sm.repeated, sm.own), `the bot's first choice was that move ${frac(sm.botOnReal, sm.own)}`) : ''}
    </div>` : '';
  const item = twin.set?.[twin.i];
  let stage = '';
  if (twin.error) stage = `<p style="color:var(--critical)">${esc(twin.error)}</p>`;
  else if (twin.status) stage = `<p class="muted">${esc(twin.status)}</p>`;
  if (twin.set && !item) stage += `<p><b>Done — ${sm?.n || 0} positions answered.</b> ${sm ? `The bot's first choice matched you ${pct(sm.top1 / sm.n)} of the time (plain Maia ${pct(sm.maiaTop1 / sm.n)})${sm.own ? `, and you repeated your own past move ${pct(sm.repeated / sm.own)} of the time` : ''}.` : ''} Press “New positions” for another round.</p>`;
  else if (item) {
    const toMove = item.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
    const hist = item.history.map((s, k) => { const ply = item.startNo + k; return (ply % 2 === 0 ? `${ply / 2 + 1}.` : (k === 0 ? `${Math.floor(ply / 2) + 1}…` : '')) + esc(s); }).join(' ');
    const r = twin.reveal;
    stage += `<div class="twin-stage">
      <div><div class="muted small" style="margin-bottom:6px">Position ${twin.i + 1} of ${twin.set.length} · <span class="pill">${item.kind === 'yours' ? 'from your games' : 'never seen'}</span> · ${esc(item.meta)}</div>
        <div class="match-board" style="--bs:min(400px, calc(100vw - 60px))"><div class="board" id="twinBoard"></div></div>
        <div class="var-line small" style="margin-top:6px">${hist} <b>· ${toMove} to move</b></div></div>
      <div class="twin-panel">${r ? twinRevealHtml(r, m) : `<h3>${toMove} to move — what do you play?</h3>`}</div>
    </div>`;
  }
  box.innerHTML = `<div class="card">${intro}${tiles}${stage}</div>`;
  $('#twStart')?.addEventListener('click', () => startTwin(false));
  $('#twRestart')?.addEventListener('click', () => startTwin(true));
  $('#twNext')?.addEventListener('click', twinNext);
  if (item && $('#twinBoard')) {
    twin.board = new BoardView($('#twinBoard'), { onMove: mv => twinAnswer(mv) });
    twin.board.set({ fen: item.fen, orientation: item.fen.split(' ')[1] === 'w' ? 'white' : 'black', lastMove: item.lastMove });
  }
}

function twinRevealHtml(r, m) {
  const hit = r.botTop === r.you;
  const rows = r.top.map(x => `<tr class="${x.san === r.you ? 'sel-row' : ''}"><td><b>${esc(x.san)}</b>${x.san === r.you ? ' <span class="pill">you</span>' : ''}${r.real && x.san === r.real ? ' <span class="pill">played then</span>' : ''}</td>
    <td><div class="share"><div style="width:${Math.round(x.p * 100)}%"></div></div><span class="small">${pct(x.p, x.p < 0.1 ? 1 : 0)}</span></td>
    <td class="num small muted">${x.maiaP != null ? pct(x.maiaP, x.maiaP < 0.1 ? 1 : 0) : ''}</td></tr>`).join('');
  return `<h3>${hit ? '✓ The bot picked your move' : `✗ The bot would play ${esc(r.botTop || '–')}`}</h3>
    <p class="small">You played <b>${esc(r.you)}</b>${r.lossYou != null ? ` <span class="muted">(${r.lossYou < 1 ? 'a top engine move' : `−${r.lossYou.toFixed(0)} win-% by Stockfish`})</span>` : ''}. The bot gave it <b>${pct(r.pYou, r.pYou < 0.1 ? 1 : 0)}</b>${r.rank >= 0 ? ` (its #${r.rank + 1} choice)` : ' (not among its candidates)'}.</p>
    ${r.real ? `<p class="small">In the real game you played <b>${esc(r.real)}</b>${r.real === r.you ? ' — the same move.' : '.'}</p>` : ''}
    <table class="tree-table"><thead><tr><th>Move</th><th>${r.source === 'book' ? 'Their games' : 'Bot'}</th><th class="num">${r.source === 'fidelity' ? 'Plain Maia' : ''}</th></tr></thead><tbody>${rows}</tbody></table>
    <button class="btn primary" id="twNext" style="margin-top:10px">Next position →</button>`;
}
