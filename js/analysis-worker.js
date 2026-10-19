// Classifies one game's moves and extracts its style records off the main thread, for big engine scans.
// The page feeds the Stockfish workers and sends each finished game's evaluations here.
// in:  { id, sans, clocks, base, evals }   out: { id, a } (analysis without per-position FENs) | { id, error }
importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js',
  'util.js', 'api.js', 'engine.js', 'board.js', 'analysis.js');

onmessage = async e => {
  const { id, sans, clocks, base, evals } = e.data;
  try {
    const rp = replay(sans);
    const a = scoreMoves({ ...rp, evals, clocks, base, book: await getBook() });
    a.moves.forEach(m => { if (m.cls === 'blunder') m.bestSan = uciToSan(a.fens[m.ply], m.best); });
    styleRecords(a, 'white');
    styleRecords(a, 'black');
    // keep only the positions brilliant candidates need for their deeper check
    a.candidateFens = Object.fromEntries(a.moves.filter(m => m.cls === 'brilliant').map(m => [m.ply, a.fens[m.ply]]));
    delete a.fens;
    postMessage({ id, a });
  } catch (err) {
    postMessage({ id, error: err.message || String(err) });
  }
};
