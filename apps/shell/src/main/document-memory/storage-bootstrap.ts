import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inspectDatabaseVersion, type StorageVersionReport } from './storage/schema-inspector'
import { migrateStorageV2ToV3, type StorageMigrationResult } from './storage-migration'
import { recoverInterruptedCutover } from './storage/migration/cutover'
import { readActiveEmbeddingConfig } from './storage/embedding-settings'

export interface BootstrapResult {
  ready: boolean
  migrated: boolean
  report?: StorageVersionReport
  migrationResult?: StorageMigrationResult
  error?: string
}

/**
 * Ensures that Document Memory SQLite database is fully migrated and verified
 * according to Schema V3 BEFORE any runtime components open it (Invariant INV-01).
 * 
 * Must be executed before `new DocumentMemoryManager()` or any worker startup.
 */
export async function ensureDocumentMemoryStorageReady(dbDir: string): Promise<BootstrapResult> {
  const dbPath = join(dbDir, 'document-memory.db')

  // Check and recover from any interrupted cutover state first (BEH-16)
  try {
    const recovered = recoverInterruptedCutover(dbDir)
    if (recovered) {
      console.info('[document-memory-bootstrap] Recovered from interrupted cutover state.')
    }
  } catch (recoverErr) {
    console.warn('[document-memory-bootstrap] Interrupted cutover recovery warning:', recoverErr)
  }

  if (!existsSync(dbPath)) {
    return { ready: true, migrated: false }
  }

  try {
    const report = inspectDatabaseVersion(dbPath)
    if (!report.needsMigration) {
      return { ready: true, migrated: false, report }
    }

    // Read active embedding configuration independently before database access (BEH-14)
    const activeConfig = readActiveEmbeddingConfig(dbDir)

    console.info('[document-memory-bootstrap] V2 storage detected. Starting verified V2->V3 migration...', {
      reasons: report.reasons,
      autoVacuum: report.autoVacuum,
      activeSpaceId: activeConfig.activeSpaceId,
    })

    const migrationResult = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: activeConfig.activeSpaceId,
      activeDimensions: activeConfig.activeDimensions,
    })
    console.info('[document-memory-bootstrap] V2->V3 storage migration completed successfully.', {
      documentsCopied: migrationResult.documentsCopied,
      chunksCopied: migrationResult.chunksCopied,
      embeddingsCopied: migrationResult.embeddingsCopied,
      durationMs: migrationResult.durationMs,
    })

    return {
      ready: true,
      migrated: true,
      report,
      migrationResult,
    }
  } catch (err) {
    const errorMsg = (err as Error).message
    console.error('[document-memory-bootstrap] Critical: V2->V3 migration failed!', { error: errorMsg })
    return {
      ready: false,
      migrated: false,
      error: errorMsg,
    }
  }
}
