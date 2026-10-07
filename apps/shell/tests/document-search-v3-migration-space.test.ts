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

function createBaseV2Schema(db: DatabaseSync): void {
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
}

function setupMultiSpaceFixtureDb(
  dbPath: string,
  insertionOrder: 'f2-first' | 'fake-first' | 'qwen-first' = 'fake-first',
): FixtureVectors {
  const db = new DatabaseSync(dbPath)
  createBaseV2Schema(db)

  // 3 embedding spaces:
  // - Space 'f2-320' (320D)
  // - Space 'qwen-512' (512D)
  // - Space 'fake-320' (320D - same dim as f2, but different space/model)
  const insertSpace = db.prepare(`
    INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insertSpace.run('f2-320', 'models/fast-embed-320', 'rev-f2', 'mean', 320, 'q8')
  insertSpace.run('qwen-512', 'models/qwen-512', 'rev-qwen', 'mean', 512, 'q8')
  insertSpace.run('fake-320', 'models/fake-model-320', 'rev-fake', 'cls', 320, 'fp32')

  // Document 1 with active chunk set 1
  db.prepare(`
    INSERT INTO documents (id, path, name, status, last_opened_at, active_chunk_set_id, embedding_model, chunk_total, chunk_done)
    VALUES (1, 'D:/documents/company-handbook.docx', 'company-handbook.docx', 'ready', 1700000000, 1, 'f2-320', 2, 2)
  `).run()

  db.prepare(`
    INSERT INTO chunk_sets (id, document_id, chunker_version, state)
    VALUES (1, 1, 1, 'active')
  `).run()

  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
    VALUES (?, 1, 1, ?, ?, ?, ?)
  `)
  insertChunk.run(101, 0, 'Nguyên tắc vận hành doanh nghiệp và bảo mật thông tin', 'nguyen tac van hanh doanh nghiep va bao mat thong tin', 'Trang 1')
  insertChunk.run(102, 1, 'Chỉ số đo lường hiệu suất OKR và kế hoạch Q4', 'chi so do luong hieu suat okr va ke hoach q4', 'Trang 2')

  // Distinct vectors for each space to guarantee byte-level verification
  const v1_f2 = createSampleVector(320, 0.111)
  const v1_qwen = createSampleVector(512, 0.222)
  const v1_fake = createSampleVector(320, 0.333)

  const v2_f2 = createSampleVector(320, 0.444)
  const v2_qwen = createSampleVector(512, 0.555)
  const v2_fake = createSampleVector(320, 0.666)

  const insertChunkEmbedding = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
    VALUES (?, ?, ?, ?)
  `)

  // Insert with deterministic order based on parameter
  const insertVectorsForChunk = (chunkId: number, f2Vec: Uint8Array, qwenVec: Uint8Array, fakeVec: Uint8Array) => {
    if (insertionOrder === 'fake-first') {
      insertChunkEmbedding.run(chunkId, 'fake-320', fakeVec, 320)
      insertChunkEmbedding.run(chunkId, 'qwen-512', qwenVec, 512)
      insertChunkEmbedding.run(chunkId, 'f2-320', f2Vec, 320)
    } else if (insertionOrder === 'qwen-first') {
      insertChunkEmbedding.run(chunkId, 'qwen-512', qwenVec, 512)
      insertChunkEmbedding.run(chunkId, 'fake-320', fakeVec, 320)
      insertChunkEmbedding.run(chunkId, 'f2-320', f2Vec, 320)
    } else {
      insertChunkEmbedding.run(chunkId, 'f2-320', f2Vec, 320)
      insertChunkEmbedding.run(chunkId, 'fake-320', fakeVec, 320)
      insertChunkEmbedding.run(chunkId, 'qwen-512', qwenVec, 512)
    }
  }

  insertVectorsForChunk(101, v1_f2, v1_qwen, v1_fake)
  insertVectorsForChunk(102, v2_f2, v2_qwen, v2_fake)

  // ann_indexes for spaces
  const insertAnn = db.prepare('INSERT INTO ann_indexes (space_id, generation, state) VALUES (?, 1, ?)')
  insertAnn.run('f2-320', 'ready')
  insertAnn.run('qwen-512', 'ready')
  insertAnn.run('fake-320', 'ready')

  db.close()

  return { v1_f2, v1_qwen, v1_fake, v2_f2, v2_qwen, v2_fake }
}

describe('Pair 02: Migration Active-Space Selection Suite (QA-02)', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-qa02-migspace-'))
    dbPath = join(tempDir, 'document-memory.db')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('SPACE-01: target F2 → only F2', () => {
    // Setup fixture with same chunk containing F2 320D, Qwen 512D, and FakeModel 320D
    const vectors = setupMultiSpaceFixtureDb(dbPath, 'fake-first')

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
      const allEmbeddings = rawDb.prepare(
        'SELECT chunk_id, space_id, vector, vector_dim FROM chunk_embeddings ORDER BY chunk_id ASC'
      ).all() as Array<{
        chunk_id: number
        space_id: string
        vector: Uint8Array
        vector_dim: number
      }>

      // 1. Target chunk_embeddings must contain exactly 2 vectors, exclusively for 'f2-320'
      expect(allEmbeddings).toHaveLength(2)
      for (const emb of allEmbeddings) {
        expect(emb.space_id).toBe('f2-320')
        expect(emb.vector_dim).toBe(320)
      }

      // 2. Zero foreign vectors (0 from fake-320, 0 from qwen-512)
      const fakeVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'fake-320'").get() as { count: number }
      const qwenVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'qwen-512'").get() as { count: number }
      const foreignVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id != 'f2-320'").get() as { count: number }
      expect(fakeVectors.count).toBe(0)
      expect(qwenVectors.count).toBe(0)
      expect(foreignVectors.count).toBe(0)

      // 3. Exact payload match for F2 vectors
      const chunk101Emb = allEmbeddings.find((e) => e.chunk_id === 101)
      const chunk102Emb = allEmbeddings.find((e) => e.chunk_id === 102)
      expect(chunk101Emb).toBeDefined()
      expect(chunk102Emb).toBeDefined()
      expect(Buffer.from(chunk101Emb!.vector).equals(Buffer.from(vectors.v1_f2))).toBe(true)
      expect(Buffer.from(chunk102Emb!.vector).equals(Buffer.from(vectors.v2_f2))).toBe(true)

      // 4. Verify document_embedding_counts table
      const docCounts = rawDb.prepare(
        'SELECT document_id, space_id, completed_chunks FROM document_embedding_counts'
      ).all() as Array<{
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

      // 5. Document status & model
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

  it('SPACE-02: target Qwen → only Qwen', () => {
    // Setup fixture with same chunk containing F2 320D, Qwen 512D, and FakeModel 320D
    const vectors = setupMultiSpaceFixtureDb(dbPath, 'fake-first')

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
      const allEmbeddings = rawDb.prepare(
        'SELECT chunk_id, space_id, vector, vector_dim FROM chunk_embeddings ORDER BY chunk_id ASC'
      ).all() as Array<{
        chunk_id: number
        space_id: string
        vector: Uint8Array
        vector_dim: number
      }>

      // 1. Target chunk_embeddings must contain exactly 2 vectors, exclusively for 'qwen-512'
      expect(allEmbeddings).toHaveLength(2)
      for (const emb of allEmbeddings) {
        expect(emb.space_id).toBe('qwen-512')
        expect(emb.vector_dim).toBe(512)
      }

      // 2. Zero foreign vectors (0 from f2-320, 0 from fake-320)
      const f2Vectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'f2-320'").get() as { count: number }
      const fakeVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'fake-320'").get() as { count: number }
      const foreignVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id != 'qwen-512'").get() as { count: number }
      expect(f2Vectors.count).toBe(0)
      expect(fakeVectors.count).toBe(0)
      expect(foreignVectors.count).toBe(0)

      // 3. Exact payload match for Qwen vectors
      const chunk101Emb = allEmbeddings.find((e) => e.chunk_id === 101)
      const chunk102Emb = allEmbeddings.find((e) => e.chunk_id === 102)
      expect(chunk101Emb).toBeDefined()
      expect(chunk102Emb).toBeDefined()
      expect(Buffer.from(chunk101Emb!.vector).equals(Buffer.from(vectors.v1_qwen))).toBe(true)
      expect(Buffer.from(chunk102Emb!.vector).equals(Buffer.from(vectors.v2_qwen))).toBe(true)

      // 4. Document counts
      const docCounts = rawDb.prepare(
        'SELECT document_id, space_id, completed_chunks FROM document_embedding_counts'
      ).all() as Array<{
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

      // 5. Document status & model
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

  it('SPACE-03: target missing → no foreign vector', () => {
    setupMultiSpaceFixtureDb(dbPath, 'fake-first')

    // Active space that does not exist in source database
    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'missing-model-768',
      activeDimensions: 768,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(1)
    expect(result.chunksCopied).toBe(2)
    expect(result.embeddingsCopied).toBe(0)

    const store = new DocumentMemoryStore(dbPath)
    try {
      // 1. All lexical chunks and FTS are 100% copied and queryable
      const chunk101 = store.readChunk(101)
      const chunk102 = store.readChunk(102)
      expect(chunk101).not.toBeNull()
      expect(chunk101?.text).toBe('Nguyên tắc vận hành doanh nghiệp và bảo mật thông tin')
      expect(chunk102).not.toBeNull()
      expect(chunk102?.text).toBe('Chỉ số đo lường hiệu suất OKR và kế hoạch Q4')

      const ftsHits = store.searchLexical('vận hành', 10)
      expect(ftsHits.length).toBeGreaterThanOrEqual(1)
      expect(ftsHits[0].chunkId).toBe(101)

      // 2. Vector count is strictly 0: no foreign vectors from f2-320, qwen-512, or fake-320
      const rawDb = store.rawDb
      const totalEmbeddings = rawDb.prepare('SELECT count(*) as count FROM chunk_embeddings').get() as { count: number }
      expect(totalEmbeddings.count).toBe(0)

      const f2Vectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'f2-320'").get() as { count: number }
      const qwenVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'qwen-512'").get() as { count: number }
      const fakeVectors = rawDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'fake-320'").get() as { count: number }
      expect(f2Vectors.count).toBe(0)
      expect(qwenVectors.count).toBe(0)
      expect(fakeVectors.count).toBe(0)

      // 3. document_embedding_counts has 0 records
      const countRows = rawDb.prepare('SELECT count(*) as count FROM document_embedding_counts').get() as { count: number }
      expect(countRows.count).toBe(0)

      // 4. Document gracefully transitioned to 'text-only' status with null embedding_model and chunk_done = 0
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

  it('SPACE-04: FakeModel 320D must not become F2', () => {
    // 1. Multi-space fixture where both F2 320D and FakeModel 320D exist for the same chunk:
    // Verify that FakeModel 320D vector is NEVER copied into F2 space or confused with F2
    const vectors = setupMultiSpaceFixtureDb(dbPath, 'fake-first')

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'f2-320',
      activeDimensions: 320,
    })
    expect(result.success).toBe(true)

    const rawDb = new DatabaseSync(dbPath)
    try {
      const f2Rows = rawDb.prepare('SELECT chunk_id, space_id, vector FROM chunk_embeddings WHERE space_id = ?').all('f2-320') as Array<{
        chunk_id: number
        space_id: string
        vector: Uint8Array
      }>
      expect(f2Rows).toHaveLength(2)

      const row101 = f2Rows.find((r) => r.chunk_id === 101)!
      // The migrated vector MUST equal F2 vector
      expect(Buffer.from(row101.vector).equals(Buffer.from(vectors.v1_f2))).toBe(true)
      // The migrated vector MUST NOT equal FakeModel vector even though FakeModel is also 320D
      expect(Buffer.from(row101.vector).equals(Buffer.from(vectors.v1_fake))).toBe(false)
    } finally {
      rawDb.close()
    }

    // 2. Dedicated scenario: A chunk that ONLY has FakeModel 320D and DOES NOT have F2 320D:
    // When target is f2-320, FakeModel 320D MUST NOT be adopted or converted into F2
    const onlyFakeDbPath = join(tempDir, 'only-fake.db')
    const onlyFakeDb = new DatabaseSync(onlyFakeDbPath)
    createBaseV2Schema(onlyFakeDb)

    onlyFakeDb.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('fake-320', 'models/fake-model-320', 'rev-fake', 'cls', 320, 'fp32')

    onlyFakeDb.prepare(`
      INSERT INTO documents (id, path, name, status, last_opened_at, active_chunk_set_id, embedding_model, chunk_total, chunk_done)
      VALUES (2, 'D:/documents/fake-only.docx', 'fake-only.docx', 'ready', 1700000000, 2, 'fake-320', 1, 1)
    `).run()

    onlyFakeDb.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (2, 2, 1, 'active')
    `).run()

    onlyFakeDb.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES (201, 2, 2, 0, 'Chunk chỉ có FakeModel embedding', 'chunk chi co fakemodel embedding', 'P1')
    `).run()

    const fakeVec201 = createSampleVector(320, 0.777)
    onlyFakeDb.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (201, 'fake-320', ?, 320)
    `).run(fakeVec201)
    onlyFakeDb.close()

    // Migrate targeting f2-320 (320D)
    const onlyFakeResult = migrateStorageV2ToV3(onlyFakeDbPath, {
      activeSpaceId: 'f2-320',
      activeDimensions: 320,
    })

    expect(onlyFakeResult.success).toBe(true)
    expect(onlyFakeResult.documentsCopied).toBe(1)
    expect(onlyFakeResult.chunksCopied).toBe(1)
    expect(onlyFakeResult.embeddingsCopied).toBe(0) // MUST be 0! FakeModel 320D was NOT converted to F2!

    const verifyFakeDb = new DatabaseSync(onlyFakeDbPath)
    try {
      const f2Count = verifyFakeDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'f2-320'").get() as { count: number }
      const fakeCount = verifyFakeDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id = 'fake-320'").get() as { count: number }
      const totalCount = verifyFakeDb.prepare('SELECT count(*) as count FROM chunk_embeddings').get() as { count: number }
      expect(f2Count.count).toBe(0)
      expect(fakeCount.count).toBe(0)
      expect(totalCount.count).toBe(0)

      const doc = verifyFakeDb.prepare('SELECT status, embedding_model, chunk_done FROM documents WHERE id = 2').get() as {
        status: string
        embedding_model: string | null
        chunk_done: number
      }
      expect(doc.status).toBe('text-only')
      expect(doc.embedding_model).toBeNull()
      expect(doc.chunk_done).toBe(0)
    } finally {
      verifyFakeDb.close()
    }
  })

  it('SPACE-05: source order does not affect selected model', () => {
    // Test 3 different table insertion orders for chunk_embeddings in source SQLite
    const orders: Array<'fake-first' | 'qwen-first' | 'f2-first'> = ['fake-first', 'qwen-first', 'f2-first']

    for (const order of orders) {
      const orderDbPath = join(tempDir, `order-${order}.db`)
      const orderVectors = setupMultiSpaceFixtureDb(orderDbPath, order)

      // Test migration to F2 320D
      const f2MigResult = migrateStorageV2ToV3(orderDbPath, {
        activeSpaceId: 'f2-320',
        activeDimensions: 320,
      })
      expect(f2MigResult.success).toBe(true)

      const orderDb = new DatabaseSync(orderDbPath)
      try {
        const f2Rows = orderDb.prepare('SELECT chunk_id, space_id, vector FROM chunk_embeddings WHERE space_id = ?').all('f2-320') as Array<{
          chunk_id: number
          space_id: string
          vector: Uint8Array
        }>
        expect(f2Rows).toHaveLength(2)

        const r101 = f2Rows.find((r) => r.chunk_id === 101)!
        const r102 = f2Rows.find((r) => r.chunk_id === 102)!
        expect(Buffer.from(r101.vector).equals(Buffer.from(orderVectors.v1_f2))).toBe(true)
        expect(Buffer.from(r102.vector).equals(Buffer.from(orderVectors.v2_f2))).toBe(true)

        // Ensure 0 foreign vectors
        const foreignCount = orderDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id != 'f2-320'").get() as { count: number }
        expect(foreignCount.count).toBe(0)
      } finally {
        orderDb.close()
      }

      // Also test a separate DB for Qwen with the same order
      const qwenOrderDbPath = join(tempDir, `qwen-order-${order}.db`)
      const qwenVectors = setupMultiSpaceFixtureDb(qwenOrderDbPath, order)

      const qwenMigResult = migrateStorageV2ToV3(qwenOrderDbPath, {
        activeSpaceId: 'qwen-512',
        activeDimensions: 512,
      })
      expect(qwenMigResult.success).toBe(true)

      const qwenDb = new DatabaseSync(qwenOrderDbPath)
      try {
        const qwenRows = qwenDb.prepare('SELECT chunk_id, space_id, vector FROM chunk_embeddings WHERE space_id = ?').all('qwen-512') as Array<{
          chunk_id: number
          space_id: string
          vector: Uint8Array
        }>
        expect(qwenRows).toHaveLength(2)

        const r101 = qwenRows.find((r) => r.chunk_id === 101)!
        const r102 = qwenRows.find((r) => r.chunk_id === 102)!
        expect(Buffer.from(r101.vector).equals(Buffer.from(qwenVectors.v1_qwen))).toBe(true)
        expect(Buffer.from(r102.vector).equals(Buffer.from(qwenVectors.v2_qwen))).toBe(true)

        const foreignCount = qwenDb.prepare("SELECT count(*) as count FROM chunk_embeddings WHERE space_id != 'qwen-512'").get() as { count: number }
        expect(foreignCount.count).toBe(0)
      } finally {
        qwenDb.close()
      }
    }
  })

  it('SPACE-06: target dimensions mismatch → fail', () => {
    // 1. Space 'f2-320' has declared dimensions 320, but options provide activeDimensions = 512
    setupMultiSpaceFixtureDb(dbPath, 'fake-first')

    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'f2-320',
        activeDimensions: 512,
      })
    }).toThrowError(/Logical consistency verification failed before cutover/)

    // 2. Space 'qwen-512' has declared dimensions 512, but options provide activeDimensions = 320
    const mismatchQwenPath = join(tempDir, 'mismatch-qwen.db')
    setupMultiSpaceFixtureDb(mismatchQwenPath, 'fake-first')

    expect(() => {
      migrateStorageV2ToV3(mismatchQwenPath, {
        activeSpaceId: 'qwen-512',
        activeDimensions: 320,
      })
    }).toThrowError(/Logical consistency verification failed before cutover/)

    // 3. Target dimensions mismatch: source contains corrupted vector with mismatched dimensionality
    const corruptDbPath = join(tempDir, 'corrupt-dim.db')
    const corruptDb = new DatabaseSync(corruptDbPath)
    createBaseV2Schema(corruptDb)

    corruptDb.prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('corrupt-space', 'models/corrupt', 'rev1', 'mean', 320, 'q8')
    `).run()

    corruptDb.prepare(`
      INSERT INTO documents (id, path, name, status, last_opened_at, active_chunk_set_id, embedding_model, chunk_total, chunk_done)
      VALUES (3, 'D:/documents/corrupt.docx', 'corrupt.docx', 'ready', 1700000000, 3, 'corrupt-space', 1, 1)
    `).run()

    corruptDb.prepare(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state)
      VALUES (3, 3, 1, 'active')
    `).run()

    corruptDb.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES (301, 3, 3, 0, 'Corrupt vector chunk', 'corrupt vector chunk', 'P1')
    `).run()

    // Insert 128D vector blob for a 320D declared space
    const corruptVec = createSampleVector(128, 0.999)
    corruptDb.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (301, 'corrupt-space', ?, 128)
    `).run(corruptVec)
    corruptDb.close()

    expect(() => {
      migrateStorageV2ToV3(corruptDbPath, {
        activeSpaceId: 'corrupt-space',
        activeDimensions: 320,
      })
    }).toThrowError(/Logical consistency verification failed before cutover/)
  })
})
