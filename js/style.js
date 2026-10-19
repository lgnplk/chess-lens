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

// ---------- archetypes: recognisable ways of playing, each defined by which measured traits it needs ----------
// rules: [dimension, direction (+1 = more than opponents, −1 = less), weight]. A player matches an archetype by
// how strongly their clear traits point the same way; `solo` archetypes rest on one trait, the rest need two.
const ARCHETYPES = [
  // attacking
  { id: 'romantic', name: 'Romantic', group: 'Attacking', rules: [['sac', 1, 2], ['forcing', 1, 1], ['trade', -1, .5], ['checks', 1, .5]],
    desc: 'Goes for sacrifices and forcing play over safe, equal moves.' },
  { id: 'sacrificer', name: 'Trigger-happy sacrificer', group: 'Attacking', rules: [['sac', 1, 2], ['captures', 1, 1.5], ['trade', -1, .5]],
    desc: 'Takes material and gives it up readily; most of the game is captures.' },
  { id: 'hunter', name: 'King hunter', group: 'Attacking', rules: [['checks', 1, 2], ['storm', 1, 1.5], ['forcing', 1, 1]],
    desc: 'Aims everything at the enemy king: checks, pawn pushes, forcing moves.' },
  { id: 'brawler', name: 'Opposite-wing brawler', group: 'Attacking', rules: [['storm', 1, 2], ['castleLong', 1, 1.5], ['pawns', 1, .5]],
    desc: 'Castles long and throws the pawns forward: a race of attacks.' },
  { id: 'tactician', name: 'Tactician', group: 'Attacking', rules: [['captures', 1, 1.5], ['forcing', 1, 1.5], ['checks', 1, .5]],
    desc: 'Looks for forcing, concrete play: captures and checks over quiet moves.' },
  { id: 'raider', name: 'Early-queen raider', group: 'Attacking', rules: [['earlyQueen', 1, 2], ['castleEarly', -1, 1], ['forcing', 1, .5]],
    desc: 'Brings the queen out early and is in no hurry to castle.' },
  // controlling
  { id: 'technician', name: 'Technician', group: 'Controlling', rules: [['trade', 1, 2], ['storm', -1, 1], ['sac', -1, .5]],
    desc: 'Trades pieces to simplify, then wins the clean position.' },
  { id: 'squeezer', name: 'Space-gaining strategist', group: 'Controlling', rules: [['pawns', 1, 1.5], ['forcing', -1, 1], ['castleEarly', 1, .5]],
    desc: 'Grabs space with pawns and builds slowly rather than forcing matters.' },
  { id: 'maneuverer', name: 'Patient maneuverer', group: 'Controlling', rules: [['forcing', -1, 2], ['captures', -1, 1.5], ['checks', -1, 1], ['trade', -1, .5]],
    desc: 'Improves piece by piece; captures and checks come late.' },
  { id: 'classicist', name: 'Classicist', group: 'Controlling', rules: [['castleEarly', 1, 1.5], ['earlyQueen', -1, 1], ['storm', -1, 1], ['sac', -1, .5]],
    desc: 'Develops, castles early and avoids early adventures.' },
  { id: 'complicator', name: 'Tension-keeper', group: 'Controlling', rules: [['trade', -1, 2], ['captures', -1, .5], ['sac', 1, .5]],
    desc: 'Declines trades and keeps the position complicated.' },
  { id: 'pragmatist', name: 'Materialist', group: 'Controlling', rules: [['sac', -1, 2], ['forcing', -1, .5], ['trade', 1, .5]],
    desc: 'Rarely gives up material, even when a sacrifice would be sound.' },
  { id: 'improviser', name: 'Improviser', group: 'Flexible', rules: [['castleEarly', -1, 2], ['earlyQueen', 1, .5], ['pawns', -1, .5]],
    desc: 'Leaves the king in the centre and decides on the fly.' },
  { id: 'loyalist', name: 'Kingside loyalist', group: 'Flexible', rules: [['castleLong', -1, 2], ['castleEarly', 1, .5]],
    desc: 'Almost always castles short.' },
  // on the clock
  { id: 'speed', name: 'Speed player', group: 'On the clock', solo: true, rules: [['clockLead', 1, 2], ['timeTrouble', -1, 1]],
    desc: 'Plays fast and finishes with time to spare.' },
  { id: 'thinker', name: 'Deep thinker', group: 'On the clock', solo: true, rules: [['timeTrouble', 1, 2], ['clockLead', -1, 1.5]],
    desc: 'Spends the clock on hard decisions and often ends up short of time.' },
  { id: 'gambler', name: 'Clock gambler', group: 'On the clock', rules: [['timeTrouble', 1, 1.5], ['sac', 1, 1], ['forcing', 1, 1]],
    desc: 'Plays sharp and fast-and-loose, often with seconds left.' },
  // temperament
  { id: 'fighter', name: 'Never-say-die fighter', group: 'Temperament', solo: true, rules: [['resign', -1, 2]],
    desc: 'Plays lost positions to the end instead of resigning.' },
  { id: 'realist', name: 'Realist', group: 'Temperament', solo: true, rules: [['resign', 1, 2]],
    desc: 'Resigns lost games early rather than playing on.' },
];
const ARCH_MIN_SCORE = 0.15;

// Credit per rule: a clear trait (z ≥ 2.5, h ≥ 0.1) counts in full; one that leans the same way (z ≥ 1.5, h ≥ 0.12) at half;
// a single large effect (h ≥ 0.3, z ≥ 1.5), or h ≥ 0.15 with z ≥ 1.8 on the archetype's defining trait, is enough alone. A clear trait the other way counts against.
function matchArchetypes(dims) {
  const out = [];
  for (const a of ARCHETYPES) {
    let score = 0, clear = 0, lean = 0, big = false;
    for (const [key, dir, w] of a.rules) {
      const d = dims[key];
      if (!d) continue;
      const signed = dir * d.h;
      if (isTrait(d)) {
        if (signed > 0) { score += w * Math.min(signed, 0.7); clear++; } else score -= w * Math.min(-signed, 0.4);
      } else if (Math.abs(d.z) >= 1.5 && Math.abs(d.h) >= 0.12) {
        if (signed > 0) {
          score += w * Math.min(signed, 0.7) * 0.5; lean++;
          // one large effect, or a moderate one on the archetype's defining trait (weight 2), is enough on its own
          if ((signed >= 0.3 && Math.abs(d.z) >= 1.5) || (w >= 2 && signed >= 0.15 && Math.abs(d.z) >= 1.8)) big = true;
        }
        else score -= w * Math.min(-signed, 0.4) * 0.25;
      }
    }
    const need = a.solo ? 1 : 2;
    if ((clear >= need || clear + lean >= need || big) && score >= ARCH_MIN_SCORE) out.push({ a, score, confident: clear >= need });
  }
  return out.sort((x, y) => y.score - x.score);
}

// extra: { brilliants, oppBrilliants } from an engine scan; many verified brilliant moves make a romantic "Brilliant"
function styleTitle(dims, extra = {}) {
  const sig = Object.values(dims).filter(isTrait).sort((a, b) => Math.abs(b.h) - Math.abs(a.h));
  const matches = matchArchetypes(dims);
  const top = matches[0];
  const close = Object.values(dims).filter(d => !isTrait(d) && Math.abs(d.h) >= 0.2 && Math.abs(d.z) >= 1.5).sort((a, b) => Math.abs(b.h) - Math.abs(a.h));
  const measured = Object.keys(dims).length;
  let title, archetype = null;
  if (top) {
    const brilliant = (top.a.id === 'romantic' || top.a.id === 'sacrificer') && (extra.brilliants || 0) >= 2 && (extra.brilliants || 0) > (extra.oppBrilliants || 0);
    archetype = { id: top.a.id, name: top.a.name, group: top.a.group, desc: top.a.desc, confident: top.confident };
    title = brilliant ? `Brilliant ${top.a.name.replace(/^./, c => c.toLowerCase())}` : top.a.name;
  } else if (measured < 4) title = 'Not enough data yet';
  else {
    title = 'All-rounder';
    const desc = sig.length ? 'A few clear habits, but no single archetype fits them.' : 'No habit stands out from your opponents’: you play like the field.';
    archetype = { id: 'allrounder', name: 'All-rounder', group: '', confident: true, desc };
  }
  // other archetypes that fit, as a share of the best fit
  const blend = matches.slice(1, 4).map(m => ({ id: m.a.id, name: m.a.name, fit: Math.round(100 * m.score / top.score) })).filter(b => b.fit >= 40);
  const evidence = sig.slice(0, 5).map(d => {
    const m = STYLE_DIMS[d.key], lo = Math.min(d.p1, d.p2), dp = lo > 0 && lo < 0.1 ? 1 : 0;
    return { key: d.key, label: m.label, up: d.effect > 0, z: d.z, h: d.h,
      text: `${m.label}: ${pct(d.p1, dp)} · opponents ${pct(d.p2, dp)}` };
  });
  const hints = close.map(d => {
    const m = STYLE_DIMS[d.key], adj = m[d.effect > 0 ? 'plus' : 'minus'][0];
    return `${(adj || m.label).toLowerCase()} (${pct(d.p1, d.p1 < 0.1 ? 1 : 0)} vs ${pct(d.p2, d.p2 < 0.1 ? 1 : 0)})`;
  });
  return { title, archetype, blend, evidence, dims, hints, significant: sig.length, measured };
}

// brilliant-move counts for the title, from an engine scan's style (aggregateScan(...).style)
const styleExtra = style => (style ? { brilliants: style.me.brilliants, oppBrilliants: style.opp.brilliants } : {});

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
