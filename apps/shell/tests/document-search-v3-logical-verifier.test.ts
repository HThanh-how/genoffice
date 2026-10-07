import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  verifyDatabaseIntegrity,
  verifyEmbeddingIntegrity,
  verifyFtsIntegrity,
  verifyLogicalConsistency,
} from '../src/main/document-memory/storage/migration/logical-verifier'
import { CANONICAL_SCHEMA_V3 } from '../src/main/document-memory/storage/schema-v3'

describe('Document Search V3 Logical Verifier Invariants (QA-03)', () => {
  const ACTIVE_SPACE_ID = 'bge-m3'
  const ACTIVE_DIMENSIONS = 384
  let db: DatabaseSync

  const createVectorBlob = (dim: number = ACTIVE_DIMENSIONS): Buffer => {
    return Buffer.alloc(dim * 4)
  }

  /**
   * Helper constructing a fully valid, canonical V3 database meeting all 14 invariants.
   */
  const seedCleanV3Db = (database: DatabaseSync) => {
    // 1. Metadata invariants
    database
      .prepare(
        "INSERT OR REPLACE INTO document_memory_meta (key, value) VALUES ('schema_version', '3'), ('name_fts_version', '1')",
      )
      .run()

    // 2. Active embedding space
    database
      .prepare(`
        INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
        VALUES (?, 'BAAI/bge-m3', 'pinned', 'mean', ?, 'fp32')
      `)
      .run(ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)

    // 3. Documents
    const insertDoc = database.prepare(`
      INSERT INTO documents (id, path, name, status, excluded, truncated, last_opened_at, priority_at, updated_at)
      VALUES (?, ?, ?, 'ready', 0, 0, 1000, 1000, 1000)
    `)
    insertDoc.run(1, 'D:/workspace/doc1.docx', 'doc1.docx')
    insertDoc.run(2, 'D:/workspace/doc2.docx', 'doc2.docx')

    // 4. Active chunk sets
    const insertSet = database.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (?, ?, 1, 'active')
    `)
    insertSet.run(10, 1)
    insertSet.run(20, 2)

    database.prepare('UPDATE documents SET active_chunk_set_id = 10 WHERE id = 1').run()
    database.prepare('UPDATE documents SET active_chunk_set_id = 20 WHERE id = 2').run()

    // 5. Chunks (Doc 1: 2 chunks, Doc 2: 1 chunk)
    const insertChunk = database.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    insertChunk.run(101, 1, 10, 0, 'Document 1 Chunk 0 text', 'page 1')
    insertChunk.run(102, 1, 10, 1, 'Document 1 Chunk 1 text', 'page 2')
    insertChunk.run(201, 2, 20, 0, 'Document 2 Chunk 0 text', 'page 1')

    // 6. Synchronized FTS rows
    const insertFts = database.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)')
    insertFts.run(101, 'Document 1 Chunk 0 text')
    insertFts.run(102, 'Document 1 Chunk 1 text')
    insertFts.run(201, 'Document 2 Chunk 0 text')

    // 7. Chunk embeddings matching declared activeSpaceId and dimensions
    const insertEmb = database.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (?, ?, ?, ?)
    `)
    insertEmb.run(101, ACTIVE_SPACE_ID, createVectorBlob(ACTIVE_DIMENSIONS), ACTIVE_DIMENSIONS)
    insertEmb.run(102, ACTIVE_SPACE_ID, createVectorBlob(ACTIVE_DIMENSIONS), ACTIVE_DIMENSIONS)
    insertEmb.run(201, ACTIVE_SPACE_ID, createVectorBlob(ACTIVE_DIMENSIONS), ACTIVE_DIMENSIONS)

    // 8. Document embedding counts matching actual chunks per document & space
    const insertCount = database.prepare(`
      INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (?, ?, ?)
    `)
    insertCount.run(1, ACTIVE_SPACE_ID, 2)
    insertCount.run(2, ACTIVE_SPACE_ID, 1)
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;')
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(CANONICAL_SCHEMA_V3)
  })

  // --------------------------------------------------------------------------
  // VERIFY-01 wrong embedding model → FAIL
  // --------------------------------------------------------------------------
  it('VERIFY-01 wrong embedding model → FAIL', () => {
    seedCleanV3Db(db)

    // Simulate database where embedding space is a different model ('text-embedding-3-small')
    // instead of expected target model ('bge-m3')
    db.prepare('DELETE FROM document_embedding_counts WHERE space_id = ?').run(ACTIVE_SPACE_ID)
    db.prepare('DELETE FROM chunk_embeddings WHERE space_id = ?').run(ACTIVE_SPACE_ID)
    db.prepare('DELETE FROM embedding_spaces WHERE id = ?').run(ACTIVE_SPACE_ID)

    const OTHER_SPACE = 'text-embedding-3-small'
    db.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, 'openai/text-embedding-3-small', 'pinned', 'cls', 1536, 'fp32')
    `).run(OTHER_SPACE)

    // When verification runs requiring ACTIVE_SPACE_ID ('bge-m3'):
    const result = verifyLogicalConsistency(db, 2, 3, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(result.ok).toBe(false)
    expect(result.reasons.some((r) => r.includes(`Target embedding space '${ACTIVE_SPACE_ID}' does not exist in embedding_spaces`))).toBe(true)

    // Direct embedding integrity check also fails
    const embResult = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(embResult.ok).toBe(false)
    expect(embResult.reasons.some((r) => r.includes(`Target embedding space '${ACTIVE_SPACE_ID}' does not exist`))).toBe(true)
  })

  // --------------------------------------------------------------------------
  // VERIFY-02 right model wrong dimension → FAIL
  // --------------------------------------------------------------------------
  it('VERIFY-02 right model wrong dimension → FAIL', () => {
    seedCleanV3Db(db)

    // The space ID is right ('bge-m3'), but declared dimensions and vector dimensions are 512 instead of 384
    const WRONG_DIM = 512
    db.prepare('UPDATE embedding_spaces SET dimensions = ? WHERE id = ?').run(WRONG_DIM, ACTIVE_SPACE_ID)
    db.prepare('UPDATE chunk_embeddings SET vector_dim = ?, vector = ? WHERE space_id = ?').run(
      WRONG_DIM,
      createVectorBlob(WRONG_DIM),
      ACTIVE_SPACE_ID,
    )

    // Verification must reject dimension mismatch against requested ACTIVE_DIMENSIONS (384)
    const result = verifyLogicalConsistency(db, 2, 3, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(result.ok).toBe(false)
    expect(
      result.reasons.some(
        (r) =>
          r.includes(`declared dimensions (${WRONG_DIM}) does not match activeDimensions (${ACTIVE_DIMENSIONS})`) ||
          r.includes('Active vectors in chunk_embeddings do not have exact dimensions') ||
          r.includes('Active vectors in chunk_embeddings have wrong dimensionality'),
      ),
    ).toBe(true)

    const embResult = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(embResult.ok).toBe(false)
    expect(embResult.reasons.length).toBeGreaterThan(0)
  })

  // --------------------------------------------------------------------------
  // VERIFY-03 missing embedding counts → FAIL
  // --------------------------------------------------------------------------
  it('VERIFY-03 missing embedding counts → FAIL', () => {
    seedCleanV3Db(db)

    // Document 2 has valid chunk embeddings, but its document_embedding_counts row is missing
    db.prepare('DELETE FROM document_embedding_counts WHERE document_id = 2 AND space_id = ?').run(ACTIVE_SPACE_ID)

    const result = verifyLogicalConsistency(db, 2, 3, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(result.ok).toBe(false)
    expect(
      result.reasons.some(
        (r) =>
          r.includes(`Missing document_embedding_counts records for space '${ACTIVE_SPACE_ID}'`) ||
          r.includes(`Mismatch in document_embedding_counts for space '${ACTIVE_SPACE_ID}'`) ||
          r.includes('[V10] Mismatch in document_embedding_counts'),
      ),
    ).toBe(true)

    const embResult = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(embResult.ok).toBe(false)
    expect(
      embResult.reasons.some((r) => r.includes(`Missing document_embedding_counts records for space '${ACTIVE_SPACE_ID}'`)),
    ).toBe(true)
  })

  // --------------------------------------------------------------------------
  // VERIFY-04 dangling FTS row → FAIL
  // --------------------------------------------------------------------------
  it('VERIFY-04 dangling FTS row → FAIL', () => {
    seedCleanV3Db(db)

    // Insert an orphan/dangling FTS record whose rowid does not exist in chunks
    const DANGLING_ROWID = 999999
    db.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)').run(
      DANGLING_ROWID,
      'Orphan dangling FTS text with no matching chunk record',
    )

    const ftsResult = verifyFtsIntegrity(db)
    expect(ftsResult.ok).toBe(false)
    expect(ftsResult.reasons.some((r) => r.includes('[V13] Orphan FTS rows detected'))).toBe(true)

    const result = verifyLogicalConsistency(db, 2, 3, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(result.ok).toBe(false)
    expect(result.reasons.some((r) => r.includes('[V13] Orphan FTS rows detected'))).toBe(true)
  })

  // --------------------------------------------------------------------------
  // VERIFY-05 corrupt FK → FAIL
  // --------------------------------------------------------------------------
  it('VERIFY-05 corrupt FK → FAIL', () => {
    seedCleanV3Db(db)

    // Temporarily bypass foreign key enforcement to simulate corrupted state / imported data
    db.exec('PRAGMA foreign_keys = OFF;')
    // Insert a chunk pointing to a nonexistent document_id 88888
    db.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location)
      VALUES (999, 88888, 10, 2, 'Corrupt FK chunk text', 'page 3')
    `).run()
    db.exec('PRAGMA foreign_keys = ON;')

    // Physical database integrity check fails on foreign_key_check
    const dbIntegrity = verifyDatabaseIntegrity(db)
    expect(dbIntegrity.ok).toBe(false)
    expect(dbIntegrity.foreignKeyErrors.length).toBeGreaterThan(0)

    // Logical consistency check fails with [V02] Foreign key violations
    const result = verifyLogicalConsistency(db, 2, 4, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(result.ok).toBe(false)
    expect(result.reasons.some((r) => r.includes('[V02] Foreign key violations detected'))).toBe(true)
  })

  // --------------------------------------------------------------------------
  // VERIFY-06 clean V3 → PASS
  // --------------------------------------------------------------------------
  it('VERIFY-06 clean V3 → PASS', () => {
    seedCleanV3Db(db)

    // 1. Full logical consistency validation
    const result = verifyLogicalConsistency(db, 2, 3, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.actualDocuments).toBe(2)
    expect(result.actualChunks).toBe(3)

    // 2. Physical SQLite database integrity
    const dbIntegrity = verifyDatabaseIntegrity(db)
    expect(dbIntegrity.ok).toBe(true)
    expect(dbIntegrity.foreignKeyErrors).toEqual([])
    expect(dbIntegrity.integrity).toBe('ok')

    // 3. Active embedding integrity
    const embResult = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
    expect(embResult.ok).toBe(true)
    expect(embResult.reasons).toEqual([])
    expect(embResult.activeSpaceId).toBe(ACTIVE_SPACE_ID)
    expect(embResult.activeDimensions).toBe(ACTIVE_DIMENSIONS)
    expect(embResult.totalActiveVectors).toBe(3)

    // 4. FTS integrity
    const ftsResult = verifyFtsIntegrity(db)
    expect(ftsResult.ok).toBe(true)
    expect(ftsResult.reasons).toEqual([])
    expect(ftsResult.totalFtsChunks).toBe(3)
  })
})
