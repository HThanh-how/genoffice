import { resolve } from 'node:path'
import { DocumentMemoryStore } from '../../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../../src/main/document-memory/embedding-profiles'

export const SEED_PROFILE = EMBEDDING_PROFILES.standard

/** Deterministic xorshift PRNG so every run seeds byte-identical corpora. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

const SYLLABLES = [
  'ba', 'be', 'bo', 'ca', 'co', 'cu', 'da', 'de', 'do', 'ga', 'ha', 'he', 'ho', 'ke', 'la', 'le', 'lo', 'ma', 'me', 'mo',
  'na', 'ne', 'no', 'pa', 'pe', 'po', 'ra', 're', 'ro', 'sa', 'se', 'so', 'ta', 'te', 'to', 'va', 've', 'vo', 'xa', 'xu',
  'ng', 'nh', 'th', 'tr', 'ch', 'kh', 'qu', 'gi',
]

/** Zipf-ish vocabulary: a few very common words and a long tail of rare ones (realistic FTS posting lists). */
export function makeVocabulary(size: number, rng: () => number): string[] {
  const words = new Set<string>()
  while (words.size < size) {
    const n = 1 + Math.floor(rng() * 3)
    let w = ''
    for (let i = 0; i <= n; i++) w += SYLLABLES[Math.floor(rng() * SYLLABLES.length)]
    words.add(w)
  }
  return [...words]
}

export function vec(seed: number, dims = SEED_PROFILE.dimensions): number[] {
  let a = seed >>> 0
  const v: number[] = []
  let n = 0
  for (let i = 0; i < dims; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    const x = a / 4294967296 - 0.5
    v.push(x)
    n += x * x
  }
  return v.map((x) => x / Math.sqrt(n))
}

export interface SeedOptions {
  /** Stop when sum(length(chunks.text)) + vector bytes + FTS text bytes reaches this many MB. */
  targetLogicalMb: number
  chunksPerDoc?: number
  wordsPerChunk?: number
  /** Fraction of documents that are byte-identical copies of an earlier document (different path). */
  duplicateDocFraction?: number
  /** Number of chunk texts per document that are shared boilerplate (headers/footers). */
  boilerplateChunksPerDoc?: number
  seed?: number
  /** Store the vectors (false = text-only documents). */
  withVectors?: boolean
}

export interface SeedResult {
  documents: number
  chunks: number
  logicalBytes: number
  /** Sample words usable as FTS queries (frequent, mid and rare). */
  queryWords: string[]
  /** paths of seeded documents in order */
  paths: string[]
}

/** Seeds a store through the real write path (replaceDocument => chunks + chunk_fts + chunk_embeddings). */
export function seedCorpus(store: DocumentMemoryStore, dir: string, options: SeedOptions): SeedResult {
  const rng = makeRng(options.seed ?? 1234)
  const chunksPerDoc = options.chunksPerDoc ?? 40
  const wordsPerChunk = options.wordsPerChunk ?? 110
  const dupFraction = options.duplicateDocFraction ?? 0.05
  const boiler = options.boilerplateChunksPerDoc ?? 2
  const withVectors = options.withVectors ?? true
  const vocab = makeVocabulary(30_000, rng)
  const pick = (): string => {
    // x^3 skews strongly towards index 0 => Zipf-like frequency
    const r = rng()
    return vocab[Math.floor(r * r * r * vocab.length)]!
  }
  const makeText = (): string => {
    const words: string[] = []
    for (let i = 0; i < wordsPerChunk; i++) words.push(pick())
    return words.join(' ')
  }
  const boilerplate = Array.from({ length: 4 }, () => makeText())
  store.ensureEmbeddingSpace(SEED_PROFILE)

  const docs: Array<{ texts: string[] }> = []
  const paths: string[] = []
  let chunks = 0
  let logicalBytes = 0
  let docIndex = 0
  const target = options.targetLogicalMb * 1024 * 1024
  const vectorBytes = SEED_PROFILE.dimensions * 4

  while (logicalBytes < target) {
    let texts: string[]
    if (docs.length > 5 && rng() < dupFraction) {
      texts = docs[Math.floor(rng() * docs.length)]!.texts
    } else {
      texts = Array.from({ length: chunksPerDoc }, (_, c) =>
        c < boiler ? boilerplate[(docIndex + c) % boilerplate.length]! : makeText(),
      )
      docs.push({ texts })
    }
    const path = resolve(dir, `doc-${docIndex}.txt`)
    store.replaceDocument(path, {
      hash: `h${docIndex}`,
      mtimeMs: 1_700_000_000_000 + docIndex * 1000,
      sizeBytes: texts.reduce((n, t) => n + t.length, 0),
      chunks: texts.map((text, c) => ({
        text,
        location: `Chunk ${c + 1}`,
        ...(withVectors ? { vector: vec(docIndex * 100_003 + c) } : {}),
      })),
      embeddingModel: SEED_PROFILE.embeddingId,
      status: withVectors ? 'ready' : 'text-only',
    })
    paths.push(path)
    chunks += texts.length
    for (const t of texts) logicalBytes += t.length * 2 + (withVectors ? vectorBytes : 0)
    docIndex++
  }
  return {
    documents: docIndex,
    chunks,
    logicalBytes,
    queryWords: [vocab[0]!, vocab[3]!, vocab[40]!, vocab[900]!, vocab[12_000]!, vocab[29_000]!],
    paths,
  }
}
