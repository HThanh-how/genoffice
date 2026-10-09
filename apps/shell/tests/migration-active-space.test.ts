import { mkdtempSync, rmSync } from 'node:fs'
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
    arr[i] = baseVal + i * 0.001
  }
  return floatBlob(arr)
}

interface FixtureVectors {
  v1_f2: Uint8Array
  v1_qwen: Uint8Array
  v1_fake: Uint8Array
  v2_f2: Uint8Array
  v2_qwen: Uint8Array
  v2_fake: Uint8Array
}

function setupV2FixtureDb(dbPath: string): FixtureVectors {
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
  `)

  // 3 embedding spaces as required:
  // - Space 'f2-320' (320D)
  // - Space 'qwen-512' (512D)
  // - Space 'fake-320' (320D - khác model dù cùng 320D)
  const insertSpace = db.prepare(`
    INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insertSpace.run('f2-320', 'models/fast-embed-320', 'rev1', 'mean', 320, 'q8')
  insertSpace.run('qwen-512', 'models/qwen-512', 'rev2', 'mean', 512, 'q8')
  insertSpace.run('fake-320', 'models/fake-model-320', 'rev1', 'cls', 320, 'fp32')

  // Document 1 with active chunk set 1
  db.prepare(`
    INSERT INTO documents (id, path, name, status, last_opened_at, active_chunk_set_id, embedding_model, chunk_total, chunk_done)
    VALUES (1, 'D:/documents/business-strategy.docx', 'business-strategy.docx', 'ready', 1700000000, 1, 'f2-320', 2, 2)
  `).run()

  db.prepare(`
    INSERT INTO chunk_sets (id, document_id, chunker_version, state)
    VALUES (1, 1, 1, 'active')
  `).run()

  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
    VALUES (?, 1, 1, ?, ?, ?, ?)
  `)
  insertChunk.run(101, 0, 'Kế hoạch chiến lược phát triển Q4', 'ke hoach chien luoc phat trien q4', 'Trang 1')
  insertChunk.run(102, 1, 'Chỉ số đo lường hiệu quả KPI tài chính', 'chi so do luong hieu qua kpi tai chinh', 'Trang 2')

  // Distinct vectors for each space
  const v1_f2 = createSampleVector(320, 0.1)
  const v1_qwen = createSampleVector(512, 0.2)
  const v1_fake = createSampleVector(320, 0.3)

  const v2_f2 = createSampleVector(320, 0.4)
  const v2_qwen = createSampleVector(512, 0.5)
  const v2_fake = createSampleVector(320, 0.6)

  const insertChunkEmbedding = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
    VALUES (?, ?, ?, ?)
  `)
  insertChunkEmbedding.run(101, 'f2-320', v1_f2, 320)
  insertChunkEmbedding.run(101, 'qwen-512', v1_qwen, 512)
  insertChunkEmbedding.run(101, 'fake-320', v1_fake, 320)

  insertChunkEmbedding.run(102, 'f2-320', v2_f2, 320)
  insertChunkEmbedding.run(102, 'qwen-512', v2_qwen, 512)
  insertChunkEmbedding.run(102, 'fake-320', v2_fake, 320)

  // ann_indexes for spaces
  const insertAnn = db.prepare('INSERT INTO ann_indexes (space_id, generation, state) VALUES (?, 1, ?)')
  insertAnn.run('f2-320', 'ready')
  insertAnn.run('qwen-512', 'ready')
  insertAnn.run('fake-320', 'ready')

  db.close()

  return { v1_f2, v1_qwen, v1_fake, v2_f2, v2_qwen, v2_fake }
}

describe('Migration Target Space Must Be Explicit (QA-02 Suite)', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-migspace-test-'))
    dbPath = join(directory, 'document-memory.db')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('MIGSPACE-01: Target là f2-320, chỉ copy vector của f2-320, 0 vector của fake-320 hay qwen-512 lọt vào', () => {
    const vectors = setupV2FixtureDb(dbPath)

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'f2-320',
      activeDimensions: 320,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(1)
    expect(result.chunksCopied).toBe(2)
    expect(result.embeddingsCopied).toBe(2)

    const rawDb = new DatabaseSync(dbPath)
    try {
      // 1. Verify chunk_embeddings contains ONLY 'f2-320'
      const allEmbeddings = rawDb.prepare('SELECT chunk_id, space_id, vector, vector_dim FROM chunk_embeddings ORDER BY chunk_id ASC').all() as Array<{
        chunk_id: number
        space_id: string
        vector: Uint8Array
        vector_dim: number
      }>

      expect(allEmbeddings).toHaveLength(2)
      for (const emb of allEmbeddings) {
        expect(emb.space_id).toBe('f2-320')
        expect(emb.vector_dim).toBe(320)
      }

      // Explicit verification: 0 vectors of 'fake-320' or 'qwen-512'
      const fakeVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'fake-320'").get() as { count: number }
      const qwenVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'qwen-512'").get() as { count: number }
      const foreignVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id != 'f2-320'").get() as { count: number }

      expect(fakeVectors.count).toBe(0)
      expect(qwenVectors.count).toBe(0)
      expect(foreignVectors.count).toBe(0)

      // Verify vector payload matches f2-320 fixture data
      const chunk101Emb = allEmbeddings.find((e) => e.chunk_id === 101)
      const chunk102Emb = allEmbeddings.find((e) => e.chunk_id === 102)
      expect(Buffer.from(chunk101Emb!.vector).equals(Buffer.from(vectors.v1_f2))).toBe(true)
      expect(Buffer.from(chunk102Emb!.vector).equals(Buffer.from(vectors.v2_f2))).toBe(true)

      // Verify document_embedding_counts has exactly 'f2-320' count
      const docCounts = rawDb.prepare('SELECT document_id, space_id, completed_chunks FROM document_embedding_counts').all() as Array<{
        document_id: number
        space_id: string
        completed_chunks: number
      }>
      expect(docCounts).toHaveLength(1)
      expect(docCounts[0]).toEqual({
        document_id: 1,
        space_id: 'f2-320',
        completed_chunks: 2,
      })

      // Verify document status & model
      const doc = rawDb.prepare('SELECT id, status, embedding_model, chunk_done FROM documents WHERE id = 1').get() as {
        id: number
        status: string
        embedding_model: string
        chunk_done: number
      }
      expect(doc.status).toBe('ready')
      expect(doc.embedding_model).toBe('f2-320')
      expect(doc.chunk_done).toBe(2)
    } finally {
      rawDb.close()
    }
  })

  it('MIGSPACE-02: Target là qwen-512, chỉ copy vector của qwen-512', () => {
    const vectors = setupV2FixtureDb(dbPath)

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'qwen-512',
      activeDimensions: 512,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(1)
    expect(result.chunksCopied).toBe(2)
    expect(result.embeddingsCopied).toBe(2)

    const rawDb = new DatabaseSync(dbPath)
    try {
      // 1. Verify chunk_embeddings contains ONLY 'qwen-512'
      const allEmbeddings = rawDb.prepare('SELECT chunk_id, space_id, vector, vector_dim FROM chunk_embeddings ORDER BY chunk_id ASC').all() as Array<{
        chunk_id: number
        space_id: string
        vector: Uint8Array
        vector_dim: number
      }>

      expect(allEmbeddings).toHaveLength(2)
      for (const emb of allEmbeddings) {
        expect(emb.space_id).toBe('qwen-512')
        expect(emb.vector_dim).toBe(512)
      }

      // Explicit verification: 0 vectors of 'f2-320' or 'fake-320'
      const f2Vectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'f2-320'").get() as { count: number }
      const fakeVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'fake-320'").get() as { count: number }
      const foreignVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id != 'qwen-512'").get() as { count: number }

      expect(f2Vectors.count).toBe(0)
      expect(fakeVectors.count).toBe(0)
      expect(foreignVectors.count).toBe(0)

      // Verify vector payload matches qwen-512 fixture data
      const chunk101Emb = allEmbeddings.find((e) => e.chunk_id === 101)
      const chunk102Emb = allEmbeddings.find((e) => e.chunk_id === 102)
      expect(Buffer.from(chunk101Emb!.vector).equals(Buffer.from(vectors.v1_qwen))).toBe(true)
      expect(Buffer.from(chunk102Emb!.vector).equals(Buffer.from(vectors.v2_qwen))).toBe(true)

      // Verify document_embedding_counts has exactly 'qwen-512' count
      const docCounts = rawDb.prepare('SELECT document_id, space_id, completed_chunks FROM document_embedding_counts').all() as Array<{
        document_id: number
        space_id: string
        completed_chunks: number
      }>
      expect(docCounts).toHaveLength(1)
      expect(docCounts[0]).toEqual({
        document_id: 1,
        space_id: 'qwen-512',
        completed_chunks: 2,
      })

      // Verify document status & model
      const doc = rawDb.prepare('SELECT id, status, embedding_model, chunk_done FROM documents WHERE id = 1').get() as {
        id: number
        status: string
        embedding_model: string
        chunk_done: number
      }
      expect(doc.status).toBe('ready')
      expect(doc.embedding_model).toBe('qwen-512')
      expect(doc.chunk_done).toBe(2)
    } finally {
      rawDb.close()
    }
  })

  it('MIGSPACE-03: Missing target (target không có trong source) -> copy 100% lexical chunks, nhưng vector copied = 0 (foreign vectors = 0)', () => {
    setupV2FixtureDb(dbPath)

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'missing-space-768',
      activeDimensions: 768,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(1)
    expect(result.chunksCopied).toBe(2)
    expect(result.embeddingsCopied).toBe(0)

    const store = new DocumentMemoryStore(dbPath)
    try {
      // 100% lexical chunks copied
      const chunk101 = store.readChunk(101)
      const chunk102 = store.readChunk(102)
      expect(chunk101).not.toBeNull()
      expect(chunk101?.text).toBe('Kế hoạch chiến lược phát triển Q4')
      expect(chunk102).not.toBeNull()
      expect(chunk102?.text).toBe('Chỉ số đo lường hiệu quả KPI tài chính')

      // Lexical FTS search works on copied chunks
      const ftsHits = store.searchLexical('chiến lược', 10)
      expect(ftsHits.length).toBeGreaterThanOrEqual(1)
      expect(ftsHits[0].chunkId).toBe(101)

      // Total vector copied = 0 (foreign vectors = 0)
      const rawDb = store.rawDb
      const embCountRow = rawDb.prepare('SELECT count(*) as count FROM chunk_embeddings').get() as { count: number }
      expect(embCountRow.count).toBe(0)

      const foreignF2 = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'f2-320'").get() as { count: number }
      const foreignQwen = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'qwen-512'").get() as { count: number }
      const foreignFake = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'fake-320'").get() as { count: number }
      expect(foreignF2.count).toBe(0)
      expect(foreignQwen.count).toBe(0)
      expect(foreignFake.count).toBe(0)

      // document_embedding_counts table has 0 entries
      const countRows = rawDb.prepare('SELECT count(*) as count FROM document_embedding_counts').get() as { count: number }
      expect(countRows.count).toBe(0)

      // Document status transitioned to 'text-only' with null embedding_model and chunk_done = 0
      const doc = store.documentById(1)
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe('text-only')

      const rawDoc = rawDb.prepare('SELECT id, status, embedding_model, chunk_done FROM documents WHERE id = 1').get() as {
        id: number
        status: string
        embedding_model: string | null
        chunk_done: number
      }
      expect(rawDoc.status).toBe('text-only')
      expect(rawDoc.embedding_model).toBeNull()
      expect(rawDoc.chunk_done).toBe(0)
    } finally {
      store.close()
    }
  })

  it('MIGSPACE-04: migration cannot start without activeSpaceId (throw validation error nếu thiếu activeSpaceId)', () => {
    setupV2FixtureDb(dbPath)

    // Missing activeSpaceId
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeDimensions: 320,
      } as any)
    }).toThrowError(/Migration target embedding space must be explicitly specified/)

    // Empty string activeSpaceId
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: '',
        activeDimensions: 320,
      } as any)
    }).toThrowError(/Migration target embedding space must be explicitly specified/)

    // Undefined activeSpaceId
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: undefined,
        activeDimensions: 320,
      } as any)
    }).toThrowError(/Migration target embedding space must be explicitly specified/)
  })

  it('MIGSPACE-05: cannot start without activeDimensions (throw validation error nếu thiếu activeDimensions)', () => {
    setupV2FixtureDb(dbPath)

    // Missing activeDimensions
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'f2-320',
      } as any)
    }).toThrowError(/Migration target embedding space must be explicitly specified/)

    // Undefined activeDimensions
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'f2-320',
        activeDimensions: undefined,
      } as any)
    }).toThrowError(/Migration target embedding space must be explicitly specified/)

    // Non-number activeDimensions (e.g. string)
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'f2-320',
        activeDimensions: '320' as any,
      })
    }).toThrowError(/Migration target embedding space must be explicitly specified/)
  })
})
