import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

function floatBlob(floats: number[]): Uint8Array {
  const f32 = new Float32Array(floats)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

function createSampleVector(dim: number, baseVal: number): Uint8Array {
  const arr = new Array(dim)
  for (let i = 0; i < dim; i++) {
    arr[i] = baseVal + (i % 50) * 0.01
  }
  return floatBlob(arr)
}

function createBaseV2Database(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      mtime_ms REAL,
      size_bytes INTEGER,
      hash TEXT,
      embedding_model TEXT,
      active_chunk_set_id INTEGER,
      error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER NOT NULL DEFAULT 0,
      priority_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      chunk_total INTEGER NOT NULL DEFAULT 0,
      chunk_done INTEGER NOT NULL DEFAULT 0,
      chunk_counted INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE embedding_spaces (
      id TEXT PRIMARY KEY,
      model_repo TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      pooling TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      quantization TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE chunk_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunker_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_set_id INTEGER REFERENCES chunk_sets(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      normalized TEXT NOT NULL,
      location TEXT NOT NULL,
      vector BLOB,
      vector_dim INTEGER
    );

    CREATE TABLE chunk_embeddings (
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      vector_dim INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (chunk_id, space_id)
    );

    CREATE TABLE ann_indexes (
      space_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      desired_generation INTEGER NOT NULL DEFAULT 0,
      file_path TEXT,
      indexed_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'ready',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE document_memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  db.prepare("INSERT INTO document_memory_meta (key, value) VALUES ('schema_version', '2')").run()
  return db
}

describe('Migration Target Space Robustness Suite (MIGINT-01..05)', () => {
  let testDirectory: string
  let sourceDbPath: string

  beforeEach(() => {
    testDirectory = mkdtempSync(join(tmpdir(), 'genoffice-qa-migint-'))
    sourceDbPath = join(testDirectory, 'document-memory.db')
  })

  afterEach(() => {
    try {
      rmSync(testDirectory, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  })

  // --------------------------------------------------------------------------
  // MIGINT-01: target F2 320, source F2 vector_dim=512, blob đúng 512D
  //            -> migration FAIL
  //            -> original V2 remains intact
  // --------------------------------------------------------------------------
  it('MIGINT-01: rejects migration when source vector dimensionality deviates from requested activeDimensions and preserves original V2', () => {
    const db = createBaseV2Database(sourceDbPath)

    // Embedding space f2-320 declared in source
    db.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('f2-320', 'models/fast-embed-320', 'v1', 'mean', 320, 'q8')
    `).run()

    // Document 1
    db.prepare(`
      INSERT INTO documents (id, path, name, status, embedding_model, active_chunk_set_id, chunk_total, chunk_done)
      VALUES (1, 'D:/docs/corrupted-dim.docx', 'corrupted-dim.docx', 'ready', 'f2-320', 1, 1, 1)
    `).run()

    // Chunk set 1
    db.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (1, 1, 1, 'active')
    `).run()

    // Chunk 101
    db.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES (101, 1, 1, 0, 'Nội dung văn bản thử nghiệm độ lệch chiều vector', 'noi dung van ban thu nghiem', 'Trang 1')
    `).run()

    // Corrupted vector dimension in source chunk_embeddings:
    // Space is 'f2-320', but vector_dim is 512 and blob is exactly 512D (512 * 4 = 2048 bytes)
    const blob512 = createSampleVector(512, 0.25)
    expect(blob512.byteLength).toBe(512 * 4)

    db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (101, 'f2-320', ?, 512)
    `).run(blob512)

    db.close()

    // Migration must FAIL before cutover via migrateStorageV2ToV3 production path
    expect(() => {
      migrateStorageV2ToV3(sourceDbPath, {
        activeSpaceId: 'f2-320',
        activeDimensions: 320,
      })
    }).toThrowError(/Logical consistency verification failed before cutover/i)

    // Verify original V2 remains intact
    expect(existsSync(sourceDbPath)).toBe(true)
    const intactV2Db = new DatabaseSync(sourceDbPath)
    try {
      // 1. Schema version remains '2' (not updated to '3')
      const metaRow = intactV2Db.prepare("SELECT value FROM document_memory_meta WHERE key = 'schema_version'").get() as { value: string }
      expect(metaRow.value).toBe('2')

      // 2. Original V2 table structure with legacy 'normalized' column still present
      const chunkCols = (intactV2Db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(chunkCols).toContain('normalized')

      // 3. Document 1 remains in V2 state
      const doc = intactV2Db.prepare('SELECT id, name, status, embedding_model FROM documents WHERE id = 1').get() as {
        id: number
        name: string
        status: string
        embedding_model: string
      }
      expect(doc.name).toBe('corrupted-dim.docx')
      expect(doc.embedding_model).toBe('f2-320')

      // 4. Chunk embedding untouched with original 512D blob
      const embRow = intactV2Db.prepare('SELECT chunk_id, space_id, length(vector) as byte_len, vector_dim FROM chunk_embeddings WHERE chunk_id = 101').get() as {
        chunk_id: number
        space_id: string
        byte_len: number
        vector_dim: number
      }
      expect(embRow.vector_dim).toBe(512)
      expect(embRow.byte_len).toBe(2048)
    } finally {
      intactV2Db.close()
    }
  })

  // --------------------------------------------------------------------------
  // MIGINT-02: target space declared 512, requested target=320
  //            -> FAIL before cutover
  // --------------------------------------------------------------------------
  it('MIGINT-02: rejects migration when target space declared dimensions in embedding_spaces do not match requested activeDimensions', () => {
    const db = createBaseV2Database(sourceDbPath)

    // Embedding space declared as 512D in source
    db.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('target-space-declared-512', 'models/qwen-512', 'v1', 'mean', 512, 'q8')
    `).run()

    // Document & chunk
    db.prepare(`
      INSERT INTO documents (id, path, name, status, embedding_model, active_chunk_set_id, chunk_total, chunk_done)
      VALUES (1, 'D:/docs/space-declared-mismatch.docx', 'space-declared-mismatch.docx', 'ready', 'target-space-declared-512', 1, 1, 1)
    `).run()

    db.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (1, 1, 1, 'active')
    `).run()

    db.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES (101, 1, 1, 0, 'Kiểm thử không đồng nhất kích thước không gian vector', 'kiem thu', 'Trang 1')
    `).run()

    const blob512 = createSampleVector(512, 0.42)
    db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (101, 'target-space-declared-512', ?, 512)
    `).run(blob512)

    db.close()

    // Requested target is 320, but target space declared 512
    expect(() => {
      migrateStorageV2ToV3(sourceDbPath, {
        activeSpaceId: 'target-space-declared-512',
        activeDimensions: 320,
      })
    }).toThrowError(/declared dimensions \(512\) does not match activeDimensions \(320\)/i)

    // Verify original V2 remains intact
    const intactV2Db = new DatabaseSync(sourceDbPath)
    try {
      const meta = intactV2Db.prepare("SELECT value FROM document_memory_meta WHERE key = 'schema_version'").get() as { value: string }
      expect(meta.value).toBe('2')
    } finally {
      intactV2Db.close()
    }
  })

  // --------------------------------------------------------------------------
  // MIGINT-03: counts mismatch
  //            -> FAIL before cutover
  // --------------------------------------------------------------------------
  it('MIGINT-03: rejects cutover when document_embedding_counts deviates from actual chunk_embeddings vectors count', () => {
    const db = createBaseV2Database(sourceDbPath)

    // Embedding space f2-320
    db.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('f2-320', 'models/fast-embed-320', 'v1', 'mean', 320, 'q8')
    `).run()

    // Document 1 with 2 chunks
    db.prepare(`
      INSERT INTO documents (id, path, name, status, embedding_model, active_chunk_set_id, chunk_total, chunk_done)
      VALUES (1, 'D:/docs/counts-mismatch.docx', 'counts-mismatch.docx', 'ready', 'f2-320', 1, 2, 2)
    `).run()

    db.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (1, 1, 1, 'active')
    `).run()

    db.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES 
        (101, 1, 1, 0, 'Phần 1 tài liệu tài chính', 'phan 1', 'Trang 1'),
        (102, 1, 1, 1, 'Phần 2 tài liệu tài chính', 'phan 2', 'Trang 2')
    `).run()

    const vec1 = createSampleVector(320, 0.1)
    const vec2 = createSampleVector(320, 0.2)

    db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES 
        (101, 'f2-320', ?, 320),
        (102, 'f2-320', ?, 320)
    `).run(vec1, vec2)

    db.close()

    const tempCandidatePath = `${sourceDbPath}.v3.tmp`

    // Introduce count mismatch dynamically during migration via onProgress callback
    expect(() => {
      migrateStorageV2ToV3(sourceDbPath, {
        activeSpaceId: 'f2-320',
        activeDimensions: 320,
        tempDbPath: tempCandidatePath,
        onProgress: (progress) => {
          if (progress.phase === 'documents') {
            // Tamper document_embedding_counts to induce count divergence
            const tamperDb = new DatabaseSync(tempCandidatePath)
            try {
              tamperDb.prepare('UPDATE document_embedding_counts SET completed_chunks = completed_chunks + 5 WHERE space_id = ?').run('f2-320')
            } finally {
              tamperDb.close()
            }
          }
        },
      })
    }).toThrowError(/Mismatch in document_embedding_counts/i)

    // Original V2 remains intact
    const intactV2Db = new DatabaseSync(sourceDbPath)
    try {
      const meta = intactV2Db.prepare("SELECT value FROM document_memory_meta WHERE key = 'schema_version'").get() as { value: string }
      expect(meta.value).toBe('2')
    } finally {
      intactV2Db.close()
    }
  })

  // --------------------------------------------------------------------------
  // MIGINT-04: valid F2
  //            -> PASS
  // --------------------------------------------------------------------------
  it('MIGINT-04: succeeds cutover when valid F2 vectors and metadata are fully consistent', () => {
    const db = createBaseV2Database(sourceDbPath)

    // Embedding space f2-320
    db.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('f2-320', 'models/fast-embed-320', 'v1', 'mean', 320, 'q8')
    `).run()

    // Document 1 with 2 chunks
    db.prepare(`
      INSERT INTO documents (id, path, name, status, embedding_model, active_chunk_set_id, chunk_total, chunk_done)
      VALUES (1, 'D:/docs/valid-doc.docx', 'valid-doc.docx', 'ready', 'f2-320', 1, 2, 2)
    `).run()

    db.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (1, 1, 1, 'active')
    `).run()

    db.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES 
        (101, 1, 1, 0, 'Báo cáo doanh thu và kế hoạch mở rộng thị trường', 'bao cao doanh thu', 'Trang 1'),
        (102, 1, 1, 1, 'Chi tiết chi phí vận hành và phân bổ ngân sách', 'chi tiet chi phi', 'Trang 2')
    `).run()

    const vec1 = createSampleVector(320, 0.31)
    const vec2 = createSampleVector(320, 0.32)

    db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES 
        (101, 'f2-320', ?, 320),
        (102, 'f2-320', ?, 320)
    `).run(vec1, vec2)

    db.close()

    // Run migration
    const result = migrateStorageV2ToV3(sourceDbPath, {
      activeSpaceId: 'f2-320',
      activeDimensions: 320,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(1)
    expect(result.chunksCopied).toBe(2)
    expect(result.embeddingsCopied).toBe(2)

    // Verify post-cutover canonical V3 database
    const store = new DocumentMemoryStore(sourceDbPath)
    try {
      const doc = store.documentById(1)
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe('ready')

      const rawDb = store.rawDb
      const rawDoc = rawDb.prepare('SELECT id, status, embedding_model, chunk_done FROM documents WHERE id = 1').get() as {
        id: number
        status: string
        embedding_model: string | null
        chunk_done: number
      }
      expect(rawDoc.status).toBe('ready')
      expect(rawDoc.embedding_model).toBe('f2-320')
      expect(rawDoc.chunk_done).toBe(2)

      const chunk101 = store.readChunk(101)
      const chunk102 = store.readChunk(102)
      expect(chunk101?.text).toBe('Báo cáo doanh thu và kế hoạch mở rộng thị trường')
      expect(chunk102?.text).toBe('Chi tiết chi phí vận hành và phân bổ ngân sách')

      // FTS search verification
      const ftsHits = store.searchLexical('doanh thu', 5)
      expect(ftsHits.length).toBeGreaterThanOrEqual(1)
      expect(ftsHits[0].chunkId).toBe(101)

      // Verify schema version is '3'
      const metaRow = rawDb.prepare("SELECT value FROM document_memory_meta WHERE key = 'schema_version'").get() as { value: string }
      expect(metaRow.value).toBe('3')

      // Verify chunk_embeddings
      const embeddings = rawDb.prepare('SELECT chunk_id, space_id, vector_dim FROM chunk_embeddings ORDER BY chunk_id ASC').all() as Array<{
        chunk_id: number
        space_id: string
        vector_dim: number
      }>
      expect(embeddings).toHaveLength(2)
      expect(embeddings[0]).toEqual({ chunk_id: 101, space_id: 'f2-320', vector_dim: 320 })
      expect(embeddings[1]).toEqual({ chunk_id: 102, space_id: 'f2-320', vector_dim: 320 })

      // Verify document_embedding_counts
      const countRow = rawDb.prepare('SELECT completed_chunks FROM document_embedding_counts WHERE document_id = 1 AND space_id = ?').get('f2-320') as {
        completed_chunks: number
      }
      expect(countRow.completed_chunks).toBe(2)
    } finally {
      store.close()
    }
  })

  // --------------------------------------------------------------------------
  // MIGINT-05: target has no vectors
  //            -> lexical migration succeeds,
  //               document text-only,
  //               no foreign vector substituted
  // --------------------------------------------------------------------------
  it('MIGINT-05: succeeds lexical migration when target has no vectors, marking document text-only without substituting foreign vectors', () => {
    const db = createBaseV2Database(sourceDbPath)

    // Source contains only foreign embedding space 'foreign-512'
    db.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('foreign-512', 'models/foreign-512', 'v1', 'mean', 512, 'fp32')
    `).run()

    // Document 1 configured originally with 'foreign-512'
    db.prepare(`
      INSERT INTO documents (id, path, name, status, embedding_model, active_chunk_set_id, chunk_total, chunk_done)
      VALUES (1, 'D:/docs/text-only-candidate.docx', 'text-only-candidate.docx', 'ready', 'foreign-512', 1, 2, 2)
    `).run()

    db.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (1, 1, 1, 'active')
    `).run()

    db.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES 
        (101, 1, 1, 0, 'Văn bản hợp đồng kinh tế điều khoản chung', 'van ban hop dong', 'Trang 1'),
        (102, 1, 1, 1, 'Điều khoản thanh toán và phạt vi phạm hợp đồng', 'dieu khoan thanh toan', 'Trang 2')
    `).run()

    // Vectors in source belong exclusively to 'foreign-512'
    const foreignBlob1 = createSampleVector(512, 0.71)
    const foreignBlob2 = createSampleVector(512, 0.72)
    db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES 
        (101, 'foreign-512', ?, 512),
        (102, 'foreign-512', ?, 512)
    `).run(foreignBlob1, foreignBlob2)

    db.close()

    // Migration requested for target 'f2-320', which has NO vectors in source
    const result = migrateStorageV2ToV3(sourceDbPath, {
      activeSpaceId: 'f2-320',
      activeDimensions: 320,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(1)
    expect(result.chunksCopied).toBe(2)
    expect(result.embeddingsCopied).toBe(0) // Zero active vectors copied

    const store = new DocumentMemoryStore(sourceDbPath)
    try {
      // 1. Lexical migration succeeds: Chunks accessible with exact content
      const chunk101 = store.readChunk(101)
      const chunk102 = store.readChunk(102)
      expect(chunk101).not.toBeNull()
      expect(chunk101?.text).toBe('Văn bản hợp đồng kinh tế điều khoản chung')
      expect(chunk102).not.toBeNull()
      expect(chunk102?.text).toBe('Điều khoản thanh toán và phạt vi phạm hợp đồng')

      // FTS search works on transferred lexical text
      const searchHits = store.searchLexical('thanh toán', 5)
      expect(searchHits.length).toBeGreaterThanOrEqual(1)
      expect(searchHits[0].chunkId).toBe(102)

      // 2. Document status is 'text-only'
      const doc = store.documentById(1)
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe('text-only')

      const rawDb = store.rawDb
      const rawDoc = rawDb.prepare('SELECT id, status, embedding_model, chunk_done FROM documents WHERE id = 1').get() as {
        id: number
        status: string
        embedding_model: string | null
        chunk_done: number
      }
      expect(rawDoc.status).toBe('text-only')
      expect(rawDoc.embedding_model).toBeNull()
      expect(rawDoc.chunk_done).toBe(0)
      const allVectors = rawDb.prepare('SELECT count(*) as cnt FROM chunk_embeddings').get() as { cnt: number }
      expect(allVectors.cnt).toBe(0)

      const foreignVectors = rawDb.prepare("SELECT count(*) as cnt FROM chunk_embeddings WHERE space_id = 'foreign-512'").get() as { cnt: number }
      expect(foreignVectors.cnt).toBe(0)

      const activeVectors = rawDb.prepare("SELECT count(*) as cnt FROM chunk_embeddings WHERE space_id = 'f2-320'").get() as { cnt: number }
      expect(activeVectors.cnt).toBe(0)

      const docCounts = rawDb.prepare('SELECT count(*) as cnt FROM document_embedding_counts').get() as { cnt: number }
      expect(docCounts.cnt).toBe(0)
    } finally {
      store.close()
    }
  })
})
