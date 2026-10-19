# Per-player fine-tuning experiment for Maia-3 (offline, PyTorch; a GPU helps but isn't required).
#
#   python tools/maia-finetune.py --maia3-src <folder containing maia3/> --checkpoint maia3-5m.pt --size maia3-5m
#                                 --data player.json [--shift -200] [--out result.json]
#
# player.json is window.MAIA_EVAL.results[...].export from maia-eval.html (the Player bot's own split:
# every 5th game held out), optionally with "extra": more of the player's games (not in the test set)
# to train on. Scores the held-out moves before and after fine-tuning:
#   full  - every weight, small learning rate
#   head  - only the move head (from/to square projections + promotion bias), as a browser could do
#   elo   - only the two rating embeddings (a learned "this player" skill vector)
# Early stopping on the last 15% of training games.
import argparse, copy, json, math, sys, time, types
from collections import deque

CC_TO_LICHESS = [[0, 650], [500, 1000], [1000, 1350], [1500, 1700], [2000, 2050], [2500, 2450], [3300, 3150]]


def cc_to_lichess(r):
    if r is None:
        return 1500
    t = CC_TO_LICHESS
    if r <= t[0][0]:
        return t[0][1]
    for (x0, y0), (x1, y1) in zip(t, t[1:]):
        if r <= x1:
            return y0 + (y1 - y0) * (r - x0) / (x1 - x0)
    return t[-1][1] + (r - t[-1][0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--maia3-src', required=True)
    ap.add_argument('--checkpoint', required=True)
    ap.add_argument('--size', default='maia3-5m')
    ap.add_argument('--data', required=True)
    ap.add_argument('--shift', type=float, default=0)
    ap.add_argument('--modes', default='full,head,elo')
    ap.add_argument('--epochs', type=int, default=12)
    ap.add_argument('--extra', type=int, default=-1, help='how many extra games to train on (-1 = all)')
    ap.add_argument('--out')
    a = ap.parse_args()
    sys.path.insert(0, a.maia3_src)

    import torch, chess
    import torch.nn.functional as F
    from maia3.model_registry import MODEL_SPECS
    from maia3.models import MAIA3Model
    from maia3.dataset import tokenize_board, get_legal_moves_mask
    from maia3.utils import get_all_possible_moves, mirror_move

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    torch.manual_seed(0)
    spec = next(s for s in MODEL_SPECS if s.name == a.size)
    cfg = types.SimpleNamespace(**spec.config, device=dev)
    base = MAIA3Model(cfg)
    ckpt = torch.load(a.checkpoint, map_location='cpu', weights_only=True)
    sd = ckpt['model_state_dict'] if isinstance(ckpt, dict) and 'model_state_dict' in ckpt else ckpt
    base.load_state_dict({k.replace('smolgen', 'gab'): v for k, v in sd.items()}, strict=False)
    base.to(dev).eval()
    moves = get_all_possible_moves()
    midx = {m: i for i, m in enumerate(moves)}

    data = json.load(open(a.data))
    games = data['games']
    if a.extra >= 0:
        data['extra'] = data.get('extra', [])[:a.extra]

    def game_examples(g, plies=None):
        # every move of the player at ply 4..119 (or only `plies`), with the real last-8 history
        out, b, hist = [], chess.Board(), deque(maxlen=8)
        me = g['color'][0] == 'w'
        es, eo = cc_to_lichess(g['me']) + a.shift, cc_to_lichess(g['opp']) + a.shift
        hist.append(tokenize_board(b))
        for i, san in enumerate(g['sans'][:120]):
            try:
                mv = b.parse_san(san)
            except ValueError:
                break
            if b.turn == (chess.WHITE if me else chess.BLACK) and i >= 4 and (plies is None or i in plies):
                h = list(hist)
                h = [h[0]] * (8 - len(h)) + h
                uci = mv.uci() if b.turn == chess.WHITE else mirror_move(mv.uci())
                out.append((torch.cat(h, 1), get_legal_moves_mask(b, midx), midx[uci], es, eo, i))
            b.push(mv)
            hist.append(tokenize_board(b))
        return out

    test_plies, train_plies = {}, {}
    for gi, ply, best, book in data['decs']:
        (test_plies if games[gi]['test'] else train_plies).setdefault(gi, set()).add(ply)
    test = [ex for gi, ps in test_plies.items() for ex in game_examples(games[gi], ps)]
    train_games = [games[gi] for gi in sorted(train_plies)] + data.get('extra', [])
    n_val = max(2, round(len(train_games) * 0.15))
    fit_games, val_games = train_games[:-n_val], train_games[-n_val:]
    fit = [ex for g in fit_games for ex in game_examples(g)]
    val = [ex for g in val_games for ex in game_examples(g)]
    print(f'{data.get("user")}: {len(fit)} training / {len(val)} validation / {len(test)} test positions '
          f'({len(train_games)} training games, {len(data.get("extra", []))} extra), shift {a.shift:+.0f}, {dev}')

    def batches(exs, bs, shuffle=False):
        idx = torch.randperm(len(exs)).tolist() if shuffle else list(range(len(exs)))
        for s in range(0, len(idx), bs):
            ch = [exs[i] for i in idx[s:s + bs]]
            yield (torch.stack([c[0] for c in ch]).to(dev), torch.stack([c[1] for c in ch]).to(dev),
                   torch.tensor([c[2] for c in ch], device=dev), torch.tensor([c[3] for c in ch], device=dev),
                   torch.tensor([c[4] for c in ch], device=dev))

    def logits_of(model, tok, mask, es, eo):
        lm, _, _ = model(tok, es, eo)
        return lm.masked_fill(~mask, float('-inf'))

    @torch.no_grad()
    def score(model, exs):
        model.eval()
        n = t1 = t3 = 0
        ll = 0.0
        for tok, mask, y, es, eo in batches(exs, 256):
            lg = logits_of(model, tok, mask, es, eo)
            lp = F.log_softmax(lg, -1)
            top = lg.topk(3, -1).indices
            t1 += (top[:, 0] == y).sum().item()
            t3 += (top == y[:, None]).any(-1).sum().item()
            ll += lp.gather(1, y[:, None]).clamp_min(-20).sum().item()
            n += len(y)
        return {'n': n, 'top1': t1 / n, 'top3': t3 / n, 'll': ll / n}

    res = {'user': data.get('user'), 'size': a.size, 'shift': a.shift, 'fit': len(fit), 'val': len(val), 'test': len(test),
           'base': {'val': score(base, val), 'test': score(base, test)}}
    print(f"  base   val ll {res['base']['val']['ll']:.3f}  test top1 {res['base']['test']['top1']:.3f} "
          f"top3 {res['base']['test']['top3']:.3f} ll {res['base']['test']['ll']:.3f}")

    for mode in filter(None, a.modes.split(',')):
        m = copy.deepcopy(base)
        for n_, p in m.named_parameters():
            p.requires_grad = (mode == 'full' or
                               (mode == 'head' and n_.split('.')[0] in ('proj_sq_from', 'proj_sq_to', 'promo_bias_proj')) or
                               (mode == 'elo' and n_.startswith('elo_embedding')))
        params = [p for p in m.parameters() if p.requires_grad]
        lr = {'full': 2e-5, 'head': 1e-4, 'elo': 1e-3}[mode]
        opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
        best, best_state, best_ep, t0 = res['base']['val']['ll'], None, 0, time.time()
        for ep in range(1, a.epochs + 1):
            m.train()  # dropout is 0, so this only matters for autograd
            for tok, mask, y, es, eo in batches(fit, 64, shuffle=True):
                loss = F.cross_entropy(logits_of(m, tok, mask, es, eo), y)
                opt.zero_grad()
                loss.backward()
                opt.step()
            v = score(m, val)
            if v['ll'] > best:
                best, best_state, best_ep = v['ll'], copy.deepcopy(m.state_dict()), ep
        if best_state is not None:
            m.load_state_dict(best_state)
        t = score(m, test)
        res[mode] = {'epochs': best_ep, 'valLL': best, 'test': t, 'seconds': round(time.time() - t0, 1),
                     'trainable': sum(p.numel() for p in params)}
        print(f"  {mode:6} val ll {best:.3f} (epoch {best_ep})  test top1 {t['top1']:.3f} top3 {t['top3']:.3f} "
              f"ll {t['ll']:.3f}  [{res[mode]['trainable']} params, {res[mode]['seconds']} s]")

    if a.out:
        json.dump(res, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
