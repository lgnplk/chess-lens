// Chess Lens desktop app (Electron).
// Serves the built site/ folder from a small local server (same pages as the website, plus the PGN Mentor
// relay that serve.js does in development) and runs native Stockfish processes for the page (see preload.js).
//   npm start        run from source (uses ../site and ./stockfish)
//   npm run dist     build the Windows installer into dist/
const { app, BrowserWindow, ipcMain, shell, Menu, dialog, powerSaveBlocker } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// CL_SITE=.. serves the project folder itself (for one-off jobs such as tools/build-ladder.js)
const SITE = process.env.CL_SITE ? path.resolve(__dirname, process.env.CL_SITE)
  : app.isPackaged ? path.join(process.resourcesPath, 'site') : path.join(__dirname, '..', 'site');
const STOCKFISH = app.isPackaged ? path.join(process.resourcesPath, 'stockfish', 'stockfish.exe') : path.join(__dirname, 'stockfish', 'stockfish.exe');
// CL_PROFILE=<folder> keeps a one-off job's data apart from the normal app
if (process.env.CL_PROFILE) app.setPath('userData', path.resolve(__dirname, process.env.CL_PROFILE));
// A fixed port keeps the page's origin stable, so saved data (IndexedDB, settings) survives restarts
const PORTS = [47365, 47366, 47367, 47368];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.onnx': 'application/octet-stream' };
const PGNMENTOR_OK = /^(files\.html|players\/[A-Za-z0-9_-]+\.zip)$/;
const relayCache = new Map();

async function relay(rel, res) {
  if (!PGNMENTOR_OK.test(rel)) { res.writeHead(403); return res.end('Not allowed'); }
  try {
    let hit = relayCache.get(rel);
    if (!hit) {
      const r = await fetch('https://www.pgnmentor.com/' + rel);
      if (!r.ok) { res.writeHead(r.status); return res.end(); }
      hit = { type: r.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await r.arrayBuffer()) };
      relayCache.set(rel, hit);
    }
    res.writeHead(200, { 'Content-Type': hit.type });
    res.end(hit.body);
  } catch (e) { res.writeHead(502); res.end('Relay failed: ' + e.message); }
}

function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/relay/pgnmentor/')) return relay(p.slice('/relay/pgnmentor/'.length), res);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(SITE, p);
    if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p.startsWith('/models/') ? 'max-age=604800' : 'no-cache' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    // each attempt drops its own listeners, so a failed port's callback can't fire for the next one
    const tryPort = i => {
      if (i >= PORTS.length) return reject(new Error('No free port'));
      const onErr = () => { server.removeListener('listening', onOk); tryPort(i + 1); };
      const onOk = () => { server.removeListener('error', onErr); resolve(PORTS[i]); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(PORTS[i], '127.0.0.1');
    };
    tryPort(0);
  });
}

// ---------- native Stockfish: one process per engine the page asks for ----------
const procs = new Map();
let nativeOk = false;

function checkStockfish() {
  return new Promise(resolve => {
    if (!fs.existsSync(STOCKFISH)) return resolve(false);
    const p = spawn(STOCKFISH, [], { windowsHide: true });
    let out = '';
    const done = ok => { clearTimeout(t); p.kill(); resolve(ok); };
    const t = setTimeout(() => done(false), 5000);
    p.stdout.on('data', d => { out += d; if (out.includes('uciok')) done(true); });
    p.on('error', () => done(false));
    p.stdin.write('uci\n');
  });
}

ipcMain.on('sf-available', e => { e.returnValue = nativeOk; });
ipcMain.on('sf-spawn', (e, id) => {
  const p = spawn(STOCKFISH, [], { windowsHide: true });
  const wc = e.sender;
  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    const all = buf.split(/\r?\n/);
    buf = all.pop();
    // the page only reads full-line search info (and the handshake/bestmove lines): drop bound, currmove and string lines
    const lines = all.filter(l => !l.startsWith('info') || (l.includes(' pv ') && !l.includes('bound')));
    if (lines.length && !wc.isDestroyed()) wc.send('sf-lines', id, lines);
  });
  p.on('exit', () => procs.delete(id));
  p.on('error', () => procs.delete(id));
  procs.set(id, p);
});
ipcMain.on('sf-send', (e, id, cmd) => { const p = procs.get(id); if (p && !p.killed) p.stdin.write(cmd + '\n'); });
// the page's theme for the window buttons drawn over its app bar
ipcMain.on('titlebar', (e, o) => { try { BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay(o); } catch { /* not supported here */ } });
ipcMain.on('sf-kill', (e, id) => { const p = procs.get(id); if (p) { p.kill(); procs.delete(id); } });
const killAll = () => { for (const p of procs.values()) p.kill(); procs.clear(); };

async function createWindow() {
  nativeOk = await checkStockfish();
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 380, minHeight: 480, backgroundColor: '#14120f', title: 'Chess Lens',
    icon: path.join(__dirname, 'icon.png'),
    // no stock title bar: the page's app bar is the title bar, with Windows' own buttons drawn over its right end
    // (the page sets their colours to the theme's: the 'titlebar' message)
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#14120f', symbolColor: '#eee7d8', height: 51 }, autoHideMenuBar: true,
    // a one-off job (CL_PROFILE, e.g. the ladder build) keeps full speed in a background window
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: !process.env.CL_PROFILE },
  });
  // ...and keeps the computer from idle-sleeping while it runs
  if (process.env.CL_PROFILE) powerSaveBlocker.start('prevent-app-suspension');
  // links to chess.com, Lichess etc. open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); } });
  // the page re-creates its engines after a reload: drop the old processes
  win.webContents.on('did-start-navigation', (e, url, inPlace, mainFrame) => {
    if ((e.isMainFrame ?? mainFrame) && !(e.isSameDocument ?? inPlace)) killAll();
  });
  // the menu bar is hidden, so its keys are handled here
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = i.key, ctrl = i.control || i.meta;
    if (k === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (k === 'F12' || (ctrl && i.shift && k.toLowerCase() === 'i')) { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'File', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'quit' }] },
  // (interface size is the page's own setting: Ctrl + = / − / 0)
  { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
]));

// Updates: the installed app checks this project's GitHub releases at start-up, downloads a newer version in the
// background, and offers to restart into it. (Only the installed app; running from source never updates.)
function setupUpdates(win) {
  if (!app.isPackaged || process.env.CL_PROFILE) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', async info => {
    const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Chess Lens update', message: `Chess Lens ${info.version} is ready.`, detail: 'Restart to finish updating. Your saved data stays.' });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', e => console.warn('update check failed:', e?.message));   // offline or no release yet: stay quiet
  autoUpdater.checkForUpdates().catch(() => {});
}

app.whenReady().then(async () => { const win = await createWindow(); setupUpdates(win); });
app.on('window-all-closed', () => { killAll(); app.quit(); });
app.on('before-quit', killAll);
