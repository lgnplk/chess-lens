// Classifies one game's moves and extracts its style records off the main thread, for big engine scans.
// The page feeds the Stockfish workers and sends each finished game's evaluations here.
// in:  { id, sans, clocks, base, evals }   out: { id, a } (analysis without per-position FENs) | { id, error }
importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js',
  'util.js', 'api.js', 'engine.js', 'board.js', 'analysis.js', 'blunders.js');

onmessage = async e => {
  const { id, sans, clocks, base, evals } = e.data;
  try {
    const rp = replay(sans);
    const a = scoreMoves({ ...rp, evals, clocks, base, book: await getBook() });
    a.moves.forEach(m => { if (m.cls === 'blunder') m.bestSan = uciToSan(a.fens[m.ply], m.best); });
    styleRecords(a, 'white');
    styleRecords(a, 'black');
    // blunders are diagnosed here, where the positions are at hand (the Blunders page would otherwise replay every
    // game); each keeps its position and the move before it for the drill
    for (const m of a.moves) {
      if (!(m.loss >= 20) || m.cls === 'book' || m.cls === 'forced') continue;
      try { m.diag = classifyBlunder(m, a.fens); } catch { m.diag = { cat: 'positional', line: [], reply: null, lost: null }; }
      const pm = a.moves[m.ply - 1];
      Object.assign(m.diag, { fen: a.fens[m.ply], last: pm ? { from: pm.from, to: pm.to } : null });
    }
    // keep only the positions brilliant candidates need for their deeper check
    a.candidateFens = Object.fromEntries(a.moves.filter(m => m.cls === 'brilliant').map(m => [m.ply, a.fens[m.ply]]));
    delete a.fens;
    postMessage({ id, a });
  } catch (err) {
    postMessage({ id, error: err.message || String(err) });
  }
};
