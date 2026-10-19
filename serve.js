// Minimal static file server: node serve.js [port] [folder]   (folder defaults to this one; e.g. "site" to test a build)
// Also relays PGN Mentor's player database (it doesn't allow browser cross-origin requests).
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, process.argv[3] || ".");
const port = +process.argv[2] || 8765;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Only these PGN Mentor paths can be relayed: the index page and per-player zip files.
const PGNMENTOR_OK = /^(files\.html|players\/[A-Za-z0-9_-]+\.zip)$/;
const relayCache = new Map();

async function relayPgnMentor(rel, res) {
  if (!PGNMENTOR_OK.test(rel)) { res.writeHead(403); return res.end('Not allowed'); }
  try {
    let hit = relayCache.get(rel);
    if (!hit) {
      const r = await fetch('https://www.pgnmentor.com/' + rel);
      if (!r.ok) { res.writeHead(r.status); return res.end(); }
      hit = { type: r.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await r.arrayBuffer()) };
      relayCache.set(rel, hit);
    }
    res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'max-age=86400' });
    res.end(hit.body);
  } catch (e) {
    res.writeHead(502); res.end('Relay failed: ' + e.message);
  }
}

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/relay/pgnmentor/')) return relayPgnMentor(p.slice('/relay/pgnmentor/'.length), res);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // the Maia model files are large and never change: let the browser keep them
    const cache = p.startsWith('/models/') ? 'public, max-age=604800' : 'no-store';
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
}).listen(port, () => console.log(`Chess Lens running at http://localhost:${port}`));
