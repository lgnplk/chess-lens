# Export an official Maia-3 checkpoint (huggingface.co/UofTCSSLab) to ONNX for js/maia.js.
#
#   python tools/maia-export.py --maia3-src <folder containing the maia3/ package from github.com/CSSLab/maia3>
#                               --checkpoint maia3-5m.pt --size maia3-5m --out models/maia3-5m.onnx
#
# Graph: history float32 [B, 64, 96] (8 boards x 12 piece planes, oldest first, current last; repeat the
#        current board 8 times when there is no history), elo_self / elo_oppo float32 [B]
#     -> logits_move float32 [B, 4352], logits_value float32 [B, 3] (loss/draw/win for the side to move).
# Weights are stored as float16 and cast back to float32 when the session loads, so the file is half
# the size but every op still runs in float32 (onnxruntime-web's wasm backend has few fp16 kernels).
# Also writes <out>.test.json: a few positions with the PyTorch model's top moves, which
# tools/maia-check.html uses to confirm the browser encoding matches the official one.
import argparse, json, sys, types

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--maia3-src', required=True)
    ap.add_argument('--checkpoint', required=True)
    ap.add_argument('--size', default='maia3-5m')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    sys.path.insert(0, a.maia3_src)

    import torch, chess, onnx
    from onnx import numpy_helper, helper, TensorProto
    import onnxruntime as ort
    from maia3.model_registry import MODEL_SPECS
    from maia3.models import MAIA3Model
    from maia3.dataset import tokenize_board, get_legal_moves_mask
    from maia3.utils import get_all_possible_moves, mirror_move

    spec = next(s for s in MODEL_SPECS if s.name == a.size)
    cfg = types.SimpleNamespace(**spec.config, device='cpu')
    model = MAIA3Model(cfg)
    ckpt = torch.load(a.checkpoint, map_location='cpu', weights_only=True)
    sd = ckpt['model_state_dict'] if isinstance(ckpt, dict) and 'model_state_dict' in ckpt else ckpt
    missing, unexpected = model.load_state_dict({k.replace('smolgen', 'gab'): v for k, v in sd.items()}, strict=False)
    if missing or unexpected:
        sys.exit(f'checkpoint mismatch: missing {missing[:5]} unexpected {unexpected[:5]}')
    model.eval()
    print(f'{a.size}: {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M parameters')

    # RMSNorm has no ONNX op before opset 23: spell it out
    def rms_forward(self, x):
        eps = self.eps if self.eps is not None else torch.finfo(x.dtype).eps
        y = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps)
        return y * self.weight if self.weight is not None else y
    for mod in model.modules():
        if isinstance(mod, torch.nn.RMSNorm):
            mod.forward = types.MethodType(rms_forward, mod)

    class Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, history, elo_self, elo_oppo):
            lm, lv, _ = self.m(history, elo_self, elo_oppo)
            return lm, lv

    w = Wrapper(model).eval()
    dummy = (torch.zeros(2, 64, 96), torch.full((2,), 1500.0), torch.full((2,), 1500.0))
    tmp = a.out + '.fp32.onnx'
    torch.onnx.export(w, dummy, tmp, input_names=['history', 'elo_self', 'elo_oppo'],
                      output_names=['logits_move', 'logits_value'], opset_version=17, dynamo=False,
                      dynamic_axes={'history': {0: 'b'}, 'elo_self': {0: 'b'}, 'elo_oppo': {0: 'b'},
                                    'logits_move': {0: 'b'}, 'logits_value': {0: 'b'}})

    # float16 storage for big float initializers, each followed by a Cast back to float32
    m = onnx.load(tmp)
    g = m.graph
    keep, casts = [], []
    for init in g.initializer:
        arr = numpy_helper.to_array(init)
        if arr.dtype == np.float32 and arr.size >= 256:
            h = numpy_helper.from_array(arr.astype(np.float16), init.name + '__f16')
            keep.append(h)
            casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + '__cast'))
        else:
            keep.append(init)
    del g.initializer[:]
    g.initializer.extend(keep)
    nodes = casts + list(g.node)
    del g.node[:]
    g.node.extend(nodes)
    onnx.checker.check_model(m)
    onnx.save(m, a.out)

    # Reference positions: official tokenizer + legal-move mask, PyTorch fp32 model
    all_moves = get_all_possible_moves()
    move_idx = {mv: i for i, mv in enumerate(all_moves)}
    fens = [
        chess.STARTING_FEN,
        'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 1 5',
        'r2q1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 0 9',
        '8/5P2/8/8/2k5/8/5K2/8 w - - 0 60',
        '8/8/8/2K5/8/8/1p3k2/8 b - - 0 70',
        'r3k2r/ppp2ppp/2n1bn2/2bqp3/8/2NP1NP1/PPPQ1PBP/R1B1K2R b KQkq - 4 9',
    ]
    sess = ort.InferenceSession(a.out)
    tests = []
    for fen in fens:
        b = chess.Board(fen)
        tok = tokenize_board(b).repeat(1, 8)[None]
        mask = get_legal_moves_mask(b, move_idx)
        for elo in (1100, 1900):
            e = torch.tensor([float(elo)])
            with torch.no_grad():
                lm, lv = w(tok, e, e)
            lm = lm[0].masked_fill(~mask, float('-inf'))
            p = torch.softmax(lm, -1)
            olm, _ = sess.run(None, {'history': tok.numpy(), 'elo_self': e.numpy(), 'elo_oppo': e.numpy()})
            po = torch.softmax(torch.tensor(olm[0]).masked_fill(~mask, float('-inf')), -1)
            top = torch.topk(p, min(5, int(mask.sum())))
            moves = [all_moves[i] if b.turn == chess.WHITE else mirror_move(all_moves[i]) for i in top.indices.tolist()]
            tests.append({'fen': fen, 'elo': elo, 'top': [[mv, round(pr, 5)] for mv, pr in zip(moves, top.values.tolist())],
                          'maxProbDiffOnnx': float((p - po).abs().max())})
    worst = max(t['maxProbDiffOnnx'] for t in tests)
    print(f'ONNX vs PyTorch, largest move-probability difference: {worst:.2e}')
    with open(a.out + '.test.json', 'w') as f:
        json.dump({'model': a.size, 'tests': tests}, f, indent=1)
    import os
    os.remove(tmp)
    print(f'wrote {a.out} ({os.path.getsize(a.out) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
