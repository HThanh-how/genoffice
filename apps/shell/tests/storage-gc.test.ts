import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

function floatBlob(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

describe('Document Memory Storage Maintenance GC & Incremental Vacuum Suite', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-gc-'))
    dbPath = join(directory, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('purges retired chunk sets, orphan chunks, and cleans up corresponding FTS entries', () => {
    const rawDb = store.rawDb

    // Insert document 1
    rawDb
      .prepare(`
      INSERT INTO documents (id, path, name, status, active_chunk_set_id)
      VALUES (1, 'D:/docs/gc-doc.txt', 'gc-doc.txt', 'ready', 2)
    `)
      .run()

    // Chunk sets: set 1 is retired, set 2 is active
    rawDb.exec(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state) VALUES
        (1, 1, 1, 'retired'),
        (2, 1, 2, 'active');
      
      -- Chunks for retired set (chunk 11)
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location) VALUES
        (11, 1, 1, 0, 'Old retired text to be reclaimed', 'Chunk 1');
      INSERT INTO chunk_fts (rowid, text) VALUES (11, 'old retired text to be reclaimed');

      -- Chunks for active set (chunk 12)
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location) VALUES
        (12, 1, 2, 0, 'Active text that must survive GC', 'Chunk 1');
      INSERT INTO chunk_fts (rowid, text) VALUES (12, 'active text that must survive gc');
    `)

    // Orphan chunk (chunk 99 with non-existent document) - temporarily disable foreign keys to simulate legacy orphaned state
    rawDb.exec('PRAGMA foreign_keys = OFF;')
    rawDb.exec(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location) VALUES
        (99, 999, NULL, 0, 'Orphan chunk without document', 'Chunk 1');
      INSERT INTO chunk_fts (rowid, text) VALUES (99, 'orphan chunk without document');
    `)
    rawDb.exec('PRAGMA foreign_keys = ON;')

    // Verify chunk 11 and chunk 99 exist in chunks and raw chunk_fts before GC
    expect(rawDb.prepare('SELECT id FROM chunks WHERE id = ?').get(11)).toBeDefined()
    expect(rawDb.prepare('SELECT id FROM chunks WHERE id = ?').get(99)).toBeDefined()
    const ftsRetiredBefore = rawDb
      .prepare('SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?')
      .all('retired')
    expect(ftsRetiredBefore).toHaveLength(1)
    const ftsOrphanBefore = rawDb
      .prepare('SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?')
      .all('orphan')
    expect(ftsOrphanBefore).toHaveLength(1)

    // Run GC
    const stats = store.runMaintenanceGc()
    expect(stats.retiredSetsDeleted).toBe(1)
    expect(stats.orphanChunksDeleted).toBeGreaterThanOrEqual(2) // chunk 11 and chunk 99
    expect(stats.ftsRowsCleaned).toBeGreaterThanOrEqual(2)

    // Verify retired chunk 11 and orphan chunk 99 are completely removed from DB & FTS
    expect(rawDb.prepare('SELECT id FROM chunks WHERE id = ?').get(11)).toBeUndefined()
    expect(rawDb.prepare('SELECT id FROM chunks WHERE id = ?').get(99)).toBeUndefined()
    const ftsRetiredAfter = rawDb
      .prepare('SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?')
      .all('retired')
    expect(ftsRetiredAfter).toHaveLength(0)
    const ftsOrphanAfter = rawDb
      .prepare('SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?')
      .all('orphan')
    expect(ftsOrphanAfter).toHaveLength(0)

    // Active chunk 12 must remain intact and searchable via searchLexical
    expect(store.readChunk(12)).not.toBeNull()
    expect(store.readChunk(12)?.text).toBe('Active text that must survive GC')
    expect(store.searchLexical('survive', 10)).toHaveLength(1)
  })

  it('purges obsolete embeddings when chunks or spaces no longer exist', () => {
    const rawDb = store.rawDb

    // Create space
    rawDb
      .prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('active-space', 'repo/model', 'rev1', 'mean', 2, 'q8')
    `)
      .run()

    // Insert doc & chunk
    rawDb
      .prepare(
        "INSERT INTO documents (id, path, name, status) VALUES (2, 'D:/doc2.txt', 'doc2.txt', 'ready')",
      )
      .run()
    rawDb
      .prepare(
        "INSERT INTO chunks (id, document_id, ordinal, text, location) VALUES (20, 2, 0, 'Doc 2', 'Chunk 1')",
      )
      .run()

    // Valid embedding
    rawDb
      .prepare(
        'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (20, ?, ?, 2)',
      )
      .run('active-space', floatBlob([0.1, 0.2]))

    // Obsolete embeddings simulation - temporarily disable foreign keys
    rawDb.exec('PRAGMA foreign_keys = OFF;')
    rawDb
      .prepare(
        'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (999, ?, ?, 2)',
      )
      .run('active-space', floatBlob([0.3, 0.4]))

    // Obsolete embedding 2: space_id 'non-existent-space' does not exist
    rawDb
      .prepare(
        'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (20, ?, ?, 2)',
      )
      .run('non-existent-space', floatBlob([0.5, 0.6]))
    rawDb.exec('PRAGMA foreign_keys = ON;')

    const gcStats = store.runMaintenanceGc()
    expect(gcStats.obsoleteEmbeddingsDeleted).toBe(2)

    // Valid embedding remains
    const validCount = (
      rawDb
        .prepare(
          "SELECT count(*) as c FROM chunk_embeddings WHERE chunk_id = 20 AND space_id = 'active-space'",
        )
        .get() as { c: number }
    ).c
    expect(validCount).toBe(1)
  })

  it('tracks freelist stats and executes incremental vacuum in batches of 256 pages', () => {
    const rawDb = store.rawDb

    // Insert a large number of rows to expand database page count
    rawDb.exec('BEGIN IMMEDIATE;')
    const insertDoc = rawDb.prepare(
      "INSERT INTO documents (path, name, status) VALUES (?, ?, 'ready')",
    )
    const insertChunk = rawDb.prepare(
      "INSERT INTO chunks (document_id, ordinal, text, location) VALUES (?, 0, ?, 'Chunk 1')",
    )
    const largeText = 'A'.repeat(8192) // 8KB per chunk to force multiple pages
    for (let i = 1; i <= 300; i++) {
      const res = insertDoc.run(`/path/to/large/doc/${i}.txt`, `doc_${i}.txt`)
      insertChunk.run(res.lastInsertRowid, largeText)
    }
    rawDb.exec('COMMIT;')

    const statsBefore = store.getStorageFreelistStats()
    expect(statsBefore.pageCount).toBeGreaterThan(100)

    // Delete all chunks to produce a large freelist (reclaimable pages)
    rawDb.exec('DELETE FROM chunks;')
    rawDb.exec('DELETE FROM documents;')

    const statsAfterDelete = store.getStorageFreelistStats()
    expect(statsAfterDelete.freelistCount).toBeGreaterThan(50)
    expect(statsAfterDelete.freelistRatio).toBeGreaterThan(0.15)
    expect(statsAfterDelete.shouldVacuum).toBe(true)

    // Run incremental vacuum in batches of 256 pages
    const vacuumResult = store.runIncrementalVacuum({ batchPages: 256 })
    expect(vacuumResult.vacuumed).toBe(true)
    expect(vacuumResult.pagesReclaimed).toBeGreaterThan(0)
    expect(vacuumResult.finalFreelistPages).toBeLessThan(statsAfterDelete.freelistCount)

    // Final freelist stats
    const statsFinal = store.getStorageFreelistStats()
    expect(statsFinal.freelistCount).toBe(0)
  })
})
