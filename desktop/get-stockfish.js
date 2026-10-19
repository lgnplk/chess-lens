// Downloads the official Stockfish build the app ships with (too big for git): node get-stockfish.js
// Puts stockfish.exe and its licence in desktop/stockfish/. Does nothing if it's already there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'sf_19';
const ASSET = 'stockfish-windows-x86-64-universal';   // picks the fastest code for each CPU at runtime
const URL = `https://github.com/official-stockfish/Stockfish/releases/download/${VERSION}/${ASSET}.zip`;
const dest = path.join(__dirname, 'stockfish');
const exe = path.join(dest, 'stockfish.exe');

(async () => {
  if (fs.existsSync(exe)) { console.log('Stockfish already present.'); return; }
  console.log(`Downloading ${VERSION} (${ASSET})…`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockfish-'));
  const zip = path.join(tmp, 'sf.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // Windows 10+ ships a tar that also reads zip files (named in full: Git's tar on the PATH reads "C:" as a host)
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const t = spawnSync(tar, ['-xf', zip, '-C', tmp], { stdio: 'inherit' });
  if (t.status !== 0) throw new Error('Could not unpack the download');
  const dir = path.join(tmp, 'stockfish');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(dir, `${ASSET}.exe`), exe);
  fs.copyFileSync(path.join(dir, 'Copying.txt'), path.join(dest, 'COPYING.txt'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Stockfish ready:', exe);
})().catch(e => { console.error(e.message); process.exit(1); });
