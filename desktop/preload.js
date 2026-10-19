// Gives the page native Stockfish processes (js/engine.js turns this into Worker-like objects).
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
// one call per burst of lines: crossing into the page is the expensive part, not the lines
ipcRenderer.on('sf-lines', (e, id, lines) => { const fn = listeners.get(id); if (fn) fn(lines); });
let seq = 0;

contextBridge.exposeInMainWorld('chessLensNative', {
  available: ipcRenderer.sendSync('sf-available'),
  engine: 'Stockfish 19',
  spawn(onLine) { const id = ++seq; listeners.set(id, onLine); ipcRenderer.send('sf-spawn', id); return id; },
  send(id, cmd) { ipcRenderer.send('sf-send', id, cmd); },
  kill(id) { listeners.delete(id); ipcRenderer.send('sf-kill', id); },
});
