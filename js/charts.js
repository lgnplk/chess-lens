// Chart.js wrappers that pull colors from CSS tokens so light/dark both work
const charts = {};
const TC_SLOT = { bullet: '--s1', blitz: '--s2', rapid: '--s3', daily: '--s4' };

function themeChartDefaults() {
  Chart.defaults.font.family = '"Source Sans 3", "Segoe UI", system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--grid');
  Object.assign(Chart.defaults.plugins.legend.labels, { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14 });
  Chart.defaults.plugins.legend.labels.color = cssVar('--ink-2');
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: cssVar('--surface'), titleColor: cssVar('--ink'), bodyColor: cssVar('--ink-2'),
    borderColor: cssVar('--border'), borderWidth: 1, padding: 8, cornerRadius: 2, displayColors: true, boxPadding: 4,
  });
}

// A chart whose canvas is still on the page is changed in place, so its values glide to their new positions.
// A new chart appears without the "grow from zero" animation: the canvas fades in instead.
const CHART_GLIDE = { duration: 260, easing: 'easeOutCubic' };
function makeChart(canvas, config) {
  const id = canvas.id || (canvas.id = 'c' + Math.random().toString(36).slice(2));
  const old = charts[id];
  const wantsAnim = config.options?.animation !== false;
  const options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: wantsAnim ? CHART_GLIDE : false }, config.options || {});
  if (wantsAnim) options.animation = CHART_GLIDE;
  if (old && old.canvas === canvas && old.config.type === config.type) {
    old.data = config.data;
    old.options = options;
    old.update();
    return old;
  }
  if (old) old.destroy();
  const ch = charts[id] = new Chart(canvas, { ...config, options: { ...options, animation: false } });
  if (wantsAnim) ch.options.animation = CHART_GLIDE;   // later changes glide
  canvas.classList.remove('chart-in'); void canvas.offsetWidth; canvas.classList.add('chart-in');
  return ch;
}

const baseScales = (yOpts = {}, xOpts = {}) => ({
  x: Object.assign({ grid: { display: false }, border: { color: cssVar('--axis') } }, xOpts),
  y: Object.assign({ grid: { color: cssVar('--grid') }, border: { display: false } }, yOpts),
});

// Bar of score% per bucket, with n in tooltip; bars fade when sample is tiny
function scoreBarChart(canvas, rows, { expected = false, color = cssVar('--s1') } = {}) {
  const datasets = [{
    label: 'Your score', data: rows.map(r => r.n ? r.score * 100 : null),
    backgroundColor: rows.map(r => r.n >= 5 ? color : color + '55'), borderRadius: 2, borderSkipped: 'bottom', maxBarThickness: 36,
  }];
  if (expected) datasets.push({
    label: 'Expected (from ratings)', data: rows.map(r => r.expected != null ? r.expected * 100 : null),
    backgroundColor: cssVar('--axis'), borderRadius: 2, borderSkipped: 'bottom', maxBarThickness: 36,
  });
  return makeChart(canvas, {
    type: 'bar',
    data: { labels: rows.map(r => r.label), datasets },
    options: {
      plugins: {
        legend: { display: expected, position: 'top', align: 'start' },
        tooltip: { callbacks: { afterBody: items => { const r = rows[items[0].dataIndex]; return r.n ? `${r.n} games · ${r.w}W ${r.d}D ${r.l}L` : 'No games'; }, label: c => `${c.dataset.label}: ${c.parsed.y?.toFixed(1)}%` } },
      },
      scales: baseScales({ min: 0, max: 100, ticks: { callback: v => v + '%' } }),
    },
  });
}

// Radar ("style shape"): series = [{ label, data, slot, dashed }] on a 0–100 scale
// rating: values are ratings (0–RATING_MAX), drawn with labelled rings every 1000
function radarChart(canvas, labels, series, { tooltip, rating = false } = {}) {
  // a missing value would be drawn at the centre, reading as 0: an axis the first series (you) lacks is left out
  // (tooltips keep the original index); another series missing one value just skips that point
  const keep = labels.map((_, i) => i).filter(i => series[0]?.data[i] != null);
  if (keep.length >= 3 && keep.length < labels.length) {
    labels = keep.map(i => labels[i]);
    series = series.map(s => ({ ...s, data: keep.map(i => s.data[i]) }));
    const t = tooltip;
    if (t) tooltip = c => t({ ...c, dataIndex: keep[c.dataIndex] });
  }
  const narrow = (canvas.parentElement?.clientWidth || 400) < 420;
  if (narrow) labels = labels.map(l => (l.includes(' ') ? l.split(' ') : l)); // two short lines leave the shape more room
  return makeChart(canvas, {
    type: 'radar',
    data: { labels, datasets: series.map(s => ({
      label: s.label, data: s.data, spanGaps: true,
      borderColor: s.dashed && !s.slot ? cssVar('--muted') : cssVar(s.slot), borderWidth: s.dashed ? 1.5 : 2.25, borderDash: s.dashed ? [4, 4] : [],
      backgroundColor: s.dashed ? 'transparent' : cssVar(s.slot) + '22',
      pointRadius: s.dashed ? 0 : 3, pointHoverRadius: 6, pointBackgroundColor: cssVar(s.slot || '--muted'),
      pointBorderColor: cssVar('--surface'), pointBorderWidth: 1.5,
    })) },
    options: {
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, font: { size: 13 } } },
        tooltip: { callbacks: { label: c => tooltip ? tooltip(c) : `${c.dataset.label}: ${Math.round(c.parsed.r)}` } },
      },
      // the middle ring is the median player, drawn a touch stronger
      scales: { r: { min: 0, max: rating ? RATING_MAX : 100,
        ticks: rating ? { stepSize: 500, z: 1, backdropColor: 'transparent', color: cssVar('--muted'), font: { size: 10.5 }, callback: v => (v && v % 1000 === 0 ? v : '') } : { display: false, stepSize: 25 },
        grid: { color: c => (!rating && c.tick?.value === 50 ? cssVar('--border-strong') : cssVar('--grid')) },
        angleLines: { color: cssVar('--grid') },
        pointLabels: { color: cssVar('--ink'), padding: 6, font: { size: narrow ? 11.5 : 13, weight: 600 } } } },
    },
  });
}

// Two players' score per bucket, side by side. rows* are statRow-like ({ label, n, score }) in the same order.
function groupedScoreChart(canvas, labels, rowsA, rowsB, nameA, nameB) {
  const ds = (rows, name, slot) => ({
    label: name, data: rows.map(r => r.n ? r.score * 100 : null), _rows: rows,
    backgroundColor: rows.map(r => r.n >= 5 ? cssVar(slot) : cssVar(slot) + '55'), borderRadius: 2, maxBarThickness: 28,
  });
  return makeChart(canvas, {
    type: 'bar',
    data: { labels, datasets: [ds(rowsA, nameA, '--s1'), ds(rowsB, nameB, '--s2')] },
    options: {
      plugins: {
        legend: { position: 'top', align: 'start' },
        tooltip: { callbacks: { label: c => { const r = c.dataset._rows[c.dataIndex]; return r.n ? `${c.dataset.label}: ${c.parsed.y.toFixed(1)}% (${r.n} games)` : `${c.dataset.label}: no games`; } } },
      },
      scales: baseScales({ min: 0, max: 100, ticks: { callback: v => v + '%' } }),
    },
  });
}
