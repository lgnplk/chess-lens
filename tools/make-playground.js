// Snapshot the current app into playground/: a frozen copy served on its own port (8766),
// so work in progress in the main folder can't break what you're playing with.
//   node tools/make-playground.js     (refuses to copy if any script has a syntax error)
//   node playground/serve.js 8766
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'playground');
const tmp = dest + '.tmp';
const ITEMS = ['index.html', 'serve.js', 'css', 'js', 'models']; // models/: the Player bot's Maia networks

// 1. syntax-check every script first
const scripts = ['serve.js', ...fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js')).map(f => path.join('js', f))];
const bad = scripts.filter(f => spawnSync(process.execPath, ['--check', path.join(root, f)]).status !== 0);
if (bad.length) {
  console.error('Not snapshotting — syntax errors in: ' + bad.join(', '));
  console.error('(Someone may be mid-edit. Try again in a minute.)');
  process.exit(1);
}

// 2. copy to a temp folder, then swap it in
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp);
for (const item of ITEMS) fs.cpSync(path.join(root, item), path.join(tmp, item), { recursive: true });

// 3. label it so it's obvious which copy is open
const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const idx = path.join(tmp, 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8')
  .replace('<title>Chess Lens</title>', '<title>Chess Lens Playground</title>')
  .replace('<span class="logo">♞</span> Chess Lens</div>', `<span class="logo">♞</span> Chess Lens <span class="pill" title="Frozen snapshot — refresh with: node tools/make-playground.js">playground · ${stamp}</span></div>`));
fs.writeFileSync(path.join(tmp, 'PLAYGROUND.md'),
  `# Chess Lens playground\n\nFrozen snapshot of the app taken ${new Date().toISOString()}.\n\n` +
  `Don't edit files here — they're replaced on every refresh. To refresh from the main folder:\n\n` +
  '```\nnode tools/make-playground.js\n```\n\nServe it with `node playground/serve.js 8766` and open http://localhost:8766.\n');

fs.rmSync(dest, { recursive: true, force: true });
fs.renameSync(tmp, dest);
console.log(`Playground snapshot updated (${scripts.length} scripts checked) → ${dest}`);
