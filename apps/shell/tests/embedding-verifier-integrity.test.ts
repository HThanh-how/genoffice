import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  verifyEmbeddingIntegrity,
  verifyActiveEmbeddingIntegrity,
  verifyLogicalConsistency,
} from '../src/main/document-memory/storage/migration/logical-verifier'
import { CANONICAL_SCHEMA_V3 } from '../src/main/document-memory/storage/schema-v3'

describe('Embedding Integrity Verifier Test Suite (BEH-18)', () => {
  const ACTIVE_SPACE_ID = 'bge-m3'
  const ACTIVE_DIMENSIONS = 384
  let db: DatabaseSync

  const createVectorBlob = (dim: number = ACTIVE_DIMENSIONS): Buffer => {
    return Buffer.alloc(dim * 4)
  }

  const seedBaseValidDb = (database: DatabaseSync) => {
    // 1. Meta & Schema version
    database.prepare("INSERT OR REPLACE INTO document_memory_meta (key, value) VALUES ('schema_version', '3'), ('name_fts_version', '1')").run()

    // 2. Active embedding space
    database.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, 'BAAI/bge-m3', 'pinned', 'mean', ?, 'fp32')
    `).run(ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)

    // 3. Documents
    const insertDoc = database.prepare(`
      INSERT INTO documents (id, path, name, status, excluded, truncated, last_opened_at, priority_at, updated_at)
      VALUES (?, ?, ?, 'ready', 0, 0, 1000, 1000, 1000)
    `)
    insertDoc.run(1, 'D:/docs/doc1.docx', 'doc1.docx')
    insertDoc.run(2, 'D:/docs/doc2.docx', 'doc2.docx')

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
    insertChunk.run(101, 1, 10, 0, 'Document 1 Chunk 0', 'page 1')
    insertChunk.run(102, 1, 10, 1, 'Document 1 Chunk 1', 'page 2')
    insertChunk.run(201, 2, 20, 0, 'Document 2 Chunk 0', 'page 1')

    // 6. Chunk embeddings
    const insertEmb = database.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (?, ?, ?, ?)
    `)
    insertEmb.run(101, ACTIVE_SPACE_ID, createVectorBlob(ACTIVE_DIMENSIONS), ACTIVE_DIMENSIONS)
    insertEmb.run(102, ACTIVE_SPACE_ID, createVectorBlob(ACTIVE_DIMENSIONS), ACTIVE_DIMENSIONS)
    insertEmb.run(201, ACTIVE_SPACE_ID, createVectorBlob(ACTIVE_DIMENSIONS), ACTIVE_DIMENSIONS)

    // 7. Document embedding counts
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
  // Fixture 1: Target space không tồn tại trong embedding_spaces -> reject
  // --------------------------------------------------------------------------
  describe('Fixture 1: Target space existence in embedding_spaces', () => {
    it('rejects when target space is missing from embedding_spaces', () => {
      seedBaseValidDb(db)
      // Delete the target space record
      db.prepare('DELETE FROM embedding_spaces WHERE id = ?').run(ACTIVE_SPACE_ID)

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Target embedding space '${ACTIVE_SPACE_ID}' does not exist in embedding_spaces`),
        ]),
      )
    })

    it('rejects when target space exists but declared dimensions does not match activeDimensions', () => {
      seedBaseValidDb(db)
      // Space declared with 512 dimensions while activeDimensions is 384
      db.prepare('UPDATE embedding_spaces SET dimensions = 512 WHERE id = ?').run(ACTIVE_SPACE_ID)

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`declared dimensions (512) does not match activeDimensions (${ACTIVE_DIMENSIONS})`),
        ]),
      )
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 2: Wrong dimensions -> reject
  // --------------------------------------------------------------------------
  describe('Fixture 2: Wrong dimensions & byte length', () => {
    it('rejects when chunk_embeddings has vector_dim != activeDimensions', () => {
      seedBaseValidDb(db)
      // Modify vector_dim of chunk 101 to 768 but keep blob matching 768
      db.prepare('UPDATE chunk_embeddings SET vector_dim = 768, vector = ? WHERE chunk_id = 101').run(
        createVectorBlob(768),
      )

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Active vectors in chunk_embeddings do not have exact dimensions'),
        ]),
      )
    })

    it('rejects when blob byte length does not match activeDimensions * 4', () => {
      seedBaseValidDb(db)
      // Modify blob byte length to wrong size (e.g. 100 bytes instead of 384 * 4 = 1536)
      const corruptedBlob = Buffer.alloc(100)
      db.prepare('UPDATE chunk_embeddings SET vector = ? WHERE chunk_id = 101').run(corruptedBlob)

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Active vectors in chunk_embeddings have wrong dimensionality'),
        ]),
      )
    })

    it('rejects when vector_dim is non-positive or null', () => {
      seedBaseValidDb(db)
      db.prepare('UPDATE chunk_embeddings SET vector_dim = 0 WHERE chunk_id = 101').run()

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons.length).toBeGreaterThan(0)
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 3: Missing count row -> reject
  // --------------------------------------------------------------------------
  describe('Fixture 3: Missing document_embedding_counts row', () => {
    it('rejects when document has embeddings but no document_embedding_counts row', () => {
      seedBaseValidDb(db)
      // Delete document_embedding_counts row for document 2
      db.prepare('DELETE FROM document_embedding_counts WHERE document_id = 2 AND space_id = ?').run(
        ACTIVE_SPACE_ID,
      )

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Missing document_embedding_counts records for space '${ACTIVE_SPACE_ID}': 1 document(s)`),
        ]),
      )
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 4: Count too high -> reject
  // --------------------------------------------------------------------------
  describe('Fixture 4: Count too high', () => {
    it('rejects when completed_chunks is greater than actual chunk_embeddings vectors count', () => {
      seedBaseValidDb(db)
      // Doc 1 has 2 vectors, inflate completed_chunks to 5
      db.prepare('UPDATE document_embedding_counts SET completed_chunks = 5 WHERE document_id = 1 AND space_id = ?').run(
        ACTIVE_SPACE_ID,
      )

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Mismatch in document_embedding_counts for space '${ACTIVE_SPACE_ID}'`),
          expect.stringContaining(`document_embedding_counts total (6) does not match actual chunk_embeddings vectors count (3)`),
        ]),
      )
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 5: Count too low -> reject
  // --------------------------------------------------------------------------
  describe('Fixture 5: Count too low', () => {
    it('rejects when completed_chunks is less than actual chunk_embeddings vectors count', () => {
      seedBaseValidDb(db)
      // Doc 1 has 2 vectors, deflate completed_chunks to 1
      db.prepare('UPDATE document_embedding_counts SET completed_chunks = 1 WHERE document_id = 1 AND space_id = ?').run(
        ACTIVE_SPACE_ID,
      )

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(false)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Mismatch in document_embedding_counts for space '${ACTIVE_SPACE_ID}'`),
          expect.stringContaining(`document_embedding_counts total (2) does not match actual chunk_embeddings vectors count (3)`),
        ]),
      )
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 6: Valid state -> accept (ok: true)
  // --------------------------------------------------------------------------
  describe('Fixture 6: Valid state verification', () => {
    it('accepts perfectly intact database with active embedding vectors and counts', () => {
      seedBaseValidDb(db)

      const result = verifyEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(result.ok).toBe(true)
      expect(result.reasons).toEqual([])
      expect(result.activeSpaceId).toBe(ACTIVE_SPACE_ID)
      expect(result.activeDimensions).toBe(ACTIVE_DIMENSIONS)
      expect(result.totalActiveVectors).toBe(3)
    })

    it('accepts valid state via options object signature and alias', () => {
      seedBaseValidDb(db)

      // Options object signature
      const resultOpts = verifyEmbeddingIntegrity(db, {
        activeSpaceId: ACTIVE_SPACE_ID,
        activeDimensions: ACTIVE_DIMENSIONS,
      })
      expect(resultOpts.ok).toBe(true)
      expect(resultOpts.totalActiveVectors).toBe(3)

      // Single options object signature
      const resultSingle = verifyEmbeddingIntegrity({
        db,
        activeSpaceId: ACTIVE_SPACE_ID,
        activeDimensions: ACTIVE_DIMENSIONS,
      })
      expect(resultSingle.ok).toBe(true)

      // Exported alias
      const resultAlias = verifyActiveEmbeddingIntegrity(db, ACTIVE_SPACE_ID, ACTIVE_DIMENSIONS)
      expect(resultAlias.ok).toBe(true)
    })

    it('integrates seamlessly with verifyLogicalConsistency runner', () => {
      seedBaseValidDb(db)

      // 2 documents, 3 chunks
      const logicalResult = verifyLogicalConsistency(
        db,
        2,
        3,
        ACTIVE_SPACE_ID,
        ACTIVE_DIMENSIONS,
      )
      expect(logicalResult.ok).toBe(true)
      expect(logicalResult.reasons).toEqual([])
      expect(logicalResult.actualDocuments).toBe(2)
      expect(logicalResult.actualChunks).toBe(3)
    })

    it('propagates embedding corruption failures up to verifyLogicalConsistency', () => {
      seedBaseValidDb(db)
      // Corrupt counts: doc 1 count set to 999
      db.prepare('UPDATE document_embedding_counts SET completed_chunks = 999 WHERE document_id = 1 AND space_id = ?').run(
        ACTIVE_SPACE_ID,
      )

      const logicalResult = verifyLogicalConsistency(
        db,
        2,
        3,
        ACTIVE_SPACE_ID,
        ACTIVE_DIMENSIONS,
      )
      expect(logicalResult.ok).toBe(false)
      expect(logicalResult.reasons.some((r) => r.includes("Mismatch in document_embedding_counts"))).toBe(true)
    })
  })
})
