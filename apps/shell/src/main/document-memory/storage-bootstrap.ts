import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspectDatabaseVersion, type StorageVersionReport } from './storage/schema-inspector'
import { migrateStorageV2ToV3, type StorageMigrationResult } from './storage-migration'
import { DocumentMemoryStore } from './store'
import { migrateCacheRetentionSchema } from './storage/migration/cache-retention'
import { migrateNameSearchProjection } from './storage/migration/name-search-projection'
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
import {
  getEffectiveStorageBudget,
  estimateMigrationGrowthBytes,
  checkMigrationAdmission,
  getValidatedFreeDiskBytesSync,
} from './runtime/backup-write-budget'
import { collectStorageAccounting } from './runtime/storage-accounting'
import {
  cleanupCompactionBackups,
  recoverInterruptedCompaction,
  runOfflineCompaction,
  type OfflineCompactionOptions,
} from './runtime/offline-compaction'
import { readOfflineCompactionSetting } from './storage/offline-compaction-setting'
import { recoverStaleMigrationArtifacts } from './storage/migration/stale-artifacts'
import { appendBootstrapLog } from './bootstrap-log'

export interface BootstrapResult {
  ready: boolean
  migrated: boolean
  report?: StorageVersionReport
  migrationResult?: StorageMigrationResult
  retentionState?: V3RetentionState
  error?: string
}

/** Coarse progress of the start-up step; `percent` is only set while migrating. */
export interface StorageBootstrapProgress {
  phase: 'checking' | 'migrating' | 'finalizing'
  percent: number | null
}

export interface StorageBootstrapOptions {
  settingsDir?: string
  /** Called (not throttled) as the step moves on; a worker host forwards it to the UI. */
  onProgress?: (progress: StorageBootstrapProgress) => void
  /**
   * Run the offline full compaction (opt-in; default: the `document-memory-compaction.json` setting, off). An object
   * also overrides the thresholds of runOfflineCompaction (tests; the defaults skip small / unfragmented databases).
   */
  offlineCompaction?: boolean | Omit<OfflineCompactionOptions, 'enabled'>
  /** Where `document-memory.log` is written (default `<settingsDir ?? dbDir>/logs`). */
  logDir?: string
}

/**
 * Detects any leftover or unexpected temporary files associated with migration or cutover.
 */
export function findUnexpectedTempArtifacts(
  dbDir: string,
  dbBase = 'document-memory.db',
): string[] {
  if (!existsSync(dbDir)) return []
  const found: string[] = []
  const prefix = dbBase.replace(/\.db$/, '')

  try {
    const entries = readdirSync(dbDir)
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      if (name.includes('.tmp') || name.includes('.migrating') || name.includes('.moving')) {
        found.push(join(dbDir, name))
      }
    }
  } catch (err: unknown) {
    console.debug('[storage-bootstrap] readdirSync failed, trying direct candidates:', err)
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
  const retentionState = readV3RetentionState(dbDir)
  const backups = findAllV2Backups(dbDir, dbBase, retentionState).map((b) => b.path)
  const mostRecent = findMostRecentV2Backup(dbDir, dbBase, retentionState)
  if (mostRecent && !backups.includes(mostRecent.path)) {
    backups.push(mostRecent.path)
  }
  if (retentionState?.backupPath && !backups.includes(retentionState.backupPath)) {
    backups.push(retentionState.backupPath)
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
  } catch (err: unknown) {
    console.debug('[storage-bootstrap] backup scan readdir failed:', err)
  }

  return backups
}

/**
 * Ensures that Document Memory SQLite database is fully migrated and verified
 * according to Schema V3 BEFORE any runtime components open it (Invariant INV-01).
 * Fails closed on any recovery error, corruption, or ambiguous temporary artifacts.
 *
 * Must be executed before `new DocumentMemoryManager()` or any worker startup.
 *
 * THREADING MODEL:
 * Both the V2->V3 migration (`migrateStorageV2ToV3`) and the start-up health check of an existing V3 database are
 * synchronous SQLite work that scales with the database (minutes for a multi-gigabyte index). They must therefore
 * never run on the Electron main thread: the main process hosts this function in a worker thread
 * (`runtime/storage-bootstrap-runner.ts`) and opens the window straight away. Running it inline is only the
 * fallback for a worker that cannot be started, and for tests.
 * It still guarantees exclusive single-writer access and complete schema verification before any runtime store,
 * indexer or background worker opens the database: the caller starts those only after this resolves `ready`.
 */
export async function ensureDocumentMemoryStorageReady(
  dbDir: string,
  options: StorageBootstrapOptions = {},
): Promise<BootstrapResult> {
  const logDir = options.logDir ?? join(options.settingsDir ?? dbDir, 'logs')
  try {
    const result = await bootstrapStorage(dbDir, options, logDir)
    if (!result.ready) {
      const why = result.report?.reasons?.length
        ? ` [schema: ${result.report.reasons.join('; ')}]`
        : ''
      appendBootstrapLog(
        logDir,
        'error',
        `Document memory is unavailable (fail-closed): ${result.error ?? 'unknown reason'}${why}`,
      )
    } else if (result.migrated) {
      const m = result.migrationResult
      appendBootstrapLog(
        logDir,
        'info',
        `V2->V3 migration completed: ${m?.documentsCopied ?? 0} documents, ${m?.chunksCopied ?? 0} chunks, ${m?.durationMs ?? 0} ms`,
      )
    }
    return result
  } catch (err) {
    appendBootstrapLog(
      logDir,
      'error',
      `Storage bootstrap threw: ${(err as Error)?.stack ?? String(err)}`,
    )
    throw err
  }
}

/** Share of the migration that is done, from the runner's progress; the copy dominates, so it gets most of the bar. */
export function migrationPercent(
  progress: { phase: string; documentsProcessed: number },
  totalDocuments: number,
): number {
  switch (progress.phase) {
    case 'schema':
      return 1
    case 'documents':
    case 'fts':
      return totalDocuments > 0
        ? Math.min(90, 1 + Math.floor((progress.documentsProcessed / totalDocuments) * 89))
        : 50
    case 'cutover':
      return 95
    case 'verified':
      return 99
    default:
      return 0
  }
}

async function bootstrapStorage(
  dbDir: string,
  options: StorageBootstrapOptions,
  logDir: string,
): Promise<BootstrapResult> {
  const dbPath = join(dbDir, 'document-memory.db')
  const notify = (
    phase: StorageBootstrapProgress['phase'],
    percent: number | null = null,
  ): void => {
    try {
      options.onProgress?.({ phase, percent })
    } catch {
      // a progress listener must never decide whether the index opens
    }
  }
  notify('checking')

  // An offline compaction killed mid-swap is rolled back to the previous verified database (separate manifest from the
  // cutover); expired `.compact-prev` backups are removed. Neither step may fail startup on its own.
  try {
    const compaction = recoverInterruptedCompaction(dbPath)
    if (compaction.recovered)
      console.info(
        `[document-memory-bootstrap] Recovered interrupted compaction (${compaction.action}).`,
      )
    if (compaction.error)
      console.warn('[document-memory-bootstrap] Compaction recovery error:', compaction.error)
    cleanupCompactionBackups(dbPath)
  } catch (compactionErr) {
    console.warn('[document-memory-bootstrap] Compaction recovery failed:', compactionErr)
  }

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

  // A V2->V3 migration that died before its cutover (killed, crashed, power loss) left only scratch files: the V2 source is
  // untouched until the cutover manifest exists. Remove them so the next attempt starts clean instead of staying fail-closed.
  const stale = recoverStaleMigrationArtifacts(dbDir, 'document-memory.db')
  if (stale.removed.length > 0) {
    console.warn(
      '[document-memory-bootstrap] Removed leftovers of an interrupted V2->V3 migration:',
      stale.removed,
    )
    appendBootstrapLog(
      logDir,
      'warn',
      `Removed leftovers of an interrupted V2->V3 migration: ${stale.removed.join(', ')}`,
    )
  }
  if (stale.blockedByPid !== undefined || stale.error) {
    const errorMsg =
      stale.blockedByPid !== undefined
        ? `Another process (pid ${stale.blockedByPid}) is migrating the document index; it will be retried on the next start.`
        : `Interrupted migration cleanup failed: ${stale.error}. It will be retried on the next start.`
    console.error('[document-memory-bootstrap]', errorMsg)
    return { ready: false, migrated: false, error: errorMsg }
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
      const errorMsg =
        'Document-memory database is missing while migration or rollback artifacts still exist.'
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
      const offline = options.offlineCompaction ?? readOfflineCompactionSetting(options.settingsDir)
      if (offline) {
        // Exclusive, before any connection of this process exists; every failure keeps the previous database.
        try {
          const compacted = runOfflineCompaction(dbPath, {
            ...(typeof offline === 'object' ? offline : {}),
            enabled: true,
          })
          if (compacted.status === 'compacted')
            console.info(
              `[document-memory-bootstrap] Offline compaction saved ${compacted.bytesSaved} bytes.`,
            )
          else if (compacted.status === 'failed' || compacted.status === 'rolled-back')
            console.warn(
              '[document-memory-bootstrap] Offline compaction not applied:',
              compacted.error ?? compacted.status,
            )
        } catch (compactErr) {
          console.warn('[document-memory-bootstrap] Offline compaction failed:', compactErr)
        }
      }
      try {
        const store = new DocumentMemoryStore(dbPath, { role: 'search' })
        try {
          const cacheRes = migrateCacheRetentionSchema(store.rawDb)
          if (cacheRes.error) {
            throw new Error(`Cache retention migration failed: ${cacheRes.error}`)
          }
          const projRes = migrateNameSearchProjection(store.rawDb)
          if (projRes.error) {
            throw new Error(`Name search projection migration failed: ${projRes.error}`)
          }
          store.repairInvalidCanonicalEmbeddings()
        } finally {
          store.close()
        }
      } catch (repairErr) {
        const errorMsg = `Existing V3 database schema migration or repair failed: ${(repairErr as Error).message}`
        console.error('[document-memory-bootstrap]', errorMsg)
        return {
          ready: false,
          migrated: false,
          report,
          error: errorMsg,
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

    // 1. Read persisted UI storage budget before migration opens new files (Requirement 1)
    const settingsDir = options.settingsDir ?? dbDir
    const effectiveBudget = getEffectiveStorageBudget(settingsDir)
    if (!effectiveBudget.valid) {
      const errorMsg = `Storage budget configuration invalid or corrupted: ${effectiveBudget.error}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }
    const budgetBytes = effectiveBudget.budgetBytes

    // 2. Probe for concurrent writers before starting migration (fail-closed if active writer detected).
    // Note: BEGIN IMMEDIATE; COMMIT is only an initial probe at bootstrap time.
    // Full exclusive protection during migration is durably maintained by migrateStorageV2ToV3
    // via an atomic operation guard file (.migrating) and a persistent BEGIN IMMEDIATE write fence held across the copy.
    try {
      const lockCheckDb = new DatabaseSync(dbPath)
      try {
        lockCheckDb.exec('PRAGMA busy_timeout = 1000;')
        lockCheckDb.exec('BEGIN IMMEDIATE; COMMIT;')
      } finally {
        lockCheckDb.close()
      }
    } catch (writerErr: any) {
      const errorMsg = `Concurrent writer detected during bootstrap: ${(writerErr as Error).message}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    // 3. Quota preflight: physical DB + WAL + SHM + old ANN + OCR + sidecars (earlier migration backups are not part of the quota)
    const preAccounting = collectStorageAccounting({ dbPath })
    if (preAccounting.isDegraded) {
      const errorMsg =
        'Storage accounting is degraded due to I/O or permission errors before migration'
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    // Read active embedding configuration independently before database access (BEH-14)
    const activeConfig = readActiveEmbeddingConfig(settingsDir)

    // Estimate conservative migration growth of new temp DB & WAL
    let estimatedGrowthBytes = 0
    let totalDocuments = 0
    try {
      const statDb = new DatabaseSync(dbPath)
      try {
        estimatedGrowthBytes = estimateMigrationGrowthBytes(
          statDb,
          activeConfig.activeSpaceId,
          activeConfig.activeDimensions,
        )
        try {
          totalDocuments = Number(
            (
              statDb.prepare('SELECT count(*) AS n FROM documents').get() as
                { n?: number } | undefined
            )?.n ?? 0,
          )
        } catch {
          totalDocuments = 0 // progress is cosmetic: an unreadable count leaves the bar indeterminate
        }
      } finally {
        statDb.close()
      }
    } catch (statErr: any) {
      const errorMsg = `Failed to estimate migration growth: ${(statErr as Error).message}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    const freeDiskBytes = getValidatedFreeDiskBytesSync(dbDir)

    const preAdmission = checkMigrationAdmission({
      sourceDbPath: dbPath,
      currentUsageBytes: preAccounting.totalManagedBytes,
      budgetBytes,
      estimatedGrowthBytes,
      freeDiskBytes,
      accountingDegraded: preAccounting.isDegraded,
    })

    if (!preAdmission.admitted) {
      const errorMsg = `Storage budget admission blocked: ${preAdmission.error || preAdmission.reason}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    console.info(
      '[document-memory-bootstrap] V2 storage detected. Starting verified V2->V3 migration...',
      {
        reasons: report.reasons,
        autoVacuum: report.autoVacuum,
        activeSpaceId: activeConfig.activeSpaceId,
        budgetBytes,
        currentUsageBytes: preAccounting.totalManagedBytes,
        estimatedGrowthBytes,
      },
    )

    notify('migrating', 0)
    const migrationResult = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: activeConfig.activeSpaceId,
      activeDimensions: activeConfig.activeDimensions,
      budgetBytes,
      settingsDir,
      freeDiskBytes,
      onProgress: (progress) =>
        notify(
          'migrating',
          totalDocuments > 0 || progress.phase !== 'documents'
            ? migrationPercent(progress, totalDocuments)
            : null,
        ),
    })
    notify('finalizing')
    console.info('[document-memory-bootstrap] V2->V3 storage migration completed successfully.', {
      documentsCopied: migrationResult.documentsCopied,
      chunksCopied: migrationResult.chunksCopied,
      embeddingsCopied: migrationResult.embeddingsCopied,
      durationMs: migrationResult.durationMs,
    })

    try {
      const store = new DocumentMemoryStore(dbPath, { role: 'search' })
      try {
        const cacheRes = migrateCacheRetentionSchema(store.rawDb)
        if (cacheRes.error) {
          throw new Error(`Cache retention migration failed: ${cacheRes.error}`)
        }
        const projRes = migrateNameSearchProjection(store.rawDb)
        if (projRes.error) {
          throw new Error(`Name search projection migration failed: ${projRes.error}`)
        }
        store.repairInvalidCanonicalEmbeddings()
      } finally {
        store.close()
      }
    } catch (repairErr) {
      const errorMsg = `Post-migration schema repair failed: ${(repairErr as Error).message}`
      console.error('[document-memory-bootstrap]', errorMsg)
      return {
        ready: false,
        migrated: false,
        report,
        error: errorMsg,
      }
    }

    // Sau migration: verifiedLaunches = 0
    let retentionState: V3RetentionState | undefined
    if (migrationResult.backupDbPath) {
      retentionState =
        readV3RetentionState(dbDir) ?? initV3RetentionState(dbDir, migrationResult.backupDbPath)
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
    console.error(
      '[document-memory-bootstrap] Critical: V2->V3 migration or verification failed!',
      { error: errorMsg },
    )
    return {
      ready: false,
      migrated: false,
      error: errorMsg,
    }
  }
}
