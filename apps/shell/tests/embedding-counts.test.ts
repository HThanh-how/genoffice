import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore, type TruncatedReason } from '../src/main/document-memory/store'

describe('Document Memory V3 Storage Schema & Embedding Counts', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-counts-'))
    dbPath = join(directory, 'doc-memory-v3.sqlite')
    store = new DocumentMemoryStore(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates document_embedding_counts table with correct constraints and cascades on document deletion', () => {
    const rawDb = store.rawDb
    const tables = (
      rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toContain('document_embedding_counts')

    const tableInfo = rawDb.prepare('PRAGMA table_info(document_embedding_counts)').all() as Array<{
      name: string
      type: string
      pk: number
    }>
    const pkColumns = tableInfo.filter((c) => c.pk > 0).map((c) => c.name)
    expect(pkColumns).toEqual(['document_id', 'space_id'])

    // Insert a document and chunks with vectors
    const testPath = join(directory, 'doc-cascade.txt')
    store.replaceDocument(testPath, {
      hash: 'hash-cascade-1',
      mtimeMs: 100,
      sizeBytes: 50,
      chunks: [
        { text: 'Chunk 1 content', location: 'Chunk 1', vector: [0.1, 0.2] },
        { text: 'Chunk 2 content', location: 'Chunk 2', vector: [0.3, 0.4] },
      ],
      embeddingModel: 'space-alpha',
      status: 'ready',
    })

    const doc = store.documentByPath(testPath)
    expect(doc).not.toBeNull()
    const docId = doc!.id

    const count = store.getEmbeddingCounts(docId, 'space-alpha')
    expect(count).toBe(2)

    // Deleting the document should cascade delete from document_embedding_counts
    rawDb.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    const countAfterDelete = store.getEmbeddingCounts(docId, 'space-alpha')
    expect(countAfterDelete).toBe(0)
  })

  it('updates document_embedding_counts incrementally when recording vector batches in recordEmbeddings', () => {
    const testPath = join(directory, 'batch-doc.txt')
    store.replaceDocument(testPath, {
      hash: 'hash-batch-1',
      mtimeMs: 200,
      sizeBytes: 80,
      chunks: [
        { text: 'Passage one', location: 'Chunk 1' },
        { text: 'Passage two', location: 'Chunk 2' },
        { text: 'Passage three', location: 'Chunk 3' },
      ],
      embeddingModel: null,
      status: 'text-only',
    })

    const doc = store.documentByPath(testPath)
    expect(doc).not.toBeNull()
    const docId = doc!.id
    expect(store.getEmbeddingCounts(docId, 'space-beta')).toBe(0)

    // Record first vector batch
    store.setChunkEmbeddings(testPath, 'hash-batch-1', 0, [[0.5, 0.5]], 'space-beta', false)
    expect(store.getEmbeddingCounts(docId, 'space-beta')).toBe(1)
    expect(store.chunkProgress(testPath).completedChunks).toBe(1)

    // Record next 2 vector batches to complete
    store.setChunkEmbeddings(
      testPath,
      'hash-batch-1',
      1,
      [
        [0.6, 0.6],
        [0.7, 0.7],
      ],
      'space-beta',
      true,
    )
    expect(store.getEmbeddingCounts(docId, 'space-beta')).toBe(3)
    expect(store.chunkProgress(testPath).completedChunks).toBe(3)
    expect(store.documentByPath(testPath)?.status).toBe('ready')
  })

  it('persists and validates truncated_reason check constraint in documents table', () => {
    const validReasons: TruncatedReason[] = [
      'chunk-limit',
      'content-limit',
      'pdf-page-limit',
      'tabular-sampling',
    ]

    for (const reason of validReasons) {
      const path = join(directory, `doc-${reason}.txt`)
      store.replaceDocument(path, {
        hash: `hash-${reason}`,
        mtimeMs: 300,
        sizeBytes: 120,
        chunks: [{ text: `Content for ${reason}`, location: 'Chunk 1' }],
        embeddingModel: null,
        status: 'text-only',
        truncated: true,
        truncatedReason: reason,
      })

      const doc = store.documentByPath(path)
      expect(doc).not.toBeNull()
      expect(doc?.truncated).toBe(true)
      expect(doc?.truncatedReason).toBe(reason)

      // Search and ensure hit carries truncatedReason
      const hits = store.search(`Content for ${reason}`, null)
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits[0]?.truncated).toBe(true)
      expect(hits[0]?.truncatedReason).toBe(reason)
    }

    // Direct insertion of an invalid truncated_reason must fail CHECK constraint
    const rawDb = store.rawDb
    expect(() => {
      rawDb
        .prepare(
          `INSERT INTO documents (path, name, status, truncated, truncated_reason)
           VALUES ('/invalid/path', 'invalid.txt', 'text-only', 1, 'invalid-reason')`,
        )
        .run()
    }).toThrow()
  })

  it('ensures V3 chunks table does not contain vector, vector_dim, or normalized columns', () => {
    const rawDb = store.rawDb
    const chunkCols = (
      rawDb.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
    ).map((c) => c.name)

    expect(chunkCols).toContain('id')
    expect(chunkCols).toContain('document_id')
    expect(chunkCols).toContain('chunk_set_id')
    expect(chunkCols).toContain('ordinal')
    expect(chunkCols).toContain('text')
    expect(chunkCols).toContain('location')

    // Columns that MUST be omitted in V3 chunks table
    expect(chunkCols).not.toContain('vector')
    expect(chunkCols).not.toContain('vector_dim')
    expect(chunkCols).not.toContain('normalized')
  })
})
