import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  capChunks,
  chunkDocumentText,
  chunkTabularText,
  MAX_TABULAR_CHUNKS,
} from '../src/main/document-memory/chunks'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-cost-control-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('chunk caps', () => {
  it('caps ordinary documents and reports truncation', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} ${'x'.repeat(480)}`).join(
      '\n\n',
    )
    const chunks = chunkDocumentText(text)
    const max = 400
    expect(chunks.length).toBeGreaterThan(max)
    const capped = capChunks(chunks, max)
    expect(capped.chunks).toHaveLength(max)
    expect(capped.truncated).toBe(true)
    expect(capChunks(chunks.slice(0, 5))).toEqual({ chunks: chunks.slice(0, 5), truncated: false })
  })

  it('indexes a huge CSV as header plus sampled rows within the tabular budget', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => `${i},${i * 3},${i % 7},north`)
    const result = chunkTabularText(['id,amount,bucket,region', ...rows].join('\n'))
    expect(result.chunks.length).toBeLessThanOrEqual(MAX_TABULAR_CHUNKS)
    expect(result.truncated).toBe(true)
    expect(result.numeric).toBe(false) // "north" keeps ~25% letters in this sample
    expect(result.chunks.every((c) => c.text.startsWith('id,amount,bucket,region\n'))).toBe(true)
    expect(result.chunks.every((c) => c.text.length <= 500)).toBe(true)
    expect(result.chunks[0]!.location).toMatch(/^Sampled rows 2-/)
  })

  it('keeps small tables whole and flags purely numeric data for lexical-only storage', () => {
    const small = chunkTabularText('name\tphone\nAn\t0912345678\nBinh\t0987654321')
    expect(small.truncated).toBe(false)
    expect(small.chunks).toHaveLength(1)
    expect(small.chunks[0]!.location).toBe('Rows 2-3')

    const numeric = chunkTabularText(
      ['t,v', ...Array.from({ length: 50 }, (_, i) => `${i},${i * 1.5}`)].join('\n'),
    )
    expect(numeric.numeric).toBe(true)
    expect(chunkTabularText('').chunks).toEqual([])
  })
})

describe('store', () => {
  it('adds the truncated column to databases created before it existed without losing data', () => {
    const dbPath = join(dir, 'old.db')
    const old = new DatabaseSync(dbPath)
    old.exec(`CREATE TABLE documents (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL,
      mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT, error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      last_opened_at INTEGER NOT NULL DEFAULT 0, priority_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO documents(path, name, status, hash) VALUES ('${join(dir, 'kept.txt').replace(/'/g, "''")}', 'kept.txt', 'ready', 'h');`)
    old.close()
    const store = new DocumentMemoryStore(dbPath)
    try {
      const doc = store.documentByPath(join(dir, 'kept.txt'))
      expect(doc).toMatchObject({ status: 'ready', hash: 'h', truncated: false })
    } finally {
      store.close()
    }
  })

  it('persists the truncated flag and exposes indexedAt/truncated on hits', () => {
    const store = new DocumentMemoryStore(join(dir, 'm.db'))
    try {
      const path = join(dir, 'big.csv')
      writeFileSync(path, 'x')
      store.replaceDocument(path, {
        hash: 'h',
        mtimeMs: 5,
        sizeBytes: 1,
        chunks: [{ text: 'sampled okapi row', location: 'Sampled rows 2-9' }],
        embeddingModel: null,
        status: 'ready',
        truncated: true,
      })
      const [hit] = store.search('okapi', null)
      expect(hit).toMatchObject({ path, truncated: true })
      expect(hit!.indexedAt).toBeGreaterThan(1_600_000_000_000)
      expect(store.folderChunkProgress(dir).truncatedFiles).toBe(1)
    } finally {
      store.close()
    }
  })

  it('tombstones documents fully but never an excluded one', () => {
    const store = new DocumentMemoryStore(join(dir, 't.db'))
    try {
      const a = join(dir, 'a.txt')
      const b = join(dir, 'b.txt')
      for (const path of [a, b])
        store.replaceDocument(path, {
          hash: path,
          mtimeMs: 1,
          sizeBytes: 1,
          chunks: [{ text: 'tombstone candidate', location: 'Chunk 1', vector: [1, 0] }],
          embeddingModel: 'm',
          status: 'ready',
        })
      store.exclude(b)
      expect(store.tombstone(a)).toBe(true)
      expect(store.tombstone(b)).toBe(false)
      expect(store.documentByPath(a)).toBeNull()
      expect(store.documentByPath(b)?.status).toBe('excluded')
      expect(store.search('tombstone', [1, 0], 5, 'm')).toEqual([])
      expect(store.stats()).toMatchObject({ docs: 0, chunks: 0, vectors: 0 })
    } finally {
      store.close()
    }
  })

  it('counts error documents without scanning chunks', () => {
    const store = new DocumentMemoryStore(join(dir, 'e.db'))
    try {
      const ok = join(dir, 'ok.txt')
      const bad = join(dir, 'bad.txt')
      const hidden = join(dir, 'hidden.txt')
      store.replaceDocument(ok, {
        hash: 'h',
        mtimeMs: 1,
        sizeBytes: 1,
        chunks: [{ text: 'fine', location: 'Chunk 1' }],
        embeddingModel: null,
        status: 'text-only',
      })
      store.markError(bad, 'boom', null)
      store.markError(hidden, 'boom', null)
      store.exclude(hidden)
      expect(store.errorCount()).toBe(1)
      expect(store.errorCount()).toBe(store.stats().errors)
    } finally {
      store.close()
    }
  })

  it('ranks vectors identically through the typed-array path, including unaligned blobs', () => {
    const store = new DocumentMemoryStore(join(dir, 'v.db'))
    try {
      const make = (name: string, vector: number[]) =>
        store.replaceDocument(join(dir, name), {
          hash: name,
          mtimeMs: 1,
          sizeBytes: 1,
          chunks: [{ text: `doc ${name}`, location: 'Chunk 1', vector }],
          embeddingModel: 'm',
          status: 'ready',
        })
      make('near.txt', [0.9, 0.1, 0])
      make('far.txt', [0, 0.1, 0.9])
      make('mid.txt', [0.5, 0.5, 0])
      const hits = store.search('zzzz', [1, 0, 0], 3, 'm')
      expect(hits.map((h) => h.name)).toEqual(['near.txt', 'mid.txt', 'far.txt'])
    } finally {
      store.close()
    }
  })
})
