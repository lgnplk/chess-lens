// Game sources for opening trees, comparisons and bots:
//   chess.com accounts, chess.com titled-player lists, Lichess accounts, and famous players'
//   OTB careers from PGN Mentor (relayed through serve.js because it blocks browser requests).
// Every source can be narrowed to one time control and the player's most recent N games of it.
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const SOURCE_CACHE = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

const sourceKey = src => JSON.stringify(src);
const tcName = tc => !tc || tc === 'all' ? '' : tc;
function sourceLabel(src) {
  const who = src.kind === 'otb' ? (src.famous ? src.name : `${src.name} (OTB)`) : src.kind === 'lichess' ? `${src.user} (Lichess)` : src.user;
  return tcName(src.tc) ? `${who} · ${src.tc}` : who;
}

// src:
//   { kind: 'chesscom', user, tc, recent }   most recent N games of a time control ('all' = any)
//   { kind: 'chesscom', user, months }        everything in the last N months (used for your own games)
//   { kind: 'lichess', user, tc, max }        { kind: 'otb', file, name, tc, recent }
// Resolves to { src, label, tc, games, player? }; label is the plain account/player name.
function loadSource(src, onStatus) {
  const key = sourceKey(src);
  if (SOURCE_CACHE.has(key)) return SOURCE_CACHE.get(key);
  const p = (async () => {
    if (src.kind === 'chesscom' && src.recent) return loadChesscomRecent(src, onStatus);
    if (src.kind === 'chesscom') {
      const d = await loadPlayerData(src.user, src.months, onStatus);
      return { src, label: d.player.profile.username || src.user, tc: 'all', games: d.games, player: d.player };
    }
    if (src.kind === 'lichess') return loadLichess(src, onStatus);
    if (src.kind === 'otb') return loadOtb(src, onStatus);
    throw new Error('Unknown source');
  })();
  SOURCE_CACHE.set(key, p);
  p.catch(() => SOURCE_CACHE.delete(key));
  return p;
}

// Walk back through the monthly archives until we have `recent` games of the chosen time control
async function loadChesscomRecent(src, onStatus) {
  const user = src.user.trim().toLowerCase(), tc = src.tc || 'all', n = src.recent;
  onStatus?.(`Looking up <b>${esc(user)}</b>…`);
  const player = await fetchPlayer(user).catch(e => { throw new Error(e.message === 'Not found' ? `No chess.com player named “${esc(user)}”.` : e.message); });
  const { archives } = await fetchJSON(`${API}/player/${user}/games/archives`);
  const raws = [];
  for (let i = archives.length - 1, months = 0; i >= 0 && months < (src.maxMonths || 60) && raws.length < n; i--, months++) {
    onStatus?.(`Downloading ${esc(user)}'s ${tcName(tc) || ''} games… ${raws.length} of ${n} found, ${months + 1} month${months ? 's' : ''} back`);
    const { games } = await fetchJSON(archives[i]).catch(() => ({ games: [] }));
    raws.push(...games.filter(g => g.rules === 'chess' && (tc === 'all' || g.time_class === tc)));
  }
  if (!raws.length) throw new Error(`${esc(user)} has no ${tcName(tc) || ''} games on chess.com.`);
  raws.sort((a, b) => b.end_time - a.end_time);
  const games = await processGames(raws.slice(0, n), user, (d, m) => onStatus?.(`Processing ${esc(user)}'s games… ${d}/${m}`));
  return { src, label: player.profile.username || user, tc, games, player };
}

const LICHESS_PERF = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'classical', daily: 'correspondence' };

async function loadLichess(src, onStatus) {
  const user = src.user.trim(), tc = src.tc || 'all';
  const perf = LICHESS_PERF[tc] ? `&perfType=${LICHESS_PERF[tc]}` : '';
  const r = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${src.max}&moves=true&opening=true&tags=true${perf}`, { headers: { Accept: 'application/x-chess-pgn' } });
  if (r.status === 404) throw new Error(`No Lichess player named “${esc(user)}”.`);
  if (r.status === 429) throw new Error('Lichess is rate-limiting requests — wait a minute and try again.');
  if (!r.ok) throw new Error(`Lichess returned HTTP ${r.status}`);
  // stream so we can show progress (Lichess exports ~20 games/second)
  const reader = r.body.getReader(), dec = new TextDecoder();
  let text = '', count = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    text += chunk;
    count += (chunk.match(/\[Event /g) || []).length;
    onStatus?.(`Downloading ${esc(user)}'s ${tcName(tc)} Lichess games… ${count} / up to ${src.max}`);
  }
  const pgns = splitPgns(text);
  if (!pgns.length) throw new Error(`${esc(user)} has no ${tcName(tc)} Lichess games.`);
  const games = await processPgnsInWorkers(pgns, { mode: 'exact', value: user.toLowerCase() }, 'lichess', (d, n) => onStatus?.(`Processing ${d}/${n} games…`));
  return { src, label: games[0]?.me.name || user, tc, games };
}

// A player's whole PGN Mentor collection is parsed once, then filtered per request
const OTB_BASE = new Map();
function loadOtbBase(src, onStatus) {
  if (!OTB_BASE.has(src.file)) {
    const p = (async () => {
      onStatus?.(`Downloading ${esc(src.name)}'s games from PGN Mentor…`);
      const r = await fetch(`relay/pgnmentor/players/${encodeURIComponent(src.file)}.zip`);
      if (!r.ok) throw new Error(r.status === 404 ? 'The game-database relay is unavailable — start the site with “node serve.js”.' : `PGN Mentor returned HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      await loadScript(JSZIP_URL);
      const zip = await JSZip.loadAsync(buf);
      const f = Object.values(zip.files).find(x => /\.pgn$/i.test(x.name));
      if (!f) throw new Error('No PGN inside the archive.');
      const pgns = splitPgns(await f.async('string'));
      const target = dominantName(pgns);
      return processPgnsInWorkers(pgns, { mode: 'surname', value: target }, 'otb', (d, n) => onStatus?.(`Processing ${esc(src.name)}'s games… ${d}/${n}`));
    })();
    OTB_BASE.set(src.file, p);
    p.catch(() => OTB_BASE.delete(src.file));
  }
  return OTB_BASE.get(src.file);
}

async function loadOtb(src, onStatus) {
  const tc = src.tc || 'all';
  let games = (await loadOtbBase(src, onStatus)).filter(g => tc === 'all' || g.timeClass === tc);
  if (src.recent) games = games.slice(0, src.recent);
  if (!games.length) throw new Error(`No ${tcName(tc)} games for ${esc(src.name)} in the database.`);
  return { src, label: src.name, tc, games };
}

// chess.com titled players (GM, IM, FM, CM, NM, WGM, WIM, WFM, WCM, WNM)
const TITLED = {};
function fetchTitled(title) {
  if (!TITLED[title]) TITLED[title] = fetchJSON(`${API}/titled/${title}`).then(j => j.players.sort()).catch(e => { delete TITLED[title]; throw e; });
  return TITLED[title];
}

// PGN Mentor player index: [{ file, name, count }]
let _otbIndex = null;
function fetchOtbIndex() {
  if (_otbIndex) return _otbIndex;
  _otbIndex = fetch('relay/pgnmentor/files.html').then(r => {
    if (!r.ok) throw new Error('relay unavailable');
    return r.text();
  }).then(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [], seen = new Set();
    for (const tr of doc.querySelectorAll('tr')) {
      const a = tr.querySelector('a[href^="players/"][href$=".zip"]');
      const tds = tr.querySelectorAll('td');
      if (!a || tds.length < 2) continue;
      const file = a.getAttribute('href').slice(8, -4);
      if (seen.has(file)) continue;
      const m = tds[1].textContent.trim().match(/^(.*),\s*([\d,]+)\s+games/);
      if (!m) continue;
      seen.add(file);
      out.push({ file, name: m[1].trim(), count: +m[2].replace(/,/g, '') });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }).catch(e => { _otbIndex = null; throw e; });
  return _otbIndex;
}

// Your own games as a source: reuse what's loaded when no time control is picked
function mySource(pick) {
  return !pick.tc || pick.tc === 'all' ? { kind: 'chesscom', user: S.username, months: S.months }
    : { kind: 'chesscom', user: S.username, tc: pick.tc, recent: pick.recent || 100 };
}

// ---------- picker UI (Prepare, Head to head, Player bot, Bot match) ----------
// opts.kinds limits the choices; calls onPick(src) when the user presses the button.
const TITLES = ['GM', 'IM', 'FM', 'WGM', 'WIM', 'CM', 'NM', 'WFM'];
const PICK_TCS = {
  chesscom: ['all', 'rapid', 'blitz', 'bullet', 'daily'],
  titled: ['all', 'rapid', 'blitz', 'bullet', 'daily'],
  lichess: ['all', 'rapid', 'blitz', 'bullet', 'classical', 'daily'],
  otb: ['all', 'classical', 'rapid', 'blitz'],
};
const PICK_RECENT = { chesscom: [50, 100, 200, 500], titled: [50, 100, 200, 500], lichess: [100, 300, 600, 1000], otb: [100, 300, 1000, 0] };

function sourcePickerHtml(id, state, { kinds = ['chesscom', 'titled', 'lichess', 'otb'], button = 'Load' } = {}) {
  const label = { chesscom: 'chess.com player', titled: 'Titled player (chess.com)', lichess: 'Lichess player', otb: 'Famous player (OTB database)' };
  return `<div class="src-picker" id="${id}">
    <select class="sp-kind">${kinds.map(k => `<option value="${k}" ${state.kind === k ? 'selected' : ''}>${label[k]}</option>`).join('')}</select>
    <span class="sp-fields"></span>
    <button class="btn primary sp-go">${button}</button>
  </div>`;
}

function bindSourcePicker(root, state, onPick) {
  const kindSel = $('.sp-kind', root), fields = $('.sp-fields', root);
  state.tc ??= 'all'; state.recent ??= 100;
  // time control + "most recent N" selectors, shared by every kind
  const tcRecent = k => {
    const recents = PICK_RECENT[k];
    const cur = k === 'lichess' ? (state.max || 300) : state.recent;
    return `<select class="sp-tc" title="Only this time control">${PICK_TCS[k].map(t => `<option value="${t}" ${state.tc === t ? 'selected' : ''}>${t === 'all' ? 'Any time control' : t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>
      <select class="sp-recent" title="How many of their most recent games">${recents.map(n => `<option value="${n}" ${+cur === n ? 'selected' : ''}>${n ? `Last ${n} games` : 'All games'}</option>`).join('')}</select>`;
  };
  const draw = async () => {
    state.kind = kindSel.value;
    const k = state.kind;
    if (k === 'chesscom') {
      fields.innerHTML = `<input class="sp-user" placeholder="chess.com username" value="${esc(state.user || '')}" spellcheck="false">${tcRecent(k)}`;
    } else if (k === 'titled') {
      fields.innerHTML = `<select class="sp-title">${TITLES.map(t => `<option ${state.title === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <input class="sp-user" list="${root.id}-titled" placeholder="Loading list…" value="${esc(state.titledUser || '')}" spellcheck="false"><datalist id="${root.id}-titled"></datalist>${tcRecent(k)}`;
      const fill = async () => {
        const t = $('.sp-title', fields).value; state.title = t;
        const inp = $('.sp-user', fields);
        try {
          const list = await fetchTitled(t);
          $(`#${root.id}-titled`).innerHTML = list.map(u => `<option value="${esc(u)}">`).join('');
          inp.placeholder = `Search ${list.length} ${t}s`;
        } catch { inp.placeholder = 'Could not load the list — type a username'; }
      };
      $('.sp-title', fields).onchange = fill;
      fill();
    } else if (k === 'lichess') {
      fields.innerHTML = `<input class="sp-user" placeholder="Lichess username (e.g. DrNykterstein)" value="${esc(state.lichessUser || '')}" spellcheck="false">${tcRecent(k)}`;
    } else if (k === 'otb') {
      fields.innerHTML = `<input class="sp-user" list="${root.id}-otb" placeholder="Loading players…" value="${esc(state.otbName || '')}" spellcheck="false"><datalist id="${root.id}-otb"></datalist>${tcRecent(k)}`;
      try {
        const idx = await fetchOtbIndex();
        $(`#${root.id}-otb`).innerHTML = idx.map(p => `<option value="${esc(p.name)}">${p.count} games</option>`).join('');
        $('.sp-user', fields).placeholder = `Search ${idx.length} players (Carlsen, Kasparov, Fischer…)`;
      } catch { $('.sp-user', fields).placeholder = 'Database relay unavailable — run node serve.js'; }
    }
  };
  kindSel.onchange = draw;
  draw();
  $('.sp-go', root).onclick = async () => {
    const k = state.kind, user = $('.sp-user', fields)?.value.trim();
    if (!user) return;
    const tc = $('.sp-tc', fields).value, recent = +$('.sp-recent', fields).value;
    state.tc = tc;
    if (k === 'chesscom' || k === 'titled') {
      if (k === 'chesscom') state.user = user; else state.titledUser = user;
      state.recent = recent;
      onPick({ kind: 'chesscom', user: user.toLowerCase(), tc, recent });
    } else if (k === 'lichess') { state.lichessUser = user; state.max = recent; onPick({ kind: 'lichess', user, tc, max: recent }); }
    else if (k === 'otb') {
      const idx = await fetchOtbIndex().catch(() => []);
      const p = idx.find(x => x.name.toLowerCase() === user.toLowerCase()) || idx.find(x => x.name.toLowerCase().includes(user.toLowerCase()));
      if (!p) { alert('No player by that name in the database.'); return; }
      state.otbName = p.name; state.recent = recent;
      onPick({ kind: 'otb', file: p.file, name: p.name, tc, recent });
    }
  };
}
