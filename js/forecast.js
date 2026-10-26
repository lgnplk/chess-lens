// Rating forecast: where your rating is likely to be after another N games in a time control. The method is simple
// and is tested on your own history before it is trusted:
//   - trend: the slope of your rating over recent games (weighted toward the latest: a game 50 back counts half),
//     assumed to fade by a factor φ per game. φ is whichever of a few (no trend, fading fast or slowly, lasting) would
//     have forecast your own past best, 10 to 200 games ahead.
//   - range: how far those back-forecasts actually missed at each distance (recent ones counting most: half as much
//     150 games further back), fitted as variance = c0 + c1·N, so the 50% and 90% ranges come from your own record
//     rather than an assumption.
// Needs 60+ rated games in the time control; more of your history (up to 1,000 games) is fetched when the loaded
// period holds fewer than 300.
const FC_MIN = 60, FC_HALF = 50, FC_PHIS = [0, 0.97, 0.99, 0.995, 1], FC_HORIZONS = [10, 25, 50, 100, 200];
const fc = { tc: null, n: 100, hist: {}, loading: null };

// your rating after each rated game of a time control, oldest first
function fcSeries(games, tc) {
  return games.filter(g => g.timeClass === tc && g.rated && g.me.rating).sort((a, b) => a.endTs - b.endTs).map(g => ({ r: g.me.rating, t: g.endTs }));
}

// weighted least-squares slope of r over the games up to `end` (inclusive)
function fcSlope(r, end) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = Math.max(0, end - 4 * FC_HALF); i <= end; i++) {
    const w = 0.5 ** ((end - i) / FC_HALF);
    sw += w; sx += w * i; sy += w * r[i]; sxx += w * i * i; sxy += w * i * r[i];
  }
  const d = sw * sxx - sx * sx;
  return d > 0 ? (sw * sxy - sx * sy) / d : 0;
}
// how much a per-game trend adds up to over h games when it fades by φ each game
const fcDamp = (phi, h) => (phi === 1 ? h : phi === 0 ? 0 : (phi * (1 - phi ** h)) / (1 - phi));

// back-forecasts from earlier points in your history: the best φ, and how far they missed at each distance
function fcModel(r) {
  const n = r.length, start = FC_MIN / 2, hs = FC_HORIZONS.filter(h => h <= n - start - 10);
  if (!hs.length) return null;
  const slopes = r.map((_, t) => (t >= 20 ? fcSlope(r, t) : 0));
  const step = Math.max(1, Math.floor((n - start) / 200));
  // recent back-forecasts count most (half as much 150 games further back): today's form, not an old climb or slump
  const wOf = t => 0.5 ** ((n - 1 - t) / 150);
  const wmse = es => sum(es.map(([e, w]) => w * e * e)) / sum(es.map(([, w]) => w));
  let best = null;
  for (const phi of FC_PHIS) {
    const err = {};
    for (const h of hs) {
      const e = [];
      for (let t = start; t + h < n; t += step) e.push([r[t + h] - (r[t] + slopes[t] * fcDamp(phi, h)), wOf(t + h)]);
      err[h] = e;
    }
    const score = hs.reduce((s, h) => s + wmse(err[h]) / h, 0);
    if (!best || score < best.score) best = { phi, err, score };
  }
  // variance = c0 + c1·h, least squares over the tested distances (weighted by how much back-forecasting each had)
  const pts = hs.map(h => ({ h, v: wmse(best.err[h]), w: sum(best.err[h].map(([, w]) => w)) }));
  const W = sum(pts.map(p => p.w)), mh = sum(pts.map(p => p.w * p.h)) / W, mv = sum(pts.map(p => p.w * p.v)) / W;
  const sxx = sum(pts.map(p => p.w * (p.h - mh) ** 2));
  let c1 = sxx > 0 ? sum(pts.map(p => p.w * (p.h - mh) * (p.v - mv))) / sxx : mv / mh, c0 = mv - c1 * mh;
  if (c1 < 0) { c1 = 0; c0 = mv; }
  if (c0 < 0) { c0 = 0; c1 = sum(pts.map(p => p.w * p.v)) / sum(pts.map(p => p.w * p.h)); }
  // the miss that 9 in 10 back-forecasts stayed within, at 50 games ahead (or the nearest tested distance)
  const h50 = hs.reduce((a, h) => (Math.abs(h - 50) < Math.abs(a - 50) ? h : a), hs[0]);
  const abs = best.err[h50].map(([e, w]) => [Math.abs(e), w]).sort((a, b) => a[0] - b[0]), W90 = 0.9 * sum(abs.map(([, w]) => w));
  let acc = 0, within90 = abs.at(-1)[0];
  for (const [e, w] of abs) { acc += w; if (acc >= W90) { within90 = e; break; } }
  return { phi: best.phi, c0, c1, maxH: hs.at(-1), h50, within90, slope: slopes[n - 1] };
}

function fcForecast(r, m, x) {
  const mid = r.at(-1) + m.slope * fcDamp(m.phi, x), sd = Math.sqrt(m.c0 + m.c1 * x);
  return { mid, lo50: mid - 0.674 * sd, hi50: mid + 0.674 * sd, lo90: mid - 1.645 * sd, hi90: mid + 1.645 * sd };
}

// ---------- the card (Summary) ----------
async function renderForecast(el) {
  if (!el || !S.username) return;
  const counts = Object.fromEntries(['bullet', 'blitz', 'rapid', 'daily'].map(tc => [tc, fcSeries(S.games, tc).length]));
  const acct = tc => { const r = S.player?.stats?.['chess_' + tc]?.record; return r ? (r.win || 0) + (r.loss || 0) + (r.draw || 0) : 0; };
  const size = tc => Math.max(counts[tc], acct(tc));
  const tcs = Object.keys(counts).filter(tc => size(tc) >= FC_MIN);
  if (!tcs.length) { el.innerHTML = `<h3>Rating forecast</h3><p class="muted small">Needs ${FC_MIN}+ rated games in one time control.</p>`; return; }
  const hf = $('#fTime')?.value;
  fc.tc = tcs.includes(fc.tc) ? fc.tc : tcs.includes(hf) ? hf : tcs.reduce((a, b) => (size(a) >= size(b) ? a : b));
  const tc = fc.tc, key = `${S.username}|${tc}`;
  // more of your history when the loaded period is short
  if (!fc.hist[key]) {
    fc.hist[key] = { series: fcSeries(S.games, tc), fetched: false };
    if (counts[tc] < 300 && acct(tc) > counts[tc]) {
      fc.loading = key;
      loadSource({ kind: 'chesscom', user: S.username, tc, recent: 1000 }, m => { const s = $('.fc-load', el); if (s) s.textContent = String(m).replace(/<[^>]+>/g, ''); })
        .then(d => { const s = fcSeries(d.games, tc); if (s.length > fc.hist[key].series.length) fc.hist[key] = { series: s, fetched: true }; })
        .catch(() => {})
        .finally(() => { if (fc.loading === key) fc.loading = null; if (S.tab === 'overview' && $('#fcCard')) renderForecast($('#fcCard')); });
    }
  }
  const hist = fc.hist[key], series = hist.series, r = series.map(p => p.r);
  const head = `<div class="row-between"><div><h3>Rating forecast</h3><div class="sub">Where your rating is likely to be after more games: your recent trend, and how far forecasts like this missed on your own history</div></div>
    <div class="seg">${tcs.map(t => `<button data-fctc="${t}" class="${t === tc ? 'active' : ''}">${tcTitle(t)}</button>`).join('')}</div></div>`;
  if (fc.loading === key && r.length < 300) { el.innerHTML = `${head}<p class="muted small"><span class="fc-load">Fetching your ${tc} history…</span></p>`; fcBind(el); return; }
  const m = r.length >= FC_MIN ? fcModel(r) : null;
  if (!m) { el.innerHTML = `${head}<p class="muted small">Needs ${FC_MIN}+ rated ${tc} games (${r.length} found).</p>`; fcBind(el); return; }
  // pace: your games of this time control a day, over the last 30 days that had any
  const recent = series.filter(p => p.t >= series.at(-1).t - 30 * 86400), days = recent.length > 1 ? Math.max(1, (recent.at(-1).t - recent[0].t) / 86400) : null;
  const perDay = days ? recent.length / days : null;
  const fade = m.phi === 1 ? 'carrying on' : `fading by half every ~${Math.round(Math.log(0.5) / Math.log(m.phi))} games`;
  const trendTxt = m.phi === 0 ? 'Your past trends did not carry on, so the forecast is your current rating, with the range your history shows.'
    : `Trend ${m.slope >= 0 ? '+' : '−'}${Math.abs(m.slope).toFixed(2)} a game lately, ${fade} (what would have forecast your past best).`;
  el.innerHTML = `${head}
    <div class="fc-body">
      <div class="fc-main">
        <label class="fc-n">After <input type="range" id="fcN" min="10" max="500" step="10" value="${fc.n}"> <b id="fcNv">${fc.n}</b> more ${tc} games</label>
        <div class="fc-big"></div><div class="fc-range"></div><div class="muted small fc-when" style="margin-top:6px"></div>
      </div>
      <div class="chart-box fc-chart"><canvas id="fcChart"></canvas></div>
    </div>
    <p class="muted small" style="margin-top:10px">${trendTxt} Tested on your last ${r.length} ${tc} games${hist.fetched ? ' (fetched beyond the loaded period)' : ''}: ${m.h50} games ahead, 9 in 10 back-forecasts were within ±${Math.round(m.within90)}.<span class="fc-extra"></span></p>`;
  el._fc = { r, m, perDay, tc };
  fcBind(el);
  fcPaint(el);
}

// the parts that follow the slider: the forecast, its ranges, the date at your pace, the fan
function fcPaint(el) {
  const { r, m, perDay, tc } = el._fc, x = fc.n, f = fcForecast(r, m, x), R = v => Math.round(v);
  const when = perDay ? new Date(Date.now() + (x / perDay) * 86400000) : null;
  $('.fc-big', el).textContent = '≈ ' + R(f.mid);
  $('.fc-range', el).innerHTML = `likely <b>${R(f.lo50)}–${R(f.hi50)}</b> · 9 in 10: ${R(f.lo90)}–${R(f.hi90)}`;
  $('.fc-when', el).textContent = `Now ${r.at(-1)}${when ? ` · at your pace (${perDay >= 1 ? Math.round(perDay) : perDay.toFixed(1)} ${tc} games a day) that's around ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}`;
  $('.fc-extra', el).textContent = x > m.maxH ? ` Beyond ${m.maxH} games ahead the range is extrapolated.` : '';
  // the fan: the last 150 games, then the forecast with its 50% and 90% ranges
  const past = r.slice(-150).map((v, i, a) => ({ x: i - (a.length - 1), y: v }));
  const steps = Array.from({ length: 21 }, (_, i) => Math.round((x * i) / 20)), at = h => (h ? fcForecast(r, m, h) : { mid: r.at(-1), lo50: r.at(-1), hi50: r.at(-1), lo90: r.at(-1), hi90: r.at(-1) });
  const acc = cssVar('--accent'), ac = /^#[0-9a-f]{6}$/i.test(acc) ? acc : '#888888';
  const band = (k, a, label, fill) => ({ label, data: steps.map(h => ({ x: h, y: at(h)[k] })), borderWidth: 0, pointRadius: 0, backgroundColor: ac + a, fill });
  makeChart($('#fcChart', el), {
    type: 'line',
    data: { datasets: [
      { label: 'Your rating', data: past, borderColor: cssVar('--ink-2'), backgroundColor: cssVar('--ink-2'), borderWidth: 1.5, pointRadius: 0, tension: 0.15 },
      band('hi90', '22', '9 in 10', '+1'), band('lo90', '22', '', false),
      band('hi50', '44', 'Likely', '+1'), band('lo50', '44', '', false),
      { label: 'Forecast', data: steps.map(h => ({ x: h, y: at(h).mid })), borderColor: ac, backgroundColor: ac, borderWidth: 2, borderDash: [5, 4], pointRadius: 0 },
    ] },
    options: {
      scales: baseScales({}, { type: 'linear', title: { display: true, text: 'games from now' }, ticks: { callback: v => (v > 0 ? '+' + v : v) } }),
      plugins: {
        legend: { labels: { filter: i => i.text } },
        tooltip: { mode: 'index', intersect: false, filter: i => i.dataset.label,
          callbacks: { title: i => (i[0].parsed.x > 0 ? `${i[0].parsed.x} games from now` : i[0].parsed.x < 0 ? `${-i[0].parsed.x} games ago` : 'now'), label: i => `${i.dataset.label}: ${Math.round(i.parsed.y)}` } },
      },
    },
  });
}

function fcBind(el) {
  $$('[data-fctc]', el).forEach(b => b.onclick = () => { fc.tc = b.dataset.fctc; renderForecast(el); });
  const s = $('#fcN', el);
  if (s) s.oninput = () => { fc.n = +s.value; $('#fcNv', el).textContent = s.value; fcPaint(el); };
}
