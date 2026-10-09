# Embedding model hosting

The default search model (Bekko a8m) is about 164 MB. Hugging Face can be slow or blocked
from some networks, so the app tries the project's own mirrors first and falls back to
Hugging Face (the canonical origin). The code is in
`apps/shell/src/main/document-memory/embedding/` (`model-mirrors.ts`, `model-transfer.ts`,
`model-files.ts`).

## Source order

For a profile flagged `mirrorable` (Base and Balanced, both MIT) each file is tried at:

1. d2x: `https://d2x.clouds.io.vn/models/<repo>/<revision>/<path>`
2. GitHub release asset:
   `https://github.com/HThanh-how/genoffice/releases/download/models-<revision[0:10]>-<repo with / as _>/<path with / as ->`
3. Hugging Face: `https://huggingface.co/<repo>/resolve/<revision>/<path>`

Mirrors are untrusted. The sha256 and exact byte size pinned in `embedding/model-specs.ts`
are the only trust anchor; a source that serves other bytes is discarded and the next one is
tried. Requests carry only `Range` and `Accept-Encoding: identity`, never cookies or user data.

`GENOFFICE_MODEL_MIRRORS` replaces the built-in mirrors (comma-separated URL templates; an
empty value means Hugging Face only). Placeholders: `{repo}` `{revision}` `{path}`, and the
derived `{rev10}` `{repoSlug}` `{asset}`.

## Bekko a8m (`hotchpotch/bekko-embedding-v1-a8m`)

Revision `c721113d59a1d91b447450324f51c4b3332c924a`, tag `models-c721113d59-hotchpotch_bekko-embedding-v1-a8m`.

| Manifest path | d2x path under the revision folder | GitHub asset | Bytes | sha256 |
| --- | --- | --- | --- | --- |
| `tokenizer.json` | `tokenizer.json` | `tokenizer.json` | 34,363,442 | `8bd47075711f75a143d1b78e01a41cc65c1c591b00d3cfeffc23db07adce1392` |
| `tokenizer_config.json` | `tokenizer_config.json` | `tokenizer_config.json` | 46,634 | `2ee40d1066ac855e1ea38ac422dbe1f3ddf84c9d415e79272adce569668f3de4` |
| `onnx/model.onnx` | `onnx/model.onnx` | `onnx-model.onnx` | 130,099,079 | `96d8cc6199e96357b21b2fb12f6d7ffd2d4abc7b182fe94b5468fbd6dc819af7` |

a25m (`balanced`) follows the same layout with its own revision; `tools/publish-embedding-model.mjs --model a25m` prints it.

## HTTP requirements

- `Range: bytes=N-` answered with `206` and a matching `Content-Range` (resume). A server that
  answers `200` still works, but every interruption restarts that file.
- `Content-Length` on every response; no `Content-Encoding` (disable gzip for these paths).
- Immutable paths: the revision is in the URL, never overwrite a file; a new revision is a new folder or tag.
- CORS is not needed: downloads run in a Node process, not in a page.
- GitHub assets are served through a redirect; the client follows it.

## Licence

Bekko a8m and a25m are MIT: keep the upstream `LICENSE` file next to the weights (the
publish script includes a `LICENSE` file from the source directory when present).
EmbeddingGemma-2 is under the Gemma terms and must not be mirrored: its profiles
(`mid`, `plus`) and the legacy profiles have `mirrorable: false` and only use their origin.

## Publishing

Put the verified files at their manifest paths in one directory (plus `LICENSE`), then:

```
node --no-warnings tools/publish-embedding-model.mjs <dir> [--model a8m|a25m]
```

The script re-checks size and sha256 against `model-specs.ts` and only then prints (it runs
nothing) the staging commands, a `gh release create ... --prerelease --latest=false` command
(keeps the model release away from the auto-updater feed) and the `rsync` layout for d2x.
Review the output, then run it by hand.
