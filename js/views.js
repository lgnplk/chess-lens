// Tab renderers. Each takes the section element and the filtered game list.

const tile = (label, value, note = '') => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
const signed = x => x == null ? '–' : (x >= 0 ? '+' : '−') + pct(Math.abs(x), 1);
const tcLabel = g => g.timeClass === 'daily' || !g.base ? (g.timeClass || '') : `${g.timeClass} ${g.base >= 60 ? g.base / 60 : g.base + 's'}${g.inc ? '+' + g.inc : ''}`;
const resBadge = r => `<span class="res ${r}">${r === 'win' ? 'W' : r === 'draw' ? 'D' : 'L'}</span>`;
const wdlLegend = `<div class="legend"><span><i style="background:var(--good)"></i>Win</span><span><i style="background:var(--neutral)"></i>Draw</span><span><i style="background:var(--critical)"></i>Loss</span></div>`;
const empty = msg => `<div class="card"><p class="muted">${msg}</p></div>`;

// ---------------- Overview ----------------
// Summary's time control picker: the header's filter, where the summary is read (counts honour colour and rated)
// loaded games under the colour and rated filters (the time control is chosen separately)
function filterBase() {
  const fc = $('#fColor').value, fr = $('#fRated').value;
  return S.games.filter(g => (fc === 'all' || g.color === fc) && (fr === 'all' || g.rated));
}
const TC_ORDER = ['all', 'bullet', 'blitz', 'rapid', 'daily'];
function ovTcPicker() {
  const cur = $('#fTime').value, base = filterBase();
  const opts = TC_ORDER.map(tc => [tc, tc === 'all' ? base.length : base.filter(g => g.timeClass === tc).length]).filter(([tc, n]) => tc === 'all' || n || tc === cur);
  return `<div class="row-between ov-tc"><div class="seg">${opts.map(([tc, n]) => `<button data-ov-tc="${tc}" class="${tc === cur ? 'active' : ''}">${tc === 'all' ? 'All' : tcTitle(tc)} <span class="seg-n">${n}</span></button>`).join('')}</div></div>`;
}
const bindOvTc = sec => $$('[data-ov-tc]', sec).forEach(b => b.onclick = () => { const f = $('#fTime'); f.value = b.dataset.ovTc; f.dispatchEvent(new Event('change')); });

function renderOverview(sec, games) {
  if (!games.length) { sec.innerHTML = ovTcPicker() + empty('No games match these filters.'); bindOvTc(sec); return; }
  const ov = computeOverview(games);
  const a = ov.all;
  const accs = games.map(g => g.ccAccuracy?.me).filter(x => x != null);
  const st = ov.streak;
  sec.innerHTML = `${ovTcPicker()}
    <div class="tiles">
      ${tile('Games', a.n, `${a.w}W · ${a.d}D · ${a.l}L`)}
      ${tile('Score', pct(a.score, 1), `${signed(a.over)} vs rating expectation`)}
      ${tile('Performance rating', a.perf ?? '–', `avg opponent ${Math.round(mean(games.map(g => g.opp.rating)))}`)}
      ${tile('As White', pct(ov.byColor.white.score), `${ov.byColor.white.n} games`)}
      ${tile('As Black', pct(ov.byColor.black.score), `${ov.byColor.black.n} games`)}
      ${tile('chess.com accuracy', accs.length ? num(mean(accs), 1) + '%' : '–', accs.length ? `from ${accs.length} reviewed games` : 'run Engine scan for your own')}
      ${tile('Current streak', `${st.n} ${st.type === 'win' ? 'W' : st.type === 'loss' ? 'L' : 'D'}`, 'most recent games')}
    </div>
    <div class="grid cols-2">
      <div class="card"><h3>Rating over time</h3><div class="sub">By time control</div><div class="chart-box tall"><canvas id="ovRating"></canvas></div></div>
      <div class="card"><h3>Results by time control</h3><div class="sub">Score vs rating expectation</div>
        ${wdlLegend}
        <div class="table-wrap"><table><thead><tr><th>Time control</th><th class="num">Games</th><th>W / D / L</th><th class="num">Score</th><th class="num">vs exp.</th><th class="num">Perf.</th></tr></thead><tbody>
        ${ov.byTime.map(t => `<tr><td><span class="dot" style="background:var(${TC_SLOT[t.tc]});border:none"></span> ${t.tc}</td><td class="num">${t.n}</td><td>${wdlBar(t)}</td><td class="num">${pct(t.score, 1)}</td><td class="num">${signed(t.over)}</td><td class="num">${t.perf}</td></tr>`).join('')}
        </tbody></table></div>
        <h3 style="margin-top:16px">By color</h3>
        <div class="table-wrap"><table><tbody>
        ${['white', 'black'].map(c => { const r = ov.byColor[c]; return `<tr><td><span class="dot ${c}"></span> ${c}</td><td class="num">${r.n}</td><td>${wdlBar(r)}</td><td class="num">${pct(r.score, 1)}</td><td class="num">${signed(r.over)}</td></tr>`; }).join('')}
        </tbody></table></div>
      </div>
      <div class="card"><h3>How your games end</h3><div class="chart-box"><canvas id="ovTerm"></canvas></div></div>
      <div class="card"><h3>Monthly score</h3><div class="sub">Faded: under 5 games</div><div class="chart-box"><canvas id="ovMonth"></canvas></div></div>
    </div>
    ${(() => { const hl = computeHighlights(games); S._hl = hl; return hl.length ? `<h2 class="h2h-section">Highlights</h2><div class="highlights">${hl.map((h, i) => `<button class="highlight" data-hl="${i}" ${h.game ? '' : 'disabled'}><span class="hl-title">${h.title}</span><span class="hl-value">${esc(h.value)}</span><span class="hl-detail">${esc(h.detail)}</span></button>`).join('')}</div>` : ''; })()}`;

  $$('[data-hl]', sec).forEach(b => b.onclick = () => { const h = S._hl[+b.dataset.hl]; if (h?.game) openReview(h.game); });
  bindOvTc(sec);

  // rating chart
  const asc = [...games].sort((x, y) => x.endTs - y.endTs);
  const datasets = Object.keys(TC_SLOT).map(tc => {
    const pts = asc.filter(g => g.timeClass === tc && g.rated).map(g => ({ x: g.endTs * 1000, y: g.me.rating }));
    return pts.length ? { label: tc, data: pts, borderColor: cssVar(TC_SLOT[tc]), backgroundColor: cssVar(TC_SLOT[tc]), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.2 } : null;
  }).filter(Boolean);
  makeChart($('#ovRating'), {
    type: 'line', data: { datasets },
    options: {
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: datasets.length > 1, position: 'top', align: 'start' }, tooltip: { callbacks: { title: it => fmtDate(new Date(it[0].parsed.x)) } } },
      scales: baseScales({}, { type: 'linear', ticks: { callback: v => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), maxTicksLimit: 8 } }),
    },
  });

  // termination chart
  const labels = [...new Set([...Object.keys(ov.reasons.win), ...Object.keys(ov.reasons.loss)])];
  labels.sort((x, y) => ((ov.reasons.win[y] || 0) + (ov.reasons.loss[y] || 0)) - ((ov.reasons.win[x] || 0) + (ov.reasons.loss[x] || 0)));
  makeChart($('#ovTerm'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Wins', data: labels.map(l => ov.reasons.win[l] || 0), backgroundColor: cssVar('--good'), borderRadius: 2, maxBarThickness: 18 },
      { label: 'Losses', data: labels.map(l => ov.reasons.loss[l] || 0), backgroundColor: cssVar('--critical'), borderRadius: 2, maxBarThickness: 18 },
    ] },
    options: { indexAxis: 'y', plugins: { legend: { position: 'top', align: 'start' } }, scales: { x: { grid: { color: cssVar('--grid') }, border: { display: false } }, y: { grid: { display: false } } } },
  });
  const an = computeAnalytics(games);
  scoreBarChart($('#ovMonth'), an.byMonth);
}

// ---------------- Games list ----------------
const gamesState = { q: '', page: 0, sort: 'date', dir: -1 };
function renderGames(sec, games) {
  const per = 50;
  const q = gamesState.q.toLowerCase();
  let list = games.filter(g => !q || g.opp.name.toLowerCase().includes(q) || g.opening.toLowerCase().includes(q) || g.eco.toLowerCase().includes(q));
  const keyFns = { date: g => g.endTs, opp: g => g.opp.rating, me: g => g.me.rating, moves: g => g.moves, acc: g => g.ccAccuracy?.me ?? -1, opening: g => g.opening };
  const kf = keyFns[gamesState.sort];
  list = [...list].sort((a, b) => { const x = kf(a), y = kf(b); return (x < y ? -1 : x > y ? 1 : 0) * gamesState.dir; });
  const pages = Math.max(1, Math.ceil(list.length / per));
  gamesState.page = Math.min(gamesState.page, pages - 1);
  const rows = list.slice(gamesState.page * per, gamesState.page * per + per);
  const th = (k, label, cls = '') => `<th class="${cls}" data-sort="${k}">${label}${gamesState.sort === k ? (gamesState.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  sec.innerHTML = `<div class="card">
    <div class="table-tools"><input id="gq" placeholder="Search opponent or opening" value="${esc(gamesState.q)}"><span class="muted">${list.length} games · click a row to review it</span></div>
    <div class="table-wrap"><table>
      <thead><tr>${th('date', 'Date')}<th></th><th>Result</th>${th('opp', 'Opponent')}${th('me', 'You', 'num')}<th>Time</th>${th('opening', 'Opening')}${th('moves', 'Moves', 'num')}<th>Ended by</th>${th('acc', 'Accuracy', 'num')}</tr></thead>
      <tbody>${rows.map(g => `<tr class="clickable" data-id="${esc(g.id)}">
        <td>${fmtDate(g.end)}</td><td><span class="dot ${g.color}" title="${g.color}"></span></td><td>${resBadge(g.result)}</td>
        <td>${esc(g.opp.name)} <span class="muted">(${g.opp.rating})</span></td><td class="num">${g.me.rating}</td>
        <td><span class="pill">${tcLabel(g)}</span></td>
        <td title="${esc(g.opening)}">${esc(g.opening.length > 38 ? g.opening.slice(0, 36) + '…' : g.opening)}</td>
        <td class="num">${g.moves}</td><td>${REASON_LABEL[g.reason] || g.reason}</td>
        <td class="num">${g.ccAccuracy ? num(g.ccAccuracy.me, 1) + ' / ' + num(g.ccAccuracy.opp, 1) : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="pager"><button class="btn" id="gprev" ${gamesState.page === 0 ? 'disabled' : ''}>Prev</button><span class="muted">Page ${gamesState.page + 1} / ${pages}</span><button class="btn" id="gnext" ${gamesState.page >= pages - 1 ? 'disabled' : ''}>Next</button></div>
  </div>`;
  const inp = $('#gq', sec);
  inp.addEventListener('input', () => { gamesState.q = inp.value; gamesState.page = 0; renderGames(sec, games); const i = $('#gq', sec); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
  $$('th[data-sort]', sec).forEach(t => t.addEventListener('click', () => { const k = t.dataset.sort; gamesState.dir = gamesState.sort === k ? -gamesState.dir : -1; gamesState.sort = k; renderGames(sec, games); }));
  $('#gprev', sec).onclick = () => { gamesState.page--; renderGames(sec, games); };
  $('#gnext', sec).onclick = () => { gamesState.page++; renderGames(sec, games); };
  $$('tr[data-id]', sec).forEach(tr => tr.addEventListener('click', () => openReview(S.games.find(g => g.id === tr.dataset.id))));
}

// ---------------- Openings ----------------
// Always split by color: each opening gets one row, with As White beside As Black
const openState = { key: 'family', min: 3 };
function renderOpenings(sec, games) {
  if (!games.length) { sec.innerHTML = empty('No games match these filters.'); return; }
  const rows = computeOpenings(games, openState.key);
  const pairs = [...groupBy(rows, r => r.name)]
    .map(([name, rs]) => { const white = rs.find(r => r.color === 'white'), black = rs.find(r => r.color === 'black'); return { name, white, black, n: (white?.n || 0) + (black?.n || 0) }; })
    .filter(p => p.n >= openState.min).sort((a, b) => b.n - a.n);
  const rep = computeRepertoire(games);
  const narrow = (sec.clientWidth || innerWidth) < 600; // phones: drop the W/D/L bars so both colors fit side by side
  const cols = narrow ? 3 : 4;
  const overCol = r => r.n < 5 ? 'inherit' : r.over >= 0.05 ? 'var(--good-text)' : r.over <= -0.05 ? 'var(--critical)' : 'inherit';
  const side = r => !r ? `<td class="num muted g0">–</td>${'<td></td>'.repeat(cols - 1)}`
    : `<td class="num g0 ${r.n < 3 ? 'thin' : ''}">${r.n}</td>${narrow ? '' : `<td class="${r.n < 3 ? 'thin' : ''}">${wdlBar(r)}</td>`}<td class="num ${r.n < 3 ? 'thin' : ''}">${pct(r.score)}</td><td class="num ${r.n < 3 ? 'thin' : ''}" style="color:${overCol(r)}">${narrow ? (r.over >= 0 ? "+" : "−") + pct(Math.abs(r.over)) : signed(r.over)}</td>`;
  const sideHead = c => `<th class="num g0">${colorDot(c)} ${narrow ? 'N' : 'Games'}</th>${narrow ? '' : '<th>W / D / L</th>'}<th class="num">Score</th><th class="num">${narrow ? '±' : 'vs exp.'}</th>`;
  const repTable = (title, rs, prefix = '') => `<div class="card"><h3>${title}</h3><div class="table-wrap"><table><thead><tr><th>Move</th><th class="num">Games</th><th>W / D / L</th><th class="num">Score</th><th class="num">vs exp.</th></tr></thead><tbody>
    ${rs.slice(0, 8).map(r => `<tr><td><b>${prefix}${esc(r.name)}</b></td><td class="num">${r.n}</td><td>${wdlBar(r)}</td><td class="num">${pct(r.score)}</td><td class="num">${signed(r.over)}</td></tr>`).join('') || '<tr><td class="muted" colspan="5">No games</td></tr>'}
    </tbody></table></div></div>`;
  sec.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="row-between">
        <div><h3>Openings</h3><div class="sub">${narrow ? '±' : 'vs exp.'} = score minus what the ratings predicted</div></div>
        <div class="table-tools" style="margin:0">
          <select id="oKey"><option value="family">Family</option><option value="opening">Variation</option><option value="eco">ECO</option></select>
          <select id="oMin"><option value="1">All</option><option value="3">3+ games</option><option value="5">5+ games</option><option value="10">10+ games</option></select>
        </div>
      </div>
      ${narrow ? '' : wdlLegend}
      <div class="table-wrap" style="max-height:520px;overflow-y:auto"><table class="op-pair"><thead>
        <tr class="grp"><th></th><th colspan="${cols}" class="g0">${colorDot('white')} As White</th><th colspan="${cols}" class="g0">${colorDot('black')} As Black</th></tr>
        <tr><th>Opening</th>${sideHead('white')}${sideHead('black')}</tr></thead>
        <tbody>${pairs.map(p => `<tr><td title="${esc(p.name)}">${esc(p.name.length > 44 ? p.name.slice(0, 42) + '…' : p.name)}</td>${side(p.white)}${side(p.black)}</tr>`).join('') || '<tr><td class="muted" colspan="${1 + 2 * cols}">No openings with enough games</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card"><h3>${colorDot('white')} As White</h3><div class="sub">vs expected · 5+ games</div><div class="chart-box tall" id="oWhiteBox"><canvas id="oWhite"></canvas></div></div>
      <div class="card"><h3>${colorDot('black')} As Black</h3><div class="sub">vs expected · 5+ games</div><div class="chart-box tall" id="oBlackBox"><canvas id="oBlack"></canvas></div></div>
    </div>
    <div class="grid cols-3">
      ${repTable(`${colorDot('white')} First move`, rep.white, '1.')}
      ${repTable(`${colorDot('black')} vs 1.e4`, rep.vsE4, '1...')}
      ${repTable(`${colorDot('black')} vs 1.d4`, rep.vsD4, '1...')}
    </div>`;
  $('#oKey', sec).value = openState.key; $('#oMin', sec).value = openState.min;
  $('#oKey', sec).onchange = e => { openState.key = e.target.value; renderOpenings(sec, games); };
  $('#oMin', sec).onchange = e => { openState.min = +e.target.value; renderOpenings(sec, games); };

  const overChart = color => {
    const top = rows.filter(r => r.color === color && r.n >= 5).slice(0, 12).sort((a, b) => b.over - a.over);
    const box = $(`#o${colorName(color)}Box`, sec);
    if (!top.length) { box.classList.remove('tall'); box.style.height = 'auto'; box.innerHTML = `<p class="muted small">No ${colorName(color)} opening with 5+ games yet.</p>`; return; }
    box.style.height = Math.max(140, 48 + top.length * 24) + 'px';
    makeChart($(`#o${colorName(color)}`, sec), {
      type: 'bar',
      data: { labels: top.map(r => r.name.length > 28 ? r.name.slice(0, 26) + '…' : r.name), datasets: [{
        label: 'vs expectation', data: top.map(r => r.over * 100),
        backgroundColor: top.map(r => r.over >= 0 ? cssVar('--s1') : cssVar('--s2')), borderRadius: 2, maxBarThickness: 18,
      }] },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => { const r = top[c.dataIndex]; return [`${signed(r.over)} vs expected`, `${pct(r.score)} in ${r.n} games as ${colorName(color)}`]; } } } },
        scales: { x: { grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { callback: v => (v > 0 ? '+' : '') + v + '%' } }, y: { grid: { display: false } } },
      },
    });
  };
  overChart('white');
  overChart('black');
}

// ---------------- Playstyle ----------------
// Shared engine-scan controls (used by the Engine scan and Playstyle tabs)
function scanControls(title, sub) {
  return `<div class="card scan-bar"><div class="row-between">
      <div><h3>${title}</h3><div class="sub">${sub}</div></div>
      <div class="scan-opts">
        ${scanTcSelect()}
        <select class="scan-n" title="Games">${SCAN_SIZES.map(n => `<option value="${n}" ${n === scanState.n ? 'selected' : ''}>${n ? `${n} games` : 'All games'}</option>`).join('')}</select>
        <select class="scan-d" title="Stockfish depth">${[8, 10, 12, 14].map(d => `<option value="${d}" ${d === scanState.depth ? 'selected' : ''}>Depth ${d}</option>`).join('')}</select>
        <button class="btn primary scan-go">${scanState.running ? 'Stop' : S.scanAgg ? 'Re-scan' : 'Scan'}</button>
      </div></div>
      <div class="muted small scan-est"></div>
      <div class="progress scan-prog ${scanState.running ? '' : 'hidden'}"><div></div></div><div class="muted small scan-msg"></div>
    </div>`;
}

// Which time control a scan covers: chosen in the scan bar, else whatever the header filter shows
const scanTc = () => scanState.tc || $('#fTime').value;
const scanPool = () => { const tc = scanTc(); return filterBase().filter(g => (tc === 'all' || g.timeClass === tc) && g.plies >= 10); };
const tcGames = tc => (tc === 'all' ? 'games' : `${tc} games`);
function scanTcSelect() {
  const base = filterBase().filter(g => g.plies >= 10), cur = scanTc();
  const opts = TC_ORDER.map(tc => [tc, tc === 'all' ? base.length : base.filter(g => g.timeClass === tc).length]).filter(([tc, n]) => tc === 'all' || n || tc === cur);
  return `<select class="scan-tc" title="Time control">${opts.map(([tc, n]) => `<option value="${tc}" ${tc === cur ? 'selected' : ''}>${tc === 'all' ? 'All time controls' : tcTitle(tc)} (${n})</option>`).join('')}</select>`;
}

// Scan sizes (0 = every loaded game) and a rough cost model: ms per position at each depth (top 3 lines)
const SCAN_SIZES = [10, 25, 50, 100, 200, 500, 1000, 0];
const SCAN_MS = { 8: 32, 10: 85, 12: 215, 14: 550 };
function scanEstimate(sec, games) {
  const el = $('.scan-est', sec);
  if (!el) return;
  const pool = games.filter(g => g.plies >= 10);
  const n = scanState.n ? Math.min(scanState.n, pool.length) : pool.length;
  const plies = mean(pool.slice(0, n).map(g => g.plies)) || 70;
  const mins = n * plies * SCAN_MS[scanState.depth] / analysisThreads() / ANALYSIS_SPEED / 60000;
  const t = mins < 1 ? 'under a minute' : mins < 90 ? `~${Math.round(mins)} min` : `~${(mins / 60).toFixed(1)} h`;
  const last = S.scanAgg && S.scanInfo ? ` · last scan: ${S.scanInfo.n} ${tcGames(S.scanInfo.tc)}, depth ${S.scanInfo.depth}` : '';
  el.innerHTML = `${n} ${tcGames(scanTc())} · ${t}${last}`;
}

// One row of the per-opportunity dot plot: 0–100% track, your 90% range, you, opponents, chance
function ciRow(label, help, me, opp, chance = null) {
  if (!me || !me.n) return `<tr><td><b>${label}</b><div class="muted small">${help}</div></td><td colspan="4" class="muted small">No opportunities in the scanned games yet</td></tr>`;
  const P = x => x == null ? null : Math.round(x * 1000) / 10;
  const low = me.n < 15;
  return `<tr>
    <td class="wrap"><b>${label}</b><div class="muted small">${help}</div></td>
    <td class="num"><b>${P(me.rate)}%</b><div class="muted small">${me.k} of ${me.n}${low ? ' · small sample' : ''}</div></td>
    <td class="num">${opp && opp.n ? `${P(opp.rate)}%<div class="muted small">of ${opp.n}</div>` : '–'}</td>
    <td class="num">${chance != null ? P(chance) + '%' : '–'}</td>
    <td style="min-width:180px"><div class="ci-track">
      <div class="ci-band" style="left:${P(me.ci[0])}%;width:${P(me.ci[1] - me.ci[0])}%"></div>
      ${chance != null ? `<div class="mk-exp" style="left:${P(chance)}%" title="By chance ${P(chance)}%"></div>` : ''}
      ${opp && opp.n ? `<div class="mk-opp" style="left:${P(opp.rate)}%" title="Opponents ${P(opp.rate)}%"></div>` : ''}
      <div class="mk-me" style="left:${P(me.rate)}%" title="You ${P(me.rate)}%"></div>
    </div></td></tr>`;
}

// Style fingerprint card: a title from the clearest traits vs your opponents, the evidence, and the famous
// players whose (identically measured) fingerprints are closest
function fingerprintCard(fp, nGames, nScan) {
  return `<div class="card fingerprint">
    <div class="fp-top">
      <div class="fp-main">
        <div class="sub">Style · ${nGames} games${nScan ? ` · ${nScan} scanned` : ''}</div>
        <div class="fp-title">${esc(fp.title)}</div>
        <div class="fp-traits">${fp.evidence.map(e => `<span class="trait-chip ${e.up ? 'up' : 'down'}">${e.up ? '▲' : '▼'} ${esc(e.label)}</span>`).join('') || '<span class="muted small">Nothing stands out yet.</span>'}</div>
      </div>
      <div class="fp-twin" id="fpTwin"></div>
    </div>
    ${fp.evidence.length ? `<ul class="fp-evidence">${fp.evidence.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul>` : ''}
    ${fp.hints.length ? `<p class="small muted" style="margin:6px 0 0">Possibly: ${fp.hints.map(esc).join('; ')}.</p>` : ''}
  </div>`;
}

async function fillTwins(fp, el) {
  if (!el) return;
  const profiles = await getFamousProfiles();
  const twins = profiles.length ? nearestFamous(fp.dims || {}, profiles) : [];
  if (!twins.length) { el.innerHTML = '<span class="muted small">Too few traits for a match.</span>'; return; }
  const f = id => FAMOUS.find(x => x.id === id);
  const [t, ...rest] = twins;
  el.innerHTML = `<div class="sub" style="margin:0 0 12px">Plays most like</div>
    <div class="twin">${avatarHtml({ name: t.name, hue: f(t.id)?.hue, size: 48, crown: /World Champion/.test(f(t.id)?.era || '') })}<div><b>${esc(t.name)}</b><div class="muted small">${t.match}% match</div></div></div>
    <div class="muted small" style="margin-top:6px">${rest.slice(0, 3).map(r => `${esc(r.name)} ${r.match}%`).join(' · ')}</div>`;
}

function renderPlaystyle(sec, games) {
  const hb = computeHabits(games);
  const prof = computeStyleProfile(S.scanAgg);
  const fp = styleTitle(styleDims({ ...(habitCounts(games) || {}), ...engineCounts(S.scanAgg?.style) }));
  let html = fingerprintCard(fp, games.length, S.scanAgg?.n)
    + '<div class="card" id="shapeCard" style="margin-bottom:14px"></div>'
    + scanControls('Engine scan', 'Adds accuracy, blunders and choices.');
  if (prof) {
    const me = prof.me, op = prof.op;
    const legend = '<div class="legend"><span><i class="lg-me"></i>You</span><span><i class="lg-band"></i>90% range</span><span><i class="lg-opp"></i>Opponents</span><span><i class="lg-exp"></i>Random good move</span></div>';
    html += `
    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card"><h3>Skill vs opponents</h3><div class="sub">${S.scanAgg.n} games · ${me.moves} moves</div>
        ${prof.sharpVsOpp ? `<p>You ${prof.sharpVsOpp.what} <b>${Math.abs(prof.sharpVsOpp.d).toFixed(0)} points ${prof.sharpVsOpp.d >= 0 ? 'more' : 'less'}</b> often than your opponents.</p>` : '<p class="muted small">Needs more scanned games.</p>'}
      </div>
      <div class="card"><h3>Brilliancies &amp; sacrifices</h3>
        <div class="tiles" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:8px">
          ${tile('Brilliant', me.brilliants, `opponents ${op.brilliants}`)}
          ${tile('Sound sacs taken', me.sacOpp.n ? pct(me.sacOpp.rate) : '–', `${me.sacOpp.n} chances · opp. ${op.sacOpp.n ? pct(op.sacOpp.rate) : '–'}`)}
          ${tile('Sacs that held', me.sacSound.n ? pct(me.sacSound.rate) : '–', `${me.sacSound.n} played · opp. ${op.sacSound.n ? pct(op.sacSound.rate) : '–'}`)}
        </div>
        ${S.scanAgg.brilliantMoves.length ? `<div class="small">${S.scanAgg.brilliantMoves.map((b, i) => `<span class="pill clickable-pill" data-bm="${i}">${Math.floor(b.ply / 2) + 1}${b.ply % 2 ? '...' : '.'}${b.san} vs ${esc(b.game.opp.name)}</span>`).join(' ')}</div>` : ''}
      </div>
    </div>
    <div class="card" style="margin-bottom:14px"><h3>Critical moments</h3>${legend}
      <div class="table-wrap"><table class="ci-table"><thead><tr><th></th><th class="num">You</th><th class="num">Opp.</th><th class="num">Chance</th><th></th></tr></thead><tbody>
        ${ciRow('Found the only move', 'Best move 10+ points ahead of the rest', me.critical, op.critical)}
        ${ciRow('…when hard to see', 'Engine needed depth 5+', me.criticalHard, op.criticalHard)}
        ${ciRow('Punished a mistake', 'Kept most of the gain', me.punish, op.punish)}
        ${ciRow('…when hard to see', 'Quiet refutation, depth 5+', me.punishHard, op.punishHard)}
        ${ciRow('Took a sound sac', 'A sacrifice was among the good moves', me.sacOpp, op.sacOpp)}
        ${ciRow('Sac held up', 'Cost under 5 points', me.sacSound, op.sacSound)}
      </tbody></table></div>
      <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Only move, by phase</th><th class="num">Opening</th><th class="num">Middlegame</th><th class="num">Endgame</th></tr></thead><tbody>
        ${[['You', me], ['Opponents', op]].map(([l, s]) => `<tr><td>${l}</td>${['opening', 'middlegame', 'endgame'].map(p => { const r = s.criticalByPhase[p]; return `<td class="num">${r.n ? pct(r.rate) + ` <span class="muted small">(${r.n})</span>` : '–'}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div>
    </div>
    <div class="card" style="margin-bottom:14px"><h3>Preferences</h3><div class="sub">Between equally good moves</div>${legend}
      <div class="table-wrap"><table class="ci-table"><thead><tr><th></th><th class="num">You</th><th class="num">Opp.</th><th class="num">Chance</th><th></th></tr></thead><tbody>
        ${ciRow('Forcing moves', 'Check or capture over a quiet move', me.forcing, op.forcing, me.forcing.expected)}
        ${ciRow('Trades', 'An equal trade over an alternative', me.trade, op.trade, me.trade.expected)}
        ${ciRow('Trades when ahead', 'Same, when clearly better', me.tradeAhead, op.tradeAhead, me.tradeAhead.expected)}
        ${ciRow('Pawn storms', 'Pawn push at the enemy king', me.storm, op.storm, me.storm.expected)}
      </tbody></table></div>
    </div>`;
  }
  if (hb) {
    html += `<div class="grid cols-2">
      <div class="card"><h3>Habits</h3><div class="sub">${hb.n} games, vs opponents in the same games</div>
        <div class="table-wrap"><table><thead><tr><th></th><th class="num">You</th><th class="num">Opp.</th><th class="num">Diff.</th></tr></thead><tbody>
        ${hb.rows.map(r => { const d = r.me - r.opp; return `<tr><td>${r.label}</td><td class="num">${r.fmt(r.me)}</td><td class="num">${r.fmt(r.opp)}</td><td class="num">${(d >= 0 ? '+' : '−') + r.fmt(Math.abs(d))}</td></tr>`; }).join('')}
        </tbody></table></div></div>
      <div class="card"><h3>Repertoire &amp; clock</h3>
        <div class="tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          ${tile('Opening families', hb.variety.families, `top one ${pct(hb.variety.top)} of games`)}
          ${tile('Variety', Math.round(hb.variety.index * 100) + ' / 100', '')}
          ${hb.clock ? tile('Time on moves 1–10', pct(hb.clock.openingShare), '') : ''}
          ${hb.clock ? tile('Time trouble', pct(hb.clock.trouble), `of games · opp. ${pct(hb.clock.oppTrouble)}`) : ''}
        </div></div>
    </div>`;
  }
  sec.innerHTML = html;
  fillTwins(fp, $('#fpTwin', sec));
  fillShapeCard($('#shapeCard', sec));
  bindScan(sec, games);
  $$('[data-bm]', sec).forEach(e => e.onclick = () => { const b = S.scanAgg.brilliantMoves[+e.dataset.bm]; openReview(b.game, b.ply + 1); });
}

// ---------------- Analytics ----------------
function renderAnalytics(sec, games) {
  if (games.length < 5) { sec.innerHTML = empty('Need at least 5 games for analytics.'); return; }
  const an = computeAnalytics(games);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const m = an.material;
  sec.innerHTML = `
    <div class="tiles">
      ${tile('Conversion', pct(m.ahead.score), `score after going +3 material (${m.ahead.n} games)`)}
      ${tile('Comebacks', pct(m.behind.score), `score after falling −3 material (${m.behind.n} games)`)}
      ${tile('Time-trouble games', an.timeTrouble.rate != null ? pct(an.timeTrouble.rate) : '–', an.timeTrouble.n ? `score ${pct(an.timeTrouble.score)} in them` : '')}
      ${tile('Timeouts while ahead', m.lostOnTimeAhead, 'losses on time up 2+ material')}
      ${tile('After 2 straight losses', pct(an.afterTwoLosses.score), `${an.afterTwoLosses.n} games · ${signed(an.afterTwoLosses.over)} vs exp.`)}
    </div>
    <div class="grid cols-2">
      <div class="card"><h3>Opponent strength</h3><div class="sub">Score vs expected, by rating gap</div><div class="chart-box"><canvas id="anDiff"></canvas></div></div>
      <div class="card"><h3>Tilt check</h3><div class="sub">Score after a win, draw or loss</div><div class="chart-box"><canvas id="anTilt"></canvas></div></div>
      <div class="card"><h3>Session fatigue</h3><div class="sub">Score by game in a session</div><div class="chart-box"><canvas id="anSession"></canvas></div></div>
      <div class="card"><h3>Game length</h3><div class="chart-box"><canvas id="anLen"></canvas></div></div>
      <div class="card"><h3>Time of day</h3><div class="chart-box"><canvas id="anHour"></canvas></div></div>
      <div class="card"><h3>Day of week</h3><div class="chart-box"><canvas id="anDay"></canvas></div></div>
      <div class="card"><h3>Clock usage</h3><div class="sub">% of clock left · wins vs losses</div><div class="chart-box"><canvas id="anClock"></canvas></div></div>
      <div class="card"><h3>When you play best</h3><div class="sub">Green above 50%, red below</div><div id="anHeat"></div>
        <div class="legend" style="margin-top:8px"><span><i style="background:var(--s2)"></i>0%</span><span><i style="background:var(--surface-2)"></i>50%</span><span><i style="background:var(--s1)"></i>100%</span></div></div>
    </div>`;
  scoreBarChart($('#anDiff'), an.diffBuckets, { expected: true });
  scoreBarChart($('#anTilt'), an.afterRes, { expected: false });
  scoreBarChart($('#anSession'), an.sessionBuckets);
  scoreBarChart($('#anLen'), an.lenBuckets);
  scoreBarChart($('#anHour'), an.byHour.map((r, h) => ({ ...r, label: String(h) })));
  scoreBarChart($('#anDay'), an.byDay.map((r, d) => ({ ...r, label: days[d] })));
  const labels = Array.from({ length: 60 }, (_, i) => i + 1);
  makeChart($('#anClock'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Wins', data: an.clock.win, borderColor: cssVar('--s1'), backgroundColor: cssVar('--s1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true },
      { label: 'Losses', data: an.clock.loss, borderColor: cssVar('--s2'), backgroundColor: cssVar('--s2'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true },
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { title: it => `Move ${it[0].label}`, label: c => `${c.dataset.label}: ${c.parsed.y?.toFixed(0)}% left` } } },
      scales: baseScales({ min: 0, max: 100, ticks: { callback: v => v + '%' } }, { ticks: { maxTicksLimit: 12 } }),
    },
  });
  // heatmap (diverging: red <- gray -> blue)
  const blue = cssVar('--s1'), red = cssVar('--s2');
  let h = '<div class="heat"><div></div>' + Array.from({ length: 24 }, (_, i) => `<div class="hl">${i % 3 === 0 ? i : ''}</div>`).join('');
  an.heat.forEach((row, d) => {
    h += `<div class="lab">${days[d]}</div>`;
    row.forEach((c, hr) => {
      if (!c.n) { h += `<div class="c" data-tip="${days[d]} ${hr}:00 — no games"></div>`; return; }
      const s = c.score, a = Math.min(1, Math.abs(s - 0.5) * 2) * Math.min(1, c.n / 6);
      const col = s >= 0.5 ? blue : red;
      h += `<div class="c" style="background:color-mix(in srgb, ${col} ${Math.round(a * 100)}%, var(--surface-2))" data-tip="${days[d]} ${hr}:00 — ${pct(s)} in ${c.n} games"></div>`;
    });
  });
  $('#anHeat').innerHTML = h + '</div>';
  bindTips($('#anHeat'));
}

function bindTips(root) {
  const tip = $('#tooltip');
  root.addEventListener('mousemove', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.classList.add('hidden'); return; }
    tip.textContent = t.dataset.tip; tip.classList.remove('hidden');
    tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY + 12) + 'px';
  });
  root.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

// ---------------- Engine scan ----------------
const scanState = { running: false, abort: false, n: 100, depth: 12, tc: null }; // tc null: follow the header filter
function renderScan(sec, games) {
  const agg = S.scanAgg;
  const ctrls = scanControls('Accuracy', 'Stockfish over your recent games.');
  if (!agg) { sec.innerHTML = ctrls + empty('No scan yet.'); bindScan(sec, games); return; }
  const t = agg.totals;
  sec.innerHTML = ctrls + `
    <div class="tiles">
      ${tile('Games scanned', agg.n, `${agg.nMoves} of your moves`)}
      ${tile('Your accuracy', num(agg.acc, 1) + '%', `opponents ${num(agg.oppAcc, 1)}%`)}
      ${tile('Avg centipawn loss', num(agg.acpl, 0))}
      ${tile('Blunders / game', num(t.blunder / agg.n, 2))}
      ${tile('Mistakes / game', num((t.mistake + t.miss) / agg.n, 2))}
      ${tile('Winning-position conversion', agg.conversion.n ? pct(agg.conversion.score) : '–', `${agg.conversion.n} games reached +3`)}
      ${tile('Saves from losing', agg.defense.n ? pct(agg.defense.score) : '–', `${agg.defense.n} games reached −3`)}
    </div>
    <div class="grid cols-2">
      <div class="card"><h3>Accuracy by game phase</h3><div class="chart-box"><canvas id="scPhase"></canvas></div>
        <div class="table-wrap"><table><thead><tr><th>Phase</th><th class="num">Moves</th><th class="num">Accuracy</th><th class="num">Inacc.</th><th class="num">Mistakes</th><th class="num">Blunders</th><th class="num">Errors / 100</th></tr></thead><tbody>
        ${agg.phaseStats.map(p => `<tr><td>${p.phase}</td><td class="num">${p.n}</td><td class="num">${num(p.acc, 1)}</td><td class="num">${p.inacc}</td><td class="num">${p.mistakes}</td><td class="num">${p.blunders}</td><td class="num">${num(p.errRate, 1)}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card"><h3>Accuracy under time pressure</h3><div class="sub">By clock left</div><div class="chart-box"><canvas id="scPress"></canvas></div></div>
      <div class="card"><h3>Accuracy per game</h3><div class="sub">Oldest → newest</div><div class="chart-box"><canvas id="scTrend"></canvas></div></div>
      <div class="card"><h3>Move quality</h3><div class="chart-box"><canvas id="scCls"></canvas></div></div>
      <div class="card"><h3>Accuracy by opening</h3><div class="table-wrap"><table><thead><tr><th>Opening</th><th class="num">Games</th><th class="num">Accuracy</th><th class="num">Score</th></tr></thead><tbody>
        ${agg.byOpening.map(o => `<tr><td>${colorDot(o.color)} ${esc(o.name)}</td><td class="num">${o.n}</td><td class="num">${num(o.acc, 1)}</td><td class="num">${pct(o.score)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><h3>Biggest blunders</h3><div class="table-wrap"><table><thead><tr><th>Game</th><th>Move</th><th>Best was</th><th class="num">Win % lost</th></tr></thead><tbody>
        ${agg.worstMoves.map((m, i) => `<tr class="clickable" data-wm="${i}"><td>vs ${esc(m.game.opp.name)} <span class="muted">${fmtDate(m.game.end)}</span></td><td>${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '...'} ${m.san}</td><td>${m.bestSan || ''}</td><td class="num">${num(m.loss, 0)}</td></tr>`).join('') || '<tr><td class="muted" colspan="4">No blunders found.</td></tr>'}
        </tbody></table></div></div>
    </div>`;
  bindScan(sec, games);
  makeChart($('#scPhase'), {
    type: 'bar',
    data: { labels: agg.phaseStats.map(p => p.phase), datasets: [{ label: 'Accuracy', data: agg.phaseStats.map(p => p.acc), backgroundColor: cssVar('--s1'), borderRadius: 2, maxBarThickness: 48 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y?.toFixed(1)}% accuracy (${agg.phaseStats[c.dataIndex].n} moves)` } } }, scales: baseScales({ min: 0, max: 100 }) },
  });
  makeChart($('#scPress'), {
    type: 'bar',
    data: { labels: agg.pressure.map(p => p.label), datasets: [{ label: 'Accuracy', data: agg.pressure.map(p => p.acc), backgroundColor: agg.pressure.map(p => p.n >= 20 ? cssVar('--s1') : cssVar('--s1') + '55'), borderRadius: 2, maxBarThickness: 48 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => { const p = agg.pressure[c.dataIndex]; return [`${c.parsed.y?.toFixed(1)}% accuracy`, `${p.n} moves · ${num(p.errRate, 1)} errors / 100`]; } } } }, scales: baseScales({ min: 0, max: 100 }) },
  });
  const pg = [...agg.perGame].sort((a, b) => a.game.endTs - b.game.endTs);
  makeChart($('#scTrend'), {
    type: 'line',
    data: { labels: pg.map(p => fmtDate(p.game.end)), datasets: [
      { label: 'You', data: pg.map(p => p.acc), borderColor: cssVar('--s1'), backgroundColor: cssVar('--s1'), borderWidth: 2, pointRadius: 4, pointHoverRadius: 6 },
      { label: 'Opponent', data: pg.map(p => p.oppAcc), borderColor: cssVar('--s2'), backgroundColor: cssVar('--s2'), borderWidth: 2, pointRadius: 4, pointHoverRadius: 6 },
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      onClick: (e, els) => { if (els.length) openReview(pg[els[0].index].game); },
      plugins: { legend: { position: 'top', align: 'start' }, tooltip: { callbacks: { afterTitle: it => { const g = pg[it[0].dataIndex].game; return `vs ${g.opp.name} — ${g.result}`; }, label: c => `${c.dataset.label}: ${c.parsed.y?.toFixed(1)}%` } } },
      scales: baseScales({ min: 0, max: 100 }, { ticks: { maxTicksLimit: 8 } }),
    },
  });
  const clsColors = { brilliant: '--s3', great: '--s1', best: '--good', excellent: '--good', good: '--good', book: '--neutral', forced: '--neutral', inaccuracy: '--warning', mistake: '--serious', miss: '--serious', blunder: '--critical' };
  makeChart($('#scCls'), {
    type: 'bar',
    data: { labels: CLS_ORDER.map(k => CLS[k].label), datasets: [{ label: 'Moves', data: CLS_ORDER.map(k => t[k]), backgroundColor: CLS_ORDER.map(k => cssVar(clsColors[k])), borderRadius: 2, maxBarThickness: 40 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y} moves (${pct(c.parsed.y / agg.nMoves, 1)})` } } }, scales: baseScales() },
  });
  $$('tr[data-wm]', sec).forEach(tr => tr.addEventListener('click', () => { const m = agg.worstMoves[+tr.dataset.wm]; openReview(m.game, m.ply + 1); }));
}

// (the scan's games come from scanPool(): the colour/rated filters plus the scan bar's time control)
function bindScan(sec) {
  $('.scan-tc', sec).onchange = e => { scanState.tc = e.target.value; scanEstimate(sec, scanPool()); };
  $('.scan-n', sec).onchange = e => { scanState.n = +e.target.value; scanEstimate(sec, scanPool()); };
  $('.scan-d', sec).onchange = e => { scanState.depth = +e.target.value; scanEstimate(sec, scanPool()); };
  $('.scan-go', sec).onclick = () => {
    if (scanState.running) { scanState.abort = true; return; }
    const pool = scanPool(), list = scanState.n ? pool.slice(0, scanState.n) : pool;
    S.scanInfo = { tc: scanTc(), n: list.length, depth: scanState.depth };
    runScan(list);
  };
  if (!scanState.running) scanEstimate(sec, scanPool());
}

async function runScan(list) {
  scanState.running = true; scanState.abort = false;
  renderTab(S.tab);
  const results = [];
  const ui = sel => $(`#tab-${S.tab} ${sel}`);
  const t0 = performance.now();
  let lastAgg = 0;
  await analyzeGamesParallel(list, scanState.depth, {
    shouldAbort: () => scanState.abort,
    onProgress: (f, done, threads) => {
      const bar = ui('.scan-prog > div'); if (bar) bar.style.width = (f * 100) + '%';
      const msg = ui('.scan-msg');
      if (msg) {
        const el = (performance.now() - t0) / 1000, left = f > 0.02 ? el / f - el : null;
        msg.textContent = `Analyzed ${done} of ${list.length} games on ${threads} engines${left != null ? ` · about ${left < 90 ? Math.round(left) + ' s' : Math.round(left / 60) + ' min'} left` : ''}…`;
      }
    },
    onResult: (g, a) => {
      results.push({ game: g, analysis: a });
      // re-aggregating is O(all moves), so do it every few seconds rather than after every game
      if (performance.now() - lastAgg > 3000) { S.scanAgg = aggregateScan(results); lastAgg = performance.now(); }
    },
  });
  if (results.length) S.scanAgg = aggregateScan(results);
  scanState.running = false;
  if (['scan', 'playstyle', 'blunders', 'report'].includes(S.tab)) renderTab(S.tab);
}

// ---------------- Report ----------------
function renderReport(sec, games) {
  if (games.length < 10) { sec.innerHTML = empty('Need at least 10 games to build a report. Load more history or relax the filters.'); return; }
  const F = computeReport(games, S.scanAgg);
  const s = F.filter(f => f.type === 'strength'), w = F.filter(f => f.type === 'weakness'), n = F.filter(f => f.type === 'note');
  const item = f => `<div class="finding ${f.type}"><div class="icon">${f.type === 'strength' ? '+' : f.type === 'weakness' ? '−' : 'i'}</div><div><b>${esc(f.title)}</b><div class="evidence">${esc(f.evidence)}</div>${f.tip ? `<div class="tip">→ ${esc(f.tip)}</div>` : ''}</div></div>`;
  const fpTitle = styleTitle(styleDims({ ...(habitCounts(games) || {}), ...engineCounts(S.scanAgg?.style) })).title;
  sec.innerHTML = `
    <div class="card" style="margin-bottom:14px"><div class="row-between"><div>
      <h3>Strengths &amp; weaknesses</h3>
      <div class="sub">${games.length} games${S.scanAgg ? ` · ${S.scanAgg.n} scanned` : ' · <a href="#" id="toScan">scan</a> for more'}</div></div>
      <div style="text-align:right"><div class="sub" style="margin:0">Style</div><b>${esc(fpTitle)}</b></div></div></div>
    <div class="grid cols-2">
      <div class="card"><h3>Strengths</h3>${s.map(item).join('') || '<p class="muted">No clear strengths stand out yet — more games will sharpen the picture.</p>'}</div>
      <div class="card"><h3>Weaknesses &amp; what to train</h3>${w.map(item).join('') || '<p class="muted">No significant weaknesses detected.</p>'}</div>
    </div>
    ${n.length ? `<div class="card" style="margin-top:14px"><h3>Other observations</h3>${n.map(item).join('')}</div>` : ''}`;
  const ts = $('#toScan', sec); if (ts) ts.onclick = e => { e.preventDefault(); switchTab('scan'); };
}
