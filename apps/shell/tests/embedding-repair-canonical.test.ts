import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { writeActiveEmbeddingConfig } from '../src/main/document-memory/storage/embedding-settings'

function floatBlob(length: number): Uint8Array {
  const arr = new Float32Array(length).fill(0.42)
  return new Uint8Array(arr.buffer)
}

describe('Task V3C1b: Canonical Embedding Repair Suite', () => {
  let tempDir: string
  let dbPath: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-repair-test-'))
    dbPath = join(tempDir, 'document-memory.db')
    managers = []
  })

  afterEach(() => {
    for (const m of managers) {
      try {
        m.close()
      } catch {}
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('REPAIR-01: DocumentMemoryManager startup repairs old DB with Qwen 512D metadata but 320D vector rows before counts/semantic query', async () => {
    writeActiveEmbeddingConfig(tempDir, 'high')

    // Seed database with Qwen 512D metadata but 320D vector rows
    const seedStore = new DocumentMemoryStore(dbPath)
    const db = seedStore.rawDb

    db.prepare(`
      INSERT OR REPLACE INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, embedding_model, updated_at)
      VALUES (1, '/docs/qwen-report.pdf', 'qwen-report.pdf', 'ready', 1000, 2048, 'hash1', 2, 2, ?, unixepoch())
    `).run(EMBEDDING_PROFILES.high.embeddingId)

    db.prepare(`
      INSERT OR REPLACE INTO chunks (id, document_id, ordinal, text, location)
      VALUES (101, 1, 0, 'intro text', 'p1'),
             (102, 1, 1, 'body text', 'p2')
    `).run()

    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, ?, 'last-token', 512, 'q8')
    `).run(
      EMBEDDING_PROFILES.high.embeddingId,
      EMBEDDING_PROFILES.high.repo,
      EMBEDDING_PROFILES.high.revision,
    )

    // Insert 320D invalid vectors into Qwen 512D space
    const invalidVec = floatBlob(320)
    db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (101, ?, ?, 320, unixepoch()),
             (102, ?, ?, 320, unixepoch())
    `).run(
      EMBEDDING_PROFILES.high.embeddingId,
      invalidVec,
      EMBEDDING_PROFILES.high.embeddingId,
      invalidVec,
    )

    db.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (1, ?, 2)
    `).run(EMBEDDING_PROFILES.high.embeddingId)

    seedStore.close()

    // Verify initial invalid state before manager startup
    const checkDb = new DatabaseSync(dbPath)
    const initialVectors = checkDb.prepare('SELECT count(*) as cnt FROM chunk_embeddings WHERE space_id = ?').get(EMBEDDING_PROFILES.high.embeddingId) as { cnt: number }
    expect(initialVectors.cnt).toBe(2)
    checkDb.close()

    // Startup DocumentMemoryManager
    const manager = new DocumentMemoryManager(tempDir, { initialEnabled: false })
    managers.push(manager)

    // Verify invalid 320D vectors were purged and document was requeued
    const remainingVectors = manager.store.rawDb.prepare('SELECT count(*) as cnt FROM chunk_embeddings WHERE space_id = ?').get(EMBEDDING_PROFILES.high.embeddingId) as { cnt: number }
    expect(remainingVectors.cnt).toBe(0)

    const doc = manager.store.rawDb.prepare('SELECT status, chunk_done, embedding_model FROM documents WHERE id = 1').get() as { status: string; chunk_done: number; embedding_model: string | null }
    expect(doc.status).toBe('text-only')
    expect(doc.chunk_done).toBe(0)
    expect(doc.embedding_model).toBeNull()

    const counts = manager.store.rawDb.prepare('SELECT coalesce(completed_chunks, 0) as cnt FROM document_embedding_counts WHERE document_id = 1 AND space_id = ?').get(EMBEDDING_PROFILES.high.embeddingId) as { cnt?: number } | undefined
    expect(counts?.cnt ?? 0).toBe(0)

    const ann = manager.store.rawDb.prepare('SELECT state FROM ann_indexes WHERE space_id = ?').get(EMBEDDING_PROFILES.high.embeddingId) as { state: string } | undefined
    expect(ann?.state).toBe('dirty')
  })

  it('REPAIR-02: storage-bootstrap ensureDocumentMemoryStorageReady runs repair on verified V3 storage', async () => {
    writeActiveEmbeddingConfig(tempDir, 'high')

    // Seed database with Qwen 512D metadata but 320D vector rows
    const seedStore = new DocumentMemoryStore(dbPath)
    const db = seedStore.rawDb

    db.prepare(`
      INSERT OR REPLACE INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, embedding_model, updated_at)
      VALUES (1, '/docs/file.docx', 'file.docx', 'ready', 1000, 1024, 'h1', 1, 1, ?, unixepoch())
    `).run(EMBEDDING_PROFILES.high.embeddingId)

    db.prepare(`
      INSERT OR REPLACE INTO chunks (id, document_id, ordinal, text, location)
      VALUES (201, 1, 0, 'some content', 'p1')
    `).run()

    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, ?, 'last-token', 512, 'q8')
    `).run(
      EMBEDDING_PROFILES.high.embeddingId,
      EMBEDDING_PROFILES.high.repo,
      EMBEDDING_PROFILES.high.revision,
    )

    db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (201, ?, ?, 320, unixepoch())
    `).run(EMBEDDING_PROFILES.high.embeddingId, floatBlob(320))

    db.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (1, ?, 1)
    `).run(EMBEDDING_PROFILES.high.embeddingId)

    seedStore.close()

    // Run ensureDocumentMemoryStorageReady
    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(true)

    // Inspect database after bootstrap
    const checkDb = new DatabaseSync(dbPath)
    const remainingVectors = checkDb.prepare('SELECT count(*) as cnt FROM chunk_embeddings WHERE space_id = ?').get(EMBEDDING_PROFILES.high.embeddingId) as { cnt: number }
    expect(remainingVectors.cnt).toBe(0)

    const doc = checkDb.prepare('SELECT status, chunk_done, embedding_model FROM documents WHERE id = 1').get() as { status: string; chunk_done: number; embedding_model: string | null }
    expect(doc.status).toBe('text-only')
    expect(doc.chunk_done).toBe(0)
    expect(doc.embedding_model).toBeNull()
    checkDb.close()
  })

  it('REPAIR-03: Exact-ID matching ignores historical revisions with substring or repo similarity', () => {
    const store = new DocumentMemoryStore(dbPath)
    const db = store.rawDb

    const historicalF2LLM = 'f2llm-v2-80m:ad88d7a126:q8:mean:384:v0'
    const historicalQwen = 'qwen3-embedding-0.6b:older-sha:q8:mean:1024:v0'

    // Seed canonical spaces
    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, ?, 'last-token', 320, 'q8'),
             (?, ?, ?, 'last-token', 512, 'q8')
    `).run(
      EMBEDDING_PROFILES.standard.embeddingId,
      EMBEDDING_PROFILES.standard.repo,
      EMBEDDING_PROFILES.standard.revision,
      EMBEDDING_PROFILES.high.embeddingId,
      EMBEDDING_PROFILES.high.repo,
      EMBEDDING_PROFILES.high.revision,
    )

    // Seed historical spaces sharing substrings and repos
    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'ad88d7a126', 'mean', 384, 'fp32'),
             (?, ?, 'older-sha', 'mean', 1024, 'fp32')
    `).run(
      historicalF2LLM,
      EMBEDDING_PROFILES.standard.repo,
      historicalQwen,
      EMBEDDING_PROFILES.high.repo,
    )

    // Add documents and chunks for historical spaces
    db.prepare(`
      INSERT OR REPLACE INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, embedding_model, updated_at)
      VALUES (10, '/docs/f2llm-old.txt', 'f2llm-old.txt', 'ready', 1000, 100, 'h10', 1, 1, ?, unixepoch()),
             (11, '/docs/qwen-old.txt', 'qwen-old.txt', 'ready', 1000, 100, 'h11', 1, 1, ?, unixepoch())
    `).run(historicalF2LLM, historicalQwen)

    db.prepare(`
      INSERT OR REPLACE INTO chunks (id, document_id, ordinal, text, location)
      VALUES (301, 10, 0, 'c10', 'p1'),
             (302, 11, 0, 'c11', 'p1')
    `).run()

    // Add 384D and 1024D vectors for the historical spaces
    db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (301, ?, ?, 384, unixepoch()),
             (302, ?, ?, 1024, unixepoch())
    `).run(
      historicalF2LLM,
      floatBlob(384),
      historicalQwen,
      floatBlob(1024),
    )

    // Run repair across all spaces
    const repairResult = store.repairInvalidCanonicalEmbeddings()
    expect(repairResult.ok).toBe(true)
    expect(repairResult.deletedEmbeddings).toBe(0)

    // Assert historical spaces metadata was NOT rewritten to canonical values
    const histF2LLMRow = db.prepare('SELECT dimensions, model_revision, pooling, quantization FROM embedding_spaces WHERE id = ?').get(historicalF2LLM) as { dimensions: number; model_revision: string; pooling: string; quantization: string }
    expect(histF2LLMRow.dimensions).toBe(384)
    expect(histF2LLMRow.pooling).toBe('mean')
    expect(histF2LLMRow.quantization).toBe('fp32')

    const histQwenRow = db.prepare('SELECT dimensions, model_revision, pooling, quantization FROM embedding_spaces WHERE id = ?').get(historicalQwen) as { dimensions: number; model_revision: string; pooling: string; quantization: string }
    expect(histQwenRow.dimensions).toBe(1024)
    expect(histQwenRow.pooling).toBe('mean')
    expect(histQwenRow.quantization).toBe('fp32')

    // Assert vectors in historical spaces were NOT deleted
    const countHistVectors = db.prepare('SELECT count(*) as cnt FROM chunk_embeddings WHERE space_id IN (?, ?)').get(historicalF2LLM, historicalQwen) as { cnt: number }
    expect(countHistVectors.cnt).toBe(2)

    store.close()
  })

  it('REPAIR-04: Exact-ID matching with targetSpaceId ignores historical ID when requested', () => {
    const store = new DocumentMemoryStore(dbPath)
    const db = store.rawDb

    const historicalId = 'f2llm-v2-80m:ad88d7a126:q8:mean:384:v0'
    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'ad88d7a126', 'mean', 384, 'fp32')
    `).run(historicalId, EMBEDDING_PROFILES.standard.repo)

    const res = store.repairInvalidCanonicalEmbeddings(historicalId)
    expect(res.ok).toBe(true)
    expect(res.repairedSpaces).toEqual([])
    expect(res.deletedEmbeddings).toBe(0)

    store.close()
  })

  it('REPAIR-05: Transaction rollback restores all changes (metadata, vector, count, status, ANN) on error', () => {
    const store = new DocumentMemoryStore(dbPath)
    const db = store.rawDb

    const targetSpace = EMBEDDING_PROFILES.standard.embeddingId

    // Insert mismatched metadata (e.g. dimensions 512 instead of 320, pooling 'mean' instead of 'last-token')
    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'wrong-rev', 'mean', 512, 'fp32')
    `).run(targetSpace, EMBEDDING_PROFILES.standard.repo)

    db.prepare(`
      INSERT OR REPLACE INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, embedding_model, updated_at)
      VALUES (42, '/docs/rollback.txt', 'rollback.txt', 'ready', 1000, 500, 'h42', 1, 1, ?, unixepoch())
    `).run(targetSpace)

    db.prepare(`
      INSERT OR REPLACE INTO chunks (id, document_id, ordinal, text, location)
      VALUES (401, 42, 0, 'test text', 'p1')
    `).run()

    // Insert invalid 999D vector
    db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (401, ?, ?, 999, unixepoch())
    `).run(targetSpace, floatBlob(999))

    db.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (42, ?, 1)
    `).run(targetSpace)

    db.prepare(`
      INSERT OR REPLACE INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
      VALUES (?, 1, 1, 1, 'ready', unixepoch())
    `).run(targetSpace)

    // Install trigger on documents update to force a rollback in the middle of repair
    db.exec(`
      CREATE TRIGGER fail_documents_update
      BEFORE UPDATE ON documents
      BEGIN
        SELECT RAISE(ABORT, 'Simulated failure during document status update');
      END;
    `)

    const onDirtySpy = vi.fn()

    // Execute repair - must throw due to trigger
    expect(() => {
      store.repairInvalidCanonicalEmbeddings(onDirtySpy)
    }).toThrow('Simulated failure during document status update')

    // Verify callback was NOT called
    expect(onDirtySpy).not.toHaveBeenCalled()

    // Verify all changes were completely rolled back:
    // 1. embedding_spaces metadata was NOT committed
    const spaceMeta = db.prepare('SELECT dimensions, model_revision, pooling, quantization FROM embedding_spaces WHERE id = ?').get(targetSpace) as { dimensions: number; model_revision: string; pooling: string; quantization: string }
    expect(spaceMeta.dimensions).toBe(512)
    expect(spaceMeta.model_revision).toBe('wrong-rev')
    expect(spaceMeta.pooling).toBe('mean')
    expect(spaceMeta.quantization).toBe('fp32')

    // 2. chunk_embeddings invalid row was NOT deleted
    const vectorRow = db.prepare('SELECT vector_dim FROM chunk_embeddings WHERE chunk_id = 401 AND space_id = ?').get(targetSpace) as { vector_dim: number } | undefined
    expect(vectorRow?.vector_dim).toBe(999)

    // 3. document_embedding_counts was NOT deleted
    const countRow = db.prepare('SELECT completed_chunks FROM document_embedding_counts WHERE document_id = 42 AND space_id = ?').get(targetSpace) as { completed_chunks: number } | undefined
    expect(countRow?.completed_chunks).toBe(1)

    // 4. documents status was NOT changed
    const docRow = db.prepare('SELECT status, chunk_done FROM documents WHERE id = 42').get() as { status: string; chunk_done: number }
    expect(docRow.status).toBe('ready')
    expect(docRow.chunk_done).toBe(1)

    // 5. ann_indexes was NOT changed to dirty
    const annRow = db.prepare('SELECT state FROM ann_indexes WHERE space_id = ?').get(targetSpace) as { state: string }
    expect(annRow.state).toBe('ready')

    store.close()
  })

  it('REPAIR-06: Successful repair commits all changes in ONE transaction and triggers onSpaceDirty', () => {
    const store = new DocumentMemoryStore(dbPath)
    const db = store.rawDb

    const targetSpace = EMBEDDING_PROFILES.standard.embeddingId

    // Insert mismatched metadata
    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'wrong-rev', 'mean', 512, 'fp32')
    `).run(targetSpace, EMBEDDING_PROFILES.standard.repo)

    db.prepare(`
      INSERT OR REPLACE INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, embedding_model, updated_at)
      VALUES (55, '/docs/success.txt', 'success.txt', 'ready', 1000, 300, 'h55', 1, 1, ?, unixepoch())
    `).run(targetSpace)

    db.prepare(`
      INSERT OR REPLACE INTO chunks (id, document_id, ordinal, text, location)
      VALUES (501, 55, 0, 'test text', 'p1')
    `).run()

    // Insert invalid 999D vector
    db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (501, ?, ?, 999, unixepoch())
    `).run(targetSpace, floatBlob(999))

    db.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (55, ?, 1)
    `).run(targetSpace)

    const onDirtySpy = vi.fn()

    const result = store.repairInvalidCanonicalEmbeddings(onDirtySpy)

    expect(result.ok).toBe(true)
    expect(result.deletedEmbeddings).toBe(1)
    expect(result.affectedDocuments).toBe(1)
    expect(result.requeuedDocuments).toBe(1)
    expect(result.repairedSpaces).toContain(targetSpace)

    // Notification callback was invoked
    expect(onDirtySpy).toHaveBeenCalledWith(targetSpace)

    // Metadata updated to canonical
    const spaceMeta = db.prepare('SELECT dimensions, model_revision, pooling, quantization FROM embedding_spaces WHERE id = ?').get(targetSpace) as { dimensions: number; model_revision: string; pooling: string; quantization: string }
    expect(spaceMeta.dimensions).toBe(EMBEDDING_PROFILES.standard.dimensions)
    expect(spaceMeta.model_revision).toBe(EMBEDDING_PROFILES.standard.revision)
    expect(spaceMeta.pooling).toBe('last-token')
    expect(spaceMeta.quantization).toBe('q8')

    // Invalid vector was deleted
    const vectorRow = db.prepare('SELECT count(*) as cnt FROM chunk_embeddings WHERE space_id = ?').get(targetSpace) as { cnt: number }
    expect(vectorRow.cnt).toBe(0)

    // Document was requeued
    const docRow = db.prepare('SELECT status, chunk_done, embedding_model FROM documents WHERE id = 55').get() as { status: string; chunk_done: number; embedding_model: string | null }
    expect(docRow.status).toBe('text-only')
    expect(docRow.chunk_done).toBe(0)
    expect(docRow.embedding_model).toBeNull()

    // Counts was reset
    const countRow = db.prepare('SELECT count(*) as cnt FROM document_embedding_counts WHERE document_id = 55 AND space_id = ?').get(targetSpace) as { cnt: number }
    expect(countRow.cnt).toBe(0)

    // ANN index state is dirty
    const annRow = db.prepare('SELECT state FROM ann_indexes WHERE space_id = ?').get(targetSpace) as { state: string }
    expect(annRow.state).toBe('dirty')

    store.close()
  })

  it('REPAIR-07: Fault injection at ann_indexes update causes complete rollback of all changes (metadata, vector, count, status)', () => {
    const store = new DocumentMemoryStore(dbPath)
    const db = store.rawDb

    const targetSpace = EMBEDDING_PROFILES.standard.embeddingId

    // Insert mismatched metadata
    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'wrong-rev', 'mean', 512, 'fp32')
    `).run(targetSpace, EMBEDDING_PROFILES.standard.repo)

    db.prepare(`
      INSERT OR REPLACE INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, embedding_model, updated_at)
      VALUES (77, '/docs/ann-rollback.txt', 'ann-rollback.txt', 'ready', 1000, 300, 'h77', 1, 1, ?, unixepoch())
    `).run(targetSpace)

    db.prepare(`
      INSERT OR REPLACE INTO chunks (id, document_id, ordinal, text, location)
      VALUES (701, 77, 0, 'test text', 'p1')
    `).run()

    // Insert invalid 999D vector
    db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (701, ?, ?, 999, unixepoch())
    `).run(targetSpace, floatBlob(999))

    db.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (77, ?, 1)
    `).run(targetSpace)

    db.prepare(`
      INSERT OR REPLACE INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
      VALUES (?, 1, 1, 1, 'ready', unixepoch())
    `).run(targetSpace)

    // Install trigger on ann_indexes to force failure when updating ann_indexes
    db.exec(`
      CREATE TRIGGER fail_ann_update
      BEFORE UPDATE ON ann_indexes
      BEGIN
        SELECT RAISE(ABORT, 'Simulated failure during ann_indexes update');
      END;
    `)

    const onDirtySpy = vi.fn()

    // Execute repair - must throw due to trigger on ann_indexes
    expect(() => {
      store.repairInvalidCanonicalEmbeddings(onDirtySpy)
    }).toThrow('Simulated failure during ann_indexes update')

    // Verify callback was NOT called
    expect(onDirtySpy).not.toHaveBeenCalled()

    // Verify all changes were completely rolled back:
    // 1. embedding_spaces metadata was NOT committed
    const spaceMeta = db.prepare('SELECT dimensions, model_revision, pooling, quantization FROM embedding_spaces WHERE id = ?').get(targetSpace) as { dimensions: number; model_revision: string; pooling: string; quantization: string }
    expect(spaceMeta.dimensions).toBe(512)
    expect(spaceMeta.model_revision).toBe('wrong-rev')
    expect(spaceMeta.pooling).toBe('mean')
    expect(spaceMeta.quantization).toBe('fp32')

    // 2. chunk_embeddings invalid row was NOT deleted
    const vectorRow = db.prepare('SELECT vector_dim FROM chunk_embeddings WHERE chunk_id = 701 AND space_id = ?').get(targetSpace) as { vector_dim: number } | undefined
    expect(vectorRow?.vector_dim).toBe(999)

    // 3. document_embedding_counts was NOT deleted
    const countRow = db.prepare('SELECT completed_chunks FROM document_embedding_counts WHERE document_id = 77 AND space_id = ?').get(targetSpace) as { completed_chunks: number } | undefined
    expect(countRow?.completed_chunks).toBe(1)

    // 4. documents status was NOT changed
    const docRow = db.prepare('SELECT status, chunk_done FROM documents WHERE id = 77').get() as { status: string; chunk_done: number }
    expect(docRow.status).toBe('ready')
    expect(docRow.chunk_done).toBe(1)

    // 5. ann_indexes state remains ready
    const annRow = db.prepare('SELECT state FROM ann_indexes WHERE space_id = ?').get(targetSpace) as { state: string }
    expect(annRow.state).toBe('ready')

    store.close()
  })

  it('REPAIR-08: Repeated repair runs are idempotent', () => {
    const store = new DocumentMemoryStore(dbPath)
    const db = store.rawDb

    const targetSpace = EMBEDDING_PROFILES.standard.embeddingId

    // Insert mismatched metadata and invalid vector
    db.prepare(`
      INSERT OR REPLACE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'wrong-rev', 'mean', 512, 'fp32')
    `).run(targetSpace, EMBEDDING_PROFILES.standard.repo)

    db.prepare(`
      INSERT OR REPLACE INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, embedding_model, updated_at)
      VALUES (88, '/docs/idempotent.txt', 'idempotent.txt', 'ready', 1000, 300, 'h88', 1, 1, ?, unixepoch())
    `).run(targetSpace)

    db.prepare(`
      INSERT OR REPLACE INTO chunks (id, document_id, ordinal, text, location)
      VALUES (801, 88, 0, 'test text', 'p1')
    `).run()

    db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (801, ?, ?, 999, unixepoch())
    `).run(targetSpace, floatBlob(999))

    db.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (88, ?, 1)
    `).run(targetSpace)

    // First repair run
    const result1 = store.repairInvalidCanonicalEmbeddings()
    expect(result1.ok).toBe(true)
    expect(result1.deletedEmbeddings).toBe(1)
    expect(result1.requeuedDocuments).toBe(1)

    // Second repair run immediately
    const onDirtySpy = vi.fn()
    const result2 = store.repairInvalidCanonicalEmbeddings(onDirtySpy)
    expect(result2.ok).toBe(true)
    expect(result2.deletedEmbeddings).toBe(0)
    expect(result2.requeuedDocuments).toBe(0)
    expect(result2.repairedSpaces).toEqual([])
    expect(onDirtySpy).not.toHaveBeenCalled()

    store.close()
  })
})
