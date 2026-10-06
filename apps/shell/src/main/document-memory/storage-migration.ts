import { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { CANONICAL_SCHEMA_V3, applyCanonicalSchemaV3 } from './storage/schema-v3'
import { OcrSidecar } from './ocr-sidecar'
import { evaluateRetentionPolicy } from './storage/migration/retention-policy'
import { verifyDatabaseIntegrity, verifyLogicalConsistency } from './storage/migration/logical-verifier'
import { performAtomicCutover, cleanWalFiles } from './storage/migration/cutover'
import {
  copyEmbeddingSpaces,
  prepareMigrationStatements,
  copyDocumentActiveChunks,
  copyOcrData,
  copyAnnMetadata,
} from './storage/migration/data-copier'

export { CANONICAL_SCHEMA_V3 as SCHEMA_V3, verifyDatabaseIntegrity, verifyLogicalConsistency }

export interface StorageMigrationOptions {
  activeSpaceId: string
  activeDimensions: number
  pageSize?: number
  tempDbPath?: string
  backupDbPath?: string
  onProgress?: (progress: StorageMigrationProgress) => void
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

/** Executes V2 to V3 storage migration runner (INV-01, INV-02, INV-08, INV-09). */
export function migrateStorageV2ToV3(sourceDbPath: string, options: StorageMigrationOptions): StorageMigrationResult {
  if (!options?.activeSpaceId || typeof options.activeDimensions !== 'number') {
    throw new Error('Migration target embedding space must be explicitly specified (activeSpaceId and activeDimensions are required).')
  }

  const startTime = performance.now()
  const resolvedSource = resolve(sourceDbPath)
  const tempPath = resolve(options.tempDbPath ?? `${resolvedSource}.v3.tmp`)
  const backupPath = resolve(options.backupDbPath ?? `${resolvedSource}.v2.backup.db`)
  const pageSize = options.pageSize ?? 500
  const activeSpaceId = options.activeSpaceId
  const activeDimensions = options.activeDimensions

  if (!existsSync(resolvedSource)) throw new Error(`Source database does not exist: ${resolvedSource}`)
  if (existsSync(tempPath)) { cleanWalFiles(tempPath); try { unlinkSync(tempPath) } catch { /* ignore */ } }

  const tempDb = new DatabaseSync(tempPath)
  tempDb.exec('PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  applyCanonicalSchemaV3(tempDb)
  OcrSidecar.ensureSchema(tempDb)

  const sourceDb = new DatabaseSync(resolvedSource)
  sourceDb.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')

  let totalProcessed = 0, totalCopied = 0, totalDropped = 0, totalChunks = 0, totalEmbeddings = 0
  try {
    options.onProgress?.({ phase: 'schema', documentsProcessed: 0, documentsCopied: 0, documentsDropped: 0, chunksCopied: 0, embeddingsCopied: 0 })
    copyEmbeddingSpaces(sourceDb, tempDb)
    const stmts = prepareMigrationStatements(sourceDb, tempDb)
    let lastId = 0, hasMore = true

    while (hasMore) {
      const pageDocs = sourceDb.prepare('SELECT * FROM documents WHERE id > ? ORDER BY id ASC LIMIT ?').all(lastId, pageSize) as Array<any>
      if (pageDocs.length === 0) { hasMore = false; break }
      tempDb.exec('BEGIN IMMEDIATE')
      try {
        for (const doc of pageDocs) {
          totalProcessed++
          lastId = doc.id
          const decision = evaluateRetentionPolicy(doc)
          if (!decision.shouldCopyDocument) { totalDropped++; continue }
          totalCopied++

          stmts.insertDoc.run(
            doc.id, doc.path, doc.name ?? basename(doc.path), doc.status, doc.mtime_ms ?? null,
            doc.size_bytes ?? null, doc.hash ?? null, doc.embedding_model ?? null, doc.active_chunk_set_id ?? null,
            doc.error ?? null, doc.excluded === 1 ? 1 : 0, doc.truncated ? 1 : 0, doc.truncated_reason ?? null,
            doc.last_opened_at ?? 0, doc.priority_at ?? (doc.last_opened_at ?? 0), doc.updated_at ?? Math.floor(Date.now() / 1000), 0, 0, 1,
          )
          if (!decision.shouldCopyChunksAndEmbeddings) continue

          const counts = copyDocumentActiveChunks(sourceDb, tempDb, doc, stmts, activeSpaceId, activeDimensions)
          totalChunks += counts.chunks
          totalEmbeddings += counts.embeddings
          copyOcrData(sourceDb, doc.path, stmts)
        }
        tempDb.exec('COMMIT')
      } catch (err) {
        tempDb.exec('ROLLBACK')
        throw err
      }
      options.onProgress?.({ phase: 'documents', documentsProcessed: totalProcessed, documentsCopied: totalCopied, documentsDropped: totalDropped, chunksCopied: totalChunks, embeddingsCopied: totalEmbeddings })
    }

    copyAnnMetadata(sourceDb, tempDb)
    tempDb.prepare("INSERT OR REPLACE INTO document_memory_meta (key, value) VALUES ('schema_version', '3'), ('name_fts_version', '1')").run()
    if (options.testFailureInjectionPoint === 'before-cutover') throw new Error('Test injected failure before cutover')
    if (options.testFailureInjectionPoint === 'corrupt-temp') tempDb.exec('DROP TABLE documents;')

    const integrity = verifyDatabaseIntegrity(tempDb)
    if (!integrity.ok) throw new Error(`Integrity verification failed before cutover: integrity=${integrity.integrity}`)
    const logical = verifyLogicalConsistency(tempDb, totalCopied, totalChunks)
    if (!logical.ok) throw new Error(`Logical consistency verification failed before cutover: ${logical.reasons.join('; ')}`)

    options.onProgress?.({ phase: 'cutover', documentsProcessed: totalProcessed, documentsCopied: totalCopied, documentsDropped: totalDropped, chunksCopied: totalChunks, embeddingsCopied: totalEmbeddings })
    sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } finally {
    sourceDb.close()
    tempDb.close()
  }

  performAtomicCutover({
    resolvedSource, tempPath, backupPath, testFailureInjectionPoint: options.testFailureInjectionPoint,
    onRollback: () => options.onProgress?.({ phase: 'rollback', documentsProcessed: totalProcessed, documentsCopied: totalCopied, documentsDropped: totalDropped, chunksCopied: totalChunks, embeddingsCopied: totalEmbeddings }),
  })

  options.onProgress?.({ phase: 'verified', documentsProcessed: totalProcessed, documentsCopied: totalCopied, documentsDropped: totalDropped, chunksCopied: totalChunks, embeddingsCopied: totalEmbeddings })
  return {
    success: true, sourceDbPath: resolvedSource, targetDbPath: resolvedSource, backupDbPath: backupPath,
    documentsProcessed: totalProcessed, documentsCopied: totalCopied, documentsDroppedArtifacts: totalDropped,
    chunksCopied: totalChunks, embeddingsCopied: totalEmbeddings, durationMs: Math.round(performance.now() - startTime), verified: true,
  }
}
