// Parses and replays games off the main thread (chess.com JSON, or raw PGN for other sources)
importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js', 'util.js', 'api.js');

onmessage = e => {
  if (e.data.type === 'pgn') {
    const { pgns, spec, source } = e.data;
    const out = [];
    pgns.forEach((p, i) => {
      try { const g = buildPgnGame(p, spec, source); if (g) out.push(replayKeys(g)); } catch (err) { /* skip */ }
      if (i % 100 === 99) postMessage({ progress: 100 });
    });
    postMessage({ progress: pgns.length % 100, games: out });
    return;
  }
  const { raws, username } = e.data;
  const out = [];
  raws.forEach((raw, i) => {
    const g = buildGame(raw, username);
    if (g) {
      try { replayFeatures(g); out.push(g); } catch (err) { /* skip unparsable game */ }
    }
    if (i % 25 === 24) postMessage({ progress: 25 });
  });
  postMessage({ progress: raws.length % 25, games: out });
};
