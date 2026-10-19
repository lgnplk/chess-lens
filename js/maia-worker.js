// Runs the Maia-3 ONNX model off the main thread (see js/maia.js).
// Backend from the worker URL: maia-worker.js (wasm, default) or maia-worker.js?ep=webgpu (GPU, falls back to wasm).
// in:  { type: 'init', url } | { type: 'run', id, history, eloSelf, eloOppo, n }
// out: { type: 'ready', ms, bytes, ep } | { type: 'result', id, move, value, ms } | { type: 'error', id?, message }
const ORT_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.23.2/';
const EP = new URLSearchParams(self.location.search).get('ep') === 'webgpu' ? 'webgpu' : 'wasm';
importScripts(ORT_BASE + (EP === 'webgpu' ? 'ort.webgpu.min.js' : 'ort.wasm.min.js'));
ort.env.wasm.wasmPaths = ORT_BASE;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let session = null;

// The published site stores big models as pieces listed in model.onnx.parts.json (some hosts cap file size);
// the local dev server has the whole file. Use the list when there is one, else the file itself.
async function loadModel(url) {
  const list = await fetch(url + '.parts.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (list?.parts?.length) {
    const base = new URL('.', url);
    const pieces = await Promise.all(list.parts.map(async p => {
      const r = await fetch(new URL(p, base));
      if (!r.ok) throw new Error(`Could not load ${p} (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    }));
    const out = new Uint8Array(list.bytes);
    let off = 0;
    for (const piece of pieces) { out.set(piece, off); off += piece.length; }
    if (off !== list.bytes) throw new Error(`Model pieces add up to ${off} bytes, expected ${list.bytes}`);
    return out.buffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.arrayBuffer();
}

self.onmessage = async e => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const t0 = performance.now();
      const buf = await loadModel(msg.url);
      const eps = EP === 'webgpu' && self.navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
      session = await ort.InferenceSession.create(buf, { executionProviders: eps, graphOptimizationLevel: 'all' });
      postMessage({ type: 'ready', ms: performance.now() - t0, bytes: buf.byteLength, ep: eps[0] });
    } else if (msg.type === 'run') {
      if (!session) throw new Error('Model not loaded');
      const t0 = performance.now();
      const out = await session.run({
        history: new ort.Tensor('float32', new Float32Array(msg.history), [msg.n, 64, 96]),
        elo_self: new ort.Tensor('float32', new Float32Array(msg.eloSelf), [msg.n]),
        elo_oppo: new ort.Tensor('float32', new Float32Array(msg.eloOppo), [msg.n]),
      });
      const move = new Float32Array(out.logits_move.data), value = new Float32Array(out.logits_value.data);
      postMessage({ type: 'result', id: msg.id, move: move.buffer, value: value.buffer, ms: performance.now() - t0 }, [move.buffer, value.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};
