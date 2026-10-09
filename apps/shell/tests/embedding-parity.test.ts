import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { overrideInstalledOrtVersion } from '../src/main/document-memory/embedding/ort-support'
import { embedTexts } from '../src/main/document-memory/embeddings'
import {
  EMBEDDING_PROFILES,
  tieredProfile,
  type EmbeddingProfile,
} from '../src/main/document-memory/embedding-profiles'
import { HARRIER_270M } from '../src/main/document-memory/embedding/model-specs'
import { encodeVectorBlob, decodeVectorBlob } from '../src/main/document-memory/embedding/vector-codec'

/**
 * JS pipeline (embeddings.ts: @huggingface/tokenizers + onnxruntime-node + our pooling) against
 * a Python reference (HF `tokenizers` + onnxruntime + numpy, same ONNX files). Opt in with
 * GENOFFICE_EMBED_PARITY_DIR=<dir holding models/<name>/... and reference.json, which
 * fixtures/embedding-parity/ref.py writes>; the mid profile additionally needs onnxruntime-node >= 1.23
 * (set GENOFFICE_ORT_VERSION to what you aliased in);
 * regular CI never downloads models. GENOFFICE_EMBED_PARITY_ONLY=<name> runs a single model
 * (run harrier270 on its own: it shares the 'mid' profile id with eg2, and the loaded session is cached per id).
 */
const dir = process.env.GENOFFICE_EMBED_PARITY_DIR
const only = process.env.GENOFFICE_EMBED_PARITY_ONLY
const enabled = !!dir && existsSync(join(dir, 'reference.json'))

const harrier: EmbeddingProfile = tieredProfile('mid', 'mid', HARRIER_270M, {
  maxInputTokens: 512,
  maxThreads: 4,
  concurrency: 2,
  heavy: true,
  resizableSession: true,
  memoryMB: 1000,
  minFreeMemoryMB: 1280,
})

const CASES: Array<{ name: string; profile: EmbeddingProfile }> = [
  { name: 'a8m', profile: EMBEDDING_PROFILES.base },
  { name: 'a25m', profile: EMBEDDING_PROFILES.balanced },
  { name: 'eg2', profile: EMBEDDING_PROFILES.mid },
  { name: 'harrier270', profile: harrier },
]

const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2 }
  return dot / Math.sqrt(na * nb)
}

// The temporary vitest config that aliases onnxruntime-node to a newer build also tells us its version.
if (process.env.GENOFFICE_ORT_VERSION) overrideInstalledOrtVersion(process.env.GENOFFICE_ORT_VERSION)

const results: Record<string, unknown> = {}
const cache = enabled ? mkdtempSync(join(tmpdir(), 'genoffice-parity-cache-')) : ''
afterAll(() => {
  if (enabled) {
    const out = join(dir!, only ? `parity-results-${only}.json` : 'parity-results.json')
    writeFileSync(out, JSON.stringify(results, null, 2))
    rmSync(cache, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('embedding pipeline parity against the Python reference', () => {
  for (const { name, profile } of CASES) {
    it.skipIf(!!only && only !== name)(
      `${profile.id}/${name}: cosine >= 0.99 per sentence, int8 close, retrieval finds the passage`,
      async () => {
        const reference = JSON.parse(readFileSync(join(dir!, 'reference.json'), 'utf8'))[name] as {
          passages: number[][]
          queries: number[][]
        }
        const texts = JSON.parse(readFileSync(join(__dirname, 'fixtures/embedding-parity/texts.json'), 'utf8')) as {
          passages: string[]
          queries: string[]
        }
        const target = join(cache, profile.repo, profile.revision)
        mkdirSync(dirname(target), { recursive: true })
        symlinkSync(join(dir!, 'models', name), target)

        const rssBefore = Math.round(process.memoryUsage().rss / 1048576)
        const t0 = performance.now()
        const passages = await embedTexts(texts.passages, 'passage', cache, profile)
        const t1 = performance.now()
        await embedTexts(texts.passages, 'passage', cache, profile)
        const warmMs = (performance.now() - t1) / texts.passages.length
        const t1b = performance.now()
        const queries = await embedTexts(texts.queries, 'query', cache, profile)
        const t2 = performance.now()
        void t1b
        const rss = Math.round(process.memoryUsage().rss / 1048576)
        // peak-ish load: near-limit chunks (~450 tokens) after the short ones
        const long = Array.from({ length: 8 }, (_, i) => texts.passages.slice(i, i + 6).join(' '))
        await embedTexts(long, 'passage', cache, profile)
        const rssLong = Math.round(process.memoryUsage().rss / 1048576)

        expect(passages[0]).toHaveLength(profile.dimensions)
        const pCos = passages.map((v, i) => cosine(v, reference.passages[i]!))
        const qCos = queries.map((v, i) => cosine(v, reference.queries[i]!))
        // the stored int8 blob decodes to (nearly) the same vector
        const blobCos = passages.map((v) => {
          const blob = encodeVectorBlob(v, profile.vectorQuantisation)
          return cosine(decodeVectorBlob(blob, profile.dimensions, profile.vectorQuantisation), v)
        })
        // the int8-rounded passages still retrieve with the float query
        let hits = 0
        queries.forEach((q, qi) => {
          const scores = passages.map((p) => cosine(q, p))
          if (scores.indexOf(Math.max(...scores)) === qi) hits++
        })
        results[name] = {
          profile: profile.id,
          embeddingId: profile.embeddingId,
          dims: profile.dimensions,
          passageCosine: { min: Math.min(...pCos), mean: pCos.reduce((a, b) => a + b, 0) / pCos.length },
          queryCosine: { min: Math.min(...qCos), mean: qCos.reduce((a, b) => a + b, 0) / qCos.length },
          blobCosineMin: Math.min(...blobCos),
          top1: `${hits}/${queries.length}`,
          msPerPassageCold: Math.round((t1 - t0) / passages.length),
          msPerPassageWarm: Math.round(warmMs),
          msPerQuery: Math.round((t2 - t1b) / queries.length),
          rssMBBefore: rssBefore,
          rssMBAfter: rss,
          rssMBDelta: rss - rssBefore,
          rssMBAfterLongChunks: rssLong,
        }
        expect(Math.min(...pCos)).toBeGreaterThanOrEqual(0.99)
        expect(Math.min(...qCos)).toBeGreaterThanOrEqual(0.99)
        expect(Math.min(...blobCos)).toBeGreaterThanOrEqual(0.9995)
        expect(hits).toBeGreaterThanOrEqual(19)
      },
      600_000,
    )
  }
})
