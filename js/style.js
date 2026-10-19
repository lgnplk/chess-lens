// Style fingerprint: what a player does differently from their own opponents, built only from traits that
// are statistically clear, turned into a title, plain-language evidence, and the closest famous player.
//
// Every dimension is a pair of counts [k1, n1, k2, n2]: how often the player did X out of n1 chances,
// and how often their opponents did, in the same games. Comparing with the same games' opponents cancels
// out opponent strength and game type.

// Each side of a trait has an [adjective, noun] for titles: the strongest trait gives the noun, the next one
// the adjective ("Never-say-die speed player"). `say` completes "<p1> …, vs <p2> for their opponents".
const STYLE_DIMS = {
  sac:         { label: 'Sacrifices', engine: true, plus: ['Sacrificial', 'romantic'], minus: ['Materialistic', 'pragmatist'],
                 say: 'took a sound sacrifice when one was on the board' },
  forcing:     { label: 'Forcing moves', engine: true, plus: ['Forcing', 'attacker'], minus: ['Patient', 'maneuverer'],
                 say: 'chose a check or capture over an equally good quiet move' },
  trade:       { label: 'Trading pieces', engine: true, plus: ['Simplifying', 'technician'], minus: ['Tension-keeping', 'complicator'],
                 say: 'traded pieces when an equally good alternative existed' },
  storm:       { label: 'Pawn storms', engine: true, plus: ['Pawn-storming', 'king hunter'], minus: ['Restrained', 'strategist'],
                 say: 'pushed a pawn at the enemy king when that was as good as anything else' },
  checks:      { label: 'Checks', plus: ['Harassing', 'king hunter'], minus: ['Quiet', 'strategist'], say: 'of moves were checks' },
  captures:    { label: 'Captures', plus: ['Trigger-happy', 'tactician'], minus: ['Restrained', 'builder'], say: 'of moves were captures' },
  pawns:       { label: 'Pawn moves', plus: ['Space-grabbing', 'pawn roller'], minus: ['Piece-first', 'piece player'], say: 'of moves were pawn moves' },
  castleEarly: { label: 'Early castling', plus: ['Safety-first', 'classicist'], minus: ['Late-castling', 'flexible strategist'], say: 'of games castled by move 10' },
  castleLong:  { label: 'Queenside castling', plus: ['Opposite-side', 'brawler'], minus: ['Kingside-loyal', null], say: 'of castled games castled queenside' },
  earlyQueen:  { label: 'Early queen', plus: ['Early-queen', 'raider'], minus: ['Patient-developing', null], say: 'of games brought the queen out in the first 6 moves' },
  timeTrouble: { label: 'Time trouble', plus: ['Clock-burning', 'deep thinker'], minus: ['Clock-disciplined', 'practical player'], say: 'of games dropped below 10% of the clock' },
  clockLead:   { label: 'Playing speed', plus: ['Quick-handed', 'speed player'], minus: ['Deliberate', 'calculator'], say: 'of games finished with more time left than the opponent' },
  resign:      { label: 'Resigning', plus: ['Realistic', null], minus: ['Never-say-die', 'fighter'], say: 'of lost games ended in resignation rather than playing on' },
};
const STYLE_Z = 2.5;  // clear in the data…
const STYLE_H = 0.1;  // …and big enough to notice (Cohen's h; 0.2 is conventionally "small")

// Cohen's h: difference between two proportions on a scale that treats 5%→8% like 50%→60%
const cohenH = (p1, p2) => 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));

// Engine-free counts from the games themselves (computes move features if a source didn't)
function habitCounts(games) {
  const fs = games.filter(g => {
    if (!g.f) { try { replayFeatures(g); } catch { return false; } }
    return g.f && g.f.myMoves >= 5 && g.f.oppMoves != null;
  });
  if (fs.length < 5) return null;
  const S1 = f => sum(fs.map(f));
  const long = fs.filter(g => g.sans.length >= 30);
  const myM = S1(g => g.f.myMoves), opM = S1(g => g.f.oppMoves);
  const myC = fs.filter(g => g.f.castle), opC = fs.filter(g => g.f.oppCastle);
  const clk = fs.filter(g => g.f.minClockFrac != null && g.f.oppMinClockFrac != null && g.sans.length >= 20);
  const lost = fs.filter(g => g.result === 'loss' && g.reason), won = fs.filter(g => g.result === 'win' && g.reason);
  return {
    games: fs.length,
    checks: [S1(g => g.f.checks), myM, S1(g => g.f.oppChecks), opM],
    captures: [S1(g => g.f.captures), myM, S1(g => g.f.oppCaptures), opM],
    pawns: [S1(g => g.f.pawnMoves), myM, S1(g => g.f.oppPawnMoves), opM],
    castleEarly: [long.filter(g => g.f.castleMove && g.f.castleMove <= 10).length, long.length, long.filter(g => g.f.oppCastleMove && g.f.oppCastleMove <= 10).length, long.length],
    castleLong: [myC.filter(g => g.f.castle === 'Q').length, myC.length, opC.filter(g => g.f.oppCastle === 'Q').length, opC.length],
    earlyQueen: [fs.filter(g => g.f.earlyQueen).length, fs.length, fs.filter(g => g.f.oppEarlyQueen).length, fs.length],
    ...(clk.length ? {
      timeTrouble: [clk.filter(g => g.f.minClockFrac < 0.1).length, clk.length, clk.filter(g => g.f.oppMinClockFrac < 0.1).length, clk.length],
      clockLead: [clk.filter(g => g.f.finalClockDiff > 0).length, clk.length, clk.filter(g => g.f.finalClockDiff < 0).length, clk.length],
    } : {}),
    // my lost games vs my opponents' lost games (= my wins)
    ...(lost.length && won.length ? { resign: [lost.filter(g => g.reason === 'resigned').length, lost.length, won.filter(g => g.reason === 'resigned').length, won.length] } : {}),
  };
}

// Engine-verified choice counts from an engine scan (aggregateScan(...).style)
function engineCounts(style) {
  if (!style) return {};
  const c = (a, b) => [a.k, a.n, b.k, b.n];
  return { forcing: c(style.me.forcing, style.opp.forcing), trade: c(style.me.trade, style.opp.trade), storm: c(style.me.storm, style.opp.storm), sac: c(style.me.sacOpp, style.opp.sacOpp) };
}

// Effect (percentage points) and z-score for each dimension with enough data
function styleDims(counts) {
  const out = {};
  for (const [key, v] of Object.entries(counts || {})) {
    if (!STYLE_DIMS[key] || !Array.isArray(v)) continue;
    const [k1, n1, k2, n2] = v;
    if (n1 < 15 || n2 < 15) continue;
    const p1 = k1 / n1, p2 = k2 / n2;
    const se = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2) || 1e-9;
    out[key] = { key, p1, p2, n1, n2, effect: (p1 - p2) * 100, h: cohenH(p1, p2), z: (p1 - p2) / se };
  }
  return out;
}

const isTrait = d => Math.abs(d.z) >= STYLE_Z && Math.abs(d.h) >= STYLE_H;

// A title from the strongest clear traits (by size of the difference, not just certainty), with evidence
function styleTitle(dims) {
  const sig = Object.values(dims).filter(isTrait).sort((a, b) => Math.abs(b.h) - Math.abs(a.h));
  const words = sig.map(d => { const m = STYLE_DIMS[d.key][d.effect > 0 ? 'plus' : 'minus']; return { d, adj: m[0], noun: m[1] }; }).filter(w => w.adj || w.noun);
  const nounW = words.find(w => w.noun);
  // the adjective comes from a different trait than the noun, and shouldn't repeat it ("Harassing king hunter" + storm)
  const adjW = words.find(w => w !== nounW && w.adj && w.noun !== nounW?.noun) || (nounW?.adj ? nounW : null);
  // close calls: big differences that need more games to confirm
  const close = Object.values(dims).filter(d => !isTrait(d) && Math.abs(d.h) >= 0.2 && Math.abs(d.z) >= 1.5).sort((a, b) => Math.abs(b.h) - Math.abs(a.h));
  const lean = close.map(d => STYLE_DIMS[d.key][d.effect > 0 ? 'plus' : 'minus'][0]).find(Boolean);
  let title;
  if (!words.length) title = Object.keys(dims).length < 4 ? 'Not enough data yet' : lean ? `Balanced, leaning ${lean.toLowerCase()}` : 'Well-rounded player';
  else title = [adjW?.adj, nounW ? nounW.noun : 'player'].filter(Boolean).join(' ').replace(/^./, c => c.toUpperCase());
  const evidence = sig.slice(0, 5).map(d => {
    const m = STYLE_DIMS[d.key], lo = Math.min(d.p1, d.p2), dp = lo > 0 && lo < 0.1 ? 1 : 0;
    return { key: d.key, label: m.label, up: d.effect > 0, z: d.z, h: d.h,
      text: `${m.label}: ${pct(d.p1, dp)} · opponents ${pct(d.p2, dp)}` };
  });
  const hints = close.map(d => {
    const m = STYLE_DIMS[d.key], adj = m[d.effect > 0 ? 'plus' : 'minus'][0];
    return `${(adj || m.label).toLowerCase()} (${pct(d.p1, d.p1 < 0.1 ? 1 : 0)} vs ${pct(d.p2, d.p2 < 0.1 ? 1 : 0)})`;
  });
  return { title, evidence, dims, hints, significant: sig.length, measured: Object.keys(dims).length };
}

// ---------- famous players' fingerprints (js/famous-profiles.json, from their OTB games) ----------
let _famousProfiles = null;
function getFamousProfiles() {
  return _famousProfiles ||= fetch('js/famous-profiles.json').then(r => (r.ok ? r.json() : [])).catch(() => []);
}

// Closest famous players by style: distance (in Cohen's h) over the shared dimensions, each scaled by how much
// it varies across the famous players. Returns [{ id, name, match (0–100), shared: [labels] }].
function nearestFamous(dims, profiles) {
  const keys = Object.keys(STYLE_DIMS);
  const fdims = profiles.map(p => ({ p, d: styleDims(p.counts) }));
  const scale = Object.fromEntries(keys.map(k => {
    const xs = fdims.map(f => f.d[k]?.h).filter(x => x != null);
    const m = mean(xs) ?? 0;
    return [k, Math.max(0.05, Math.sqrt(mean(xs.map(x => (x - m) ** 2)) ?? 0))];
  }));
  return fdims.map(({ p, d }) => {
    const common = keys.filter(k => dims[k] && d[k]);
    if (common.length < 3) return null;
    const dist = Math.sqrt(mean(common.map(k => ((dims[k].h - d[k].h) / scale[k]) ** 2)));
    const shared = common.filter(k => Math.abs(dims[k].z) >= 2 && Math.abs(d[k].z) >= 2 && Math.sign(dims[k].effect) === Math.sign(d[k].effect))
      .map(k => STYLE_DIMS[k].label.toLowerCase());
    return { id: p.id, name: p.name, match: Math.round(100 * Math.exp(-dist * dist / 2)), dist, shared };
  }).filter(Boolean).sort((a, b) => a.dist - b.dist);
}
