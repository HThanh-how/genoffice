import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'

function floatBlob(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

function makeVector(dim: number, seed: number): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i * 0.05))
}

function initLegacyDb(dbPath: string): DatabaseSync {
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
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_set_id INTEGER,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      normalized TEXT NOT NULL,
      location TEXT NOT NULL,
      vector BLOB,
      vector_dim INTEGER
    );
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
  `)
  return db
}

describe('Legacy Vector Provenance Migration Rules', () => {
  let directory: string
  let dbPath: string

  const TARGET_SPACE_ID = EMBEDDING_PROFILES.standard.embeddingId
  const TARGET_DIM = EMBEDDING_PROFILES.standard.dimensions // 320
  const FAKE_SPACE_ID = 'fake-model-320'
  const QWEN_SPACE_ID = EMBEDDING_PROFILES.high.embeddingId
  const QWEN_DIM = EMBEDDING_PROFILES.high.dimensions // 512

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-legacy-vec-'))
    dbPath = join(directory, 'document-memory.sqlite')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('LEGACYVEC-01: F2 320 -> target F2 320 => copy vector', () => {
    const rawDb = initLegacyDb(dbPath)
    const vec320 = makeVector(TARGET_DIM, 1.1)
    const blob320 = floatBlob(vec320)

    rawDb.exec(`
      INSERT INTO documents (id, path, name, status, embedding_model, chunk_total, chunk_done, chunk_counted, last_opened_at)
      VALUES (1, 'D:/work/f2-report.docx', 'f2-report.docx', 'ready', '${TARGET_SPACE_ID}', 1, 1, 1, 1700000000);
    `)
    rawDb
      .prepare(`
        INSERT INTO chunks (id, document_id, ordinal, text, normalized, location, vector, vector_dim)
        VALUES (101, 1, 0, 'Quarterly financial report with verified F2 embeddings', 'quarterly financial report with verified f2 embeddings', 'p1', ?, 320)
      `)
      .run(blob320)
    rawDb.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (101, ?)').run('Quarterly financial report with verified F2 embeddings')
    rawDb.close()

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: TARGET_SPACE_ID,
      activeDimensions: TARGET_DIM,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.chunksCopied).toBe(1)
    expect(result.embeddingsCopied).toBe(1)

    const store = new DocumentMemoryStore(dbPath)
    try {
      const doc = store.documentById(1)
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe('ready')

      const raw = store.rawDb
      const docRow = raw.prepare('SELECT status, embedding_model, chunk_done FROM documents WHERE id = 1').get() as any
      expect(docRow.status).toBe('ready')
      expect(docRow.embedding_model).toBe(TARGET_SPACE_ID)
      expect(docRow.chunk_done).toBe(1)

      const embRow = raw.prepare('SELECT chunk_id, space_id, vector_dim, length(vector) as byte_len FROM chunk_embeddings WHERE chunk_id = 101').get() as any
      expect(embRow).toBeDefined()
      expect(embRow.space_id).toBe(TARGET_SPACE_ID)
      expect(embRow.vector_dim).toBe(320)
      expect(embRow.byte_len).toBe(320 * 4)

      expect(store.getEmbeddingCounts(1, TARGET_SPACE_ID)).toBe(1)

      const hits = store.searchSemantic(vec320, 5, TARGET_SPACE_ID)
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits[0]?.chunkId).toBe(101)
    } finally {
      store.close()
    }
  })

  it('LEGACYVEC-02: Fake 320 -> target F2 320 => DO NOT copy vector (dù cùng dimension 320)', () => {
    const rawDb = initLegacyDb(dbPath)
    const vec320 = makeVector(TARGET_DIM, 2.2)
    const blob320 = floatBlob(vec320)

    rawDb.exec(`
      INSERT INTO documents (id, path, name, status, embedding_model, chunk_total, chunk_done, chunk_counted, last_opened_at)
      VALUES (2, 'D:/work/fake-report.docx', 'fake-report.docx', 'ready', '${FAKE_SPACE_ID}', 1, 1, 1, 1700000000);
    `)
    rawDb
      .prepare(`
        INSERT INTO chunks (id, document_id, ordinal, text, normalized, location, vector, vector_dim)
        VALUES (201, 2, 0, 'Legacy document generated by an unverified fake 320D model', 'legacy document generated by an unverified fake 320d model', 'p1', ?, 320)
      `)
      .run(blob320)
    rawDb.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (201, ?)').run('Legacy document generated by an unverified fake 320D model')
    rawDb.close()

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: TARGET_SPACE_ID,
      activeDimensions: TARGET_DIM,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.chunksCopied).toBe(1)
    expect(result.embeddingsCopied).toBe(0)

    const store = new DocumentMemoryStore(dbPath)
    try {
      const doc = store.documentById(2)
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe('text-only')

      const raw = store.rawDb
      const docRow = raw.prepare('SELECT status, embedding_model, chunk_done FROM documents WHERE id = 2').get() as any
      expect(docRow.status).toBe('text-only')
      expect(docRow.embedding_model).toBeNull()
      expect(docRow.chunk_done).toBe(0)

      const embRows = raw.prepare('SELECT * FROM chunk_embeddings WHERE chunk_id = 201').all()
      expect(embRows).toHaveLength(0)

      expect(store.getEmbeddingCounts(2, TARGET_SPACE_ID)).toBe(0)

      const hits = store.searchSemantic(vec320, 5, TARGET_SPACE_ID)
      expect(hits.some((h) => h.chunkId === 201)).toBe(false)
    } finally {
      store.close()
    }
  })

  it('LEGACYVEC-03: unknown model (null) 320 -> DO NOT copy vector', () => {
    const rawDb = initLegacyDb(dbPath)
    const vec320 = makeVector(TARGET_DIM, 3.3)
    const blob320 = floatBlob(vec320)

    rawDb.exec(`
      INSERT INTO documents (id, path, name, status, embedding_model, chunk_total, chunk_done, chunk_counted, last_opened_at)
      VALUES (3, 'D:/work/unknown-model.docx', 'unknown-model.docx', 'ready', NULL, 1, 1, 1, 1700000000);
    `)
    rawDb
      .prepare(`
        INSERT INTO chunks (id, document_id, ordinal, text, normalized, location, vector, vector_dim)
        VALUES (301, 3, 0, 'Legacy document with unknown model null provenance', 'legacy document with unknown model null provenance', 'p1', ?, 320)
      `)
      .run(blob320)
    rawDb.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (301, ?)').run('Legacy document with unknown model null provenance')
    rawDb.close()

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: TARGET_SPACE_ID,
      activeDimensions: TARGET_DIM,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.chunksCopied).toBe(1)
    expect(result.embeddingsCopied).toBe(0)

    const store = new DocumentMemoryStore(dbPath)
    try {
      const doc = store.documentById(3)
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe('text-only')

      const raw = store.rawDb
      const docRow = raw.prepare('SELECT status, embedding_model, chunk_done FROM documents WHERE id = 3').get() as any
      expect(docRow.status).toBe('text-only')
      expect(docRow.embedding_model).toBeNull()
      expect(docRow.chunk_done).toBe(0)

      const embRows = raw.prepare('SELECT * FROM chunk_embeddings WHERE chunk_id = 301').all()
      expect(embRows).toHaveLength(0)

      expect(store.getEmbeddingCounts(3, TARGET_SPACE_ID)).toBe(0)
    } finally {
      store.close()
    }
  })

  it('LEGACYVEC-04: Qwen 512 -> target F2 320 => DO NOT copy vector', () => {
    const rawDb = initLegacyDb(dbPath)
    const vec512 = makeVector(QWEN_DIM, 4.4)
    const blob512 = floatBlob(vec512)

    rawDb.exec(`
      INSERT INTO documents (id, path, name, status, embedding_model, chunk_total, chunk_done, chunk_counted, last_opened_at)
      VALUES (4, 'D:/work/qwen-report.docx', 'qwen-report.docx', 'ready', '${QWEN_SPACE_ID}', 1, 1, 1, 1700000000);
    `)
    rawDb
      .prepare(`
        INSERT INTO chunks (id, document_id, ordinal, text, normalized, location, vector, vector_dim)
        VALUES (401, 4, 0, 'Qwen high dimension 512 embeddings cannot fit into F2 320 space', 'qwen high dimension 512 embeddings cannot fit into f2 320 space', 'p1', ?, 512)
      `)
      .run(blob512)
    rawDb.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (401, ?)').run('Qwen high dimension 512 embeddings cannot fit into F2 320 space')
    rawDb.close()

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: TARGET_SPACE_ID,
      activeDimensions: TARGET_DIM,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.chunksCopied).toBe(1)
    expect(result.embeddingsCopied).toBe(0)

    const store = new DocumentMemoryStore(dbPath)
    try {
      const doc = store.documentById(4)
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe('text-only')

      const raw = store.rawDb
      const docRow = raw.prepare('SELECT status, embedding_model, chunk_done FROM documents WHERE id = 4').get() as any
      expect(docRow.status).toBe('text-only')
      expect(docRow.embedding_model).toBeNull()
      expect(docRow.chunk_done).toBe(0)

      const embRows = raw.prepare('SELECT * FROM chunk_embeddings WHERE chunk_id = 401').all()
      expect(embRows).toHaveLength(0)

      expect(store.getEmbeddingCounts(4, TARGET_SPACE_ID)).toBe(0)
    } finally {
      store.close()
    }
  })

  it('LEGACYVEC-05: lexical chunks still survive without vector (text copy 100%, FTS có, status text-only)', () => {
    const rawDb = initLegacyDb(dbPath)
    const vec320 = makeVector(TARGET_DIM, 5.5)
    const blob320 = floatBlob(vec320)

    rawDb.exec(`
      INSERT INTO documents (id, path, name, status, embedding_model, chunk_total, chunk_done, chunk_counted, last_opened_at) VALUES
        (51, 'D:/work/policy-doc.docx', 'policy-doc.docx', 'ready', '${FAKE_SPACE_ID}', 2, 2, 1, 1700000000),
        (52, 'D:/work/manual-doc.docx', 'manual-doc.docx', 'ready', NULL, 1, 1, 1, 1700000000);
    `)

    const insertChunk = rawDb.prepare(`
      INSERT INTO chunks (id, document_id, ordinal, text, normalized, location, vector, vector_dim)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insertChunk.run(501, 51, 0, 'Internal security policy article alpha regarding encryption', 'internal security policy article alpha regarding encryption', 'Section 1', blob320, 320)
    insertChunk.run(502, 51, 1, 'Compliance guidelines paragraph beta on credential storage', 'compliance guidelines paragraph beta on credential storage', 'Section 2', blob320, 320)
    insertChunk.run(503, 52, 0, 'Operational instructions chapter gamma for system restore', 'operational instructions chapter gamma for system restore', 'Chapter 1', blob320, 320)

    const insertFts = rawDb.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)')
    insertFts.run(501, 'Internal security policy article alpha regarding encryption')
    insertFts.run(502, 'Compliance guidelines paragraph beta on credential storage')
    insertFts.run(503, 'Operational instructions chapter gamma for system restore')
    rawDb.close()

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: TARGET_SPACE_ID,
      activeDimensions: TARGET_DIM,
    })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(2)
    expect(result.chunksCopied).toBe(3)
    expect(result.embeddingsCopied).toBe(0)

    const store = new DocumentMemoryStore(dbPath)
    try {
      // 1. Text copy 100%: verify exact text and location preserved for all chunks
      const chunk501 = store.readChunk(501)
      expect(chunk501).not.toBeNull()
      expect(chunk501?.text).toBe('Internal security policy article alpha regarding encryption')
      expect(chunk501?.location).toBe('Section 1')

      const chunk502 = store.readChunk(502)
      expect(chunk502).not.toBeNull()
      expect(chunk502?.text).toBe('Compliance guidelines paragraph beta on credential storage')
      expect(chunk502?.location).toBe('Section 2')

      const chunk503 = store.readChunk(503)
      expect(chunk503).not.toBeNull()
      expect(chunk503?.text).toBe('Operational instructions chapter gamma for system restore')
      expect(chunk503?.location).toBe('Chapter 1')

      // 2. FTS lexical search works immediately and accurately
      const hitsAlpha = store.searchLexical('encryption', 10)
      expect(hitsAlpha.length).toBeGreaterThanOrEqual(1)
      expect(hitsAlpha.some((h) => h.chunkId === 501)).toBe(true)

      const hitsBeta = store.searchLexical('credential storage', 10)
      expect(hitsBeta.length).toBeGreaterThanOrEqual(1)
      expect(hitsBeta.some((h) => h.chunkId === 502)).toBe(true)

      const hitsGamma = store.searchLexical('system restore', 10)
      expect(hitsGamma.length).toBeGreaterThanOrEqual(1)
      expect(hitsGamma.some((h) => h.chunkId === 503)).toBe(true)

      // 3. Document status: both demoted to text-only
      const doc51 = store.documentById(51)
      expect(doc51?.status).toBe('text-only')

      const doc52 = store.documentById(52)
      expect(doc52?.status).toBe('text-only')

      // 4. Zero vectors copied into canonical chunk_embeddings
      const raw = store.rawDb
      const embs = raw.prepare('SELECT count(*) as count FROM chunk_embeddings WHERE chunk_id IN (501, 502, 503)').get() as { count: number }
      expect(embs.count).toBe(0)
    } finally {
      store.close()
    }
  })
})
