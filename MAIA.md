# Maia neural-net bot: prototype and findings

**Recommendation: integrate it.** Maia-3, run in the browser, predicts both test players' real moves far better than
the current Player bot. On the bot's own held-out games it gets **62% top-1 for gogangoblin (bot 43%, Stockfish 41%)
and 59–62% for Naroditsky (bot 44%, Stockfish 40%)**, with no Stockfish analysis needed. Use the 5M model (11 MB) as
the bot's base model, and 23M (46 MB) when WebGPU is available, which helps strong players. Keep the opening book,
and optionally keep the bot's fitted features as a thin correction layer on top. Per-player fine-tuning of the
network moved top-1 by −1.6 to +0.9 points, even with 800–1,000 games, so it isn't worth building, offline or in the
browser. Before shipping, decide whether the
**AGPL-3.0** licence on Maia-3 is acceptable for how Chess Lens is distributed (see the Licence section).

## What's published

| | Maia-1 (KDD 2020) | Maia-2 (NeurIPS 2024) | **Maia-3** (ICLR 2026, "Chessformer") |
|---|---|---|---|
| Weights | 9 lc0 nets `maia-1100…1900.pb.gz` (1.2–1.3 MB each), [GitHub releases](https://github.com/CSSLab/maia-chess/releases) | `blitz_model.pt`, `rapid_model.pt` on Google Drive, fetched by `pip install maia2` ([repo](https://github.com/CSSLab/maia2)) | `maia3-{3m,5m,23m,79m}.pt` state dicts (21 / 92 / 316 MB for 5M / 23M / 79M), [huggingface.co/UofTCSSLab](https://huggingface.co/collections/UofTCSSLab/maia3); code [CSSLab/maia3](https://github.com/CSSLab/maia3) |
| Licence | GPL-3.0 | MIT | AGPL-3.0 (repo); the HF cards say "see repo for code/weights license" |
| Model | lc0 residual CNN, one net per 100-point rating band | CNN (5×256) + small transformer, skill-aware attention | encoder-only transformer, 64 square tokens, 8 blocks (dim 256 for 5M, 512 for 23M) |
| Input | lc0 112 planes, policy over 1858 moves | 18 planes (pieces, side, castling, e.p.); rating as **11 bins, <1100 … ≥2000** | last 8 boards × 12 piece planes, mover-relative (mirrored when Black moves; no castling/e.p. planes); **continuous** self and opponent rating 0–5000 |
| Output | 1858-move policy (+ value) | 1880-move policy, side info, value | 4352-move policy (64×64 + 256 promotions), loss/draw/win |
| Trained on | Lichess, rating bands 1100–1900 | Lichess 2018–2023 | Lichess Jan 2023 – Jul 2025 |
| Browser builds | none official; lc0 has `leela2onnx` | none official (maiachess.com used to ship `maia_rapid.onnx`) | **maiachess.com ships one** (`public/maia3/maia3_simplified.onnx`, 45.7 MB, onnxruntime-web 1.23, [frontend repo](https://github.com/CSSLab/maia-platform-frontend), GPL-3.0); third-party fp16/fp32 exports at [bqrio/maia3-onnx](https://huggingface.co/bqrio/maia3-onnx) |

No TF.js conversions exist for any of them. Maia-3 is the clear choice. It's the newest and most accurate (the
5M card reports 57.1% move matching on Lichess), it has a continuous rating input (Maia-1/2 can't express a ~1000
Lichess player or a GM well), and onnxruntime-web is already proven to run it.

## What I built (new files only)

| File | What it does |
|---|---|
| `tools/maia-export.py` | Official checkpoint → ONNX (opset 17; RMSNorm spelled out, which opset 17 lacks). Inputs: `history` [B,64,96], `elo_self`, `elo_oppo`. Weights are stored as fp16 and cast back to fp32 at load, so the files are half size but all maths runs in fp32. Also writes `*.test.json` with PyTorch reference outputs. |
| `models/maia3-5m.onnx` (10.8 MB), `models/maia3-23m.onnx` (45.8 MB) | Built from the official UofTCSSLab checkpoints. Served by `serve.js` as-is. |
| `js/maia.js` | Board/history encoding, move-index mapping, softmax over legal moves, chess.com → Lichess rating conversion. `new Maia('5m', { ep })`, then `await maia.predict([{ fens, eloSelf, eloOppo }])` returns `{ moves: [{ uci, san, p }], value }`. |
| `js/maia-worker.js` | Runs onnxruntime-web 1.23.2 (cdnjs) in a Web Worker. WASM by default; `?ep=webgpu` uses the GPU. |
| `maia-eval.html` + `js/maia-eval.js` | The comparison below, run on the Player bot's own split. Also an encoding check against PyTorch. Uses `js/bot.js` read-only. |
| `tools/maia-finetune.py` | Offline per-player fine-tuning experiment (PyTorch). |

**Correctness:** in the browser, all 14 reference positions give the same top move as the official PyTorch code. The
largest probability difference is 0.0015 (5M) / 0.0002 (23M), which is the fp16 weight storage. The offline
PyTorch pipeline reproduces the browser's held-out score exactly (62.0% / 82.4%).

**Speed** (this laptop, single-threaded WASM because `serve.js` doesn't send COOP/COEP headers): 5M ≈ 40–57 ms
per position, 23M ≈ 140–150 ms. WebGPU (RTX 5070 laptop), batched: about 2–6 ms per position for either size. The
model loads in about 1 s from localhost.

## Results: held-out move matching

Same protocol as the Player bot: the player's most recent 80 games, every 5th game held out (book built without
them), plies 4–119 of the player's moves. "Stockfish" is the depth-10 top move. The Player bot is today's
`js/bot.js`, refitted on the same split.

**gogangoblin** (chess.com ≈ 500, mostly blitz; 3 months, all time controls; 79 games, 518 test positions):

All Maia rows use the player's book first, as the bot does. Log-likelihood is the model's own, without the book.

| Predictor | Top-1 | Top-3 | Log-lik/move |
|---|---|---|---|
| Stockfish top move | 40.5% | – | – |
| Player bot (book + model) | 43.4% | 69.3% | −1.90 |
| Maia-3 5M, current board only, rating converted (≈1000 Lichess) | 60.0% | 81.1% | −1.35 |
| **Maia-3 5M, last 8 positions** (best rating offset on training games: 0) | **62.2%** | **82.4%** | **−1.27** |
| Maia-3 23M, last 8 positions (offset 0) | 61.8% | 83.0% | −1.24 |
| Hybrid: bot features + Maia-3 5M log-prob, fitted on training games | 62.0% | 83.2% | −1.25 |

**danielnaroditsky** (chess.com blitz ≈ 3100; 1 month, blitz; 80 games, 675 test positions):

| Predictor | Top-1 | Top-3 | Log-lik/move |
|---|---|---|---|
| Stockfish top move | 40.0% | – | – |
| Player bot (book + model) | 44.0% | 72.4% | −1.89 |
| Maia-3 5M, current board only, rating converted (≈2980 Lichess) | 57.2% | 84.7% | −1.33 |
| **Maia-3 5M, last 8 positions, rating −200** (fitted on training games) | **59.4%** | **86.1%** | **−1.20** |
| **Maia-3 23M, last 8 positions, rating −200** (fitted) | **62.1%** | **89.8%** | **−1.09** |
| Hybrid: bot features + Maia-3 5M | 61.3% | 87.0% | −1.16 |
| Hybrid: bot features + Maia-3 23M | 61.8% | 90.4% | −1.06 |

The quoted baselines (gogangoblin 44.6% vs 36.7%, Naroditsky 43.8% vs 42.7%) came from other game sets. On these
splits the bot's lead over Stockfish is similar (+2.9 and +4.0 points). Maia's lead over the bot is **+18.8 points**
for gogangoblin and **+15.4 (5M) / +18.1 (23M)** for Naroditsky. Each test set has about ±4 points of sampling noise
(95%), so the gap is far outside it.

What the variants show:
- **History helps** (+2–3 points). Use the real last 8 positions, not the current board repeated.
- **Rating matters**, and the conversion table in `js/maia.js` is about right for club players (fitted offset 0).
  Above about 3000 on the Lichess scale Maia gets much worse (Naroditsky at +400: 46%), probably because there's
  little training data that high. For him, ratings from 2600 to 2800 were best. Cap the rating input near 2800, or
  fit an offset per player; a 1-D search over the training games landed at or next to the best test value for both
  players.
- **23M helps strong players only.** +2.7 points for Naroditsky (top-3 90%), nothing for gogangoblin. It's 4× the
  download (46 MB) and 4× slower on WASM; on WebGPU both sizes are fast.
- **Book:** irrelevant for the 500 player (0.4% of positions); about +1 point for the GM.
- **Hybrid:** for the GM, the bot's engine-loss and style features on top of Maia-3 5M add +1.9 points and close
  most of the gap to 23M. On top of 23M, or for the club player, they only improve calibration (log-likelihood).

## Per-player fine-tuning

Offline experiment (`tools/maia-finetune.py`, RTX 5070 laptop GPU, same split, early stopping on the last 15% of
training games). Maia-3 5M with history and the fitted rating. Test top-1 / log-likelihood on the same held-out
moves as above:

| Player, training data | Base | Full fine-tune (5.2M weights) | Move head only (132k) | Rating embeddings only (256) |
|---|---|---|---|---|
| gogangoblin, 64 games (1.8k positions) | 62.0% / −1.27 | 62.9% / −1.23 | 61.6% / −1.25 | 61.6% / −1.25 |
| gogangoblin, 991 games (24k positions, 2 years) | 62.0% / −1.27 | 61.8% / −1.22 | 62.4% / −1.26 | 61.6% / −1.30 |
| Naroditsky, 64 games (2.3k positions) | 58.5% / −1.20 | 56.9% / −1.21 | 56.7% / −1.25 | 58.7% / −1.20 |
| Naroditsky, 864 games (30k positions, 6 months) | 58.5% / −1.20 | 57.8% / −1.19 | 57.5% / −1.20 | 58.5% / −1.20 |

Time on the laptop GPU per variant: 30–60 s for 64 games, and 4–10 minutes for 800–1,000 games. The bottleneck is the
Python data pipeline, not the GPU.

- **Offline fine-tuning works mechanically**, but it doesn't buy accuracy. Top-1 moves by −1.6 to +0.9 points, and
  13–15× more data doesn't change that. Only top-3 and log-likelihood improve a little (best case +1.8 points top-3
  and +0.05 log-lik, gogangoblin's full fine-tune with 991 games). The literature agrees. Per-player Maia-1 models
  ([McIlroy-Young et al., KDD 2022](https://arxiv.org/abs/2008.10086)) gained 4–5 points, but from thousands of
  games per player. [Maia4All (2025)](https://arxiv.org/abs/2507.21488) gets about +2 points over Maia-2 from 20–50
  games by learning a 128-number player embedding, but that needs a base model retrained with player embeddings,
  and no code or weights are linked. Per-player fine-tuning would also mean a 10 MB model per player and a
  Python/GPU step outside the app.
- **In the browser:** onnxruntime-web's training API was experimental and CPU-only, and ORT's training packages were
  deprecated after 1.19.2, so it's not a foundation to build on. TF.js would need Maia-3 re-implemented layer by layer
  (custom geometric attention bias) before any training could start. Training only the move head (the part plain JS
  could train on exported hidden states) gave −1.8 to +0.4 points offline. **Not worth building.**
- **What does personalize cheaply in the browser** is what the prototype already does: fit the rating offset (one
  number), and the hybrid layer (~40 parameters over Maia's log-probabilities plus the existing features). Both
  take seconds in plain JS.

## How to integrate into the Player bot tab

1. **Model:** ship `models/maia3-5m.onnx` (10.8 MB) and `js/maia.js` + `js/maia-worker.js`, and optionally
   `models/maia3-23m.onnx` (45.8 MB) for WebGPU machines. Load lazily when the Player bot tab opens. `serve.js` sends
   `no-store`, so cache the file with the Cache API or IndexedDB, as maiachess.com does. WASM 5M is fine for one
   move at a time (~50 ms).
2. **Prediction:** out of book, call `maia.predict` with the real last 8 positions, the player's rating converted
   with `chesscomToLichess` (capped ≈2800), and the opponent's rating. "Most likely move" is the argmax.
   "Like them" samples from Maia's probabilities, which are much better calibrated than the current model's
   (log-lik −1.2 vs −1.9). Lichess sources need no conversion. PGN Mentor's OTB Elo needs its own (FIDE runs
   below Lichess), or just the fitted offset.
3. **Training becomes optional and fast:** with Maia alone there's no Stockfish pass. "Training" is building the
   book and fitting the rating offset on the player's games. The held-out evaluation can stay exactly as it is.
4. **Optional "style correction":** keep `bot.js`'s features and fit them on top of Maia (the hybrid in
   `js/maia-eval.js`: `fitHybrid` / `hybridProbs`). That needs today's Stockfish pass and helps strong players.
5. **Model card:** report Maia's top-1/top-3 next to the Stockfish baseline as now, plus the fitted rating ("plays
   like a ~1000 Lichess player").

## Licence

Maia-3's code and weights are **AGPL-3.0**. Shipping the weights in Chess Lens and serving them to other people
(e.g. a public deployment) probably obliges you to offer the whole app's source under AGPL-compatible terms. For
personal/local use it doesn't matter. The MIT alternative is Maia-2, but its rating input stops at "≥2000" and there's
no official browser build. Maia-1 is GPL-3.0. This is not legal advice; it's a decision for the project owner.

## Caveats

- Two players, one window each. The size of the gap makes the conclusion safe, but per-player numbers will vary.
- The chess.com → Lichess conversion is approximate (blitz survey figures). The per-player offset fit corrects it.
- Maia-3's input has no castling or en-passant planes (by design), so positions that differ only in those rights
  look the same to it. The legal-move mask still keeps every prediction legal.
- Naroditsky's 5M numbers came out identical on WASM and WebGPU, and gogangoblin's identical in PyTorch.
- Reproduce: `node serve.js 8767`, then open
  `http://localhost:8767/maia-eval.html?user=gogangoblin&tc=all&months=3&games=80&models=5m&ep=webgpu&maiaWorkers=1`
  (drop `ep`/`maiaWorkers` for WASM; results are in `window.MAIA_EVAL`).
