# Python reference for tests/embedding-parity.test.ts (HF `tokenizers` + onnxruntime + numpy).
# Usage: python -I ref.py <parity-dir>   where <parity-dir>/models/{a8m,a25m,eg2,harrier270}/ hold the pinned
# files exactly as listed in embedding/model-specs.ts (a8m = bekko-a8m, a25m = bekko-a25m, eg2 = EmbeddingGemma-2,
# harrier270 = Harrier 270m). Writes <parity-dir>/reference.json. Same recipe as the benchmark's lab.py.
import json, sys, os, numpy as np, onnxruntime as ort
from tokenizers import Tokenizer
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(sys.argv[1])
TASK = 'Given a user query, retrieve the most relevant local document passages. Documents may be in Vietnamese or English.'
SPECS = {
 'a8m':  dict(file='onnx/model.onnx', pool='mean', dim=384, q=lambda t: t, p=lambda t: t),
 'a25m': dict(file='onnx/model.onnx', pool='mean', dim=384, q=lambda t: t, p=lambda t: t),
 'eg2':  dict(file='onnx/model_quantized.onnx', pool='out', dim=512, q=lambda t: 'task: search result | query: ' + t, p=lambda t: 'title: none | text: ' + t, extra=True),
 'harrier270': dict(file='onnx/model_quantized.onnx', pool='out', dim=640, q=lambda t: f'Instruct: {TASK}\nQuery: {t}', p=lambda t: t),
}
texts = json.load(open(os.path.join(HERE, 'texts.json')))
out = {}
for name, s in SPECS.items():
    d = os.path.join(BASE, 'models', name)
    if not os.path.exists(os.path.join(d, s['file'])): continue
    tok = Tokenizer.from_file(os.path.join(d, 'tokenizer.json')); tok.no_padding(); tok.enable_truncation(max_length=512)
    so = ort.SessionOptions(); so.intra_op_num_threads = 2
    sess = ort.InferenceSession(os.path.join(d, s['file']), so, providers=['CPUExecutionProvider'])
    names = [i.name for i in sess.get_inputs()]
    def enc(t):
        e = tok.encode(t); ids = np.array([e.ids], dtype=np.int64); m = np.ones_like(ids)
        feed = {'input_ids': ids, 'attention_mask': m}
        if s.get('extra'):
            for k in ('image_features', 'video_features', 'audio_features'): feed[k] = np.zeros((0, 512), np.float32)
        if s['pool'] == 'mean':
            h = sess.run(['last_hidden_state'], feed)[0][0]; v = h.mean(0)
        else:
            v = sess.run(['sentence_embedding'], feed)[0][0]
        v = v.astype(np.float32); v = v / max(np.linalg.norm(v), 1e-9)   # native, normalised
        v = v[:s['dim']]; v = v / max(np.linalg.norm(v), 1e-9)           # MRL truncate + renormalise
        return v, len(e.ids)
    rec = {'dim': s['dim'], 'passages': [], 'queries': [], 'passageTokens': [], 'queryTokens': []}
    for t in texts['passages']:
        v, n = enc(s['p'](t)); rec['passages'].append([round(float(x), 6) for x in v]); rec['passageTokens'].append(n)
    for t in texts['queries']:
        v, n = enc(s['q'](t)); rec['queries'].append([round(float(x), 6) for x in v]); rec['queryTokens'].append(n)
    # python retrieval sanity
    P = np.array(rec['passages']); Q = np.array(rec['queries'])
    rec['pyTop1'] = [int(i) for i in (Q @ P.T).argmax(1)]
    out[name] = rec
    print(name, 'py top1 hits', sum(1 for i, t in enumerate(rec['pyTop1']) if i == t), '/20', flush=True)
json.dump(out, open(os.path.join(BASE, 'reference.json'), 'w'))
