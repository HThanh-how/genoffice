import { DatabaseSync } from 'node:sqlite'
import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { isGeneratedArtifactPath } from './artifact-policy'
import { documentIndexFields } from './normalization'
import { LEGACY_E5_EMBEDDING_ID, LEGACY_VIETNAMESE_EMBEDDING_ID } from './embedding-profiles'
import { OcrSidecar } from './ocr-sidecar'

export interface StorageMigrationOptions {
  pageSize?: number
  tempDbPath?: string
  backupDbPath?: string
  activeSpaceId?: string
  onProgress?: (progress: StorageMigrationProgress) => void
  /** Injects failure for testing rollback robustness */
  testFailureInjectionPoint?: 'before-cutover' | 'corrupt-temp' | 'verification-failed'
}

export interface StorageMigrationProgress {
  phase: 'schema' | 'documents' | 'fts' | 'cutover' | 'verified' | 'rollback'
  documentsProcessed: number
  documentsCopied: number
  documentsDropped: number
  chunksCopied: number
  embeddingsCopied: number
}

export interface StorageMigrationResult {
  success: boolean
  sourceDbPath: string
  targetDbPath: string
  backupDbPath: string
  documentsProcessed: number
  documentsCopied: number
  documentsDroppedArtifacts: number
  chunksCopied: number
  embeddingsCopied: number
  durationMs: number
  verified: boolean
}

export const SCHEMA_V3 = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS documents (
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
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  truncated INTEGER NOT NULL DEFAULT 0,
  truncated_reason TEXT CHECK (truncated_reason IN ('chunk-limit', 'content-limit', 'pdf-page-limit', 'tabular-sampling') OR truncated_reason IS NULL),
  last_opened_at INTEGER NOT NULL DEFAULT 0,
  priority_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  chunk_total INTEGER NOT NULL DEFAULT 0,
  chunk_done INTEGER NOT NULL DEFAULT 0,
  chunk_counted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS embedding_spaces (
  id TEXT PRIMARY KEY,
  model_repo TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  pooling TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  quantization TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chunk_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunker_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building', 'active', 'retired')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_set_id INTEGER REFERENCES chunk_sets(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  location TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_embedding_counts (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(document_id, space_id)
);
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  vector_dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chunk_id, space_id)
);
CREATE INDEX IF NOT EXISTS chunk_embeddings_space ON chunk_embeddings(space_id, chunk_id);
CREATE TABLE IF NOT EXISTS embedding_migrations (
  target_space_id TEXT PRIMARY KEY,
  source_space_id TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'paused', 'complete', 'failed')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunk_migrations (
  version INTEGER PRIMARY KEY,
  total_documents INTEGER NOT NULL,
  completed_documents INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ann_indexes (
  space_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0,
  desired_generation INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  indexed_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'dirty',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS document_name_fts USING fts5(
  name,
  path,
  content='documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='3 4'
);
CREATE TRIGGER IF NOT EXISTS documents_name_ai AFTER INSERT ON documents BEGIN
  INSERT INTO document_name_fts(rowid, name, path) VALUES(new.id, new.name, new.path);
END;
CREATE TRIGGER IF NOT EXISTS documents_name_ad AFTER DELETE ON documents BEGIN
  INSERT INTO document_name_fts(document_name_fts, rowid, name, path) VALUES('delete', old.id, old.name, old.path);
END;
CREATE TRIGGER IF NOT EXISTS documents_name_au AFTER UPDATE OF name, path ON documents BEGIN
  INSERT INTO document_name_fts(document_name_fts, rowid, name, path) VALUES('delete', old.id, old.name, old.path);
  INSERT INTO document_name_fts(rowid, name, path) VALUES(new.id, new.name, new.path);
END;
CREATE TABLE IF NOT EXISTS document_memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS chunks_chunk_set_id ON chunks(chunk_set_id);
CREATE UNIQUE INDEX IF NOT EXISTS chunks_set_ordinal ON chunks(chunk_set_id, ordinal) WHERE chunk_set_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chunks_legacy_doc_ordinal ON chunks(document_id, ordinal) WHERE chunk_set_id IS NULL;
CREATE INDEX IF NOT EXISTS documents_excluded_status ON documents(excluded, status);
CREATE TRIGGER IF NOT EXISTS chunks_counter_insert AFTER INSERT ON chunks
BEGIN
  UPDATE documents SET chunk_total = chunk_total + 1 WHERE id = new.document_id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_counter_delete AFTER DELETE ON chunks
BEGIN
  UPDATE documents SET chunk_total = chunk_total - 1 WHERE id = old.document_id;
END;
`

function cleanWalFiles(path: string): void {
  const wal = `${path}-wal`
  const shm = `${path}-shm`
  if (existsSync(wal)) {
    try {
      unlinkSync(wal)
    } catch {
      // ignore
    }
  }
  if (existsSync(shm)) {
    try {
      unlinkSync(shm)
    } catch {
      // ignore
    }
  }
}

export function verifyDatabaseIntegrity(dbPath: string): {
  ok: boolean
  integrity: string
  foreignKeyErrors: unknown[]
} {
  const db = new DatabaseSync(dbPath)
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    const integrity = integrityRow?.integrity_check ?? 'unknown'
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all()
    const ok = integrity === 'ok' && foreignKeyErrors.length === 0
    return { ok, integrity, foreignKeyErrors }
  } finally {
    db.close()
  }
}

/**
 * Executes V2 to V3 storage migration:
 * 1. Creates a clean temp database with V3 schema (auto_vacuum=INCREMENTAL, WAL, foreign_keys=ON).
 * 2. Copies only live canonical data in bounded pages.
 * 3. Applies document policies:
 *    - Case A: excluded=1 -> copies exclusion metadata only.
 *    - Case B: last_opened_at=0 AND isGeneratedArtifactPath(path) -> DROPPED (auto-discovered build artifacts).
 *    - Case C: last_opened_at>0 -> KEPT (user explicit intent preserves document).
 *    - Case D: normal document -> copies metadata, active chunks, canonical embeddings, and OCR sidecars.
 * 4. Rebuilds clean FTS5 from active canonical chunks.
 * 5. Marks ann_indexes as 'dirty' for clean post-migration rebuild.
 * 6. Performs atomic cutover with WAL truncate, atomic renames, verification, and automated safe rollback.
 */
export function migrateStorageV2ToV3(
  sourceDbPath: string,
  options: StorageMigrationOptions = {},
): StorageMigrationResult {
  const startTime = performance.now()
  const resolvedSource = resolve(sourceDbPath)
  const tempPath = resolve(options.tempDbPath ?? `${resolvedSource}.v3.tmp`)
  const backupPath = resolve(options.backupDbPath ?? `${resolvedSource}.v2.backup.db`)
  const pageSize = options.pageSize ?? 500

  if (!existsSync(resolvedSource)) {
    throw new Error(`Source database does not exist: ${resolvedSource}`)
  }

  // Cleanup old temp file if exists from previous abort
  if (existsSync(tempPath)) {
    cleanWalFiles(tempPath)
    try {
      unlinkSync(tempPath)
    } catch {
      // ignore
    }
  }

  // 1. Initialize Temp DB with Schema V3
  const tempDb = new DatabaseSync(tempPath)
  tempDb.exec(
    'PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
  )
  tempDb.exec(SCHEMA_V3)
  OcrSidecar.ensureSchema(tempDb)

  // 2. Open Source DB
  const sourceDb = new DatabaseSync(resolvedSource)
  sourceDb.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')

  let totalProcessed = 0
  let totalCopied = 0
  let totalDroppedArtifacts = 0
  let totalChunksCopied = 0
  let totalEmbeddingsCopied = 0

  try {
    options.onProgress?.({
      phase: 'schema',
      documentsProcessed: 0,
      documentsCopied: 0,
      documentsDropped: 0,
      chunksCopied: 0,
      embeddingsCopied: 0,
    })

    // Check source database table structure
    const sourceTables = (
      sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((t) => t.name)

    const sourceChunkCols = sourceTables.includes('chunks')
      ? (sourceDb.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        )
      : []

    const hasSourceChunks = sourceTables.includes('chunks')
    const hasChunkSetId = sourceChunkCols.includes('chunk_set_id')
    const hasChunkVector = sourceChunkCols.includes('vector')
    const hasSourceChunkEmbeddings = sourceTables.includes('chunk_embeddings')
    const hasSourceChunkSets = sourceTables.includes('chunk_sets')
    const hasSourceOcrPages = sourceTables.includes('ocr_pages')
    const hasSourcePdfScanInfo = sourceTables.includes('pdf_scan_info')
    const hasSourceAnnIndexes = sourceTables.includes('ann_indexes')

    // Copy embedding spaces (active spaces and standard spaces)
    if (sourceTables.includes('embedding_spaces')) {
      const spaces = sourceDb
        .prepare(
          'SELECT id, model_repo, model_revision, pooling, dimensions, quantization FROM embedding_spaces',
        )
        .all() as Array<{
        id: string
        model_repo: string
        model_revision: string
        pooling: string
        dimensions: number
        quantization: string
      }>

      const insertSpace = tempDb.prepare(`
        INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const space of spaces) {
        insertSpace.run(
          space.id,
          space.model_repo,
          space.model_revision,
          space.pooling,
          space.dimensions,
          space.quantization,
        )
      }
    } else {
      // Ensure defaults
      tempDb
        .prepare(`
        INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
        VALUES
          (?, 'Xenova/multilingual-e5-small', '761b726dd34fb83930e26aab4e9ac3899aa1fa78', 'mean', 384, 'q8'),
          (?, 'AITeamVN/Vietnamese_Embedding', 'dea33aa1ab339f38d66ae0a40e6c40e0a9249568', 'sentence', 1024, 'fp32')
      `)
        .run(LEGACY_E5_EMBEDDING_ID, LEGACY_VIETNAMESE_EMBEDDING_ID)
    }

    // Prepared statements for copying into tempDb
    const insertDoc = tempDb.prepare(`
      INSERT INTO documents (
        id, path, name, status, mtime_ms, size_bytes, hash, embedding_model,
        active_chunk_set_id, error, excluded, truncated, truncated_reason,
        last_opened_at, priority_at, updated_at, chunk_total, chunk_done, chunk_counted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertChunkSet = tempDb.prepare(`
      INSERT OR REPLACE INTO chunk_sets (id, document_id, chunker_version, state, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const insertChunk = tempDb.prepare(`
      INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    const insertFts = tempDb.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)')

    const insertEmbedding = tempDb.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `)

    const ensureEmbeddingSpace = tempDb.prepare(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'legacy', 'mean', ?, 'fp32')
    `)

    const insertOcrPage = hasSourceOcrPages
      ? tempDb.prepare(`
        INSERT OR REPLACE INTO ocr_pages (path, page, hash, mtime_ms, size_bytes, total_pages, text, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      : null

    const insertPdfScan = hasSourcePdfScanInfo
      ? tempDb.prepare(`
        INSERT OR REPLACE INTO pdf_scan_info (path, mtime_ms, size_bytes, total_pages, scanned)
        VALUES (?, ?, ?, ?, ?)
      `)
      : null

    // Paged iteration over documents in sourceDb using keyset pagination
    let lastId = 0
    let hasMore = true

    while (hasMore) {
      const pageDocs = sourceDb
        .prepare('SELECT * FROM documents WHERE id > ? ORDER BY id ASC LIMIT ?')
        .all(lastId, pageSize) as Array<{
        id: number
        path: string
        name: string
        status: string
        mtime_ms: number | null
        size_bytes: number | null
        hash: string | null
        embedding_model: string | null
        active_chunk_set_id?: number | null
        error: string | null
        excluded?: number
        truncated?: number
        truncated_reason?: string | null
        last_opened_at?: number
        priority_at?: number
        updated_at?: number
        chunk_total?: number
        chunk_done?: number
        chunk_counted?: number
      }>

      if (pageDocs.length === 0) {
        hasMore = false
        break
      }

      tempDb.exec('BEGIN IMMEDIATE')
      try {
        for (const doc of pageDocs) {
          totalProcessed++
          lastId = doc.id
          const lastOpenedAt = doc.last_opened_at ?? 0
          const isExcluded = doc.excluded === 1

          // Case B: Auto-discovered generated artifact: NEVER OPENED (last_opened_at === 0) AND artifact path
          // Policy: Drop completely! (Removes 10 chromium license files without requiring Clear Index)
          if (!isExcluded && lastOpenedAt === 0 && isGeneratedArtifactPath(doc.path)) {
            totalDroppedArtifacts++
            continue
          }

          // Case C (User-opened: last_opened_at > 0) OR Case D (Normal document) OR Case A (Excluded metadata)
          totalCopied++

          // 1. Copy Document Row
          insertDoc.run(
            doc.id,
            doc.path,
            doc.name ?? basename(doc.path),
            doc.status,
            doc.mtime_ms ?? null,
            doc.size_bytes ?? null,
            doc.hash ?? null,
            doc.embedding_model ?? null,
            doc.active_chunk_set_id ?? null,
            doc.error ?? null,
            isExcluded ? 1 : 0,
            doc.truncated ? 1 : 0,
            doc.truncated_reason ?? null,
            lastOpenedAt,
            doc.priority_at ?? lastOpenedAt,
            doc.updated_at ?? Math.floor(Date.now() / 1000),
            0, // Counter triggers will maintain chunk_total
            0,
            1,
          )

          // If excluded, do NOT copy searchable chunks or embeddings (Case A)
          if (isExcluded) {
            continue
          }

          // 2. Determine Active Chunks to Copy
          // We copy ONLY active chunk set (or legacy chunks where chunk_set_id IS NULL)
          // Retired chunk sets and abandoned building sets are ignored!
          let chunksToCopy: Array<{
            id: number
            document_id: number
            chunk_set_id?: number | null
            ordinal: number
            text: string
            location: string
            vector?: Uint8Array | null
            vector_dim?: number | null
          }> = []

          if (!hasSourceChunks) {
            chunksToCopy = []
          } else if (doc.active_chunk_set_id != null && hasChunkSetId) {
            // Copy active chunk set entry
            if (hasSourceChunkSets) {
              const activeSetRow = sourceDb
                .prepare('SELECT id, chunker_version, state, created_at FROM chunk_sets WHERE id = ?')
                .get(doc.active_chunk_set_id) as
                | { id: number; chunker_version: number; state: string; created_at: number }
                | undefined

              if (activeSetRow) {
                insertChunkSet.run(
                  activeSetRow.id,
                  doc.id,
                  activeSetRow.chunker_version,
                  'active',
                  activeSetRow.created_at,
                )
              }
            }

            chunksToCopy = sourceDb
              .prepare(
                'SELECT * FROM chunks WHERE document_id = ? AND chunk_set_id = ? ORDER BY ordinal ASC',
              )
              .all(doc.id, doc.active_chunk_set_id) as typeof chunksToCopy
          } else if (hasChunkSetId) {
            // Legacy chunks without chunk_set_id
            chunksToCopy = sourceDb
              .prepare(
                'SELECT * FROM chunks WHERE document_id = ? AND chunk_set_id IS NULL ORDER BY ordinal ASC',
              )
              .all(doc.id) as typeof chunksToCopy
          } else {
            // Pre-V2 chunks table without chunk_set_id column
            chunksToCopy = sourceDb
              .prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal ASC')
              .all(doc.id) as typeof chunksToCopy
          }

          let docActiveVectors = 0
          for (const chunk of chunksToCopy) {
            totalChunksCopied++

            // Insert into V3 chunks table (no vector columns!)
            insertChunk.run(
              chunk.id,
              doc.id,
              chunk.chunk_set_id ?? null,
              chunk.ordinal,
              chunk.text,
              chunk.location,
            )

            // Rebuild FTS5 entry
            const fields = documentIndexFields(chunk.text)
            insertFts.run(chunk.id, fields.searchText)

            // Embeddings: check chunk_embeddings first, fallback to legacy chunks.vector
            let vectorBlob: Uint8Array | null = null
            let vectorDim = 0
            let spaceId = doc.embedding_model ?? LEGACY_E5_EMBEDDING_ID

            if (hasSourceChunkEmbeddings) {
              const embRow = sourceDb
                .prepare('SELECT space_id, vector, vector_dim FROM chunk_embeddings WHERE chunk_id = ?')
                .get(chunk.id) as
                | { space_id: string; vector: Uint8Array; vector_dim: number }
                | undefined
              if (embRow && embRow.vector) {
                vectorBlob = embRow.vector
                vectorDim = embRow.vector_dim
                spaceId = embRow.space_id
              }
            }

            if (!vectorBlob && hasChunkVector && chunk.vector) {
              vectorBlob = chunk.vector
              vectorDim = chunk.vector_dim ?? (chunk.vector.byteLength / 4)
            }

            if (vectorBlob && vectorDim > 0) {
              ensureEmbeddingSpace.run(spaceId, spaceId, vectorDim)
              insertEmbedding.run(chunk.id, spaceId, vectorBlob, vectorDim)
              totalEmbeddingsCopied++
              docActiveVectors++

              // Upsert document_embedding_counts
              tempDb
                .prepare(`
                  INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
                  VALUES (?, ?, 1)
                  ON CONFLICT (document_id, space_id)
                  DO UPDATE SET completed_chunks = document_embedding_counts.completed_chunks + 1
                `)
                .run(doc.id, spaceId)
            }
          }

          if (docActiveVectors > 0) {
            tempDb
              .prepare('UPDATE documents SET chunk_done = ? WHERE id = ?')
              .run(docActiveVectors, doc.id)
          }

          // 3. Copy OCR Sidecar data if available
          if (insertOcrPage) {
            const ocrRows = sourceDb.prepare('SELECT * FROM ocr_pages WHERE path = ?').all(doc.path) as Array<{
              path: string
              page: number
              hash: string
              mtime_ms: number
              size_bytes: number
              total_pages: number
              text: string
              model?: string | null
              created_at: number
            }>
            for (const ocr of ocrRows) {
              insertOcrPage.run(
                ocr.path,
                ocr.page,
                ocr.hash,
                ocr.mtime_ms,
                ocr.size_bytes,
                ocr.total_pages,
                ocr.text,
                ocr.model ?? null,
                ocr.created_at,
              )
            }
          }

          if (insertPdfScan) {
            const pdfRows = sourceDb
              .prepare('SELECT * FROM pdf_scan_info WHERE path = ?')
              .all(doc.path) as Array<{
              path: string
              mtime_ms: number
              size_bytes: number
              total_pages: number
              scanned: string
            }>
            for (const pdf of pdfRows) {
              insertPdfScan.run(pdf.path, pdf.mtime_ms, pdf.size_bytes, pdf.total_pages, pdf.scanned)
            }
          }
        }
        tempDb.exec('COMMIT')
      } catch (err) {
        tempDb.exec('ROLLBACK')
        throw err
      }

      options.onProgress?.({
        phase: 'documents',
        documentsProcessed: totalProcessed,
        documentsCopied: totalCopied,
        documentsDropped: totalDroppedArtifacts,
        chunksCopied: totalChunksCopied,
        embeddingsCopied: totalEmbeddingsCopied,
      })
    }

    // 4. Copy ANN metadata but mark state = 'dirty'
    if (hasSourceAnnIndexes) {
      const annRows = sourceDb
        .prepare('SELECT space_id, file_path, generation, desired_generation FROM ann_indexes')
        .all() as Array<{
        space_id: string
        file_path?: string | null
        generation?: number
        desired_generation?: number
      }>
      const insertAnn = tempDb.prepare(`
        INSERT OR REPLACE INTO ann_indexes (space_id, generation, desired_generation, file_path, indexed_count, state, updated_at)
        VALUES (?, ?, ?, ?, 0, 'dirty', unixepoch())
      `)
      for (const ann of annRows) {
        insertAnn.run(
          ann.space_id,
          ann.generation ?? 0,
          ann.desired_generation ?? 0,
          ann.file_path ?? null,
        )
      }
    }

    // Record schema metadata
    tempDb
      .prepare("INSERT OR REPLACE INTO document_memory_meta (key, value) VALUES ('schema_version', '3')")
      .run()
    tempDb
      .prepare("INSERT OR REPLACE INTO document_memory_meta (key, value) VALUES ('name_fts_version', '1')")
      .run()

    // Test failure injection before cutover
    if (options.testFailureInjectionPoint === 'before-cutover') {
      throw new Error('Test injected failure before cutover')
    }

    if (options.testFailureInjectionPoint === 'corrupt-temp') {
      tempDb.exec('DROP TABLE documents;')
    }

    // 5. Atomic Cutover
    options.onProgress?.({
      phase: 'cutover',
      documentsProcessed: totalProcessed,
      documentsCopied: totalCopied,
      documentsDropped: totalDroppedArtifacts,
      chunksCopied: totalChunksCopied,
      embeddingsCopied: totalEmbeddingsCopied,
    })

    // Checkpoint WAL on both source and temp
    sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } finally {
    sourceDb.close()
    tempDb.close()
  }

  // File system atomic cutover with safe rollback
  cleanWalFiles(resolvedSource)
  cleanWalFiles(tempPath)

  let backupCreated = false
  try {
    // Rename source -> backup
    renameSync(resolvedSource, backupPath)
    backupCreated = true

    // Rename temp -> source
    renameSync(tempPath, resolvedSource)

    // Verification check on newly cutover database
    if (options.testFailureInjectionPoint === 'verification-failed') {
      throw new Error('Test injected verification failure')
    }

    const verification = verifyDatabaseIntegrity(resolvedSource)
    if (!verification.ok) {
      throw new Error(
        `Integrity verification failed post-cutover: integrity=${verification.integrity}, fkErrors=${verification.foreignKeyErrors.length}`,
      )
    }

    options.onProgress?.({
      phase: 'verified',
      documentsProcessed: totalProcessed,
      documentsCopied: totalCopied,
      documentsDropped: totalDroppedArtifacts,
      chunksCopied: totalChunksCopied,
      embeddingsCopied: totalEmbeddingsCopied,
    })

    const durationMs = Math.round(performance.now() - startTime)
    return {
      success: true,
      sourceDbPath: resolvedSource,
      targetDbPath: resolvedSource,
      backupDbPath: backupPath,
      documentsProcessed: totalProcessed,
      documentsCopied: totalCopied,
      documentsDroppedArtifacts: totalDroppedArtifacts,
      chunksCopied: totalChunksCopied,
      embeddingsCopied: totalEmbeddingsCopied,
      durationMs,
      verified: true,
    }
  } catch (error) {
    // SAFE ROLLBACK
    options.onProgress?.({
      phase: 'rollback',
      documentsProcessed: totalProcessed,
      documentsCopied: totalCopied,
      documentsDropped: totalDroppedArtifacts,
      chunksCopied: totalChunksCopied,
      embeddingsCopied: totalEmbeddingsCopied,
    })

    if (backupCreated && existsSync(backupPath)) {
      // Remove failed target if present
      if (existsSync(resolvedSource)) {
        cleanWalFiles(resolvedSource)
        try {
          unlinkSync(resolvedSource)
        } catch {
          // ignore
        }
      }
      // Restore original V2 backup back to sourceDbPath
      renameSync(backupPath, resolvedSource)
    }

    // Cleanup temp if still exists
    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try {
        unlinkSync(tempPath)
      } catch {
        // ignore
      }
    }

    throw new Error(
      `V2 to V3 migration failed and was safely rolled back. Reason: ${(error as Error).message}`,
      { cause: error },
    )
  }
}
