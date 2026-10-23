# Chess Lens

A desktop chess.com game analyzer: Stockfish game review with verified brilliant moves, opening efficiency split by
colour, a style fingerprint compared with world champions, advanced analytics and highlights, a rating ladder of the
typical player at every level, head-to-head comparisons, opening preparation against any player, bots that play like
real people (including 16 legends), bot matches and tournaments with predictions, and a strengths & weaknesses report.
Training too: rated puzzles and Puzzle Rush, endgame drills against Stockfish, opening practice, a master-games opening
explorer, and games against a bot at any rating with a coach.

## Desktop app (Windows)

```
cd desktop
npm run setup     # once: Electron, its runtime, and Stockfish
npm start         # run from source
npm run dist      # build the installer: desktop/release/<version>/Chess Lens Setup <version>.exe
```

The app (`desktop/main.js`) serves the built pages from a small local server and runs native **Stockfish 19** for
analysis (Review, scans, Head to head, Blunders), about twice as fast per position as the browser engine and much
stronger. Bots keep the browser Stockfish their calibration was fitted with. `desktop/get-stockfish.js` downloads the
official Stockfish build (it's too big for git); `tools/make-site.js` assembles the pages and models into `site/`,
which the installer bundles. Bump `version` in `desktop/package.json` for each release.

### Releasing an update

The installed app checks this repository's GitHub releases at start-up and offers a restart when a newer one is ready.
To publish one: bump `version` in `desktop/package.json`, run `npm run release` in `desktop/`, commit and push, then create a
release tagged `v<version>` with three files from `desktop/release/<version>/`: the installer, its `.blockmap`, and
`latest.yml`. Upload the installer and block map under the hyphenated names `latest.yml` lists
(`Chess-Lens-Setup-<version>.exe`): GitHub turns spaces in file names into dots, which breaks the update.

## Develop in a browser

```
node serve.js
```

Then open http://localhost:8765 (add `?user=<name>` to auto-load a player). No build step; libraries load from CDNs:
chess.js, Chart.js, Stockfish 10 (WebAssembly), onnxruntime-web, JSZip, and the lichess piece set. `serve.js` also
relays PGN Mentor's player database (`/relay/pgnmentor/…`, limited to its index page and player zips), because PGN
Mentor doesn't allow browser cross-origin requests; the app's server does the same.

## Navigation

Five sections: **Overview** (Summary with current ratings, Analytics, Report), **Games** (Games, Review, Explorer,
Editor, Openings, Prepare), **Insights** (one page: the engine scan, style and shape, accuracy, blunders, and the ladder by
rating), **Train** (Puzzles, Drills, Openings) and **Bots** (Play, Your bot, Arena). Without loading a player
("Play the legends" or "Solve puzzles" on the welcome page) Review, Explorer, Train, Play Arena and the Editor still work.
Copy is kept to a minimum.

## Training

- **Puzzles** (`js/puzzles.js`): 37,892 puzzles from lichess's public-domain puzzle database
  (`js/puzzles.json`, built by `node tools/build-puzzles.js`: 500+ plays, popularity 80+, settled rating, up to
  1,600 drawn at random from every 100-point band from 400 to 2900). **Rated** keeps an Elo puzzle rating on this
  computer and serves puzzles near it, by theme if you like; **Puzzle Rush** (3 or 5 minutes, or untimed Survival)
  gets harder as you go and ends on the third mistake. Any checkmate counts as a solution.
- **Drills** (`js/drills.js`): the basic mates (queen, rook, two rooks, two bishops) and key endgames (opposition,
  queen against a pawn, Lucena, Philidor) played out against Stockfish at full strength. Every position was checked
  at depth 30; after each of your moves the engine checks that the win (or the draw) is still there, so a slip ends
  the drill at once.
- **Openings** (`js/learn.js`): practise a line move by move; a wrong move slides back with the book move shown.
- **Explorer** (`js/explorer.js`, under Games): from any position, the moves played and how they scored, from
  434,770 over-the-board master games (`js/explorer-masters.json`, first 10 moves, positions in 5+ games; built by
  `node --max-old-space-size=12000 tools/build-explorer.js` from PGN Mentor's player files) or from your own games.
- **Play** (`js/play.js`, under Bots): a game against Maia-3 set to any chess.com rating from 400 to 2600, a
  legend, or one of your arena bots. The rating bot keeps 20+ win-% blunders to the rate the ladder's typical rapid
  player at that rating makes them (the blunder check below). With the **coach** on, Stockfish grades each of your
  moves as Review does, explains it, and stops the game on a mistake or blunder (the reply it allows drawn in red) so
  you can take it back or play on. Hints circle the piece, then show the move. Finished games open in Review.
- **Board editor** (`js/editor.js`, under Games; ✎ in Review opens the current position there): drag pieces
  anywhere, paint them from the palette (drag one off the board, or right-click a square, to clear it), set the side
  to move and castling, paste or copy a FEN, then play moves from it. **Show … move** asks Stockfish (top 5 lines),
  Maia at any rating, a legend, your arena bots, the Your bot tab's bot, or a new bot built from any player's games
  (saved with your arena bots) what it would play: each answer is a card with its odds and arrows on the board, so
  several can be compared on one position.
- **Review settings** (Review › Report): review depth (up to 22 on the desktop app), number of engine lines (1–5),
  live depth (up to unlimited), and whether the board shows best-move arrows, move badges and the eval bar.

## Rating ladder

`js/ladder.json` holds the typical chess.com player of every 250-point band (<250, 250–499, … ), for bullet,
blitz and rapid, built once by `tools/build-ladder.js` (52,462 players) and shipped as a file.

- **Sample.** Players are found by walking opponents; each time control × band gets about 40 "focus" players with
  50 games of habits and 20 games through Stockfish 19 (depth 12, top 3 lines: the app's own scan). Both sides of
  every game count, so each band holds thousands of players.
- **What is measured.** Style: checks, captures, pawn moves, early castling, early queen, time trouble.
  Performance: accuracy, blunders, conversion (score from +3), resilience (score from −3), brilliance (sound
  sacrifices taken and hard refutations found), consistency (game-to-game swing in accuracy) and clutch (only
  moves found), each counted exactly as the app counts your scanned games.
- **Noise removed.** A player's numbers from a few games are their real level plus luck. The game-to-game swing is
  measured from players with many games and removed with a random-effects model, so medians, quartiles and
  percentiles describe players, not lucky samples. (For consistency, which is itself a spread, the noise is the
  sampling error of a variance, from the number of games and the measured kurtosis.)
- **Sliding window.** Each band pools nearby ratings with Gaussian weights, after correcting for the rating trend,
  and widens where players are scarce.
- **Radar scale.** Each axis is a percentile among all chess.com players of that time control: bands are weighted
  by chess.com's published rating distribution (`tools/rating-dist.json`). "Few blunders" and consistency are
  inverted (fewer, smaller swings = outward).
- **Where it shows.** Insights: the Shape radars (you vs a band's typical player, or a chess.com player with your
  record against them) and By rating. Both radars place each value by its distance from the median player of its time
  control, in units of how much players really differ; each axis stretches to its most extreme value, so outliers
  (a legend's brilliance) stay visible. Performance values are first pulled toward the typical player of the band
  when the sample is small; tooltips give the value and the rating whose typical player matches it.

Rebuild: run the app from source with `CL_SITE=.. CL_PROFILE=../.ladder-build` (that profile also keeps the
computer awake and the window at full speed), then in DevTools `await loadScript('tools/build-ladder.js');
LB.start()` (options: `{ quota, engineGames, minutes }`); when done, save `JSON.stringify(await LB.build())` as
`js/ladder.json`. Progress is kept in the app profile, so a restart resumes it (`LB.load()` reloads it without
crawling).

Maia-3 is AGPL-3.0: if you give the app to other people, offer them the source (see `MAIA.md`).

## Layout

| File | Purpose |
|---|---|
| `js/api.js` | chess.com API, PGN parsing, per-game features for both sides (castling, checks, clocks, sessions) |
| `js/worker.js` | Parses games in parallel Web Workers |
| `js/engine.js` | Stockfish worker wrappers: batch analysis (top-3 lines + stable depth) and the live review engine |
| `js/analysis.js` | Move classification, accuracy, explanations, per-opportunity style records, parallel scan runner |
| `js/analysis-worker.js` | Scores finished games and extracts style records off the main thread during scans |
| `js/insights.js` | Aggregates: overview, openings, habits, style profile, analytics, engine-scan stats, report rules |
| `js/views.js` | Tab renderers and charts |
| `js/review.js` | Game review: board, variations, live lines, coach, eval graph |
| `js/sources.js` | Game sources: chess.com accounts, chess.com titled lists, Lichess exports, PGN Mentor OTB careers; shared picker UI |
| `js/tree.js` | Opening trees (position → moves, counts, results), main lines, weak/strong spots, repertoire-clash prediction |
| `js/prepare.js` | Prepare tab: play against a player's repertoire |
| `js/h2h.js` | Head to head tab: direct record, side-by-side stats, opening clash |
| `js/bot.js` | Player bot: book + Maia-3, rating-offset fit, held-out evaluation, move prediction |
| `js/fidelity.js` | High fidelity: Stockfish-scored Maia candidates, per-player mistake calibration (max-likelihood fit) |
| `js/twin.js` | Twin test: you answer positions, the bot answers the same ones, compared |
| `js/blunders.js` | Blunders tab: classifies each blunder from the position, finds when you blunder, prevention rules, blunder drill |
| `js/maia.js`, `js/maia-worker.js` | Maia-3 neural network in the browser (onnxruntime-web, WebGPU or WASM) |
| `js/botview.js` | Player bot tab: build UI, model card, play against the bot |
| `js/match.js` | Bot games engine: plays any set of pairings at once (batched Maia calls), resignation, draw guard |
| `js/arena.js` | Bot arena tab: roster (create / duplicate / edit), drag-and-drop matches, round-robin tournaments, odds, predictions, history |
| `js/famous.js` | The 16 legends (PGN Mentor files, fallback ratings, one-line notes) and monogram avatars |
| `js/style.js` | Style fingerprint: traits vs your own opponents, titles, closest famous player |
| `js/famous-profiles.json` | The legends' precomputed fingerprints (counts from their classical games) |
| `js/puzzles.js`, `js/drills.js`, `js/learn.js` | Train: puzzles and Puzzle Rush, endgame drills, opening practice |
| `js/explorer.js` | Opening explorer: master games (`js/explorer-masters.json`) or your own |
| `js/editor.js` | Board editor: set up any position and ask Stockfish or any bot for its move |
| `js/play.js` | Play a bot at any rating, a legend or your bots, with the coach |
| `js/book.json` | Opening book (positions → ECO/name), built by `node tools/build-book.js` from lichess chess-openings |

Engine evaluations are cached in IndexedDB (room for thousands of games), so re-opening a game or re-running a
scan is instant.

**Big scans.** The Engine scan / Playstyle scan goes up to 1,000 games or every loaded game. It runs one Stockfish
worker per spare CPU core (up to 12), while background workers (`js/analysis-worker.js`) score each finished game, so
the page itself stays free. On a 32-thread machine, 500 games at depth 8 take about a minute; the tab shows an estimate
before you start and the time left while it runs. Load a longer period at the top (e.g. All time) to have more games
to scan.

## How playstyle is measured

Per-move counts (captures per move, game length, decisive-game rate) mostly reflect the opponent and the
kind of game, so the Playstyle tab doesn't use them. Instead it uses **per-opportunity** rates from
Stockfish's top 3 moves in every position:

- **Skill:** in *only-move* positions (best beats the runner-up by 10+ win-% points; escaping check,
  captures and moving an attacked piece away excluded), how often the player found it. It also counts how often
  they kept the advantage after an opponent mistake. Both are split out for *hard* cases, where the
  engine itself needed depth 5+ to settle on the move.
- **Preferences:** only positions where two kinds of move (e.g. forcing vs quiet) were both within 3 win-%
  points of the best and the player chose one of those good moves. Recapture situations are excluded.
- **Sacrifices / brilliant moves:** sound-sacrifice opportunities taken, soundness of sacrifices played,
  and brilliant moves found.

Every rate is shown with a 90% range and next to the **opponents' rate in the same games**, which cancels
out opponent strength and game type.

**Style fingerprint and title.** Each trait is a pair of rates, the player's and their opponents' in the same games:
the engine choices above (sacrifices, forcing moves, trades, pawn storms) plus habits that need no engine — checks,
captures, pawn moves, castling by move 10, castling queenside, early queen, and on chess.com also time trouble,
finishing with more clock than the opponent, and resigning lost games versus playing on. A trait counts only when the
difference is both clear (|z| ≥ 2.5) and big enough to notice (Cohen's h ≥ 0.1). The first version used certainty
alone, and with thousands of moves a 1-point difference in checks was "certain", so most players ended up
"check-happy". The title takes its noun from the strongest trait and its adjective from the next one
("Harassing classicist", "Simplifying technician"). With nothing confirmed it says "Balanced, leaning …" when a big
but unconfirmed difference exists. Every trait in the title is backed by a sentence with both rates.

**Plays most like.** The legends were measured the same way (habits on 200 classical games each, engine choices on
150 at depth 8; `js/famous-profiles.json`). The closest is the smallest distance over shared traits, each scaled by
how much that trait varies among the legends.

**Brilliant moves** are found in two stages. The quick rule from the scan's search: within 2 win-% of best, the mover
not losing (≥ 50%) and not already completely winning (< 92%), a piece left en prise, and the piece wasn't already
lost where it stood (a "desperado" doesn't count). Each candidate is then re-searched at depth 14 (top 3 lines) and
kept only if it is still within 3 win-% of best and leaves the mover at 50% or better. Unconfirmed candidates become
best/excellent. The Playstyle tab shows how many candidates were confirmed. On the legends' 2,400 classical games,
327 of 401 candidates (82%) held up.
A move that was one of the engine's top 3 is scored from that same search, which keeps search-to-search
noise from inventing errors for very accurate players.

## Blunders

The Blunders tab uses the engine scan (shared with the Engine scan and Playstyle tabs). A blunder is any move that gives
away 20+ win-% points, including failing to punish the opponent's mistake when that costs as much.

- **What went wrong.** Each blunder is diagnosed from the position. The engine's refutation line is played out, and
  attack maps tell what happened. Loose pieces: moved a piece to an unsafe square, left another piece undefended,
  took poisoned material. The opponent's threats: ignored a piece that was already attacked, fork, pin or skewer,
  discovered attack, a combination starting with a check, a quiet threat, or a longer combination where material
  falls after six moves. King safety: back-rank mate or other mating attack. Missed chances: a forced mate, a free
  piece, a winning tactic, or not punishing a mistake. Endgame technique: let a pawn promote, miscalculated an
  endgame. Strategy: lost time in the opening, traded into a worse position, weakened the position. Each kind has a
  concrete habit that prevents it.
- **When you blunder.** Blunders per 100 moves when moving quickly (under about a third of your usual time for that
  game, from the clock data), in time trouble, while clearly winning, right after the opponent captured or gave
  check, and by phase, each against the rest of your moves. "While losing" is left out: win-% losses shrink once a
  game is lost, so it would measure the scale rather than you.
- **Your three rules.** The prevention habits for your two biggest kinds of blunder, plus the riskiest situation.
- **Are you blundering less?** Your scanned games in date order, in equal groups of about 12, with blunders per
  game by kind in each, plus your newer half of games against your older half. (Calendar months were too uneven:
  one player had 7 games in August and 83 in October.)
- **Blunder drill**, two modes, each with a running score. *Stay safe*: your own blunder positions; play any move
  that doesn't blunder (under 12 win-% lost). *Find the win*: positions where you missed a mate, a free piece or a
  winning tactic; find the move (within 5 win-% of best). Stockfish checks each answer, then shows what you played
  in the game, the refutation or winning line, and the habit behind it.
- **In Review**, every mistake and blunder gets the same diagnosis in the coach panel (kind, refutation, habit).
- **In the report**, your biggest kind of blunder, your riskiest situation (1.5× or more) and a clear change in your
  blunder rate (25% or more) appear as findings.
- **Every blunder** in a table, most costly first, each opening in Review.

On gogangoblin's last 92 games (depth 10): 237 blunders, 2.6 per game. 40% came from the opponent's threats, most
often a piece that was already attacked; 21% from loose pieces; 17% from missed chances. Middlegame moves carried
2.3 times the blunder rate of the rest.

## Prepare & head to head

- **Prepare** builds an opening tree (first 30 plies, transpositions merged) from any source and plays the
  target's moves at you — most common, or weighted by frequency — with their results per move, the replies
  that have worked against them ("best try"), their main lines, and weak/strong spots. Stockfish can take
  over once they're out of book. Pick yourself to practise against your own repertoire.
- **Head to head** compares you with another chess.com player over the same period: your games against each
  other, ratings, results, both rating curves, the likely opening when your repertoires meet, a **playstyle**
  comparison (habit radar with each player measured against their own opponents, plus an optional engine-verified
  per-opportunity comparison) and **analytics** overlays (opponent strength, pressure situations, session fatigue,
  game length, clock usage, day of week).
- The **Playstyle** tab draws two radars: a habit shape (relative to your opponents, 50 = same as them) and, after a
  scan, an engine-verified choice shape (your per-opportunity rates vs your opponents').

## Player bot

The bot tries to play the move a specific player would play.

- **Book:** if the player reached the current position in 3+ of their games, it follows their own choices.
- **Maia-3:** otherwise it uses [Maia-3](https://github.com/CSSLab/maia3) (University of Toronto CSSLab), a neural
  network trained on millions of Lichess games to predict the move a human of a given rating plays, from the
  last 8 positions. It runs in the browser with onnxruntime-web (`js/maia.js`, `js/maia-worker.js`), on the GPU
  via WebGPU where available, otherwise on the CPU. Models: `models/maia3-5m.onnx` (11 MB) and
  `models/maia3-23m.onnx` (46 MB; better for strong players), built by `tools/maia-export.py`.
- **Personalisation:** the player's ratings are converted to Lichess scale (capped at 2850), then one rating offset is
  fitted to their own moves (the strength that best explains how they actually play).
- **Testing:** every 5th game is held out. The model card shows how often the bot's top choice was the player's real
  move, next to "always play Stockfish's top move" (depth 10) on the same positions.
- **Modes:** "most likely move" plays the top choice; "like them" samples from the probabilities, so it also
  makes the kind of mistakes the player makes.
- **Fidelity:** *High* (the default) calibrates the bot to the player's real accuracy with Stockfish (below);
  *Standard* is Maia alone, which is fast. Up to 300 games can be used; more games give a sharper calibration.

### High fidelity (`js/fidelity.js`)

Maia's probabilities are spread over several moves mostly because the model can't tell which one this player would
pick, not because the player picks at random. Sampling them as if they were the player's own randomness made strong
players' bots err far too often: a bot of Hikaru gave away 30+ win-% points four times as often as Hikaru does, and a
bot of a ~1350 player (jcbmrk) took 2 wins and 3 draws from it in 100 games. Weak players' bots erred slightly too rarely.

High fidelity scores each of Maia's candidates with Stockfish (depth 10) and reweights them:
`P(move) ∝ p_maia^a · exp(θ[loss band] + adjustments for winning/losing, opening/endgame and time trouble
+ β·[Stockfish's top move])`. The loss bands are <1, 1–3, 3–8, 8–15, 15–30 and 30+ win-% points. The weights are
fitted by maximum likelihood on the player's own moves (a convex fit, solved with Newton's method). At the optimum,
the bot's expected share of each kind of mistake equals the player's, overall and in each situation and phase.
Time trouble (under 10% of the clock, from chess.com clock data) is learned separately, and the bot, which has no
clock, plays at the player's with-time-to-think rates. Adjustments have a tighter prior, so thin data falls back to
the player's overall rates. Building takes 1–5 minutes; Stockfish's scores are cached in IndexedDB, so rebuilding is quick.

Measured on held-out games (hikaru, 80 recent blitz games, 611 test moves):

| | Real Hikaru | Standard bot | High fidelity |
|---|---|---|---|
| Moves losing 30+ win-% (blunders) | 0.3% | 1.2% | 0.3% |
| Moves losing 15–30 | 2.5% | 4.0% | 1.6% |
| Moves losing 8+ in the middlegame / endgame | 11.9% / 7.0% | 18.7% / 10.7% | 10.4% / 5.9% |
| Predicts his exact move (out of book) | – | 57.6% | 62.7% |

Hikaru vs jcbmrk, 100 games each with both bots on high fidelity, run twice: 98–1–1 and 100–0–0.

The legends had the same problem. On their own classical games (120 each), standard bots gave away 30+ win-% points
3–12 times as often as the players did: Capablanca 1.6% vs 0.3%, Fischer 1.6% vs 0.2%, Botvinnik 1.2% vs 0.1%.
High fidelity matches every one of them and predicts their moves 2–4 points more often (e.g. Fischer 58% → 62%).
Fischer vs a ~1000 club player's bot: 10–0, with no blunders. For a club player
(gogangoblin), Maia's odds were already about right; high fidelity and plain Maia predict the same share of moves
(55–56%) and blunder at about the real rate. What didn't help: Stockfish depth 12 instead of 10 (no better on
held-out moves, 2.5× slower), and per-player fine-tuning of the network (see `MAIA.md`).

### Twin test (`js/twin.js`)

Once a bot is built, the Player bot tab offers a **twin test** for the person it's based on: play the move you'd
really play in 24 positions, and the bot answers each one without seeing yours. Half the positions come from your own
older games (games the bot didn't learn from, up to a year back), half from your recent opponents' games, so you've
never seen them. The tab tracks how often the bot's first choice was your move, against plain Maia. It also tracks
how often you repeated what you played back then. People don't repeat themselves every time, so that figure is the
realistic ceiling for any bot. Answers are saved in the browser, so a test can be continued later.

First run (gogangoblin, bot built from 300 games on high fidelity): the bot's first choice was the player's move in
12 of 24 positions, with their move in its top 3 in 21. In positions from their own older games, the player
repeated what they had played back then only 4 times out of 12, while the bot's first choice matched that past move
6 times. On 1,993 held-out moves from real games, the same bot predicts 59% exactly and 84% in its top 3
(Stockfish's top move: 41%). Twenty-four positions carry about ±20 points of noise, so the held-out figures are the
firmer ones.

Building a bot takes about 20 seconds on a GPU or about a minute on the CPU (80 games). Measured on held-out games
(see `MAIA.md`): gogangoblin ≈ 61% of moves predicted vs 38% for Stockfish's top move; Danny Naroditsky ≈ 59–62% vs 40%.
Per-player fine-tuning of the network was tested and didn't help, so it isn't used.

**Licence:** Maia-3's code and weights are AGPL-3.0. That's fine for personal and local use; if you host Chess Lens
for other people, you may need to offer its source under AGPL-compatible terms (see `MAIA.md`).

The previous hand-built model (engine top-8 candidates plus style features) is kept as `js/bot-legacy.js` for the
comparison page `maia-eval.html`; the app no longer loads it.

## Choosing players

Wherever you pick a player (Prepare, Head to head, Player bot, Bot arena) you can limit it to **one time control
and their most recent N games** — e.g. a friend's last 100 rapid games when their blitz rating is very different.
For chess.com it walks back through the monthly archives until it has N games of that time control; Lichess
filters on its side; famous OTB collections filter by event type. In Head to head, picking a time control for the
other player filters your games to the same one.

## Bot arena

Bots are cards with an avatar, where their games come from, their fitted rating and their style title. **Create bot**
builds one from any chess.com account (optionally one time control, last N games), Lichess account or OTB
collection; **⧉** duplicates any bot (e.g. a legend learning from more games, or "most likely move" mode); bots
are saved in the browser. The **16 legends** (Morphy, Capablanca, Alekhine, Botvinnik, Tal, Petrosian, Spassky,
Fischer, Karpov, Kasparov, Judit Polgar, Anand, Kramnik, Carlsen, Nakamura, Caruana) learn from their most recent
120 classical OTB games in PGN Mentor's database. Games without ratings (anything before ~1970) fall back to a
historical estimate.

- **Match:** drag a bot onto White and another onto Black (or press ＋), choose 2–100 games, colors alternate.
- **Tournament:** drag 3–10 bots into the round robin. "Build bots & show odds" simulates it 4,000 times from the
  bots' ratings. Friends enter 1st/2nd/3rd predictions, scored 5/3/2 for an exact place and 1 for a top-3 finisher in
  another place. Results: standings (Sonneborn–Berger tiebreak), crosstable, prediction table, every game openable
  in Review, and a copy-to-share summary.
- **History** keeps the last 30 matches and tournaments.
- **Fidelity:** bots are built on high fidelity unless you choose Standard in the bot's form. The legends' calibration
  is precomputed from their classical games (`js/legend-fidelity.json`), so they build without a Stockfish pass.
- **Known limit:** Maia-3's strength scale tops out near Lichess 2850, so every legend's rating fits to the ceiling.
  High fidelity is what separates them: each errs as often as they did in their own classical games.

### How bot games are played

Each bot uses its player's opening book, then Maia-3 at the strength fitted to their games, reweighted by high
fidelity. The sampling and blunder-check rules below apply to Standard bots.

- **Sampling:** moves are drawn only from the plausible ones (the smallest set covering 90% of Maia's probability,
  each at least 2%), and never a stalemating move unless it's Maia's top choice. Drawing from the full tail let
  rare blunders and stalemates with mate on the board creep into long games.
- **Equal-strength conditioning:** each bot's Maia call assumes an opponent of its own strength. Maia learned from
  Lichess, where huge rating gaps barely occur, and its win estimate is dominated by the rating gap; told "you're
  1350 facing 2650" it played and resigned strangely. Strength differences still come from each bot's own rating.
- **Blunder check:** Maia picks moves by pattern without calculating, so a strong player's bot could play a
  natural-looking move that hangs the queen. Every Maia move gets a quick Stockfish check (depth 8); a move losing
  40+ win-% points (roughly a piece or worse) is kept only as often as the player really makes such blunders,
  measured on up to 30 of their own games in the same time control. Applies in the Bot arena, on Play and when you play a Player bot.
- **Resignation:** when Maia's position-based estimate stays under 5% for three of its moves *and*, allowing for the
  rating gap, the bot is still not favored — a GM down a queen against a beginner plays on. Games stop at 150 moves.
- **Time control matters:** a bot built from someone's bullet games blunders like they do in bullet. Pick their rapid
  games to model slower play.
- **Known gap (Standard only):** the check can only remove blunders, so Standard bots of club players make big
  blunders less often than the real players do (e.g. 0.5% vs 2.2% of moves). High fidelity matches the real rate.
- **Calibration check:** club bots miss a mate-in-1 about 32% of the time, matching the same players' real games (30–34%).
The page shows the score with a 95% range next to the rating-based expectation, every game (watch it live or
open it in Review), results by color and the openings played. A 20-game match takes under a minute on a GPU.
