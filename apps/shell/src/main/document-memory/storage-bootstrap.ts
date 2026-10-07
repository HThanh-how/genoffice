import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inspectDatabaseVersion, type StorageVersionReport } from './storage/schema-inspector'
import { migrateStorageV2ToV3, type StorageMigrationResult } from './storage-migration'
import { recoverInterruptedCutover, getManifestPath } from './storage/migration/cutover'
import { readActiveEmbeddingConfig } from './storage/embedding-settings'
import { verifyDatabaseIntegrity } from './storage/migration/logical-verifier'
import {
  initV3RetentionState,
  recordV3VerifiedLaunch,
  type V3RetentionState,
} from './storage/migration/v3-retention-state'
import { enforceBackupRetentionPolicy } from './storage/migration/backup-retention'

export interface BootstrapResult {
  ready: boolean
  migrated: boolean
  report?: StorageVersionReport
  migrationResult?: StorageMigrationResult
  retentionState?: V3RetentionState
  error?: string
}

export interface StorageBootstrapOptions {
  settingsDir?: string
}

/**
 * Ensures that Document Memory SQLite database is fully migrated and verified
 * according to Schema V3 BEFORE any runtime components open it (Invariant INV-01).
 * 
 * Must be executed before `new DocumentMemoryManager()` or any worker startup.
 */
export async function ensureDocumentMemoryStorageReady(
  dbDir: string,
  options: StorageBootstrapOptions = {},
): Promise<BootstrapResult> {
  const dbPath = join(dbDir, 'document-memory.db')

  // Check and recover from any interrupted cutover state first (BEH-16 / INV-01 fail-closed)
  try {
    const recovered = recoverInterruptedCutover(dbDir)
    if (recovered) {
      console.info('[document-memory-bootstrap] Recovered from interrupted cutover state.')
    }
  } catch (recoverErr) {
    const errorMsg = `Interrupted cutover recovery failed: ${(recoverErr as Error).message}`
    console.error('[document-memory-bootstrap] Critical:', errorMsg)
    return {
      ready: false,
      migrated: false,
      error: errorMsg,
    }
  }

  const manifestPath = getManifestPath(dbDir)
  const tempManifestPath = `${manifestPath}.tmp`
  if (existsSync(manifestPath) || existsSync(tempManifestPath)) {
    const errorMsg = 'Critical: migration manifest still present after cutover recovery'
    console.error('[document-memory-bootstrap]', errorMsg)
    return {
      ready: false,
      migrated: false,
      error: errorMsg,
    }
  }

  if (!existsSync(dbPath)) {
    return { ready: true, migrated: false }
  }

  try {
    const report = inspectDatabaseVersion(dbPath)
    if (!report.needsMigration) {
      // V3 database already exists. Verify physical & FK integrity.
      let retentionState: V3RetentionState | undefined
      const integrity = verifyDatabaseIntegrity(dbPath)
      if (report.isV3 && integrity.ok) {
        // Bootstrap V3 physical/integrity PASS -> verifiedLaunches += 1
        const recorded = recordV3VerifiedLaunch(dbDir)
        if (recorded) {
          retentionState = recorded
        }
        // Enforce backup retention policy
        try {
          enforceBackupRetentionPolicy(dbPath)
        } catch {
          // Retention purge failure should not block bootstrap readiness
        }
      }

      return { ready: true, migrated: false, report, retentionState }
    }

    // Read active embedding configuration independently before database access (BEH-14)
    const settingsDir = options.settingsDir ?? dbDir
    const activeConfig = readActiveEmbeddingConfig(settingsDir)

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

    // Sau migration: verifiedLaunches = 0
    let retentionState: V3RetentionState | undefined
    if (migrationResult.backupDbPath) {
      retentionState = initV3RetentionState(dbDir, migrationResult.backupDbPath)
    }

    return {
      ready: true,
      migrated: true,
      report,
      migrationResult,
      retentionState,
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
