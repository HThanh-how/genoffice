# Local OCR with TrueOCR

GenOffice bundles [TrueOCR 0.1.1](https://github.com/pvd0anh/trueocr), including
the four models from its PyPI wheel, under Apache-2.0. The TypeScript port runs
on the existing `onnxruntime-node` **1.23.2** CPU backend. All four models are
IR 8 / opset 17 and have been loaded and exercised on that exact runtime.
No Python, OpenCV, model download, or additional native dependency is needed
by the application.

In the OCR settings, expand the budget and reading schedule controls:

- **Local OCR** enables/disables the local pass independently of cloud OCR.
- **Automatic** uses TrueOCR then Tesseract on Windows/Linux. macOS first uses
  Apple Vision, then TrueOCR, then Tesseract.
- **Tesseract only** uses only Tesseract locally, including on macOS.
- **Apple Vision** is also available on macOS, with TrueOCR/Tesseract fallback.

Existing settings without an engine key migrate to `auto`; explicit existing
choices are retained. The shared settings contract also accepts `trueocr-vie`.
The RAM guards are 550 MB for Vision, 400 MB for TrueOCR, and 300 MB for Tesseract.

## Pipeline and fallbacks

The full page pipeline runs in the existing index child process: EXIF orientation
and PNG alpha-on-white, projection-profile deskew, orientation model, line
detection (including adaptive small-text redetection), four-connected component
decoding, padded/inverted line crops, width-batched recognition, greedy CTC,
and layout-aware block/line reading order. Sessions are loaded lazily, use one
CPU thread with the CPU arena disabled, serialize inference, and release after
the local batch or on disposal. Excessive line counts are rejected before the
quadratic order model runs. The existing grayscale decoder supports baseline
JPEG and non-interlaced 8-bit gray/RGB/RGBA PNG; other encodings try Tesseract.
JPEG decoding uses its luma plane; small differences from the Python RGB/OpenCV
decode and resampling can change a few characters on degraded images.

An unavailable model or TrueOCR error tries Tesseract. A successful TrueOCR page
also tries Tesseract when empty or when its character-weighted confidence is
below `TRUEOCR_TESSERACT_MIN_CONFIDENCE = 0.80`. A failed/unavailable Tesseract
retry retains the successful TrueOCR result. Stored engine and scoring always
describe the result actually used; sensitivity checks retain both local reads.

Confidence is an uncalibrated CTC peak probability. The 0.80 operating point
(also the reference package's low-confidence marker) selects 0/51 reference
pages in the first benchmark (36 A variants + 15 scans) and 16/77 C pages.
A 0.90 floor would retry 2/51 and 31/77; the lower floor preserves the requested
speed priority. It targets the low-confidence tail, rather than claiming a
validated error detector. For remaining TrueOCR results,
`TRUEOCR_ESCALATION_THRESHOLD = 0.65` applies to the existing
`S = character-weighted confidence × Vietnamese syllable validity` score.
That point selects 0/51 and 26/77 reference pages before local retry, sensitivity
and minimum-text gates. These are sample operating points, not accuracy labels;
re-fit them against reviewed outcomes as more data becomes available.
The TS A/C run reproduces those operating-point counts: 0/36 and 16/77 local
retry candidates; 0/36 and 26/77 scores below 0.65 before the other gates.

The recognizer cannot emit `! ? [ ] = " ° ₫ – …` because these are absent from
`meta.json`. There is **no reliable cheap signal** for missing punctuation on an
otherwise confident page: such pages do not automatically retry. A sparse page
can also legitimately contain little text, so area/text-density heuristics are
not used. Choose Tesseract only when symbol fidelity matters. Handwriting,
stamps, signatures, unfamiliar fonts and table structure remain limitations.

Cloud OCR keeps the existing admission, quota, power/idle, cancellation, privacy
and score machinery. Tesseract's threshold and invoice-number check are unchanged.
Images and sensitive documents retain their existing cloud restrictions.

## Measurements and reproducibility

Reference hardware: Windows, Ryzen 7 8845H, 8 cores / 16 threads. Python reference:
TrueOCR 0.1.1, ORT 1.31.1, one thread. Its original 31-page C run averaged
286.3 ms/page and 151.8 MiB sampled peak RSS, versus Tesseract's 7244.3 ms/page
and 176.9 MiB. The 25.3× speedup is a **Python reference** measurement.

Port measurement (one run, Node 22.19.0 / ORT-node 1.23.2; one thread):

| Set             | Pages | Character agreement | Exact pages | TS / Python mean ms | TS / Python mean sampled peak RSS MiB |
| --------------- | ----: | ------------------: | ----------: | ------------------: | ------------------------------------: |
| A, all variants |    36 |              99.93% |          18 |       836.8 / 657.3 |                         251.6 / 160.1 |
| A, originals    |    12 |                100% |          12 |       789.3 / 634.3 |                         255.0 / 159.9 |
| C, all variants |    77 |              98.69% |          17 |       737.1 / 278.2 |                         229.7 / 151.9 |
| C, originals    |    31 |              98.94% |          13 |       766.4 / 286.3 |                         230.0 / 151.8 |

The observed process peaks were 268.4 MiB (A) and 263.3 MiB (C).
TS timings are slower than Python; the Python 25.3× speedup must not be
attributed to this port. These numbers cover TrueOCR alone, before any Tesseract
retry or cloud work. RSS includes the single Node process and the tsx loader,
not the full Electron app. There is no separate tsx launcher process. The
reference was measured earlier on the same machine, so background load and
runtime versions are not controlled; no claim of statistical significance.

The comparisons use
NFC-normalized, whitespace-collapsed output against the frozen Python JSONL:
character agreement is `1 − sum(edit distance) / sum(max(output lengths))`.
Agreement measures port fidelity, not OCR accuracy. The supplied C PDF text
layer is noisy and the real scans lack reviewed ground truth.

`tools/bench-trueocr.ts` accepts a manifest `[{ id, path }]` and a root directory.
Run `node --import tsx tools/bench-trueocr.ts manifest.json root` with stdout
redirected to a private ignored folder. It excludes initial model load/warm-up
and image-byte reads from page time. Sample the single Node process RSS externally
at 10 ms intervals for peak measurements. Keep all real images, manifests and
raw text out of git; publish only aggregate numbers.

The public synthetic fixture `tests/fixtures/ocr/trueocr-synth.png` and its JSON
golden have identical NFC text in Python and TypeScript. Both read `chủ` as
`chú`; the golden deliberately records the recognizer output, not corrected text.
Real-model tests skip only when model files are absent. Tests also cover the
actual index child process, decoding, engine/RAM selection, migration, local
retry, packaging hashes and the unchanged cloud path.

## Updating models

Obtain a specific upstream wheel, verify its license, then replace the four
ONNX files and `meta.json` in `apps/shell/resources/ocr/trueocr/` together.
Record source version, file bytes and SHA-256 in its README and `manifest.json`;
keep LICENSE beside them. Load every model on the pinned ORT-node version before
changing the default. Never silently upgrade ORT to accommodate new weights.
Review charset/preprocessing/model contracts, regenerate the public golden with
the matching Python package, repeat A/C comparison and threshold calibration,
then run typecheck, lint and the OCR tests. Packaging copies the directory to
`Resources/ocr/trueocr` outside asar and validates required source files;
the existing `node_modules/onnxruntime-node/**` unpack rule ships its native CPU
binding and libraries. A packaged installer on macOS/Linux has not been exercised
by the Windows benchmark.
