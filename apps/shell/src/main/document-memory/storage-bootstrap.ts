import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { inspectDatabaseVersion, type StorageVersionReport } from './storage/schema-inspector'
import { migrateStorageV2ToV3, type StorageMigrationResult } from './storage-migration'
import { recoverInterruptedCutover, getManifestPath } from './storage/migration/cutover'
import { readActiveEmbeddingConfig } from './storage/embedding-settings'
import { verifyDatabaseStartupHealth } from './storage/migration/logical-verifier'
import {
  findAllV2Backups,
  findMostRecentV2Backup,
  initV3RetentionState,
  readV3RetentionState,
  recordV3VerifiedLaunch,
  type V3RetentionState,
} from './storage/migration/v3-retention-state'

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
 * Detects any leftover or unexpected temporary files associated with migration or cutover.
 */
export function findUnexpectedTempArtifacts(dbDir: string, dbBase = 'document-memory.db'): string[] {
  if (!existsSync(dbDir)) return []
  const found: string[] = []
  const prefix = dbBase.replace(/\.db$/, '')

  try {
    const entries = readdirSync(dbDir)
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      if (
        name.includes('.tmp') ||
        name.includes('.migrating') ||
        name.includes('.moving')
      ) {
        found.push(join(dbDir, name))
      }
    }
  } catch {
    const directCandidates = [
      join(dbDir, `${dbBase}.v3.tmp`),
      join(dbDir, `${dbBase}.v3.tmp.db`),
      join(dbDir, `${dbBase}.tmp`),
      join(dbDir, `${dbBase}.migrating`),
    ]
    for (const candidate of directCandidates) {
      if (existsSync(candidate)) found.push(candidate)
    }
  }

  return found
}

/**
 * Detects any candidate V2 rollback backup files present in the database directory.
 */
export function findAnyBackupArtifacts(dbDir: string, dbBase = 'document-memory.db'): string[] {
  if (!existsSync(dbDir)) return []
  const backups = findAllV2Backups(dbDir, dbBase).map((b) => b.path)
  const mostRecent = findMostRecentV2Backup(dbDir, dbBase)
  if (mostRecent && !backups.includes(mostRecent.path)) {
    backups.push(mostRecent.path)
  }

  const prefix = dbBase.replace(/\.db$/, '')
  try {
    const entries = readdirSync(dbDir)
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      if (
        (name.includes('.backup') || name.includes('.v2.') || name.endsWith('.bak')) &&
        !name.includes('.tmp')
      ) {
        const full = join(dbDir, name)
        if (!backups.includes(full)) {
          backups.push(full)
        }
      }
    }
  } catch {
    // ignore
  }

  return backups
}

/**
 * Ensures that Document Memory SQLite database is fully migrated and verified
 * according to Schema V3 BEFORE any runtime components open it (Invariant INV-01).
 * Fails closed on any recovery error, corruption, or ambiguous temporary artifacts.
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

  // Any unexpected temporary migration artifacts on disk indicate an interrupted/ambiguous state
  const unexpectedTemps = findUnexpectedTempArtifacts(dbDir, 'document-memory.db')
  if (unexpectedTemps.length > 0) {
    const errorMsg = `Critical: unexpected temporary migration artifacts found on disk: ${unexpectedTemps.join(', ')}`
    console.error('[document-memory-bootstrap]', errorMsg)
    return {
      ready: false,
      migrated: false,
      error: errorMsg,
    }
  }

  const backupArtifacts = findAnyBackupArtifacts(dbDir, 'document-memory.db')
  const retentionState = readV3RetentionState(dbDir)
  if (!existsSync(dbPath)) {
    if (backupArtifacts.length > 0 || retentionState) {
      const errorMsg = 'Document-memory database is missing while migration or rollback artifacts still exist.'
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        error: errorMsg,
      }
    }
    return {
      ready: true,
      migrated: false,
    }
  }

  try {
    const report = inspectDatabaseVersion(dbPath)

    if (report.state === 'corrupt') {
      const errorMsg = `Existing document-memory database is corrupted: ${report.reasons.join('; ')}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    if (report.state === 'migration-in-progress') {
      const errorMsg = `Existing document-memory database has an unresolved migration in progress: ${report.reasons.join('; ')}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    if (report.state === 'unknown') {
      const errorMsg = `Existing document-memory database has unknown schema: ${report.state}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    if (!report.needsMigration) {
      if (!report.isV3) {
        return {
          ready: false,
          migrated: false,
          report,
          error: `Existing document-memory database is not a verified V3 database: ${report.state}`,
        }
      }
      const integrity = verifyDatabaseStartupHealth(dbPath)
      if (!integrity.ok) {
        return {
          ready: false,
          migrated: false,
          report,
          error:
            `Existing V3 database failed startup health verification: ` +
            `quickCheck=${integrity.quickCheck}, ` +
            `fkErrors=${integrity.foreignKeyErrors.length}`,
        }
      }
      let retentionState: V3RetentionState | undefined
      const recorded = recordV3VerifiedLaunch(dbDir)
      if (recorded) {
        retentionState = recorded
      }
      return {
        ready: true,
        migrated: false,
        report,
        retentionState,
      }
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
    console.error('[document-memory-bootstrap] Critical: V2->V3 migration or verification failed!', { error: errorMsg })
    return {
      ready: false,
      migrated: false,
      error: errorMsg,
    }
  }
}
