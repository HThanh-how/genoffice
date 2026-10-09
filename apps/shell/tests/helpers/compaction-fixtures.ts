import { resolve } from 'node:path'
import { DocumentMemoryStore } from '../../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../../src/main/document-memory/embedding-profiles'
import { createStorageBudget, type DocumentIndexStorageBudget } from '../../src/main/document-memory/storage-budget'
import type { CompactionWorkerContext } from '../../src/main/document-memory/runtime/worker-compaction'
import { collectStorageAccounting } from '../../src/main/document-memory/runtime/storage-accounting'

export const PROFILE = EMBEDDING_PROFILES.standard
export const DAY = 86_400_000

/** Deterministic unit vector (same recipe as compaction-contract.test.ts). */
export function vec(seed: number): number[] {
  let a = seed >>> 0
  const v: number[] = []
  let n = 0
  for (let i = 0; i < PROFILE.dimensions; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    const x = a / 4294967296 - 0.5
    v.push(x)
    n += x * x
  }
  return v.map((x) => x / Math.sqrt(n))
}

/** Unique, non-repetitive prose per document so the redundancy analysis finds no boilerplate to compact first. */
export function prose(seed: number, words: number): string {
  let a = (seed * 2654435761) >>> 0
  const out: string[] = []
  for (let i = 0; i < words; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    out.push(`w${(a >>> 8).toString(36)}`)
  }
  return out.join(' ')
}

export type Kind = 'important' | 'low' | 'normal'
export interface SeedDoc {
  name: string
  kind?: Kind
  /** age in days since the file was modified (and, unless `opened` is set, last touched) */
  ageDays: number
  chunks?: number
  /** words per chunk (text bytes); default 120 */
  words?: number
  /** last_opened_at age in days; default never opened */
  openedAgeDays?: number
  vectors?: boolean
}

export interface Seeded {
  path: string
  name: string
  kind: Kind
  ageDays: number
  chunks: number
}

let counter = 0

/** Writes documents through the real store path (chunks + FTS + vectors + counters). */
export function seedDocuments(store: DocumentMemoryStore, dir: string, docs: SeedDoc[], now = Date.now()): Seeded[] {
  store.ensureEmbeddingSpace(PROFILE)
  const out: Seeded[] = []
  for (const d of docs) {
    const idx = counter++
    const path = resolve(dir, d.name)
    const n = d.chunks ?? 10
    const chunks = Array.from({ length: n }, (_, c) => ({
      text: `${prose(idx * 1000 + c, d.words ?? 120)} marker${idx}x${c}`,
      location: `Chunk ${c + 1}`,
      ...(d.vectors === false ? {} : { vector: vec(idx * 1000 + c) }),
    }))
    store.replaceDocument(path, {
      hash: `h${idx}`,
      mtimeMs: now - d.ageDays * DAY,
      sizeBytes: 1000 + idx,
      chunks,
      embeddingModel: d.vectors === false ? null : PROFILE.embeddingId,
      status: d.vectors === false ? 'text-only' : 'ready',
    })
    const kind = d.kind ?? 'normal'
    if (kind === 'important') store.setImportanceOverride(path, 'important')
    if (kind === 'low') store.setImportanceOverride(path, 'low')
    if (d.openedAgeDays !== undefined) {
      store.rawDb.prepare('UPDATE documents SET last_opened_at = ? WHERE path = ?').run(now - d.openedAgeDays * DAY, path)
    }
    out.push({ path, name: d.name, kind, ageDays: d.ageDays, chunks: n })
  }
  store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return out
}

export function vectorCount(store: DocumentMemoryStore, path: string): number {
  return (
    store.rawDb
      .prepare(
        'SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE d.path = ?',
      )
      .get(path) as { c: number }
  ).c
}

export function chunkCount(store: DocumentMemoryStore, path: string): number {
  return (
    store.rawDb
      .prepare('SELECT count(*) AS c FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ?')
      .get(path) as { c: number }
  ).c
}

/** Physical managed bytes exactly as the quota counts them (db + wal + shm + ann + ocr + temp + backups). */
export function physicalBytes(store: DocumentMemoryStore): number {
  return collectStorageAccounting({ dbPath: store.dbPath }).totalManagedBytes
}

/** A budget that puts the current physical size at `ratio` of the SOFT quota. */
export function budgetForRatio(store: DocumentMemoryStore, ratio: number, extra: Partial<DocumentIndexStorageBudget> = {}) {
  store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return createStorageBudget({ maxDatabaseBytes: Math.round(physicalBytes(store) / ratio), version: 1, ...extra })
}

/** Lane context for an in-process "worker" (cooperative yield = setImmediate). */
export function laneContext(store: DocumentMemoryStore, budget: DocumentIndexStorageBudget, version: number | null = 1): CompactionWorkerContext {
  return {
    store,
    getBudget: () => budget,
    getConfigVersion: () => version,
    yieldNow: () => new Promise<void>((r) => setImmediate(r)),
  }
}
