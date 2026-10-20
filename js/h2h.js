// Head to head: your record against another chess.com player, side-by-side stats, and how
// your opening repertoires are likely to collide.
const h2h = { pick: { kind: 'chesscom', user: '', months: 3, title: 'GM' }, src: null, data: null, loading: false, error: null, tc: 'all', built: false };

function renderH2H(sec) {
  if (!h2h.built) {
    h2h.pick.months = S.months;
    sec.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <h3>Head to head</h3>
        <div class="sub">Your games together, stats side by side, and your openings' clash.</div>
        ${sourcePickerHtml('h2hPicker', h2h.pick, { kinds: ['chesscom', 'titled'], button: 'Compare' })}
        <div class="prep-opts"><label>Time control <select id="h2hTc"><option value="all">All</option><option value="bullet">Bullet</option><option value="blitz">Blitz</option><option value="rapid">Rapid</option><option value="daily">Daily</option></select></label></div>
        <div class="muted small" id="h2hStatus" style="margin-top:6px"></div>
      </div>
      <div id="h2hBody"></div>`;
    h2h.built = true;
    bindSourcePicker($('#h2hPicker'), h2h.pick, async src => {
      const token = h2h.token = (h2h.token || 0) + 1;
      h2h.src = src; h2h.loading = true; h2h.error = null; refreshH2H();
      let data = null, error = null;
      try { data = await loadSource(src, m => { if (token === h2h.token) showStatus($('#h2hStatus'), m); }); }
      catch (e) { error = e.message || String(e); }
      if (token !== h2h.token) return;
      // compare like with like: a player picked for one time control filters your games to it too
      if (data?.tc && data.tc !== 'all') h2h.tc = data.tc;
      Object.assign(h2h, { data, error, loading: false });
      await ensureMyH2HGames(token);
      if (token === h2h.token) refreshH2H();
    });
    $('#h2hTc').onchange = async e => { h2h.tc = e.target.value; refreshH2H(); const t = h2h.token; await ensureMyH2HGames(t); if (t === h2h.token) refreshH2H(); };
  }
  refreshH2H();
}

// Your side of the comparison: the loaded period, unless it has too few games in the chosen time control —
// then your own most recent games in it, as many as the other player has (so both sides are measured alike)
async function ensureMyH2HGames(token) {
  const tc = h2h.tc, other = h2h.data?.games.filter(g => tc === 'all' || g.timeClass === tc).length || 0;
  if (tc === 'all' || !S.username) return;
  const want = Math.min(Math.max(other, 20), 200);
  if (S.games.filter(g => g.timeClass === tc).length >= want) return;
  if (h2h.mine?.tc === tc && h2h.mine.user === S.username && h2h.mine.want >= want) return;
  $('#h2hStatus').textContent = `Loading your ${tc} games…`;
  const mine = await loadSource({ kind: 'chesscom', user: S.username, tc, recent: want }).catch(() => null);
  if (token !== h2h.token) return;
  h2h.mine = mine ? { tc, want, user: S.username, games: mine.games } : null;
  $('#h2hStatus').textContent = '';
}
const myH2HGames = () => (h2h.mine?.tc === h2h.tc && h2h.mine.user === S.username ? h2h.mine.games : S.games);

function h2hStats(games) {
  const ov = computeOverview(games), an = computeAnalytics(games), hb = computeHabits(games);
  const wins = games.filter(g => g.result === 'win'), losses = games.filter(g => g.result === 'loss');
  const accs = games.map(g => g.ccAccuracy?.me).filter(x => x != null);
  return {
    n: games.length, ov, an, hb,
    acc: accs.length ? mean(accs) : null, nAcc: accs.length,
    mateWins: wins.length ? wins.filter(g => g.reason === 'checkmated').length / wins.length : null,
    timeLosses: losses.length ? losses.filter(g => g.reason === 'timeout').length / losses.length : null,
    avgOpp: games.length ? mean(games.map(g => g.opp.rating)) : null,
    avgLen: games.length ? mean(games.map(g => g.moves)) : null,
    families: new Set(games.map(g => g.family)).size,
  };
}

function refreshH2H() {
  if (!h2h.built) return;
  $('#h2hTc').value = h2h.tc;
  const body = $('#h2hBody'), status = $('#h2hStatus');
  if (h2h.error) status.innerHTML = `<span style="color:var(--critical)">${h2h.error}</span>`;
  else if (!h2h.loading) status.textContent = '';
  if (!h2h.data) { body.innerHTML = h2h.loading ? '' : empty('Enter a player above and press Compare.'); return; }

  const tcf = gs => h2h.tc === 'all' ? gs : gs.filter(g => g.timeClass === h2h.tc);
  const A = { label: S.player?.profile?.username || S.username, player: S.player, games: tcf(myH2HGames()) };
  const B = { label: h2h.data.label, player: h2h.data.player, games: tcf(h2h.data.games) };
  if (A.label.toLowerCase() === B.label.toLowerCase()) { body.innerHTML = empty('That\'s you — pick someone else to compare with.'); return; }
  const sa = h2hStats(A.games), sb = h2hStats(B.games);

  // --- direct encounters (from your archive) ---
  const direct = A.games.filter(g => (g.opp.name || '').toLowerCase() === B.label.toLowerCase());
  const dr = wdl(direct);
  const byTc = [...groupBy(direct, g => g.timeClass)].map(([tc, gs]) => ({ tc, ...wdl(gs) }));
  const directHtml = direct.length ? `
    <div class="tiles">
      ${tile('Games played', dr.n, `${dr.w}W · ${dr.d}D · ${dr.l}L`)}
      ${tile('Your score', pct(dr.score, 1), `${esc(B.label)}: ${pct(1 - dr.score, 1)}`)}
      ${tile('Last game', fmtDate(direct[0].end), `${direct[0].result} as ${direct[0].color}`)}
      ${byTc.map(t => tile(t.tc, `${t.w}–${t.d}–${t.l}`, `${pct(t.score)} for you`)).join('')}
    </div>
    <div class="card" style="margin-bottom:14px"><h3>Your games against ${esc(B.label)}</h3><div class="sub">Click a game to review it</div>
      <div class="table-wrap" style="max-height:320px;overflow-y:auto"><table><thead><tr><th>Date</th><th></th><th>Result</th><th>Time</th><th>Opening</th><th class="num">Moves</th><th>Ended by</th></tr></thead><tbody>
      ${direct.slice(0, 100).map((g, i) => `<tr class="clickable" data-dg="${i}"><td>${fmtDate(g.end)}</td><td><span class="dot ${g.color}"></span></td><td>${resBadge(g.result)}</td><td><span class="pill">${tcLabel(g)}</span></td><td>${esc(g.opening.length > 40 ? g.opening.slice(0, 38) + '…' : g.opening)}</td><td class="num">${g.moves}</td><td>${REASON_LABEL[g.reason] || g.reason}</td></tr>`).join('')}
      </tbody></table></div></div>`
    : `<div class="card" style="margin-bottom:14px"><p class="muted">You haven't played ${esc(B.label)} in the loaded period${h2h.tc !== 'all' ? ` at ${h2h.tc}` : ''}.</p></div>`;

  // --- ratings ---
  const rat = (p, k) => { const s = p?.stats?.['chess_' + k]; return s?.last ? `${s.last.rating}${s.best ? ` <span class="muted small">best ${s.best.rating}</span>` : ''}` : '–'; };
  const ratRows = ['bullet', 'blitz', 'rapid', 'daily'].map(k => `<tr><td>${k}</td><td class="num">${rat(A.player, k)}</td><td class="num">${rat(B.player, k)}</td></tr>`).join('');
  const puzzle = p => p?.stats?.tactics?.highest?.rating ?? '–';

  // --- comparison rows: [label, a, b, fmt, better] ---
  const P = x => pct(x, 0), N0 = x => x == null ? '–' : Math.round(x), S1 = x => signed(x);
  const rows = [
    ['Games in period', sa.n, sb.n, N0, null],
    ['Score', sa.ov.all.score, sb.ov.all.score, x => pct(x, 1), null],
    ['Score vs rating expectation', sa.ov.all.over, sb.ov.all.over, S1, 'high'],
    ['Performance rating', sa.ov.all.perf, sb.ov.all.perf, N0, 'high'],
    ['Average opponent', sa.avgOpp, sb.avgOpp, N0, null],
    ['Score as White', sa.ov.byColor.white.score, sb.ov.byColor.white.score, P, 'high'],
    ['Score as Black', sa.ov.byColor.black.score, sb.ov.byColor.black.score, P, 'high'],
    ['chess.com accuracy', sa.acc, sb.acc, x => num(x, 1), 'high'],
    ['Wins by checkmate', sa.mateWins, sb.mateWins, P, null],
    ['Losses on time', sa.timeLosses, sb.timeLosses, P, 'low'],
    ['Time-trouble games', sa.an.timeTrouble.rate, sb.an.timeTrouble.rate, P, 'low'],
    ['Conversion (score after +3 material)', sa.an.material.ahead.score, sb.an.material.ahead.score, P, 'high'],
    ['Comebacks (score after −3 material)', sa.an.material.behind.score, sb.an.material.behind.score, P, 'high'],
    ['Score right after a loss', sa.an.afterRes[2].score, sb.an.afterRes[2].score, P, 'high'],
    ['Average game length (moves)', sa.avgLen, sb.avgLen, N0, null],
    ['Opening families played', sa.families, sb.families, N0, null],
  ];
  const cmpHtml = rows.map(([l, a, b, f, better]) => {
    let ea = '', eb = '';
    if (better && a != null && b != null && a !== b) { const aw = better === 'high' ? a > b : a < b; ea = aw ? 'edge' : ''; eb = aw ? '' : 'edge'; }
    return `<tr><td>${l}</td><td class="num ${ea}">${f(a)}</td><td class="num ${eb}">${f(b)}</td></tr>`;
  }).join('');

  // --- repertoires ---
  const topFam = (gs, color) => computeOpenings(gs.filter(g => g.color === color)).slice(0, 5);
  const famTable = (who, color) => {
    const rs = topFam(who.games, color), n = who.games.filter(g => g.color === color).length;
    return rs.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${pct(r.n / n)}</td><td class="num">${pct(r.score)}</td></tr>`).join('') || '<tr><td class="muted" colspan="3">No games</td></tr>';
  };

  // --- opening clash ---
  const tA = { white: buildTree(A.games, 'white'), black: buildTree(A.games, 'black') };
  const tB = { white: buildTree(B.games, 'white'), black: buildTree(B.games, 'black') };
  const clash = [
    { title: `${A.label} (White) vs ${B.label} (Black)`, line: predictClash(tA.white, tB.black), bColor: 'black' },
    { title: `${B.label} (White) vs ${A.label} (Black)`, line: predictClash(tB.white, tA.black), bColor: 'white' },
  ];
  const clashHtml = clash.map((c, ci) => `<div class="clash">
      <div class="row-between"><b>${esc(c.title)}</b>${c.line.length ? `<button class="btn small-btn" data-clash="${ci}">Prepare this vs ${esc(B.label)}</button>` : ''}</div>
      <div class="clash-line">${c.line.length ? c.line.map((m, i) => {
        const who = (m.turn === 'w') === (ci === 0) ? A.label : B.label;
        return `<span class="cm" title="${esc(who)} plays this in ${pct(m.share)} of ${m.n} games">${i % 2 === 0 ? `<span class="muted">${i / 2 + 1}.</span>` : ''}${esc(m.san)}<sub>${Math.round(m.share * 100)}%</sub></span>`;
      }).join(' ') : '<span class="muted small">Not enough shared opening data.</span>'}</div>
      ${c.line.length ? `<div class="muted small">Each side's most common move</div>` : ''}
    </div>`).join('');

  // --- playstyle: habits (no engine) and engine-verified choices (optional run) ---
  const hA = habitAxes(sa.hb), hB = habitAxes(sb.hb);
  const habitRows = sa.hb && sb.hb ? sa.hb.rows.map((r, i) => {
    const rb = sb.hb.rows[i];
    return `<tr><td>${r.label}</td><td class="num">${r.fmt(r.me)} <span class="muted small">vs ${r.fmt(r.opp)}</span></td><td class="num">${rb.fmt(rb.me)} <span class="muted small">vs ${rb.fmt(rb.opp)}</span></td></tr>`;
  }).join('') : '';
  const styleKey = `${A.label}|${B.label}|${h2h.tc}|${A.games.length}|${B.games.length}`;
  const st = h2h.style?.key === styleKey ? h2h.style : null;
  const run = h2h.styleRun?.running ? h2h.styleRun : null;
  const runCtl = `<div class="prep-opts">
      <label>Games per player <select id="h2hStyleN">${[10, 25, 50, 100, 200].map(n => `<option ${n === (h2h.styleN || 25) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="btn ${st ? '' : 'primary'} small-btn" id="h2hStyleGo">${run ? 'Stop' : st ? 'Re-run' : 'Analyze both players'}</button>
    </div>
    <div class="progress ${run ? '' : 'hidden'}" id="h2hStyleProg" style="margin-top:8px"><div style="width:${run ? run.progress * 100 : 0}%"></div></div>
    <div class="muted small" id="h2hStyleMsg" style="margin-top:4px">${run ? run.msg : ''}</div>`;
  let engineHtml;
  if (st) {
    const ax = engineAxes([st.A.style.me, st.B.style.me]);
    const ta = styleTitle(styleDims({ ...(habitCounts(A.games) || {}), ...engineCounts(st.A.style) }), styleExtra(st.A.style)).title;
    const tb = styleTitle(styleDims({ ...(habitCounts(B.games) || {}), ...engineCounts(st.B.style) }), styleExtra(st.B.style)).title;
    const keys = [['Found the only move', 'critical'], ['…hard to see', 'criticalHard'], ['Punished a mistake', 'punish'], ['…hard refutation', 'punishHard'], ['Took a sound sacrifice', 'sacOpp'], ['Sacrifices that held up', 'sacSound'], ['Chose forcing moves', 'forcing'], ['Chose trades', 'trade'], ['Pawn storms', 'storm']];
    const cell = r => r?.n ? `${pct(r.rate)} <span class="muted small">of ${r.n}</span>` : '<span class="muted">–</span>';
    engineHtml = `<div>
        <div>${ax.length >= 3 ? `<div class="chart-box radar"><canvas id="h2hEngineRadar"></canvas></div>` : '<p class="muted small">Not enough shared chances to draw the shape yet — analyze more games.</p>'}</div>
        <div class="table-wrap"><table class="cmp"><thead><tr><th></th><th class="num">${esc(A.label)}</th><th class="num">${esc(B.label)}</th></tr></thead><tbody>
          <tr><td>Style</td><td class="num style-name">${esc(ta)}</td><td class="num style-name">${esc(tb)}</td></tr>
          <tr><td>Games analyzed</td><td class="num">${st.A.n}</td><td class="num">${st.B.n}</td></tr>
          ${keys.map(([l, k]) => `<tr><td>${l}</td><td class="num">${cell(st.A.style.me[k])}</td><td class="num">${cell(st.B.style.me[k])}</td></tr>`).join('')}
        </tbody></table>
        </div>
      </div>${runCtl}`;
  } else {
    engineHtml = `<p class="small">Stockfish over both players' recent games.</p>${runCtl}`;
  }
  const styleHtml = `
    <h2 class="h2h-section">Playstyle</h2>
    <div class="card" id="h2hShape" style="margin-bottom:14px"></div>
    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card"><h3>Habits</h3><div class="sub">Each vs their own opponents</div>
        ${habitRows ? `<table class="cmp"><thead><tr><th></th><th class="num">${esc(A.label)}</th><th class="num">${esc(B.label)}</th></tr></thead><tbody>${habitRows}</tbody></table>` : '<p class="muted small">Needs 5+ games for each player.</p>'}</div>
      <div class="card"><h3>Engine-verified style</h3>${engineHtml}</div>
    </div>`;

  // --- analytics overlays ---
  const an = [sa.an, sb.an];
  const pressure = x => [
    { label: 'Up 3+ material', ...x.material.ahead }, { label: 'Down 3+ material', ...x.material.behind },
    { label: 'In time trouble', n: x.timeTrouble.n, score: x.timeTrouble.score }, { label: 'After a loss', ...x.afterRes[2] }, { label: 'After 2 losses', ...x.afterTwoLosses },
  ];
  const analyticsHtml = `
    <h2 class="h2h-section">Analytics</h2>
    <div class="grid cols-2">
      <div class="card"><h3>Against stronger and weaker opponents</h3><div class="sub">Score by rating gap · faded: under 5 games</div><div class="chart-box"><canvas id="h2hDiff"></canvas></div></div>
      <div class="card"><h3>Under pressure</h3><div class="chart-box"><canvas id="h2hPressure"></canvas></div></div>
      <div class="card"><h3>Session fatigue</h3><div class="sub">Score by game in a session</div><div class="chart-box"><canvas id="h2hSession"></canvas></div></div>
      <div class="card"><h3>Game length</h3><div class="chart-box"><canvas id="h2hLen"></canvas></div></div>
      <div class="card"><h3>Clock usage</h3><div class="sub">% of clock left</div><div class="chart-box"><canvas id="h2hClock"></canvas></div></div>
      <div class="card"><h3>Day of week</h3><div class="chart-box"><canvas id="h2hDay"></canvas></div></div>
    </div>`;

  body.innerHTML = `
    ${directHtml}
    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card"><h3>Side by side</h3><div class="sub">${A.games.length} vs ${B.games.length}${h2h.tc !== 'all' ? ` ${h2h.tc}` : ''} games · bold = clearly better</div>
        <div class="table-wrap"><table class="cmp"><thead><tr><th></th><th class="num">${esc(A.label)}</th><th class="num">${esc(B.label)}</th></tr></thead><tbody>
          ${ratRows}<tr><td>puzzles (best)</td><td class="num">${puzzle(A.player)}</td><td class="num">${puzzle(B.player)}</td></tr>
          <tr><td colspan="3" class="sep-row"></td></tr>${cmpHtml}
        </tbody></table></div></div>
      <div>
        <div class="card" style="margin-bottom:14px"><h3>Rating over time</h3><div class="sub">${esc(h2hRatingClass(A.games, B.games))} rating after each rated game</div><div class="chart-box"><canvas id="h2hRating"></canvas></div></div>
        <div class="card"><h3>Score by time control</h3><div class="sub">Faded: under 5 games</div><div class="chart-box short"><canvas id="h2hTcChart"></canvas></div></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:14px"><h3>Opening clash</h3><div class="sub">If you played today</div>${clashHtml}</div>
    <div class="grid" style="margin-bottom:14px">
      ${['white', 'black'].map(col => `<div class="card"><h3>Most played as ${col}</h3><div class="grid cols-2" style="gap:24px">
        ${[A, B].map(w => `<div><div class="sub"><b>${esc(w.label)}</b></div><table><thead><tr><th>Opening</th><th class="num">Share</th><th class="num">Score</th></tr></thead><tbody>${famTable(w, col)}</tbody></table></div>`).join('')}
      </div></div>`).join('')}
    </div>
    ${styleHtml}
    ${analyticsHtml}`;

  $$('#h2hBody [data-dg]').forEach(tr => tr.onclick = () => openReview(direct[+tr.dataset.dg]));
  $$('#h2hBody [data-clash]').forEach(b => b.onclick = () => {
    const c = clash[+b.dataset.clash];
    prepareLine(h2h.src, c.bColor, c.line.map(m => m.san));
  });
  drawH2HCharts(A, B);

  fillPairShape($('#h2hShape'), { ...A, agg: st?.A }, { ...B, agg: st?.B });
  if (st) {
    const ax = engineAxes([st.A.style.me, st.B.style.me]);
    if (ax.length >= 3) radarChart($('#h2hEngineRadar'), ax.map(x => x.label), [
      { label: A.label, data: ax.map(x => x.vs[0]), slot: '--s1' },
      { label: B.label, data: ax.map(x => x.vs[1]), slot: '--s2' },
    ], { tooltip: c => { const x = ax[c.dataIndex]; return `${c.dataset.label}: ${Math.round(c.parsed.r)}% of ${x.ns[c.datasetIndex]} chances`; } });
  }
  $('#h2hStyleN').onchange = e => h2h.styleN = +e.target.value;
  $('#h2hStyleGo').onclick = () => {
    if (h2h.styleRun?.running) { h2h.styleRun.abort = true; return; }
    runH2HStyle(A, B, h2h.styleN || 25, styleKey);
  };

  const names = [A.label, B.label];
  groupedScoreChart($('#h2hDiff'), an[0].diffBuckets.map(x => x.label), an[0].diffBuckets, an[1].diffBuckets, ...names);
  const pr = an.map(pressure);
  groupedScoreChart($('#h2hPressure'), pr[0].map(r => r.label), pr[0], pr[1], ...names);
  groupedScoreChart($('#h2hSession'), an[0].sessionBuckets.map(x => x.label), an[0].sessionBuckets, an[1].sessionBuckets, ...names);
  groupedScoreChart($('#h2hLen'), an[0].lenBuckets.map(x => x.label), an[0].lenBuckets, an[1].lenBuckets, ...names);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  groupedScoreChart($('#h2hDay'), days, an[0].byDay, an[1].byDay, ...names);
  const curves = [A, B].map(w => clockCurveAll(w.games));
  makeChart($('#h2hClock'), {
    type: 'line',
    data: { labels: Array.from({ length: 60 }, (_, i) => i + 1), datasets: [A, B].map((w, i) => ({
      label: w.label, data: curves[i], borderColor: cssVar(i ? '--s2' : '--s1'), backgroundColor: cssVar(i ? '--s2' : '--s1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true,
    })) },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { title: it => `Move ${it[0].label}`, label: c => `${c.dataset.label}: ${c.parsed.y?.toFixed(0)}% left` } } },
      scales: baseScales({ min: 0, max: 100, ticks: { callback: v => v + '%' } }, { ticks: { maxTicksLimit: 12 } }),
    },
  });
}

// Average share of the starting clock left at each of the player's moves (timed games)
function clockCurveAll(games) {
  const timed = games.filter(g => g.f?.myClocks?.length && g.base);
  return Array.from({ length: 60 }, (_, i) => {
    const v = timed.filter(g => g.f.myClocks[i] != null).map(g => g.f.myClocks[i] / g.base);
    return v.length >= 5 ? mean(v) * 100 : null;
  });
}

// Engine-verified style for both players: engine analysis of each one's recent games (cached, shared with
// the Engine scan tab), aggregated per opportunity
async function runH2HStyle(A, B, n, key) {
  const run = h2h.styleRun = { running: true, abort: false, progress: 0, msg: 'Starting…' };
  refreshH2H();
  // the time control the Shape radars compare (their Performance radar needs games in it), else any
  const tc = h2h.tc !== 'all' ? null : ladderState.ptc;
  const pick = (w, any) => w.games.filter(g => g.plies >= 10 && (any || !tc || g.timeClass === tc)).slice(0, n);
  const lists = [A, B].map(w => (pick(w).length ? pick(w) : pick(w, true)));
  const total = lists[0].length + lists[1].length;
  const results = [[], []];
  let done = 0;
  const show = () => {
    const m = $('#h2hStyleMsg'), p = $('#h2hStyleProg > div');
    if (m) m.textContent = run.msg;
    if (p) p.style.width = (run.progress * 100) + '%';
  };
  try {
    for (let side = 0; side < 2 && !run.abort; side++) {
      const who = [A, B][side].label, base = done;
      await analyzeGamesParallel(lists[side], 12, {
        shouldAbort: () => run.abort,
        onProgress: (f, d, threads) => { run.progress = (base + f * lists[side].length) / total; run.msg = `Analyzing ${who}'s games: ${d} of ${lists[side].length} on ${threads} engines…`; show(); },
        onResult: (g, a) => { results[side].push({ game: g, analysis: a }); done++; },
      });
    }
    if (!run.abort && results[0].length && results[1].length) h2h.style = { key, n, A: aggregateScan(results[0]), B: aggregateScan(results[1]) };
  } finally {
    run.running = false;
    if (S.tab === 'h2h') refreshH2H();
  }
}

function h2hRatingClass(ga, gb) {
  if (h2h.tc !== 'all') return h2h.tc;
  const counts = {};
  [...ga, ...gb].forEach(g => counts[g.timeClass] = (counts[g.timeClass] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'blitz';
}

function drawH2HCharts(A, B) {
  const tc = h2hRatingClass(A.games, B.games);
  const series = (who, slot) => ({
    label: who.label, borderColor: cssVar(slot), backgroundColor: cssVar(slot), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.2,
    data: who.games.filter(g => g.timeClass === tc && g.rated).sort((a, b) => a.endTs - b.endTs).map(g => ({ x: g.endTs * 1000, y: g.me.rating })),
  });
  makeChart($('#h2hRating'), {
    type: 'line', data: { datasets: [series(A, '--s1'), series(B, '--s2')] },
    options: {
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { title: it => fmtDate(new Date(it[0].parsed.x)) } } },
      scales: baseScales({}, { type: 'linear', ticks: { callback: v => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), maxTicksLimit: 8 } }),
    },
  });
  const tcs = ['bullet', 'blitz', 'rapid', 'daily'].filter(t => A.games.some(g => g.timeClass === t) || B.games.some(g => g.timeClass === t));
  const ds = (who, slot) => {
    const rs = tcs.map(t => wdl(who.games.filter(g => g.timeClass === t)));
    return { label: who.label, data: rs.map(r => r.n ? r.score * 100 : null), backgroundColor: rs.map(r => r.n >= 5 ? cssVar(slot) : cssVar(slot) + '55'), borderRadius: 2, maxBarThickness: 32, _rows: rs };
  };
  const dA = ds(A, '--s1'), dB = ds(B, '--s2');
  makeChart($('#h2hTcChart'), {
    type: 'bar', data: { labels: tcs, datasets: [dA, dB] },
    options: {
      plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { label: c => { const r = c.dataset._rows[c.dataIndex]; return `${c.dataset.label}: ${c.parsed.y?.toFixed(1)}% (${r.n} games)`; } } } },
      scales: baseScales({ min: 0, max: 100, ticks: { callback: v => v + '%' } }),
    },
  });
}
