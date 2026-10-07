import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

function floatBlob(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

describe('Document Memory V2 to V3 Migration Suite', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-v3-mig-'))
    dbPath = join(directory, 'document-memory.db')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('migrates V2 database with policy filtering: drops auto-discovered artifacts, keeps user-opened, active chunks only, and preserves OCR', () => {
    // 1. Manually setup a rich V2 database
    const v2Db = new DatabaseSync(dbPath)
    v2Db.exec(`
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
      CREATE TABLE ocr_pages (
        path TEXT NOT NULL,
        page INTEGER NOT NULL,
        hash TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        total_pages INTEGER NOT NULL,
        text TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (path, page)
      ) WITHOUT ROWID;
      CREATE TABLE pdf_scan_info (
        path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        total_pages INTEGER NOT NULL,
        scanned TEXT NOT NULL
      ) WITHOUT ROWID;
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

    // Insert Embedding Space
    v2Db
      .prepare(`
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('space-v2', 'repo/v2', 'rev1', 'mean', 2, 'q8')
    `)
      .run()

    // Document 1: Case B - Auto-discovered generated artifact (last_opened_at = 0, licenses.chromium.html)
    // POLICY: MUST BE DROPPED!
    v2Db
      .prepare(`
      INSERT INTO documents (id, path, name, status, last_opened_at)
      VALUES (1, 'D:/app/dist_electron/win-unpacked/licenses.chromium.html', 'licenses.chromium.html', 'ready', 0)
    `)
      .run()
    v2Db
      .prepare(`
      INSERT INTO chunks (id, document_id, ordinal, text, normalized, location)
      VALUES (101, 1, 0, 'Chromium license terms', 'chromium license terms', 'Chunk 1')
    `)
      .run()

    // Document 2: Case C - User-opened generated-looking file (last_opened_at > 0)
    // POLICY: USER INTENT WINS -> MUST BE KEPT!
    v2Db
      .prepare(`
      INSERT INTO documents (id, path, name, status, last_opened_at, embedding_model)
      VALUES (2, 'D:/projects/custom/licenses.chromium.html', 'licenses.chromium.html', 'ready', 1700000000, 'space-v2')
    `)
      .run()
    v2Db
      .prepare(`
      INSERT INTO chunks (id, document_id, ordinal, text, normalized, location)
      VALUES (201, 2, 0, 'User inspected chromium license', 'user inspected chromium license', 'Chunk 1')
    `)
      .run()
    v2Db
      .prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (201, 'space-v2', ?, 2)
    `)
      .run(floatBlob([0.1, 0.9]))

    // Document 3: Case D - Normal document with retired chunk set, building chunk set, active chunk set, and OCR
    // POLICY: ONLY ACTIVE CHUNKS & OCR COPIED!
    v2Db
      .prepare(`
      INSERT INTO documents (id, path, name, status, last_opened_at, embedding_model, active_chunk_set_id)
      VALUES (3, 'D:/docs/report.pdf', 'report.pdf', 'ready', 1700000100, 'space-v2', 302)
    `)
      .run()

    // Set 301 (retired), Set 302 (active), Set 303 (building / abandoned)
    v2Db.exec(`
      INSERT INTO chunk_sets (id, document_id, chunker_version, state) VALUES
        (301, 3, 1, 'retired'),
        (302, 3, 2, 'active'),
        (303, 3, 2, 'building');
      
      -- Chunks for retired set
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location) VALUES
        (311, 3, 301, 0, 'Old retired text', 'old retired text', 'Chunk 1');

      -- Chunks for active set
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location) VALUES
        (321, 3, 302, 0, 'Active report executive summary', 'active report executive summary', 'Chunk 1');

      -- Chunks for abandoned building set
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location) VALUES
        (331, 3, 303, 0, 'Abandoned draft text', 'abandoned draft text', 'Chunk 1');
    `)

    v2Db
      .prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (321, 'space-v2', ?, 2)
    `)
      .run(floatBlob([0.8, 0.6]))

    // OCR Sidecar for doc 3
    v2Db
      .prepare(`
      INSERT INTO ocr_pages (path, page, hash, mtime_ms, size_bytes, total_pages, text)
      VALUES ('D:/docs/report.pdf', 1, 'pdfhash123', 1000, 5000, 1, 'OCR transcribed page 1 text')
    `)
      .run()
    v2Db
      .prepare(`
      INSERT INTO pdf_scan_info (path, mtime_ms, size_bytes, total_pages, scanned)
      VALUES ('D:/docs/report.pdf', 1000, 5000, 1, '1')
    `)
      .run()

    // Document 4: Case A - Excluded document
    // POLICY: Metadata copied, no searchable chunks copied
    v2Db
      .prepare(`
      INSERT INTO documents (id, path, name, status, excluded, last_opened_at)
      VALUES (4, 'D:/docs/secret.txt', 'secret.txt', 'excluded', 1, 0)
    `)
      .run()

    v2Db
      .prepare(`
      INSERT INTO ann_indexes (space_id, generation, state) VALUES ('space-v2', 1, 'ready')
    `)
      .run()

    v2Db.close()

    // 2. Run V2 to V3 Migration
    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'space-v2',
      activeDimensions: 2,
    })
    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsDroppedArtifacts).toBe(1) // doc 1 dropped!
    expect(result.documentsCopied).toBe(3) // doc 2, 3, 4 copied

    // 3. Inspect migrated V3 database using DocumentMemoryStore
    const store = new DocumentMemoryStore(dbPath)
    try {
      // Doc 1 (auto-discovered artifact) MUST NOT EXIST
      const doc1 = store.documentById(1)
      expect(doc1).toBeNull()

      // Doc 2 (user opened) MUST EXIST
      const doc2 = store.documentById(2)
      expect(doc2).not.toBeNull()
      expect(doc2?.name).toBe('licenses.chromium.html')

      // Doc 3 (normal doc with active set) MUST EXIST
      const doc3 = store.documentById(3)
      expect(doc3).not.toBeNull()
      expect(doc3?.name).toBe('report.pdf')

      // Doc 4 (excluded) MUST EXIST as excluded
      const doc4 = store.documentById(4)
      expect(doc4).not.toBeNull()
      expect(doc4?.status).toBe('excluded')

      // Check Chunks: retired chunk 311 and abandoned chunk 331 MUST NOT EXIST
      const chunk311 = store.readChunk(311)
      const chunk331 = store.readChunk(331)
      expect(chunk311).toBeNull()
      expect(chunk331).toBeNull()

      // Active chunk 321 MUST EXIST
      const chunk321 = store.readChunk(321)
      expect(chunk321).not.toBeNull()
      expect(chunk321?.text).toBe('Active report executive summary')

      // Search Lexical FTS5 works immediately on migrated active chunks
      const ftsHits = store.searchLexical('executive summary', 10)
      expect(ftsHits).toHaveLength(1)
      expect(ftsHits[0]?.chunkId).toBe(321)

      // Search Semantic works from canonical chunk_embeddings
      const semHits = store.searchSemantic([0.8, 0.6], 10, 'space-v2')
      expect(semHits.length).toBeGreaterThanOrEqual(1)
      expect(semHits[0]?.chunkId).toBe(321)

      // Check OCR sidecar preserved
      const ocrPages = store.ocr.pages('D:/docs/report.pdf', 'pdfhash123')
      expect(ocrPages).not.toBeNull()
      expect(ocrPages?.pages[0]?.text).toBe('OCR transcribed page 1 text')

      // Check ANN indexes state was set to 'dirty' for background rebuild
      const rawDb = store.rawDb
      const annRow = rawDb.prepare("SELECT state FROM ann_indexes WHERE space_id = 'space-v2'").get() as {
        state: string
      }
      expect(annRow.state).toBe('dirty')

      // Check document_embedding_counts table populated
      expect(store.getEmbeddingCounts(3, 'space-v2')).toBe(1)
      expect(store.getEmbeddingCounts(2, 'space-v2')).toBe(1)
    } finally {
      store.close()
    }
  })
})
