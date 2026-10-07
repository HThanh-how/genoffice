import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EmbeddingMigration } from '../src/main/document-memory/embedding-migration'

describe('Embedding Rolling Migration Engine', () => {
  let directory: string
  let store: DocumentMemoryStore
  let migration: EmbeddingMigration

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-migration-'))
    const dbPath = join(directory, 'memory.sqlite')
    store = new DocumentMemoryStore(dbPath)
    // Access internal DB instance from store
    migration = new EmbeddingMigration((store as unknown as { db: import('node:sqlite').DatabaseSync }).db)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('initializes migration target and starts with pending state', () => {
    const docPath = join(directory, 'doc1.txt')
    store.replaceDocument(docPath, {
      hash: 'h-1',
      mtimeMs: 1000,
      sizeBytes: 40,
      chunks: [
        { text: 'Chunk 1', location: 'C1' },
        { text: 'Chunk 2', location: 'C2' },
      ],
      embeddingModel: 'f2llm-v2-80m:v1',
      status: 'ready',
    })

    migration.setTarget('qwen3-embedding-0.6b:v1')
    expect(migration.getTarget()).toBe('qwen3-embedding-0.6b:v1')

    const progress = migration.getProgress()
    expect(progress?.targetSpaceId).toBe('qwen3-embedding-0.6b:v1')
    expect(progress?.totalChunks).toBe(2)
    expect(progress?.completedChunks).toBe(0)
    expect(progress?.state).toBe('pending')
  })

  it('pulls next batch prioritised by documents.priority_at DESC', () => {
    const docOld = join(directory, 'doc-old.txt')
    const docRecent = join(directory, 'doc-recent.txt')

    store.replaceDocument(docOld, {
      hash: 'h-old',
      mtimeMs: 1000,
      sizeBytes: 20,
      chunks: [{ text: 'Old document text', location: 'C1' }],
      embeddingModel: 'f2llm-v2-80m:v1',
      status: 'ready',
    })

    store.replaceDocument(docRecent, {
      hash: 'h-recent',
      mtimeMs: 2000,
      sizeBytes: 20,
      chunks: [{ text: 'Recent opened document text', location: 'C1' }],
      embeddingModel: 'f2llm-v2-80m:v1',
      status: 'ready',
    })

    // Simulate user opening docRecent by setting priority_at
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.prepare('UPDATE documents SET priority_at = 999999 WHERE path = ?').run(docRecent)

    migration.setTarget('qwen3-embedding-0.6b:v1')
    const batch = migration.nextBatch(1)

    expect(batch.chunks).toHaveLength(1)
    expect(batch.chunks[0]?.text).toBe('Recent opened document text')
  })

  it('supports pause and resume without losing progress', () => {
    const docPath = join(directory, 'doc-pause.txt')
    store.replaceDocument(docPath, {
      hash: 'h-pause',
      mtimeMs: 1000,
      sizeBytes: 20,
      chunks: [{ text: 'Pausable chunk', location: 'C1' }],
      embeddingModel: 'f2llm-v2-80m:v1',
      status: 'ready',
    })

    migration.setTarget('target-model')
    migration.pause()
    expect(migration.getProgress()?.state).toBe('paused')

    // Calling nextBatch while paused returns empty
    const pausedBatch = migration.nextBatch(10)
    expect(pausedBatch.chunks).toHaveLength(0)

    migration.resume()
    expect(migration.getProgress()?.state).toBe('running')

    const resumedBatch = migration.nextBatch(10)
    expect(resumedBatch.chunks).toHaveLength(1)
  })

  it('marks migration complete when all chunks have embeddings in target space', () => {
    const docPath = join(directory, 'doc-complete.txt')
    store.replaceDocument(docPath, {
      hash: 'h-complete',
      mtimeMs: 1000,
      sizeBytes: 20,
      chunks: [{ text: 'Final chunk', location: 'C1' }],
      embeddingModel: 'f2llm-v2-80m:v1',
      status: 'ready',
    })

    store.ensureEmbeddingSpace({
      id: 'target-complete',
      embeddingId: 'target-complete',
      repo: 'target-complete',
      revision: 'r1',
      pooling: 'last-token',
      dimensions: 2,
    } as any)
    migration.setTarget('target-complete')
    const batch = migration.nextBatch(10)
    expect(batch.chunks).toHaveLength(1)

    // Commit vector for the chunk
    store.setChunkEmbeddings(docPath, 'h-complete', 0, [[0.5, 0.5]], 'target-complete', true)
    migration.markCompleted(batch.chunks.map((c) => c.chunkId))

    // Pulling next batch when finished triggers complete state
    const emptyBatch = migration.nextBatch(10)
    expect(emptyBatch.chunks).toHaveLength(0)
    expect(migration.isComplete()).toBe(true)
    expect(migration.getProgress()?.state).toBe('complete')
  })
})
