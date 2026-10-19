// Player bot tab: build a bot for a player (book + Maia-3), inspect how well it predicts them, play it.
const botv = {
  pick: { kind: 'chesscom', user: '', months: 3, title: 'GM', max: 300 },
  nGames: 80, tc: 'all', size: 'auto', fid: 'high', model: null, training: false, abort: false, error: null, status: '', progress: 0,
  mode: 'likely', userColor: 'white', flipped: false, line: [], idx: 0, dist: null, thinking: false, token: 0,
  board: null, built: false,
};

// Large model where the GPU can run it (it helps strong players); the small one runs fine on any CPU
const botModelSize = () => botv.size !== 'auto' ? botv.size : (navigator.gpu ? '23m' : '5m');

function renderBot(sec) {
  if (!botv.built) {
    sec.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <h3>Player bot</h3>
        <div class="sub">Their openings, then Maia-3 tuned to their strength and accuracy.</div>
        ${sourcePickerHtml('botPicker', botv.pick, { button: 'Build bot' })}
        <div class="prep-opts">
          <button class="btn small-btn" id="botMe">Use my games</button>
          <label>Learn from <select id="botN">${[40, 80, 160, 300].map(n => `<option value="${n}" ${n === botv.nGames ? 'selected' : ''}>${n} games</option>`).join('')}</select></label>
          <label>Fidelity <select id="botFid">
            <option value="high">High (1–5 min)</option>
            <option value="standard">Standard (fast)</option>
          </select></label>
          <label>Model <select id="botSize">
            <option value="auto">Auto</option>
            <option value="5m">Maia-3 5M</option>
            <option value="23m">Maia-3 23M</option>
          </select></label>
          <button class="btn small-btn hidden" id="botStop">Stop</button>
        </div>
        <div class="progress hidden" id="botProg" style="margin-top:10px"><div></div></div>
        <div class="muted small" id="botStatus" style="margin-top:6px"></div>
      </div>
      <div id="botModel"></div>
      <div class="rv prep hidden" id="botPlay">
        <div class="rv-board">
          <div class="player-line" id="botTop"></div>
          <div class="board-wrap">
            <div class="evalbar" style="visibility:hidden" aria-hidden="true"></div><!-- no eval bar while playing the bot: it would give answers away -->
            <div class="board" id="botBoard"></div>
          </div>
          <div class="player-line" id="botBottom"></div>
          <div class="controls">
            <button class="btn" data-bnav="prev" title="Back (←)">◀</button>
            <button class="btn" data-bnav="next" title="Forward (→)">▶</button>
            <button class="btn" data-bnav="takeback" title="Take back your last move">↶</button>
            <button class="btn" data-bnav="new" title="New game">↺</button>
            <button class="btn" data-bnav="flip" title="Flip board">⇅</button>
            <button class="btn hidden" data-bnav="analyze" id="botAnalyze" title="Open this game in Review">Analyze</button>
          </div>
        </div>
        <div class="rv-panel">
          <div class="rv-head" id="botHead"></div>
          <div class="rv-body scroll" id="botThink"></div>
        </div>
      </div>
      <div id="botTwin" style="margin-top:14px"></div>
      <p class="muted small" style="margin-top:14px">Maia-3 by the University of Toronto Computational Social Science Lab (<a href="https://github.com/CSSLab/maia3" target="_blank" rel="noopener">github.com/CSSLab/maia3</a>), AGPL-3.0, running in your browser.</p>`;
    botv.built = true;
    if (S.username && !botv.pick.user) { botv.pick.user = S.username; botv.pick.months = S.months; }
    bindSourcePicker($('#botPicker'), botv.pick, src => trainBotFor(src));
    $('#botMe').onclick = () => trainBotFor(mySource(botv.pick));
    $('#botN').onchange = e => botv.nGames = +e.target.value;
    $('#botFid').value = botv.fid;
    $('#botFid').onchange = e => botv.fid = e.target.value;
    $('#botSize').value = botv.size;
    $('#botSize').onchange = e => botv.size = e.target.value;
    $('#botStop').onclick = () => { botv.abort = true; };
    $$('[data-bnav]').forEach(b => b.onclick = () => botNav(b.dataset.bnav));
    botv.board = new BoardView($('#botBoard'), { onMove: mv => botUserMove(mv) });
    document.addEventListener('keydown', e => {
      if (S.tab !== 'bot' || !botv.model || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); botNav('prev'); }
      if (e.key === 'ArrowRight') { e.preventDefault(); botNav('next'); }
    });
  }
  refreshBot();
}

function hideBot() { botv.token++; }

async function trainBotFor(src) {
  if (botv.training) return;
  botv.model?.maia.terminate();
  Object.assign(botv, { training: true, abort: false, error: null, model: null, status: 'Loading games…', progress: 0 });
  refreshBot();
  try {
    botv.model = await trainPlayerBot(src, {
      nGames: botv.nGames, tc: 'all', size: botModelSize(), fidelity: botv.fid === 'high',
      shouldAbort: () => botv.abort,
      onStatus: (m, f) => { botv.status = m; if (f != null) botv.progress = f; drawBotStatus(); },
    });
    botv.line = []; botv.idx = 0; botv.dist = null;
    openTwin(botv.model);
  } catch (e) {
    botv.error = e.message || String(e);
  }
  botv.training = false;
  refreshBot();
  maybeBotThink();
}

function drawBotStatus() {
  const st = $('#botStatus'), prog = $('#botProg');
  if (!st) return;
  const m = botv.model;
  st.innerHTML = botv.error ? `<span style="color:var(--critical)">${botv.error}</span>`
    : botv.training ? botv.status
    : m ? `Bot built from ${m.stats.games} of ${esc(m.label)}'s ${m.gamesTc && m.gamesTc !== 'all' ? m.gamesTc + ' ' : ''}games · Maia-3 ${m.size.toUpperCase()} on ${m.backend === 'webgpu' ? 'your GPU' : 'the CPU'}${m.fidelity ? ` · high fidelity (calibrated on ${m.fidelity.n} of their moves)` : ''}.` : '';
  prog.classList.toggle('hidden', !botv.training);
  prog.firstElementChild.style.width = (botv.progress * 100) + '%';
  $('#botStop').classList.toggle('hidden', !botv.training);
}

// ---------- model card ----------
function drawBotModel() {
  const box = $('#botModel');
  const m = botv.model;
  if (!m) { box.innerHTML = botv.training ? '' : empty('Pick a player and press <b>Build bot</b>. It takes about a minute: fitting their playing strength, then testing on held-out games.'); return; }
  const ev = m.evaluation;
  const scale = m.kind === 'lichess' ? 'Lichess' : m.kind === 'otb' ? 'FIDE-ish' : 'chess.com';
  const shiftTxt = m.shift === 0 ? 'exactly as their rating suggests' : `${Math.abs(m.shift)} points ${m.shift > 0 ? 'stronger' : 'weaker'} than their rating suggests`;
  const fr = m.fidelity?.report;
  box.innerHTML = `
    <div class="tiles">
      ${ev ? tile('Predicts their move', pct(fr && !m.fidelity.inSample ? fidCombinedTop1(m, ev) : ev.botTop1), `on ${ev.n} moves from games it never saw${fr && !m.fidelity.inSample ? ` · standard bot ${pct(ev.botTop1)}` : ''}`) : tile('Predicts their move', '–', 'needs 10+ games to test')}
      ${ev ? tile('Their move in bot\'s top 3', pct(ev.botTop3), `${pct(ev.bookShare)} of test moves came from their book`) : ''}
      ${ev ? tile('Stockfish\'s top move', pct(ev.sfTop1), 'how often “play the engine move” matches them — the baseline to beat') : ''}
      ${tile('Plays like', `~${m.playRating}`, `Lichess-scale rating · moves fit ${shiftTxt}`)}
      ${tile('Their usual rating', `~${m.typical}`, `${scale} rating, on the Lichess scale Maia uses`)}
    </div>
    ${fr ? fidProfileCard(m) : ''}
    ${ev ? `<div class="grid cols-2" style="margin-bottom:14px">
      <div class="card"><h3>Prediction accuracy by phase</h3><div class="sub">Real moves predicted, held-out games</div><div class="chart-box"><canvas id="botPhase"></canvas></div></div>
      <div class="card"><h3>How to read this</h3>
        <p class="small">Maia-3 alone matches about 57% of Lichess moves.</p>
        <p class="small">Top choice <b>${pct(ev.botTop1)}</b> · top 3 <b>${pct(ev.botTop3)}</b> · Stockfish <b>${pct(ev.sfTop1)}</b> · ±${Math.round(1.96 * Math.sqrt(ev.botTop1 * (1 - ev.botTop1) / ev.n) * 100)} points</p>
        <p class="muted small">“Like them” samples, mistakes included.</p>
      </div>
    </div>` : ''}`;
  if (ev) {
    const phases = ['opening', 'middlegame', 'endgame'].filter(p => ev.byPhase[p].n);
    makeChart($('#botPhase'), {
      type: 'bar',
      data: { labels: phases.map(p => `${p} (${ev.byPhase[p].n})`), datasets: [
        { label: 'Player bot', data: phases.map(p => ev.byPhase[p].bot * 100), backgroundColor: cssVar('--s1'), borderRadius: 2, maxBarThickness: 32 },
        { label: 'Stockfish top move', data: phases.map(p => ev.byPhase[p].sf * 100), backgroundColor: cssVar('--s2'), borderRadius: 2, maxBarThickness: 32 },
      ] },
      options: {
        plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } },
        scales: baseScales({ min: 0, max: 100, ticks: { callback: v => v + '%' } }),
      },
    });
  }
}

// High fidelity on held-out games: book positions as the book plays them, the rest with the calibrated model
function fidCombinedTop1(m, ev) {
  const fr = m.fidelity.report;
  return (ev.bookHits + fr.top1.fid * fr.n) / (ev.bookN + fr.n);
}

// How the bot's mistakes compare with the player's: real moves vs standard sampling vs high fidelity
function fidProfileCard(m) {
  const f = m.fidelity, r = f.report, p1 = x => x == null ? '–' : pct(x, x < 0.1 ? 1 : 0);
  const rows = FID_BAND_LABELS.map((lab, b) => `<tr><td>${lab}</td><td class="num"><b>${p1(r.bands.actual[b])}</b></td><td class="num">${p1(r.bands.maiaPool[b])}</td><td class="num">${p1(r.bands.fid[b])}</td></tr>`).join('');
  const ph = Object.entries(r.byPhase).filter(([, v]) => v.n).map(([p, v]) => `<tr><td>${p} <span class="muted small">(${v.n})</span></td><td class="num"><b>${p1(v.actual)}</b></td><td class="num">${p1(v.today)}</td><td class="num">${p1(v.fid)}</td></tr>`).join('');
  const where = f.inSample ? `${r.n} training moves` : `${r.n} held-out moves`;
  return `<div class="grid cols-2" style="margin-bottom:14px">
    <div class="card"><h3>Mistakes: the real ${esc(m.label)} vs the bot</h3><div class="sub">Win-% given away · ${where}</div>
      <table class="cmp"><thead><tr><th>Move loses</th><th class="num">Real</th><th class="num">Standard bot</th><th class="num">High fidelity</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small" style="margin-top:8px">Average loss per move: real <b>${r.avgLoss.actual.toFixed(2)}</b> · standard ${r.avgLoss.maia.toFixed(2)} · high fidelity <b>${r.avgLoss.fid.toFixed(2)}</b>. Predicts their exact move ${pct(r.top1.fid)} of the time out of book (plain Maia ${pct(r.top1.maia)}).</p></div>
    <div class="card"><h3>Mistakes of 8+ points, by phase</h3>
      <table class="cmp"><thead><tr><th>Phase</th><th class="num">Real</th><th class="num">Standard bot</th><th class="num">High fidelity</th></tr></thead><tbody>${ph}</tbody></table>
      </div>
  </div>`;
}

// ---------- playing ----------
function botChess(upto = botv.idx) { const c = new Chess(); for (const s of botv.line.slice(0, upto)) c.move(s); return c; }
function botFens(upto = botv.idx) { const c = new Chess(), f = [c.fen()]; for (const s of botv.line.slice(0, upto)) { c.move(s); f.push(c.fen()); } return f; }
const botColor = () => botv.userColor === 'white' ? 'black' : 'white';

// The game as a record the Review tab can open; the id follows the moves, so the same game reuses its cached analysis
function botGameRecord() {
  const m = botv.model, sans = [...botv.line], me = botv.userColor, c = botChess(sans.length);
  const result = c.in_checkmate() ? (c.turn() === me[0] ? 'loss' : 'win') : c.game_over() ? 'draw' : null;
  return {
    id: 'bot:' + hashStr(`${m.label}|${me}|${sans.join(' ')}`), sans, clocks: [], base: null, color: me,
    me: { name: S.player?.profile?.username || S.username || 'You', rating: null }, opp: { name: `${m.label} bot`, rating: m.playRating },
    result, reason: c.in_checkmate() ? 'checkmated' : c.in_stalemate() ? 'stalemate' : null,
    opening: '', eco: '', url: null, end: new Date(), timeClass: 'bot game',
  };
}
function analyzeBotGame() {
  if (!botv.model || !botv.line.length) return;
  openReview(botGameRecord(), botv.idx < botv.line.length ? botv.idx : 0);
}

function botUserMove(mv) {
  if (!botv.model || botv.thinking) return;
  botv.line = botv.line.slice(0, botv.idx);
  botv.line.push(mv.san);
  botv.idx = botv.line.length;
  botv.dist = null;
  refreshBot();
  maybeBotThink();
}

function botNav(cmd) {
  if (cmd === 'analyze') { analyzeBotGame(); return; }
  botv.token++; botv.thinking = false;
  if (cmd === 'prev') botv.idx = Math.max(0, botv.idx - 1);
  else if (cmd === 'next') botv.idx = Math.min(botv.line.length, botv.idx + 1);
  else if (cmd === 'new') { botv.line = []; botv.idx = 0; botv.dist = null; }
  else if (cmd === 'flip') botv.flipped = !botv.flipped;
  else if (cmd === 'takeback') {
    botv.line = botv.line.slice(0, botv.idx);
    do { botv.line.pop(); } while (botv.line.length && botChess(botv.line.length).turn() !== botv.userColor[0]);
    botv.idx = botv.line.length; botv.dist = null;
  }
  refreshBot();
  if (cmd === 'new' || cmd === 'takeback') maybeBotThink();
}

async function maybeBotThink() {
  if (!botv.model || S.tab !== 'bot' || botv.idx !== botv.line.length) return;
  const c = botChess();
  if (c.game_over() || c.turn() !== botColor()[0]) return;
  const token = ++botv.token;
  botv.thinking = true; refreshBot();
  let dist, pick;
  try {
    dist = await botDistribution(botv.model, botFens());
    if (token !== botv.token) return;
    if (botv.model.fidelity && dist.source === 'maia') {
      const r = await fidChoose(botv.model, dist.moves, botFens().at(-1), getEnginePool()[0], botv.mode === 'sample' ? 'sample' : 'likely');
      dist = { ...dist, moves: r.ranked, fid: true }; pick = r.move;
    } else pick = await botPick(botv.model, dist, botv.mode, botFens().at(-1), getEnginePool()[0]);
  } catch (e) { if (token === botv.token) { botv.thinking = false; botv.error = 'The bot failed to move: ' + (e.message || e); refreshBot(); } return; }
  if (token !== botv.token) return;
  botv.dist = dist;
  if (token !== botv.token) return;
  botv.thinking = false;
  if (pick) {
    await sleep(250);
    if (token !== botv.token) return;
    botv.line.push(pick.san); botv.idx = botv.line.length;
  }
  refreshBot();
}

function refreshBot() {
  if (!botv.built) return;
  drawBotStatus();
  if (botv._drawn !== botv.model || !botv.model) { drawBotModel(); botv._drawn = botv.model; drawTwin(); }
  const m = botv.model;
  $('#botPlay').classList.toggle('hidden', !m);
  if (!m) return;
  $('#botAnalyze').classList.toggle('hidden', !botv.line.length);
  const c = botChess();
  const last = botv.idx > 0 ? botChess(botv.idx - 1).move(botv.line[botv.idx - 1]) : null;
  const orient = botv.flipped ? botColor() : botv.userColor;
  botv.board.set({ fen: c.fen(), orientation: orient, lastMove: last });
  const botName = `${esc(m.label)} bot`;
  const sideHtml = col => col === botColor()
    ? `<span class="pl"><span class="dot ${col}"></span><b>${botName}</b> <span class="muted">~${m.playRating} ${botv.thinking ? '· thinking…' : ''}</span></span>`
    : `<span class="pl"><span class="dot ${col}"></span><b>You</b></span>`;
  const topCol = orient === 'white' ? 'black' : 'white';
  $('#botTop').innerHTML = sideHtml(topCol);
  $('#botBottom').innerHTML = sideHtml(topCol === 'white' ? 'black' : 'white');

  const toks = botv.line.map((s, i) => `<span class="mv ${i + 1 === botv.idx ? 'cur' : ''}" data-bi="${i + 1}">${i % 2 === 0 ? `${i / 2 + 1}.` : ''}${esc(s)}</span>`).join(' ');
  const over = c.game_over() ? `<div class="bot-over"><b>${c.in_checkmate() ? (c.turn() === botv.userColor[0] ? 'Checkmate — the bot wins.' : 'Checkmate — you win!') : 'Draw.'}</b><button class="btn primary" id="botAnalyzeEnd">Analyze?</button></div>` : '';
  $('#botHead').innerHTML = `${over}
    <div class="prep-opts" style="margin-top:0">
      <label>You play <select id="botColor"><option value="white" ${botv.userColor === 'white' ? 'selected' : ''}>White</option><option value="black" ${botv.userColor === 'black' ? 'selected' : ''}>Black</option></select></label>
      <label>Bot plays <select id="botMode"><option value="likely" ${botv.mode === 'likely' ? 'selected' : ''}>Most likely move</option><option value="sample" ${botv.mode === 'sample' ? 'selected' : ''}>Like them</option></select></label>
    </div>
    <div class="var-line small">${toks || '<span class="muted">New game — ' + (c.turn() === botv.userColor[0] ? 'your move' : 'the bot moves first') + '</span>'}</div>`;
  $('#botColor').onchange = e => { botv.userColor = e.target.value; botNav('new'); };
  $('#botMode').onchange = e => { botv.mode = e.target.value; };
  $$('#botHead [data-bi]').forEach(e => e.onclick = () => { botv.token++; botv.thinking = false; botv.idx = +e.dataset.bi; refreshBot(); });

  const think = $('#botThink');
  let html = '';
  const d = botv.dist;
  if (botv.thinking) html += '<p class="muted">The bot is thinking…</p>';
  else if (d && d.moves.length) {
    html += d.source === 'book'
      ? `<h3>From their games</h3><div class="sub">${d.n} of their games</div>`
      : d.fid ? `<h3>What the bot expects ${esc(m.label)} to play</h3><div class="sub">${d.value != null ? `Bot's chances ${pct(d.value)}` : ''}</div>`
      : `<h3>What Maia expects ${esc(m.label)} to play</h3><div class="sub">Probability of each move for a ~${m.playRating} player in this position${d.value != null ? ` · the bot rates its chances at ${pct(d.value)}` : ''}</div>`;
    html += `<table class="tree-table"><thead><tr><th>Move</th><th>Chance</th>${d.source === 'book' ? '<th class="num">Games</th>' : ''}</tr></thead><tbody>
      ${d.moves.slice(0, 8).map(x => `<tr><td><b>${esc(x.san)}</b></td><td><div class="share"><div style="width:${Math.round(x.p * 100)}%"></div></div><span class="small">${pct(x.p, x.p < 0.1 ? 1 : 0)}</span></td>${d.source === 'book' ? `<td class="num small">${x.games}</td>` : ''}</tr>`).join('')}
      </tbody></table>`;
    html += `<p class="muted small" style="margin-top:8px">${botv.mode === 'likely' ? 'Plays the top move.' : 'Samples these odds.'}</p>`;
  } else if (!c.game_over()) html += `<p class="muted">${c.turn() === botv.userColor[0] ? 'Your move.' : ''}</p>`;
  think.innerHTML = html;
  const end = $('#botAnalyzeEnd');
  if (end) end.onclick = analyzeBotGame;
}
