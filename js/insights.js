// Engine-free aggregate analytics over a set of game records

function perfRating(games) {
  if (!games.length) return null;
  const r = wdl(games);
  return Math.round(mean(games.map(g => g.opp.rating)) + 400 * (r.w - r.l) / r.n);
}

// Actual score minus Elo-expected score (positive = over-performing)
function overPerf(games) {
  if (!games.length) return null;
  return mean(games.map(g => scoreOf(g) - eloExpected(g.diff)));
}

function statRow(games) {
  const r = wdl(games);
  return { ...r, perf: perfRating(games), over: overPerf(games), avgDiff: mean(games.map(g => g.diff)) };
}

function computeOverview(games) {
  const byColor = { white: statRow(games.filter(g => g.color === 'white')), black: statRow(games.filter(g => g.color === 'black')) };
  const tcs = ['bullet', 'blitz', 'rapid', 'daily'];
  const byTime = tcs.map(tc => ({ tc, ...statRow(games.filter(g => g.timeClass === tc)) })).filter(x => x.n);
  const reasons = { win: {}, loss: {}, draw: {} };
  for (const g of games) {
    const lab = REASON_LABEL[g.reason] || g.reason;
    reasons[g.result][lab] = (reasons[g.result][lab] || 0) + 1;
  }
  // current streak
  let streak = 0, type = games[0]?.result;
  for (const g of games) { if (g.result === type) streak++; else break; }
  return { all: statRow(games), byColor, byTime, reasons, streak: { type, n: streak } };
}

// One row per opening AND color: facing the Caro-Kann as White and playing it as Black are different skills,
// so they are never pooled.
function computeOpenings(games, key = 'family') {
  const groups = groupBy(games, g => `${g.color}|${g[key]}`);
  const rows = [];
  for (const [k, gs] of groups) {
    const accs = gs.map(g => g.ccAccuracy?.me).filter(x => x != null);
    rows.push({
      name: k.slice(k.indexOf('|') + 1), color: gs[0].color, ...statRow(gs), games: gs,
      eco: gs[0].eco,
      avgMoves: mean(gs.map(g => g.moves)),
      acc: accs.length ? mean(accs) : null,
    });
  }
  rows.sort((a, b) => b.n - a.n);
  return rows;
}
const colorName = c => (c === 'white' ? 'White' : 'Black');
const colorDot = c => `<span class="dot ${c}" title="As ${colorName(c)}"></span>`;

function computeRepertoire(games) {
  const white = computeOpenings(games.filter(g => g.color === 'white' && g.sans[0]).map(g => ({ ...g, k: g.sans[0] })), 'k');
  const vsE4 = computeOpenings(games.filter(g => g.color === 'black' && g.sans[0] === 'e4' && g.sans[1]).map(g => ({ ...g, k: g.sans[1] })), 'k');
  const vsD4 = computeOpenings(games.filter(g => g.color === 'black' && g.sans[0] === 'd4' && g.sans[1]).map(g => ({ ...g, k: g.sans[1] })), 'k');
  return { white, vsE4, vsD4 };
}

// Wilson score interval (90%) for k successes out of n
function wilson(k, n, z = 1.645) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// ---------- Engine-free habits, always shown next to the opponents' numbers from the same games ----------
function computeHabits(games) {
  const fs = games.filter(g => g.f && g.f.myMoves >= 5 && g.f.oppMoves != null);
  if (fs.length < 5) return null;
  const per100 = (k, n) => n ? k / n * 100 : null;
  const myMoves = sum(fs.map(g => g.f.myMoves)), oppMoves = sum(fs.map(g => g.f.oppMoves));
  const long = fs.filter(g => g.moves >= 15);
  const fam = groupBy(fs, g => g.family);
  const entropy = -sum([...fam.values()].map(v => { const p = v.length / fs.length; return p * Math.log(p); }));
  const timed = fs.filter(g => g.f.minClockFrac != null);
  return {
    n: fs.length,
    rows: [
      { label: 'Checks per 100 moves', me: per100(sum(fs.map(g => g.f.checks)), myMoves), opp: per100(sum(fs.map(g => g.f.oppChecks)), oppMoves), fmt: x => num(x, 1) },
      { label: 'Captures per 100 moves', me: per100(sum(fs.map(g => g.f.captures)), myMoves), opp: per100(sum(fs.map(g => g.f.oppCaptures)), oppMoves), fmt: x => num(x, 1) },
      { label: 'Castled by move 10', me: long.filter(g => g.f.castleMove && g.f.castleMove <= 10).length / Math.max(1, long.length) * 100, opp: long.filter(g => g.f.oppCastleMove && g.f.oppCastleMove <= 10).length / Math.max(1, long.length) * 100, fmt: x => num(x, 0) + '%' },
      { label: 'Queen moved in first 6 moves', me: fs.filter(g => g.f.earlyQueen).length / fs.length * 100, opp: fs.filter(g => g.f.oppEarlyQueen).length / fs.length * 100, fmt: x => num(x, 0) + '%' },
      { label: 'Pawn moves share', me: per100(sum(fs.map(g => g.f.pawnMoves)), myMoves), opp: per100(sum(fs.map(g => g.f.oppPawnMoves)), oppMoves), fmt: x => num(x, 0) + '%' },
    ],
    variety: { families: fam.size, top: Math.max(...[...fam.values()].map(v => v.length)) / fs.length, index: fam.size > 1 ? entropy / Math.log(Math.min(fam.size, 30)) : 0 },
    clock: timed.length ? {
      used: mean(timed.map(g => 1 - g.f.minClockFrac)),
      openingShare: mean(timed.map(g => g.f.openingTimeShare).filter(x => x != null)),
      trouble: timed.filter(g => g.f.timeTrouble).length / timed.length,
      oppTrouble: timed.filter(g => g.f.oppMinClockFrac != null && g.f.oppMinClockFrac < 0.1).length / timed.length,
    } : null,
    castleRate: fs.filter(g => g.f.castle).length / fs.length,
    earlyQueen: fs.filter(g => g.f.earlyQueen).length / fs.length,
  };
}

// ---------- Engine style (per opportunity) ----------
function aggregateStyle(recs) {
  const rate = (rs, key) => {
    const xs = rs.filter(r => r[key] !== undefined);
    const k = xs.filter(r => r[key]).length;
    return { n: xs.length, k, rate: xs.length ? k / xs.length : null, ci: wilson(k, xs.length) };
  };
  const pref = (rs, key) => {
    const xs = rs.filter(r => r[key]);
    const k = xs.filter(r => r[key].chose).length;
    return { n: xs.length, k, rate: xs.length ? k / xs.length : null, expected: mean(xs.map(r => r[key].expected)), ci: wilson(k, xs.length) };
  };
  const phases = Object.fromEntries(['opening', 'middlegame', 'endgame'].map(p => [p, rate(recs.filter(r => r.phase === p), 'critical')]));
  return {
    moves: recs.length,
    critical: rate(recs, 'critical'), criticalHard: rate(recs, 'criticalHard'), criticalByPhase: phases,
    punish: rate(recs, 'punish'), punishHard: rate(recs, 'punishHard'),
    sacOpp: rate(recs, 'sacOpp'),
    sacSound: rate(recs, 'playedSac'),
    sacsPlayed: recs.filter(r => r.playedSac !== undefined).length,
    brilliants: recs.filter(r => r.brilliant).length,
    forcing: pref(recs, 'forcing'), trade: pref(recs, 'trade'), storm: pref(recs, 'storm'),
    tradeAhead: pref(recs.filter(r => r.ahead), 'trade'),
  };
}

function computeStyleProfile(scan) {
  if (!scan?.style) return null;
  const me = scan.style.me, op = scan.style.opp;
  // Preference = your rate minus your opponents' rate in the same games (a human baseline,
  // since people as a whole are not random pickers). Needs 12+ real choices on each side.
  const idx = k => me[k].n >= 12 && op[k].n >= 12 ? (me[k].rate - op[k].rate) * 100 : null;
  const fI = idx('forcing'), tI = idx('trade'), sI = idx('storm');
  const sacRate = me.sacOpp.n >= 5 ? me.sacOpp.rate : null;
  const cands = [];
  if (sacRate != null && sacRate >= 0.4 && (op.sacOpp.n < 5 || sacRate - op.sacOpp.rate >= 0.15)) cands.push({ s: sacRate * 100, name: 'The Romantic', desc: 'When a sound sacrifice is on the board, you usually go for it.' });
  if (fI != null && fI >= 8) cands.push({ s: fI + 40, name: 'The Attacker', desc: 'Given equally good options, you pick checks and captures noticeably more often than your opponents do.' });
  if (sI != null && sI >= 10) cands.push({ s: sI + 35, name: 'The Stormer', desc: 'When it is sound, you push pawns at the enemy king more often than your opponents do.' });
  if (tI != null && tI >= 8) cands.push({ s: tI + 40, name: 'The Technician', desc: 'Given equally good options, you trade pieces and simplify more often than your opponents do.' });
  if (fI != null && fI <= -8) cands.push({ s: -fI + 35, name: 'The Maneuverer', desc: 'Given equally good options, you choose quiet moves over checks and captures more often than your opponents do.' });
  cands.sort((a, b) => b.s - a.s);
  const arch = cands[0] || (fI == null ? null : { name: 'The Universal Player', desc: 'Your choices between equally good moves look much like your opponents\' — no strong lean either way.' });
  // Headline skill comparison: hard punishes (proved to separate levels in testing); only-moves are
  // rarer and noisier, so they only count with 30+ opportunities on both sides.
  let sharp = null;
  if (me.punishHard.n >= 15 && op.punishHard.n >= 15) sharp = { what: 'punish a mistake when the refutation is hard to see', d: (me.punishHard.rate - op.punishHard.rate) * 100 };
  else if (me.critical.n >= 30 && op.critical.n >= 30) sharp = { what: 'find the only good move', d: (me.critical.rate - op.critical.rate) * 100 };
  return { arch, idx: { forcing: fI, trade: tI, storm: sI }, sharpVsOpp: sharp, me, op };
}

function computeAnalytics(games) {
  const byHour = Array.from({ length: 24 }, (_, h) => statRow(games.filter(g => g.hour === h)));
  const byDay = Array.from({ length: 7 }, (_, d) => statRow(games.filter(g => g.weekday === d)));
  const heat = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => wdl(games.filter(g => g.weekday === d && g.hour === h))));
  const sessionBuckets = [[1, 1, '1st'], [2, 3, '2–3'], [4, 6, '4–6'], [7, 10, '7–10'], [11, 999, '11+']]
    .map(([a, b, label]) => ({ label, ...statRow(games.filter(g => g.sessionIdx >= a && g.sessionIdx <= b)) }));
  const afterRes = ['win', 'draw', 'loss'].map(r => ({ label: `After a ${r}`, ...statRow(games.filter(g => g.prevResult === r)) }));
  // two+ losses in a row
  const asc = [...games].sort((a, b) => a.endTs - b.endTs);
  const afterTwoLosses = [];
  for (let i = 2; i < asc.length; i++) {
    if (asc[i].prevResult === 'loss' && asc[i - 1].prevResult === 'loss' && asc[i].endTs - asc[i - 1].endTs < 1800) afterTwoLosses.push(asc[i]);
  }
  const diffBuckets = [[-9999, -200, '< −200'], [-200, -100, '−200…−100'], [-100, -25, '−100…−25'], [-25, 25, '±25'], [25, 100, '+25…+100'], [100, 200, '+100…+200'], [200, 9999, '> +200']]
    .map(([a, b, label]) => {
      const gs = games.filter(g => g.diff >= a && g.diff < b);
      return { label, ...statRow(gs), expected: gs.length ? mean(gs.map(g => eloExpected(g.diff))) : null };
    });
  const lenBuckets = [[0, 20, '≤20'], [21, 30, '21–30'], [31, 40, '31–40'], [41, 55, '41–55'], [56, 999, '56+']]
    .map(([a, b, label]) => ({ label, ...statRow(games.filter(g => g.moves >= a && g.moves <= b)) }));

  // clock remaining by move number, wins vs losses (live games, same base only)
  const timed = games.filter(g => g.f?.myClocks?.length && g.base);
  const clockCurve = res => Array.from({ length: 60 }, (_, i) => {
    const vals = timed.filter(g => g.result === res && g.f.myClocks[i] != null).map(g => g.f.myClocks[i] / g.base);
    return vals.length >= 5 ? mean(vals) * 100 : null;
  });
  const timeTrouble = timed.filter(g => g.f.timeTrouble);
  const material = {
    ahead: statRow(games.filter(g => g.f?.maxAdv >= 3)),
    behind: statRow(games.filter(g => g.f?.maxDef <= -3)),
    lostOnTimeAhead: games.filter(g => g.result === 'loss' && g.reason === 'timeout' && g.f?.finalMat >= 2).length,
  };
  // monthly
  const byMonth = [...groupBy(games, g => g.end.toISOString().slice(0, 7))].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([m, gs]) => ({ label: m, ...statRow(gs) }));

  return {
    byHour, byDay, heat, sessionBuckets, afterRes, afterTwoLosses: statRow(afterTwoLosses), diffBuckets, lenBuckets,
    clock: { win: clockCurve('win'), loss: clockCurve('loss'), nTimed: timed.length },
    timeTrouble: { n: timeTrouble.length, rate: timed.length ? timeTrouble.length / timed.length : null, ...statRow(timeTrouble), noTrouble: statRow(timed.filter(g => !g.f.timeTrouble)) },
    material, byMonth,
  };
}

// ---------- Engine scan aggregation ----------
function aggregateScan(results) {
  // results: [{ game, analysis }]
  const myMoves = [];
  const perGame = [];
  const recsMe = [], recsOpp = [], brilliantMoves = [];
  // only-move and brilliance chances in one game ([found, chances]), counted as the ladder counts them (tools/build-ladder.js)
  const chances = (who, recs) => {
    const t = key => { const xs = recs.filter(r => r[key] !== undefined); return [xs.filter(r => r[key]).length, xs.length]; };
    const [ck, cn] = t('critical'), [sk, sn] = t('sacOpp'), [pk, pn] = t('punishHard');
    return { [who + 'Crit']: [ck, cn], [who + 'Bril']: [sk + pk, sn + pn] };
  };
  for (const { game, analysis } of results) {
    const mine = styleRecords(analysis, game.color), theirs = styleRecords(analysis, game.color === 'white' ? 'black' : 'white');
    recsMe.push(...mine);
    recsOpp.push(...theirs);
    mine.filter(r => r.brilliant).forEach(r => brilliantMoves.push({ game, ply: r.ply, san: r.san }));
    const c = game.color === 'white' ? 'w' : 'b';
    const ms = analysis.moves.filter(m => m.color === c);
    myMoves.push(...ms.map(m => ({ ...m, game })));
    // eval swings from my POV
    const sign = c === 'w' ? 1 : -1;
    const evs = analysis.evals.map(e => evalToCp(e) * sign);
    perGame.push({
      game, acc: analysis.summary[c].accuracy, oppAcc: analysis.summary[c === 'w' ? 'b' : 'w'].accuracy,
      acpl: analysis.summary[c].acpl, counts: analysis.summary[c].counts,
      maxEval: Math.max(...evs), minEval: Math.min(...evs),
      // blunders (20+ win-% points lost) per counted move, for both sides, as the ladder counts them
      ...Object.fromEntries([['my', c], ['opp', c === 'w' ? 'b' : 'w']].flatMap(([who, side]) => {
        const counted = analysis.moves.filter(m => m.color === side && m.cls !== 'book' && m.cls !== 'forced');
        return [[who + 'Counted', counted.length], [who + 'Bl', counted.filter(m => m.loss >= 20).length]];
      })),
      ...chances('my', mine), ...chances('opp', theirs),
    });
  }
  const phaseStats = ['opening', 'middlegame', 'endgame'].map(p => {
    const ms = myMoves.filter(m => m.phase === p);
    return {
      phase: p, n: ms.length, acc: gameAccuracy(ms.map(m => m.acc)),
      blunders: ms.filter(m => m.cls === 'blunder').length, mistakes: ms.filter(m => m.cls === 'mistake' || m.cls === 'miss').length,
      inacc: ms.filter(m => m.cls === 'inaccuracy').length,
      errRate: ms.length ? ms.filter(m => m.cls === 'blunder' || m.cls === 'mistake' || m.cls === 'miss').length / ms.length * 100 : null,
    };
  });
  const pressure = [[0.5, 9, 'Over 50%'], [0.2, 0.5, '20–50%'], [0.1, 0.2, '10–20%'], [0, 0.1, 'Under 10%']].map(([a, b, label]) => {
    const ms = myMoves.filter(m => m.clockFrac != null && m.clockFrac >= a && m.clockFrac < b);
    return { label, n: ms.length, acc: gameAccuracy(ms.map(m => m.acc)), errRate: ms.length ? ms.filter(m => m.cls === 'blunder' || m.cls === 'mistake' || m.cls === 'miss').length / ms.length * 100 : null };
  });
  const blunderPieces = {};
  myMoves.filter(m => m.cls === 'blunder' || m.cls === 'mistake').forEach(m => { blunderPieces[m.piece] = (blunderPieces[m.piece] || 0) + 1; });
  const movesPerPiece = {};
  myMoves.forEach(m => { movesPerPiece[m.piece] = (movesPerPiece[m.piece] || 0) + 1; });
  const winning = perGame.filter(p => p.maxEval >= 300);
  const losing = perGame.filter(p => p.minEval <= -300);
  const byOpening = [...groupBy(perGame, p => `${p.game.color}|${p.game.family}`)].map(([k, ps]) => ({ name: k.slice(k.indexOf('|') + 1), color: ps[0].game.color, n: ps.length, acc: mean(ps.map(p => p.acc)), score: mean(ps.map(p => scoreOf(p.game))) }))
    .sort((a, b) => b.n - a.n);
  const byTC = [...groupBy(perGame, p => p.game.timeClass)].map(([name, ps]) => ({ name, n: ps.length, acc: mean(ps.map(p => p.acc)) }));
  const totals = Object.fromEntries(CLS_ORDER.map(k => [k, myMoves.filter(m => m.cls === k).length]));
  // how the quick brilliant rule held up under the deeper check (both players' moves)
  const brilliantCheck = results.reduce((t, { analysis: a }) => ({ candidates: t.candidates + (a.brilliantCheck?.candidates || 0), confirmed: t.confirmed + (a.brilliantCheck?.confirmed || 0) }), { candidates: 0, confirmed: 0 });
  return {
    n: perGame.length, nMoves: myMoves.length, myMoves, perGame, phaseStats, pressure, blunderPieces, movesPerPiece, totals, brilliantCheck,
    acc: mean(perGame.map(p => p.acc)), oppAcc: mean(perGame.map(p => p.oppAcc)), acpl: mean(perGame.map(p => p.acpl)),
    conversion: { n: winning.length, score: winning.length ? mean(winning.map(p => scoreOf(p.game))) : null },
    defense: { n: losing.length, score: losing.length ? mean(losing.map(p => scoreOf(p.game))) : null },
    byOpening, byTC,
    style: { me: aggregateStyle(recsMe), opp: aggregateStyle(recsOpp) }, brilliantMoves,
    worstMoves: myMoves.filter(m => m.cls === 'blunder').sort((a, b) => b.loss - a.loss).slice(0, 12),
  };
}

// ---------- Strengths & weaknesses ----------
function computeReport(games, scan) {
  const F = [];
  const add = (type, title, evidence, tip, weight = 1) => F.push({ type, title, evidence, tip, weight });
  if (games.length < 10) return [];
  const ov = computeOverview(games);
  const an = computeAnalytics(games);
  const hb = computeHabits(games);

  // Color balance
  const { white: W, black: B } = ov.byColor;
  if (W.n >= 8 && B.n >= 8) {
    const d = W.score - B.score;
    if (Math.abs(d) >= 0.08) {
      const better = d > 0 ? 'White' : 'Black', worse = d > 0 ? 'Black' : 'White';
      add('weakness', `Your ${worse} results lag behind ${better}`,
        `You score ${pct(d > 0 ? B.score : W.score)} with ${worse} vs ${pct(d > 0 ? W.score : B.score)} with ${better} (${W.n}/${B.n} games).`,
        `Review your ${worse.toLowerCase()} repertoire in the Openings tab — pick one reliable system and study its typical plans.`, Math.abs(d) * 10);
    } else add('note', 'Balanced results with both colors', `White ${pct(W.score)} vs Black ${pct(B.score)}.`, '', 0.2);
  }

  // Openings
  const ops = computeOpenings(games).filter(o => o.n >= 6);
  const allScore = ov.all.score;
  for (const o of ops) {
    const delta = o.over;
    if (delta >= 0.08) add('strength', `Strong results in the ${o.name} as ${colorName(o.color)}`, `${o.n} games · ${pct(o.score)} · +${pct(delta)} vs expected`, 'Steer toward it.', delta * 8 + Math.log(o.n) / 4);
    else if (delta <= -0.08) add('weakness', `Struggling in the ${o.name} as ${colorName(o.color)}`, `${o.n} games · ${pct(o.score)} · −${pct(-delta)} vs expected`, 'Study model games or replace it.', -delta * 8 + Math.log(o.n) / 4);
  }

  // Time classes
  if (ov.byTime.length > 1) {
    const tcs = ov.byTime.filter(t => t.n >= 10).sort((a, b) => b.over - a.over);
    if (tcs.length > 1 && tcs[0].over - tcs.at(-1).over > 0.08) {
      add('note', `You perform best at ${tcs[0].tc}`, `vs expected: ${tcs.map(t => `${t.tc} ${t.over >= 0 ? '+' : ''}${pct(t.over)}`).join(' · ')}`, '', 0.6);
    }
  }

  // Time management
  if (an.timeTrouble.rate != null && an.clock.nTimed >= 10) {
    const losses = games.filter(g => g.result === 'loss');
    const onTime = losses.filter(g => g.reason === 'timeout').length / Math.max(1, losses.length);
    if (onTime >= 0.25) add('weakness', 'Too many losses on time', `${pct(onTime)} of losses${an.material.lostOnTimeAhead ? ` · ${an.material.lostOnTimeAhead} while ahead` : ''}`, 'Budget your clock: aim to have at least 50% of your time left at move 20, and pre-move recaptures in simple positions.', onTime * 6);
    if (an.timeTrouble.rate >= 0.3 && an.timeTrouble.n >= 5 && an.timeTrouble.score < an.timeTrouble.noTrouble.score - 0.08)
      add('weakness', 'Time trouble costs you points', `${pct(an.timeTrouble.rate)} of games · score ${pct(an.timeTrouble.score)} vs ${pct(an.timeTrouble.noTrouble.score)}`, 'Play the opening faster — you likely know it — and save time for critical middlegame moments.', 3);
    if (an.timeTrouble.rate < 0.12) add('strength', 'Good clock management', `Time trouble in ${pct(an.timeTrouble.rate)} of games`, '', 1);
  }

  // Material conversion / comeback
  const m = an.material;
  if (m.ahead.n >= 8) {
    if (m.ahead.score >= 0.88) add('strength', 'Clinical conversion', `${pct(m.ahead.score)} when 3+ up · ${m.ahead.n} games`, '', 2);
    else if (m.ahead.score < 0.78) add('weakness', 'Letting winning positions slip', `${pct(m.ahead.score)} when 3+ up · ${m.ahead.n} games`, 'When ahead: trade pieces, kill counterplay.', (0.88 - m.ahead.score) * 10);
  }
  if (m.behind.n >= 8) {
    if (m.behind.score >= 0.3) add('strength', 'Resourceful defender', `${pct(m.behind.score)} when 3+ down · ${m.behind.n} games`, '', 1.5);
    else if (m.behind.score <= 0.1) add('note', 'Few comebacks when behind', `${pct(m.behind.score)} when 3+ down · ${m.behind.n} games`, 'When behind, complicate.', 0.8);
  }

  // Tilt
  const aL = an.afterRes.find(r => r.label === 'After a loss'), aW = an.afterRes.find(r => r.label === 'After a win');
  if (aL.n >= 10 && aW.n >= 10) {
    const d = aW.over - aL.over;
    if (d >= 0.08) add('weakness', 'Tilt after losses', `${pct(aL.score)} after a loss · ${pct(aW.score)} after a win`, 'Break after a loss.', d * 10);
    else if (d <= -0.03) add('strength', 'Bounce back well after losses', `${pct(aL.score)} after a loss`, '', 0.8);
  }
  if (an.afterTwoLosses.n >= 8 && an.afterTwoLosses.over <= -0.08)
    add('weakness', 'Losing streaks snowball', `${pct(an.afterTwoLosses.score)} after two losses`, 'Stop after two losses in a row.', 2);
  const longS = an.sessionBuckets.filter(s => s.n >= 10);
  if (longS.length >= 2) {
    const first = longS[0], last = longS.at(-1);
    if (first.over - last.over >= 0.08) add('weakness', 'Performance fades in long sessions', `Game ${first.label}: ${pct(first.score)} · game ${last.label}: ${pct(last.score)}`, 'Shorter sessions.', 1.5);
  }

  // Opponent strength
  const up = an.diffBuckets.filter(b => b.label.startsWith('<') || b.label.startsWith('−200'));
  const upG = games.filter(g => g.diff <= -100);
  if (upG.length >= 10) {
    const o = overPerf(upG);
    if (o >= 0.05) add('strength', 'Giant killer', `${pct(wdl(upG).score)} vs 100+ higher · +${pct(o)} vs expected`, '', 1.5);
  }
  const downG = games.filter(g => g.diff >= 100);
  if (downG.length >= 10) {
    const o = overPerf(downG);
    if (o <= -0.05) add('weakness', 'Dropping points to lower-rated players', `${pct(wdl(downG).score)} vs 100+ lower · −${pct(-o)} vs expected`, 'Play solid; let them err.', 1.5);
  }

  // Game length -> endgame skill proxy
  const lb = an.lenBuckets.filter(b => b.n >= 10);
  const longG = games.filter(g => g.moves >= 50);
  if (longG.length >= 10) {
    const o = overPerf(longG);
    if (o >= 0.06) add('strength', 'Strong in long games', `${pct(wdl(longG).score)} in 50+ move games · +${pct(o)}`, '', 1.2);
    else if (o <= -0.06) add('weakness', 'Long games go badly', `${pct(wdl(longG).score)} in 50+ move games · −${pct(-o)}`, 'Practice rook endgames.', 1.2);
  }
  const shortL = games.filter(g => g.moves <= 25 && g.result === 'loss');
  if (shortL.length / Math.max(1, games.filter(g => g.result === 'loss').length) >= 0.35)
    add('weakness', 'Quick losses', `${pct(shortL.length / games.filter(g => g.result === 'loss').length)} of losses within 25 moves`, 'Develop, castle, check their threats.', 2);

  // Playstyle
  if (hb) {
    const castle = hb.rows.find(r => r.label === 'Castled by move 10'), q = hb.rows.find(r => r.label === 'Queen moved in first 6 moves');
    if (castle.me < castle.opp - 15) add('weakness', 'King often left in the center', `Castled by move 10: ${num(castle.me, 0)}% · opponents ${num(castle.opp, 0)}%`, 'Castle early.', 1.2);
    if (q.me > 30 && q.me > q.opp + 10) add('note', 'Frequent early queen moves', `${num(q.me, 0)}% of games · opponents ${num(q.opp, 0)}%`, '', 0.5);
  }

  // Engine scan
  if (scan && scan.n >= 3) {
    const ph = scan.phaseStats.filter(p => p.n >= 30 && p.acc != null);
    if (ph.length >= 2) {
      ph.sort((a, b) => b.acc - a.acc);
      add('strength', `Most accurate in the ${ph[0].phase}`, `${scan.phaseStats.filter(p => p.acc != null).map(p => `${p.phase} ${num(p.acc, 1)}%`).join(' · ')}`, '', 1.5);
      const worst = ph.at(-1);
      add('weakness', `Least accurate in the ${worst.phase}`, `${num(worst.acc, 1)}% · ${num(worst.errRate, 1)} errors per 100 moves`,
        { opening: 'Learn the ideas behind your openings rather than move orders; review where you leave theory.', middlegame: 'Do daily tactics puzzles and practise a checks-captures-threats routine before each move.', endgame: 'Study fundamental endgames (king activity, rook endgames, pawn races).' }[worst.phase], 2);
    }
    const pr = scan.pressure.filter(p => p.n >= 25);
    if (pr.length >= 2 && pr[0].acc - pr.at(-1).acc > 8)
      add('weakness', 'Accuracy collapses under time pressure', `${num(pr[0].acc, 1)}% with time · ${num(pr.at(-1).acc, 1)}% under ${pr.at(-1).label.toLowerCase().replace('under ', '')}`, 'Play the opening faster.', 2);
    if (scan.conversion.n >= 4 && scan.conversion.score < 0.7)
      add('weakness', 'Missed wins', `${pct(scan.conversion.score)} from ${scan.conversion.n} winning positions`, 'When winning, check their best reply.', 2);
    const st = scan.style, sp = (r) => `${pct(r.rate)} of ${r.n}`;
    if (st.me.critical.n >= 30 && st.opp.critical.n >= 30) {
      const d = st.me.critical.rate - st.opp.critical.rate;
      if (d >= 0.07) add('strength', 'You find the only move', `${sp(st.me.critical)} · opponents ${pct(st.opp.critical.rate)}`, '', 2);
      else if (d <= -0.07) add('weakness', 'Missing critical moves', `${sp(st.me.critical)} · opponents ${pct(st.opp.critical.rate)}`, 'Slow down when the position is sharp: checks, captures and threats for both sides before moving.', 2);
    }
    if (st.me.punishHard.n >= 15 && st.opp.punishHard.n >= 15) {
      const d = st.me.punishHard.rate - st.opp.punishHard.rate;
      if (d >= 0.08) add('strength', 'You see hidden refutations', `${sp(st.me.punishHard)} · opponents ${pct(st.opp.punishHard.rate)}`, '', 2);
      else if (d <= -0.08) add('weakness', 'Missing hidden refutations', `${sp(st.me.punishHard)} · opponents ${pct(st.opp.punishHard.rate)}`, 'Practice puzzles with quiet key moves (not captures) — they train exactly this.', 2);
    }
    if (st.me.punish.n >= 8 && st.opp.punish.n >= 8) {
      const d = st.me.punish.rate - st.opp.punish.rate;
      if (d <= -0.08) add('weakness', 'Not punishing mistakes', `${sp(st.me.punish)} · opponents ${pct(st.opp.punish.rate)}`, 'After each move: what did it allow?', 1.8);
      else if (d >= 0.08) add('strength', 'Ruthless after mistakes', `${sp(st.me.punish)} · opponents ${pct(st.opp.punish.rate)}`, '', 1.5);
    }
    if (st.me.sacSound.n >= 4 && st.me.sacSound.rate < 0.5) add('weakness', 'Unsound sacrifices', `${sp(st.me.sacSound)} held up`, 'Calculate to the end, or keep the material.', 1.2);
    if (st.me.brilliants >= 1) add('strength', `${st.me.brilliants} brilliant move${st.me.brilliants > 1 ? 's' : ''}`, `${scan.n} scanned games`, '', 0.8);
    const bp = Object.entries(scan.blunderPieces).map(([p, n]) => ({ p, rate: n / (scan.movesPerPiece[p] || 1), n })).filter(x => x.n >= 3).sort((a, b) => b.rate - a.rate);
    if (bp.length) add('note', `Your ${PIECE_NAMES[bp[0].p].toLowerCase()} moves are the most error-prone`, `${bp[0].n} errors in ${scan.movesPerPiece[bp[0].p]} moves`, '', 0.7);
    // what kind of blunders, and when (js/blunders.js)
    if (scan.myMoves && typeof blunderAnatomy === 'function') {
      if (S._blAgg !== scan) { S._blAgg = scan; S._bl = blunderAnatomy(scan.myMoves); }
      const B = S._bl, top = B.families[0];
      if (top && B.list.length >= 8 && top.share >= 0.3) {
        add('weakness', `Your blunders: ${top.label.toLowerCase()}`, `${pct(top.share)} of ${B.list.length} blunders · mostly ${top.cats[0].label.toLowerCase()}`, `${top.prevent} Drill: Insights → Blunders.`, 2.4);
      }
      const risky = B.situations.find(s => ['fast', 'trouble', 'winning', 'afterCapture', 'afterCheck'].includes(s.key) && s.ratio >= 1.5 && s.blunders >= 5);
      if (risky) add('weakness', `Blunder-prone: ${risky.label.toLowerCase()}`, `${num(risky.rate, 1)} blunders per 100 moves vs ${num(risky.base, 1)}`, blunderRules(B).find(r => r.why.includes('×'))?.rule || '', 1.6);
      if (B.halves && B.halves.older && B.halves.newer != null) {
        const d = (B.halves.newer - B.halves.older) / B.halves.older;
        if (d <= -0.25) add('strength', 'Blundering less', `${num(B.halves.newer, 1)} per game lately, from ${num(B.halves.older, 1)}`, '', 1.2);
        else if (d >= 0.25) add('weakness', 'Blundering more lately', `${num(B.halves.newer, 1)} per game lately, from ${num(B.halves.older, 1)}`, 'Faster time controls or long sessions lately?', 1.2);
      }
    }
    if (scan.acc != null && scan.oppAcc != null) {
      if (scan.acc - scan.oppAcc >= 3) add('strength', 'You outplay your opponents', `Average accuracy ${num(scan.acc, 1)}% vs your opponents' ${num(scan.oppAcc, 1)}%.`, '', 1);
      else if (scan.oppAcc - scan.acc >= 3) add('weakness', 'Opponents play more accurately', `Average accuracy ${num(scan.acc, 1)}% vs your opponents' ${num(scan.oppAcc, 1)}%.`, '', 1);
    }
  }
  F.sort((a, b) => b.weight - a.weight);
  return F;
}

// ---------- "style shape" radar axes ----------
// Habits, each relative to the player's own opponents in the same games: 50 = same as them,
// 75 = twice as often, 25 = half as often (log scale, so above and below are symmetric).
const habitIndex = (me, opp) => me == null || opp == null ? null : clamp(50 + 25 * Math.log2((me + 0.5) / (opp + 0.5)), 0, 100);

function habitAxes(hb) {
  if (!hb) return [];
  const row = l => hb.rows.find(r => r.label === l);
  const axes = [
    ['Checks', row('Checks per 100 moves')], ['Captures', row('Captures per 100 moves')],
    ['Early castling', row('Castled by move 10')], ['Early queen', row('Queen moved in first 6 moves')],
    ['Pawn moves', row('Pawn moves share')],
  ].map(([label, r]) => ({ label, v: habitIndex(r.me, r.opp), raw: r }));
  if (hb.clock) axes.push({ label: 'Time trouble', v: habitIndex(hb.clock.trouble * 100, hb.clock.oppTrouble * 100), raw: { me: hb.clock.trouble * 100, opp: hb.clock.oppTrouble * 100, fmt: x => num(x, 0) + '%' } });
  return axes;
}

// Engine-verified choice rates (0–100%), only axes with enough chances on every side being drawn
function engineAxes(styles, minN = 5) {
  const defs = [
    ['Found the only move', 'critical'], ['Hard only moves', 'criticalHard'], ['Punished mistakes', 'punish'],
    ['Hard punishes', 'punishHard'], ['Took sound sacs', 'sacOpp'], ['Sacs held up', 'sacSound'],
    ['Chose forcing moves', 'forcing'], ['Chose trades', 'trade'],
  ];
  return defs.filter(([, k]) => styles.every(s => s[k]?.n >= minN))
    .map(([label, k]) => ({ label, key: k, vs: styles.map(s => s[k].rate * 100), ns: styles.map(s => s[k].n) }));
}

// ---------- highlights: the memorable games and patterns in a set of games ----------
function computeHighlights(games) {
  if (games.length < 5) return [];
  const asc = [...games].sort((a, b) => a.endTs - b.endTs);
  const wins = games.filter(g => g.result === 'win');
  const out = [];
  const add = (icon, title, value, detail, game) => out.push({ icon, title, value, detail, game });
  const vs = g => `vs ${g.opp.name} (${g.opp.rating}) · ${fmtDate(g.end)}`;

  const upset = wins.filter(g => g.opp.rating > g.me.rating).sort((a, b) => (b.opp.rating - b.me.rating) - (a.opp.rating - a.me.rating))[0];
  if (upset) add('', 'Biggest upset', `+${upset.opp.rating - upset.me.rating}`, `Beat ${upset.opp.name}, rated ${upset.opp.rating - upset.me.rating} points higher · ${fmtDate(upset.end)}`, upset);

  const byOpp = [...groupBy(games, g => g.opp.name.toLowerCase())].map(([, gs]) => ({ name: gs[0].opp.name, gs, ...wdl(gs) })).filter(o => o.n >= 3);
  const nemesis = byOpp.filter(o => o.score < 0.5).sort((a, b) => a.score - b.score || b.n - a.n)[0];
  if (nemesis) add('', 'Nemesis', nemesis.name, `${nemesis.w}W ${nemesis.d}D ${nemesis.l}L in ${nemesis.n} games (${pct(nemesis.score)})`, nemesis.gs[0]);
  const victim = byOpp.filter(o => o.score > 0.5).sort((a, b) => b.w - a.w || b.score - a.score)[0];
  if (victim) add('', 'Favorite opponent', victim.name, `${victim.w}W ${victim.d}D ${victim.l}L in ${victim.n} games (${pct(victim.score)})`, victim.gs[0]);

  let best = 0, cur = 0, end = null;
  for (const g of asc) { cur = g.result === 'win' ? cur + 1 : 0; if (cur > best) { best = cur; end = g; } }
  if (best >= 3) add('', 'Longest win streak', `${best} wins`, `ended ${fmtDate(end.end)}`, end);

  const mate = wins.filter(g => g.reason === 'checkmated').sort((a, b) => a.moves - b.moves)[0];
  if (mate) add('', 'Fastest checkmate', `${mate.moves} moves`, vs(mate), mate);

  const comeback = wins.filter(g => g.f?.maxDef <= -3).sort((a, b) => a.f.maxDef - b.f.maxDef)[0];
  if (comeback) add('', 'Greatest comeback', `−${-comeback.f.maxDef} material`, `Won after falling ${-comeback.f.maxDef} points of material behind · ${vs(comeback)}`, comeback);

  const longest = [...games].sort((a, b) => b.moves - a.moves)[0];
  add('', 'Longest game', `${longest.moves} moves`, `${longest.result} · ${vs(longest)}`, longest);

  const days = [...groupBy(games, g => g.end.toDateString())].map(([d, gs]) => ({ d, gs, ...wdl(gs) })).filter(x => x.n >= 4);
  const bestDay = days.sort((a, b) => b.score - a.score || b.n - a.n)[0];
  if (bestDay) add('', 'Best day', `${bestDay.w}–${bestDay.d}–${bestDay.l}`, `${fmtDate(bestDay.gs[0].end)} · ${pct(bestDay.score)} from ${bestDay.n} games`, bestDay.gs.find(g => g.result === 'win'));

  const clutch = wins.filter(g => g.f?.myClocks?.length && g.base).map(g => ({ g, left: Math.min(...g.f.myClocks) })).sort((a, b) => a.left - b.left)[0];
  if (clutch && clutch.left < 10) add('', 'Closest shave', `${clutch.left.toFixed(1)} s left`, `Won with your clock down to ${clutch.left.toFixed(1)} s · ${vs(clutch.g)}`, clutch.g);
  return out;
}
