import { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { applyCanonicalSchemaV3 } from '../schema-v3'
import { OcrSidecar } from '../../ocr-sidecar'
import { evaluateRetentionPolicy } from './retention-policy'
import { verifyDatabaseIntegrity, verifyLogicalConsistency } from './logical-verifier'
import { performAtomicCutover, cleanWalFiles, getManifestPath } from './cutover'
import { generateCollisionSafeBackupPath } from './backup-retention'
import {
  copyEmbeddingSpaces,
  ensureActiveEmbeddingSpaceMetadata,
  prepareMigrationStatements,
  copyDocumentActiveChunks,
  copyOcrData,
  copyMediaRow,
  copyAnnMetadata,
} from './data-copier'
import { copyOversizedDocument } from './oversized-document-copier'
import {
  getEffectiveStorageBudget,
  estimateMigrationGrowthBytes,
  estimateBatchMigrationGrowth,
  checkMigrationAdmission,
  getValidatedFreeDiskBytesSync,
  MigrationBudgetContract,
  MAX_MIGRATION_BATCH_DOCS,
  MAX_MIGRATION_BATCH_BYTES,
} from '../../runtime/backup-write-budget'
import { collectStorageAccounting } from '../../runtime/storage-accounting'
import type {
  StorageMigrationOptions,
  StorageMigrationProgress,
  StorageMigrationResult,
} from '../../storage-migration'

export type {
  StorageMigrationOptions,
  StorageMigrationProgress,
  StorageMigrationResult,
}

/** Executes V2 to V3 storage migration runner (INV-01, INV-02, INV-08, INV-09). */
export function runStorageMigrationV2ToV3(
  sourceDbPath: string,
  options: StorageMigrationOptions,
): StorageMigrationResult {
  // 1. Upfront strict parameter validation before any file or database mutation
  if (
    !options?.activeSpaceId ||
    typeof options.activeDimensions !== 'number' ||
    !Number.isSafeInteger(options.activeDimensions) ||
    options.activeDimensions <= 0
  ) {
    throw new Error('Migration target embedding space must be explicitly specified (activeSpaceId and activeDimensions must be positive safe integers).')
  }

  const rawPageSize = options.pageSize !== undefined ? options.pageSize : MAX_MIGRATION_BATCH_DOCS
  if (!Number.isSafeInteger(rawPageSize) || rawPageSize <= 0) {
    throw new Error(`pageSize must be a positive safe integer, got ${options.pageSize}`)
  }
  const effectiveBatchLimit = Math.min(rawPageSize, MAX_MIGRATION_BATCH_DOCS)

  const startTime = performance.now()
  const resolvedSource = resolve(sourceDbPath)
  const tempPath = resolve(options.tempDbPath ?? `${resolvedSource}.v3.tmp`)
  // Unique collision-safe backup path; manifest preserves exact path throughout atomic cutover
  const backupPath = resolve(options.backupDbPath ?? generateCollisionSafeBackupPath(resolvedSource))
  const activeSpaceId = options.activeSpaceId
  const activeDimensions = options.activeDimensions

  if (!existsSync(resolvedSource)) throw new Error(`Source database does not exist: ${resolvedSource}`)

  // 2. Cutover safety precedes quota: check for unresolved manifest BEFORE touching temp files
  const manifestPath = getManifestPath(resolvedSource)
  const tempManifestPath = `${manifestPath}.tmp`
  if (existsSync(manifestPath) || existsSync(tempManifestPath)) {
    throw new Error(
      `Cannot start migration: unresolved cutover manifest found at "${manifestPath}". Cutover crash recovery must run before mutation.`,
    )
  }

  // 3. Prevent backup destination overwrite collision
  if (options.backupDbPath && existsSync(backupPath)) {
    throw new Error(
      `Backup destination collision: explicit backup path already exists at "${backupPath}". Cannot overwrite existing backup.`,
    )
  }

  // 4. Resolve and validate storage budget (fails closed on invalid budget or corrupted settings)
  let budgetBytes = options.budgetBytes
  if (budgetBytes === undefined) {
    const effectiveBudget = getEffectiveStorageBudget(options.settingsDir ?? dirname(resolvedSource))
    if (!effectiveBudget.valid) {
      throw new Error(`Storage budget configuration invalid or corrupted: ${effectiveBudget.error}`)
    }
    budgetBytes = effectiveBudget.budgetBytes
  }

  // 5. Durable exclusive operation guard cooperating with bootstrap/main before opening files
  const guardFilePath = `${resolvedSource}.migrating`
  let guardFileCreated: boolean
  try {
    writeFileSync(guardFilePath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' })
    guardFileCreated = true
  } catch (err: any) {
    throw new Error(
      `Cannot start migration: concurrent migration or unrecovered migration guard exists at "${guardFilePath}": ${err?.message || String(err)}`,
      { cause: err },
    )
  }

  let sourceDb: DatabaseSync | null = null
  let tempDb: DatabaseSync | null = null
  let inSourceTx = false
  let ownedTempPath: string | null = null

  let totalProcessed = 0
  let totalCopied = 0
  let totalDropped = 0
  let totalChunks = 0
  let totalEmbeddings = 0

  try {
    // 6. Open source DB and acquire exclusive transactional write fence (held throughout copy)
    sourceDb = new DatabaseSync(resolvedSource)
    sourceDb.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    try {
      sourceDb.exec('BEGIN IMMEDIATE;')
      inSourceTx = true
    } catch (err: any) {
      throw new Error(`Concurrent writer detected on source database during migration: ${err?.message || String(err)}`, { cause: err })
    }

    // 7. No single-document size gate: a document larger than MAX_MIGRATION_BATCH_BYTES is copied in byte-bounded
    // slices (oversized-document-copier.ts), each admitted against the live quota / free disk before it is written.
    // The whole-database admission below (grace zone + hardCapBytes) still denies a migration that cannot fit.

    // 8. Preflight quota and free disk admission check BEFORE new DatabaseSync(tempPath)
    const preReport = collectStorageAccounting({ dbPath: resolvedSource })
    if (preReport.isDegraded) {
      throw new Error(
        'Storage accounting is degraded due to I/O or permission errors; migration admission rejected (fail-closed)',
      )
    }

    const currentUsageBytes = preReport.totalManagedBytes
    const estimatedGrowthBytes = estimateMigrationGrowthBytes(sourceDb, activeSpaceId, activeDimensions)
    const freeDiskBytes =
      options.freeDiskBytes !== undefined ? options.freeDiskBytes : getValidatedFreeDiskBytesSync(dirname(resolvedSource))

    const admission = checkMigrationAdmission({
      sourceDbPath: resolvedSource,
      currentUsageBytes,
      budgetBytes,
      estimatedGrowthBytes,
      freeDiskBytes,
      accountingDegraded: preReport.isDegraded,
    })

    if (!admission.admitted) {
      throw new Error(`Migration storage admission rejected: ${admission.error || admission.reason}`)
    }

    const contract =
      options.budgetContract ?? new MigrationBudgetContract(resolvedSource, currentUsageBytes, budgetBytes)

    // 9. Safely clean previous temporary files (verified safe because manifest does not exist)
    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try {
        unlinkSync(tempPath)
      } catch {
        /* ignore */
      }
    }

    ownedTempPath = tempPath
    tempDb = new DatabaseSync(tempPath)
    tempDb.exec('PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;')
    applyCanonicalSchemaV3(tempDb)
    OcrSidecar.ensureSchema(tempDb)

    options.onProgress?.({
      phase: 'schema',
      documentsProcessed: 0,
      documentsCopied: 0,
      documentsDropped: 0,
      chunksCopied: 0,
      embeddingsCopied: 0,
    })
    copyEmbeddingSpaces(sourceDb, tempDb)
    ensureActiveEmbeddingSpaceMetadata(tempDb, activeSpaceId, activeDimensions)
    const stmts = prepareMigrationStatements(sourceDb, tempDb)
    let lastId = 0
    let hasMore = true

    // Live recompute of free disk and base usage, then contract admission, before every write unit (batch or slice)
    const admitLive = (estimatedBytes: number): void => {
      const liveFreeDisk =
        options.freeDiskBytes !== undefined ? options.freeDiskBytes : getValidatedFreeDiskBytesSync(dirname(resolvedSource))
      const liveReport = collectStorageAccounting({ dbPath: resolvedSource })
      if (liveReport.isDegraded) {
        throw new Error('Storage accounting degraded during migration batch admission')
      }
      const batchAdmission = contract.admitBatch(estimatedBytes, liveFreeDisk, liveReport.totalManagedBytes)
      if (!batchAdmission.admitted) {
        throw new Error(`Storage quota exceeded during migration batch: ${batchAdmission.reason}`)
      }
    }
    const insertDocumentRows = (doc: any): void => {
      stmts.insertDoc.run(
        doc.id,
        doc.path,
        doc.name ?? basename(doc.path),
        doc.status,
        doc.mtime_ms ?? null,
        doc.size_bytes ?? null,
        doc.hash ?? null,
        // a model other than the active space is not carried: its vectors are not copied (legacy-vector-policy.ts)
        doc.embedding_model === activeSpaceId ? activeSpaceId : null,
        doc.active_chunk_set_id ?? null,
        doc.error ?? null,
        doc.excluded === 1 ? 1 : 0,
        doc.truncated ? 1 : 0,
        doc.truncated_reason ?? null,
        doc.last_opened_at ?? 0,
        doc.priority_at ?? (doc.last_opened_at ?? 0),
        doc.updated_at ?? Math.floor(Date.now() / 1000),
        0,
        0,
        1,
      )
      copyMediaRow(sourceDb!, doc.id, stmts)
    }

    // 10. Copy documents in bounded batches (both page doc count and byte bounds strictly checked BEFORE BEGIN)
    while (hasMore) {
      const candidateDocs = sourceDb
        .prepare('SELECT * FROM documents WHERE id > ? ORDER BY id ASC LIMIT ?')
        .all(lastId, effectiveBatchLimit) as Array<any>
      if (candidateDocs.length === 0) {
        hasMore = false
        break
      }

      // Bound batch bytes BEFORE BEGIN:
      const batchDocs: any[] = []
      let batchGrowthBytes = 0

      for (const doc of candidateDocs) {
        const docGrowth = estimateBatchMigrationGrowth(sourceDb, [doc.id], activeDimensions, activeSpaceId)
        if (batchDocs.length > 0 && batchGrowthBytes + docGrowth > MAX_MIGRATION_BATCH_BYTES) {
          break
        }
        batchDocs.push(doc)
        batchGrowthBytes += docGrowth
        // A document that alone exceeds the bound travels alone and is copied in slices (never rejected)
        if (docGrowth > MAX_MIGRATION_BATCH_BYTES) break
      }
      const oversizedDoc = batchGrowthBytes > MAX_MIGRATION_BATCH_BYTES


      if (!oversizedDoc) admitLive(batchGrowthBytes)

      if (oversizedDoc) {
        const doc = batchDocs[0]
        totalProcessed++
        lastId = doc.id
        const decision = evaluateRetentionPolicy(doc)
        if (!decision.shouldCopyDocument) {
          totalDropped++
        } else {
          totalCopied++
          const copied = copyOversizedDocument({
            sourceDb,
            tempDb,
            stmts,
            doc,
            decision,
            activeSpaceId,
            activeDimensions,
            maxSliceBytes: MAX_MIGRATION_BATCH_BYTES,
            budget: { admit: admitLive, reconcile: () => contract.reconcileBatch(tempPath) },
            insertDocumentRows: () => insertDocumentRows(doc),
          })
          totalChunks += copied.chunks
          totalEmbeddings += copied.embeddings
        }
      } else {
        tempDb.exec('BEGIN IMMEDIATE')
        try {
          for (const doc of batchDocs) {
            totalProcessed++
            lastId = doc.id
            const decision = evaluateRetentionPolicy(doc)
            if (!decision.shouldCopyDocument) {
              totalDropped++
              continue
            }
            totalCopied++

            insertDocumentRows(doc)
            if (!decision.shouldCopyChunksAndEmbeddings) continue

            const counts = copyDocumentActiveChunks(sourceDb, tempDb, doc, stmts, activeSpaceId, activeDimensions)
            totalChunks += counts.chunks
            totalEmbeddings += counts.embeddings
            copyOcrData(sourceDb, doc.path, stmts, doc)
          }
          tempDb.exec('COMMIT')
        } catch (err) {
          tempDb.exec('ROLLBACK')
          throw err
        }
      }

      // Post-commit: reconcile fresh physical bytes on disk (fails closed on non-ENOENT stat errors)
      contract.reconcileBatch(tempPath)

      options.onProgress?.({
        phase: 'documents',
        documentsProcessed: totalProcessed,
        documentsCopied: totalCopied,
        documentsDropped: totalDropped,
        chunksCopied: totalChunks,
        embeddingsCopied: totalEmbeddings,
      })
    }

    // 11. Budget final metadata, ANN copy, WAL checkpoint, cutover manifest & retention overhead (no hidden writes)
    const finalOverheadBytes = 128 * 1024 // 128 KB base overhead buffer for ANN metadata, meta table, and WAL truncate
    const finalFreeDisk =
      options.freeDiskBytes !== undefined ? options.freeDiskBytes : getValidatedFreeDiskBytesSync(dirname(resolvedSource))
    const finalReport = collectStorageAccounting({ dbPath: resolvedSource })
    if (finalReport.isDegraded) {
      throw new Error('Storage accounting degraded before final cutover admission')
    }
    const finalAdmission = contract.admitBatch(finalOverheadBytes, finalFreeDisk, finalReport.totalManagedBytes)
    if (!finalAdmission.admitted) {
      throw new Error(`Storage quota exceeded during final cutover admission: ${finalAdmission.reason}`)
    }

    copyAnnMetadata(sourceDb, tempDb)
    tempDb
      .prepare(
        "INSERT OR REPLACE INTO document_memory_meta (key, value) VALUES ('schema_version', '3'), ('name_fts_version', '1')",
      )
      .run()
    contract.reconcileBatch(tempPath)

    if (options.testFailureInjectionPoint === 'before-cutover') throw new Error('Test injected failure before cutover')
    if (options.testFailureInjectionPoint === 'corrupt-temp') tempDb.exec('DROP TABLE documents;')

    const integrity = verifyDatabaseIntegrity(tempDb)
    if (!integrity.ok) throw new Error(`Integrity verification failed before cutover: integrity=${integrity.integrity}`)
    const logical = verifyLogicalConsistency(tempDb, totalCopied, totalChunks, activeSpaceId, activeDimensions)
    if (!logical.ok) {
      throw new Error(`Logical consistency verification failed before cutover: ${logical.reasons.join('; ')}`)
    }

    options.onProgress?.({
      phase: 'cutover',
      documentsProcessed: totalProcessed,
      documentsCopied: totalCopied,
      documentsDropped: totalDropped,
      chunksCopied: totalChunks,
      embeddingsCopied: totalEmbeddings,
    })

    // 12. Release source transaction write fence BEFORE wal_checkpoint to allow clean truncate
    if (inSourceTx) {
      sourceDb.exec('COMMIT;')
      inSourceTx = false
    }

    sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE);')

    // Close both database handles before filesystem cutover rename
    sourceDb.close()
    sourceDb = null
    tempDb.close()
    tempDb = null

    // 13. Perform atomic cutover with State Machine Manifest and automatic safe rollback
    performAtomicCutover({
      resolvedSource,
      tempPath,
      backupPath,
      testFailureInjectionPoint: options.testFailureInjectionPoint,
      onRollback: () =>
        options.onProgress?.({
          phase: 'rollback',
          documentsProcessed: totalProcessed,
          documentsCopied: totalCopied,
          documentsDropped: totalDropped,
          chunksCopied: totalChunks,
          embeddingsCopied: totalEmbeddings,
        }),
    })

    // Remove migration exclusive guard file on success
    if (guardFileCreated) {
      try {
        unlinkSync(guardFilePath)
      } catch {
        /* ignore */
      }
      guardFileCreated = false
    }
  } catch (err) {
    if (inSourceTx && sourceDb) {
      try {
        sourceDb.exec('ROLLBACK;')
      } catch {
        /* ignore */
      }
      inSourceTx = false
    }
    if (sourceDb) {
      try {
        sourceDb.close()
      } catch {
        /* ignore */
      }
      sourceDb = null
    }
    if (tempDb) {
      try {
        tempDb.close()
      } catch {
        /* ignore */
      }
      tempDb = null
    }
    // Cleanup ONLY owned new temp, preserving user original and avoiding touching arbitrary/unowned paths
    if (ownedTempPath && existsSync(ownedTempPath)) {
      cleanWalFiles(ownedTempPath)
      try {
        unlinkSync(ownedTempPath)
      } catch {
        /* ignore */
      }
    }
    if (guardFileCreated) {
      try {
        unlinkSync(guardFilePath)
      } catch {
        /* ignore */
      }
      guardFileCreated = false
    }
    throw err
  } finally {
    if (inSourceTx && sourceDb) {
      try {
        sourceDb.exec('ROLLBACK;')
      } catch {
        /* ignore */
      }
    }
    if (sourceDb) {
      try {
        sourceDb.close()
      } catch {
        /* ignore */
      }
    }
    if (tempDb) {
      try {
        tempDb.close()
      } catch {
        /* ignore */
      }
    }
    if (guardFileCreated) {
      try {
        unlinkSync(guardFilePath)
      } catch {
        /* ignore */
      }
    }
  }

  options.onProgress?.({
    phase: 'verified',
    documentsProcessed: totalProcessed,
    documentsCopied: totalCopied,
    documentsDropped: totalDropped,
    chunksCopied: totalChunks,
    embeddingsCopied: totalEmbeddings,
  })

  return {
    success: true,
    sourceDbPath: resolvedSource,
    targetDbPath: resolvedSource,
    backupDbPath: backupPath,
    documentsProcessed: totalProcessed,
    documentsCopied: totalCopied,
    documentsDroppedArtifacts: totalDropped,
    chunksCopied: totalChunks,
    embeddingsCopied: totalEmbeddings,
    durationMs: Math.round(performance.now() - startTime),
    verified: true,
  }
}

export { runStorageMigrationV2ToV3 as migrateStorageV2ToV3 }
