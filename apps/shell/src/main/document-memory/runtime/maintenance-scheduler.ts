import type { DocumentMemoryStore, FolderChunkProgress } from '../store'
import type { DocumentIndexProgress } from '@genoffice/agent-core'
import { foldFolderProgress, type FolderIndexProgress } from '../folder-progress'
import { isIndexingPaused } from '../../fork/indexing-policy-bus'
import type { BackgroundWorkGate } from '../background-work-gate'
import type { WorkerRequest, WorkerReply } from '../worker-types'
import {
  type DocumentIndexStorageBudget,
  type StorageBudgetSnapshot,
  type StorageLimitState,
  DEFAULT_STORAGE_BUDGET,
  CACHE_RETENTION_HIGH_WATERMARK,
  createStorageBudgetSnapshot,
  safeGetFileSize,
} from '../storage-budget'
import { BackupRetentionRunner } from './backup-retention-runner'
import { StorageAccountingRunner } from './storage-accounting-runner'
import { type StorageAccountingReport } from './storage-accounting'
import { safeError } from '../issues'
import type { StorageAdmissionController } from './storage-admission'
import {
  BASE_PROJECTION_METADATA_BYTES,
  MAX_PROJECTION_BATCH_BYTES,
  type NameProjectionBackfillResult,
} from '../name-search-projection'
import { executePostWriteAccounting } from './post-write-accounting'
import {
  CompactionDriver,
  type CompactionCycleOutcome,
  type MakeRoomOutcome,
  type MakeRoomRequest,
} from './compaction-driver'
import type { AnnRebuildRequest } from './ann-rebuild-after-compaction'
import { resolveAgePolicy } from './value-density'

export const FTS_MERGE_PAGES = 8
export const VACUUM_STEP_MAX_PAGES = 256
export const INITIAL_MAINTENANCE_DELAY_MS = 5_000
export const PERIODIC_MAINTENANCE_INTERVAL_MS = 60_000

export interface MaintenanceSchedulerOptions {
  store: DocumentMemoryStore
  budget?: DocumentIndexStorageBudget
  onBudgetStateChange?: (state: StorageLimitState, snapshot: StorageBudgetSnapshot) => void
  onFtsStep?: (pages: number) => boolean
  /** `timeoutMs` is set by the long-running compaction lane (retention can take minutes); default is the caller's. */
  askWorker?: (request: WorkerRequest, timeoutMs?: number) => Promise<WorkerReply | null>
  backgroundGate?: BackgroundWorkGate
  isPaused?: () => boolean
  isStopped?: () => boolean
  isQueued?: (path: string) => boolean
  isExtracting?: (path: string) => boolean
  backupRetentionRunner?: BackupRetentionRunner
  storageAccountingRunner?: StorageAccountingRunner
  isWriteReady?: () => boolean
  admission?: StorageAdmissionController
  getFreeDiskBytes?: () => Promise<number | null>
  headroomBytes?: number
  /** Worker-run compaction finished (report incl. redundancy / age buckets) - diagnostics / status. */
  onCompactionOutcome?: (outcome: CompactionCycleOutcome) => void
  /** Vectors / skeletons were released for re-hydration; the owner re-queues them (poll). */
  onCompactionReleased?: () => void
  /** ANN rebuilds the worker scheduled after compaction; dispatched through the admission-guarded host path. */
  onAnnRebuildRequests?: (requests: AnnRebuildRequest[]) => void | Promise<void>
}

export class MaintenanceScheduler {
  private readonly backupRetentionRunner: BackupRetentionRunner
  private readonly storageAccountingRunner: StorageAccountingRunner
  private ftsTimer: NodeJS.Timeout | null = null
  private gcTimer: NodeJS.Timeout | null = null
  private vacuumTimer: NodeJS.Timeout | null = null
  private periodicTimer: NodeJS.Timeout | null = null

  private ftsRunning = false
  private gcRunning = false
  private vacuumRunning = false
  private periodicRunning = false
  private backfillRunning = false
  private disposed = false
  private epoch = 0

  private lastBudgetState: StorageLimitState | null = null
  private lastBudgetSnapshot: StorageBudgetSnapshot | null = null
  private lastAccountingReport: StorageAccountingReport | null = null

  private currentBudget: DocumentIndexStorageBudget
  /** Decides WHEN the indexing worker compacts; the main thread never runs retention itself. */
  private readonly compaction: CompactionDriver

  constructor(private readonly options: MaintenanceSchedulerOptions) {
    this.backupRetentionRunner = options.backupRetentionRunner ?? new BackupRetentionRunner()
    this.storageAccountingRunner = options.storageAccountingRunner ?? new StorageAccountingRunner()
    this.currentBudget = options.budget ?? DEFAULT_STORAGE_BUDGET
    this.compaction = new CompactionDriver({
      askWorker: options.askWorker,
      getBudget: () => this.budget,
      getSnapshot: () => this.getStorageBudgetSnapshot(),
      refreshAccounting: () => this.refreshAccountingAsync(),
      isStopped: () => this.isStopped(),
      isPaused: () => this.isPaused(),
      isWriteReady: options.isWriteReady,
      getEpoch: () => this.epoch,
      invalidateMainAnn: (spaceId) => {
        try {
          this.store.invalidateAnnInMemory(spaceId)
        } catch {
          // the store may already be closed
        }
      },
      onOutcome: options.onCompactionOutcome,
      onReleased: () => options.onCompactionReleased?.(),
      onAnnRebuildRequests: options.onAnnRebuildRequests,
    })
    // Initial startup async measurement refresh to prevent deadlocking admission
    setImmediate(() => {
      if (!this.isStopped()) {
        void this.refreshAccountingAsync().catch(() => {})
      }
    })
  }

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  get budget(): DocumentIndexStorageBudget {
    return this.currentBudget
  }

  getLastBudgetSnapshot(): StorageBudgetSnapshot | null {
    return this.lastBudgetSnapshot
  }

  getStorageBudgetSnapshot(): StorageBudgetSnapshot {
    if (this.lastBudgetSnapshot) {
      return this.lastBudgetSnapshot
    }
    return this.checkStorageBudget()
  }

  getLastAccountingReport(): StorageAccountingReport | null {
    return this.lastAccountingReport
  }

  setBudget(budget: DocumentIndexStorageBudget): StorageBudgetSnapshot {
    this.currentBudget = budget
    return this.checkStorageBudget()
  }

  /**
   * Invalidates accounting report and budget snapshot on measurement failures or degradation.
   * Truthfully measures physical disk bytes instead of faking 0, marks degraded, and closes gates.
   */
  invalidateAccounting(errorReason?: string): StorageBudgetSnapshot {
    const lastReport = this.lastAccountingReport
    const dbPath = this.store.dbPath
    const activeDbSizeBytes = safeGetFileSize(dbPath)
    const walSizeBytes = safeGetFileSize(`${dbPath}-wal`)
    const shmSizeBytes = safeGetFileSize(`${dbPath}-shm`)
    const physicalDbBytes = activeDbSizeBytes + walSizeBytes + shmSizeBytes

    const degradedReport: StorageAccountingReport = {
      databaseBytes: Math.max(lastReport?.databaseBytes ?? 0, physicalDbBytes),
      dbSizeBytes: lastReport?.dbSizeBytes ?? activeDbSizeBytes,
      walSizeBytes: lastReport?.walSizeBytes ?? walSizeBytes,
      shmSizeBytes: lastReport?.shmSizeBytes ?? shmSizeBytes,
      sidecarSizeBytes: lastReport?.sidecarSizeBytes ?? 0,
      annSizeBytes: lastReport?.annSizeBytes ?? 0,
      ocrSizeBytes: lastReport?.ocrSizeBytes ?? 0,
      tempSizeBytes: lastReport?.tempSizeBytes ?? 0,
      backupSizeBytes: lastReport?.backupSizeBytes ?? 0,
      protectedBytes: lastReport?.protectedBytes ?? 0,
      totalManagedBytes: Math.max(lastReport?.totalManagedBytes ?? 0, physicalDbBytes),
      totalTrackedBytes: Math.max(lastReport?.totalTrackedBytes ?? 0, physicalDbBytes),
      reclaimableBytes: lastReport?.reclaimableBytes ?? 0,
      reusableFreelistBytes: lastReport?.reusableFreelistBytes ?? 0,
      modelWeightsBytes: lastReport?.modelWeightsBytes ?? 0,
      breakdown: lastReport?.breakdown ?? {
        activeDbBytes: activeDbSizeBytes,
        walBytes: walSizeBytes,
        shmBytes: shmSizeBytes,
        annBytes: 0,
        ocrExternalBytes: 0,
        tempBytes: 0,
        backupBytes: 0,
        protectedBackupBytes: 0,
        reusableFreelistBytes: 0,
        modelWeightsBytes: 0,
      },
      annFiles: lastReport?.annFiles ?? [],
      backupFiles: lastReport?.backupFiles ?? [],
      tempFiles: lastReport?.tempFiles ?? [],
      ocrFiles: lastReport?.ocrFiles ?? [],
      isDegraded: true,
      timestamp: Date.now(),
      lastAttemptTimestamp: Date.now(),
      measurementErrors: [
        ...(lastReport?.measurementErrors ?? []),
        { path: dbPath, error: errorReason ?? 'Accounting invalidated' },
      ],
    }

    this.lastAccountingReport = degradedReport
    return this.checkStorageBudget(degradedReport)
  }

  checkStorageBudget(accountingReport?: StorageAccountingReport): StorageBudgetSnapshot {
    if (accountingReport) {
      this.lastAccountingReport = accountingReport
    }
    if (this.isStopped()) {
      return (
        this.lastBudgetSnapshot ??
        createStorageBudgetSnapshot({
          activeDbSizeBytes: 0,
          budgetBytes: this.budget.maxDatabaseBytes,
          overshootRatio: this.budget.overshootRatio,
          configVersion: this.budget.version,
          measurementStatus: 'unknown',
          isDegraded: true,
        })
      )
    }
    const dbPath = this.store.dbPath
    const activeDbSizeBytes = safeGetFileSize(dbPath)
    const walSizeBytes = safeGetFileSize(`${dbPath}-wal`)
    const report = this.lastAccountingReport
    let freelistBytes = report?.reusableFreelistBytes
    if (freelistBytes === undefined && !this.isStopped()) {
      try {
        if (typeof this.store.getStorageFreelistStats === 'function') {
          freelistBytes = this.store.getStorageFreelistStats().reclaimableBytes
        }
      } catch {
        freelistBytes = 0
      }
    }

    const isDegraded = report ? report.isDegraded : true
    const measurementStatus = report
      ? report.isDegraded
        ? 'degraded'
        : Date.now() - report.timestamp > 5 * 60_000
          ? 'stale'
          : 'fresh'
      : 'unknown'

    const snapshot = createStorageBudgetSnapshot({
      activeDbSizeBytes,
      walSizeBytes,
      budgetBytes: this.budget.maxDatabaseBytes,
      overshootRatio: this.budget.overshootRatio,
      backupBytes: report?.breakdown.backupBytes ?? safeGetFileSize(`${dbPath}.v2.backup.db`),
      reclaimableBytes: report?.reusableFreelistBytes ?? freelistBytes ?? 0,
      totalManagedBytes: report?.totalManagedBytes,
      protectedBytes: report?.protectedBytes,
      reusableFreelistBytes: report?.reusableFreelistBytes ?? freelistBytes,
      breakdown: report?.breakdown,
      modelBytes: report?.modelWeightsBytes,
      nameMetadataBytes: report?.nameMetadataBytes,
      configVersion: this.budget.version,
      measurementStatus,
      isDegraded,
      measuredAt: report?.timestamp,
      lastAttemptAt: report?.lastAttemptTimestamp ?? report?.timestamp,
      measurementError: report?.measurementErrors?.[0]?.error,
    })

    const prevState = this.lastBudgetState
    this.lastBudgetState = snapshot.limitState
    this.lastBudgetSnapshot = snapshot

    if (snapshot.limitState === 'warning') {
      this.scheduleGcStep(100)
      this.scheduleVacuumStep(500)
      this.scheduleFtsMaintenance(250)
    } else if (snapshot.limitState === 'full') {
      this.scheduleGcStep(50)
      this.scheduleVacuumStep(100)
    }

    if (
      (prevState === null || prevState !== snapshot.limitState) &&
      this.options.onBudgetStateChange &&
      !this.isStopped()
    ) {
      this.options.onBudgetStateChange(snapshot.limitState, snapshot)
    }
    // >= 90%: ask the worker to compact (urgent in the grace zone); a no-op below that or without a worker
    this.compaction.onSnapshot(snapshot)

    return snapshot
  }

  canAcceptExpensiveWork(): boolean {
    const snap = this.lastBudgetSnapshot ?? this.checkStorageBudget()
    const writeReady = this.options.isWriteReady ? this.options.isWriteReady() : true
    const isFresh =
      this.lastAccountingReport !== null &&
      this.lastAccountingReport.isDegraded === false &&
      Date.now() - this.lastAccountingReport.timestamp <= 5 * 60_000
    return !this.isStopped() && writeReady && isFresh && snap.limitState !== 'full'
  }

  async refreshAccountingAsync(): Promise<StorageBudgetSnapshot> {
    if (this.isStopped()) return this.getStorageBudgetSnapshot()
    const opEpoch = this.epoch
    const report = await this.collectAccountingSafe(opEpoch)
    if (this.isValid(opEpoch)) {
      return this.checkStorageBudget(report)
    }
    return this.getStorageBudgetSnapshot()
  }

  refreshCanAcceptExpensiveWork(): boolean {
    this.checkStorageBudget()
    if (this.lastAccountingReport === null && !this.isStopped()) {
      void this.refreshAccountingAsync().catch(() => {})
    }
    return this.canAcceptExpensiveWork()
  }

  async runBackupRetentionMaintenance(): Promise<{ purgedCount: number }> {
    if (this.isStopped()) return { purgedCount: 0 }
    const opEpoch = this.epoch
    try {
      const result = await this.backupRetentionRunner.run(this.store.dbPath)
      if (!this.isValid(opEpoch)) return { purgedCount: 0 }
      return result
    } catch (error) {
      if (!this.isStopped()) {
        console.warn('[MaintenanceScheduler] Backup retention maintenance error:', safeError(error))
      }
      return { purgedCount: 0 }
    }
  }

  private isStopped(): boolean {
    return this.disposed || (this.options.isStopped ? this.options.isStopped() : false)
  }

  private isValid(opEpoch: number): boolean {
    return !this.isStopped() && opEpoch === this.epoch
  }

  private isPaused(): boolean {
    if (this.options.isPaused) return this.options.isPaused()
    return isIndexingPaused()
  }

  scheduleFtsMaintenance(delayMs = 250): void {
    if (this.isStopped() || this.ftsTimer) return
    this.ftsTimer = setTimeout(() => {
      this.ftsTimer = null
      void this.runFtsMaintenance()
    }, delayMs)
    this.ftsTimer.unref?.()
  }

  async runFtsMaintenance(): Promise<void> {
    if (this.isStopped() || this.ftsRunning) return
    if (this.isPaused()) return
    if (
      this.options.backgroundGate &&
      !this.options.backgroundGate.canRun('fts-maintenance-step')
    ) {
      return
    }

    this.ftsRunning = true
    const opEpoch = this.epoch
    try {
      if (this.options.backgroundGate) {
        await this.options.backgroundGate.enqueue('fts-maintenance-step', async (signal) => {
          if (signal.aborted || !this.isValid(opEpoch)) return
          await this.executeFtsStep(opEpoch)
        })
      } else {
        await this.executeFtsStep(opEpoch)
      }
    } catch (err) {
      if (!this.isStopped()) {
        console.warn('[MaintenanceScheduler] FTS step failed:', safeError(err))
      }
    } finally {
      this.ftsRunning = false
    }
  }

  private async executeFtsStep(opEpoch: number): Promise<void> {
    if (!this.isValid(opEpoch)) return
    if (this.options.askWorker) {
      const reply = await this.options.askWorker({ type: 'fts-maintenance-step' })
      if (!this.isValid(opEpoch)) return
      if (
        reply &&
        'result' in reply &&
        reply.result &&
        typeof reply.result === 'object' &&
        'more' in reply.result
      ) {
        const { more } = reply.result as { more: boolean; durationMs?: number }
        if (more && this.isValid(opEpoch) && !this.isPaused()) {
          this.scheduleFtsMaintenance(250)
        }
      }
    }
  }

  scheduleGcStep(delayMs = 1000): void {
    if (this.isStopped() || this.gcTimer) return
    this.gcTimer = setTimeout(() => {
      this.gcTimer = null
      void this.runGcStep()
    }, delayMs)
    this.gcTimer.unref?.()
  }

  async runGcStep(): Promise<void> {
    if (this.isStopped() || this.gcRunning || this.compaction.isRunning()) return
    if (this.isPaused()) return
    if (this.options.backgroundGate && !this.options.backgroundGate.canRun('gc-step')) {
      return
    }

    this.gcRunning = true
    const opEpoch = this.epoch
    try {
      if (this.options.backgroundGate) {
        await this.options.backgroundGate.enqueue('gc-step', async (signal) => {
          if (signal.aborted || !this.isValid(opEpoch)) return
          await this.executeGcStep(opEpoch)
        })
      } else {
        await this.executeGcStep(opEpoch)
      }
    } catch (err) {
      if (!this.isStopped()) {
        console.warn('[MaintenanceScheduler] GC step failed:', safeError(err))
      }
    } finally {
      this.gcRunning = false
    }
  }

  private async executeGcStep(opEpoch: number): Promise<void> {
    if (!this.isValid(opEpoch) || !this.options.askWorker) return
    await this.options.askWorker({ type: 'gc-step' })
  }

  scheduleVacuumStep(delayMs = 1000): void {
    if (this.isStopped() || this.vacuumTimer) return
    this.vacuumTimer = setTimeout(() => {
      this.vacuumTimer = null
      void this.runVacuumStep()
    }, delayMs)
    this.vacuumTimer.unref?.()
  }

  async runVacuumStep(): Promise<void> {
    if (this.isStopped() || this.vacuumRunning || this.compaction.isRunning()) return
    if (this.isPaused()) return
    if (this.options.backgroundGate && !this.options.backgroundGate.canRun('vacuum-step')) {
      return
    }

    this.vacuumRunning = true
    const opEpoch = this.epoch
    try {
      if (this.options.backgroundGate) {
        await this.options.backgroundGate.enqueue('vacuum-step', async (signal) => {
          if (signal.aborted || !this.isValid(opEpoch)) return
          await this.executeVacuumStep(opEpoch)
        })
      } else {
        await this.executeVacuumStep(opEpoch)
      }
    } catch (err) {
      if (!this.isStopped()) {
        console.warn('[MaintenanceScheduler] Vacuum step failed:', safeError(err))
      }
    } finally {
      this.vacuumRunning = false
    }
  }

  private async executeVacuumStep(opEpoch: number): Promise<void> {
    if (!this.isValid(opEpoch) || !this.options.askWorker) return
    await this.options.askWorker({ type: 'vacuum-step' })
  }

  async runNameProjectionBackfill(batchSize = 100, maxBatchesPerRun = 5): Promise<void> {
    if (this.isStopped() || this.isPaused() || this.backfillRunning) return
    if (typeof this.store.backfillNameProjectionBatch !== 'function') return
    if (!this.canAcceptExpensiveWork()) return

    // Missing callback failclosed, không unlimited default
    if (!this.options.admission || !this.options.getFreeDiskBytes) {
      return
    }

    this.backfillRunning = true
    const opEpoch = this.epoch
    const admission = this.options.admission
    const getFreeDisk = this.options.getFreeDiskBytes
    const headroomBytes = this.options.headroomBytes ?? 10 * 1024 * 1024

    try {
      let batchesRun = 0
      while (
        batchesRun < maxBatchesPerRun &&
        this.isValid(opEpoch) &&
        !this.isPaused() &&
        this.canAcceptExpensiveWork()
      ) {
        // 1. Fresh physical measurement before each batch transaction
        let freshSnap: StorageBudgetSnapshot
        try {
          freshSnap = await this.refreshAccountingAsync()
        } catch (err) {
          this.invalidateAccounting(`name-projection-backfill-pre: ${safeError(err)}`)
          break
        }

        if (freshSnap.measurementStatus !== 'fresh' || freshSnap.isDegraded) {
          break
        }

        // 2. Fresh disk check before each transaction
        let freeDiskBytes: number | null = null
        try {
          freeDiskBytes = await getFreeDisk()
        } catch {
          freeDiskBytes = null
        }

        if (
          freeDiskBytes === null ||
          !Number.isFinite(freeDiskBytes) ||
          !Number.isSafeInteger(freeDiskBytes) ||
          freeDiskBytes < 0
        ) {
          break
        }

        // 3. Live budget and headroom validation
        const liveBudget = this.budget.maxDatabaseBytes
        const currentUsage = freshSnap.totalManagedBytes ?? freshSnap.databaseBytes

        if (currentUsage + headroomBytes >= liveBudget || freeDiskBytes < headroomBytes) {
          break
        }

        const availableQuota = liveBudget - (currentUsage + headroomBytes)
        const availableDisk = freeDiskBytes - headroomBytes
        if (
          availableQuota < BASE_PROJECTION_METADATA_BYTES ||
          availableDisk < BASE_PROJECTION_METADATA_BYTES
        ) {
          // Min metadata can't fit: honest paused, cursor/completedversion does not advance
          break
        }

        const maxBatchBytes = Math.min(MAX_PROJECTION_BATCH_BYTES, availableQuota, availableDisk)

        // 4. Reserve growth with central admission controller
        const token = `name-proj:${Date.now()}:${Math.random().toString(36).slice(2)}`
        const reservationId = `name-projection-backfill:${token}`
        const dec = admission.reserve(
          reservationId,
          'lexical',
          maxBatchBytes,
          currentUsage,
          liveBudget,
          30_000,
          {
            ownerId: token,
            headroomBytes,
            freeDiskBytes,
            isAlive: () => !this.isStopped() && !this.isPaused(),
          },
        )

        if (!dec.admitted) {
          // Denied: honest pause, cursor does not advance
          break
        }

        // 5. Execute synchronous batch with typed preauthorized bounds (NO async inside SQL)
        let backfillResult: NameProjectionBackfillResult | null = null
        let backfillError: unknown = null
        try {
          backfillResult = this.store.backfillNameProjectionBatch(batchSize, {
            maxBatchBytes,
            maxBatchRows: batchSize,
            preauthorizedBytes: maxBatchBytes,
          })
        } catch (err) {
          backfillError = err
        }

        // 6. Postcommit refresh / reconcile & exact lease owner release
        await executePostWriteAccounting({
          maintScheduler: this,
          admission,
          reservationId,
          ownerToken: token,
          context: 'name-projection-backfill',
          writeSuccess: backfillResult !== null && backfillError === null,
          isStopped: () => this.isStopped(),
        })

        if (backfillError) {
          throw backfillError
        }

        batchesRun++
        if (
          !backfillResult ||
          backfillResult.done ||
          backfillResult.remaining === 0 ||
          backfillResult.processed === 0
        ) {
          break
        }

        await new Promise<void>((r) => setImmediate(r))
        if (!this.isValid(opEpoch) || this.isPaused() || !this.canAcceptExpensiveWork()) {
          break
        }
      }
    } catch (err) {
      if (!this.isStopped()) {
        console.warn('[MaintenanceScheduler] Name projection backfill failed:', safeError(err))
      }
    } finally {
      this.backfillRunning = false
    }
  }

  schedulePeriodicMaintenance(delayMs = PERIODIC_MAINTENANCE_INTERVAL_MS): void {
    if (this.isStopped() || this.periodicTimer) return
    this.periodicTimer = setTimeout(() => {
      this.periodicTimer = null
      void this.runPeriodicMaintenance()
    }, delayMs)
    this.periodicTimer.unref?.()
  }

  isPeriodicMaintenanceArmed(): boolean {
    return this.periodicTimer !== null
  }

  isPeriodicMaintenanceRunning(): boolean {
    return this.periodicRunning
  }

  private async collectAccountingSafe(opEpoch: number): Promise<StorageAccountingReport> {
    if (!this.isValid(opEpoch)) {
      return this.lastAccountingReport ?? this.createSafeEmptyReport()
    }

    let annIndexesMeta: Array<{ space_id: string; file_path: string | null }> | undefined
    let reusableFreelistBytes: number | undefined
    try {
      if (!this.isStopped() && this.store.rawDb) {
        annIndexesMeta = this.store.rawDb
          .prepare('SELECT space_id, file_path FROM ann_indexes')
          .all() as Array<{ space_id: string; file_path: string | null }>
      }
    } catch {
      // non-blocking
    }
    try {
      if (!this.isStopped() && this.store.rawDb) {
        reusableFreelistBytes = this.store.getStorageFreelistStats().reclaimableBytes
      }
    } catch {
      // non-blocking
    }

    try {
      const report = await this.storageAccountingRunner.run(
        {
          dbPath: this.store.dbPath,
          annIndexesMeta,
          reusableFreelistBytes,
        },
        this.lastAccountingReport,
      )
      if (!this.isValid(opEpoch)) {
        return this.lastAccountingReport ?? report
      }
      this.lastAccountingReport = report
      return report
    } catch (err) {
      if (!this.isValid(opEpoch)) {
        return this.lastAccountingReport ?? this.createSafeEmptyReport()
      }
      if (this.lastAccountingReport) {
        const degradedReport: StorageAccountingReport = {
          ...this.lastAccountingReport,
          isDegraded: true,
          timestamp: this.lastAccountingReport.timestamp,
          lastAttemptTimestamp: Date.now(),
          measurementErrors: [
            ...this.lastAccountingReport.measurementErrors,
            { path: this.store.dbPath, error: safeError(err) },
          ],
        }
        this.lastAccountingReport = degradedReport
        return degradedReport
      }
      return this.createDegradedReport(safeError(err))
    }
  }

  private createSafeEmptyReport(): StorageAccountingReport {
    return {
      databaseBytes: 0,
      dbSizeBytes: 0,
      walSizeBytes: 0,
      shmSizeBytes: 0,
      sidecarSizeBytes: 0,
      annSizeBytes: 0,
      ocrSizeBytes: 0,
      tempSizeBytes: 0,
      backupSizeBytes: 0,
      protectedBytes: 0,
      totalManagedBytes: 0,
      totalTrackedBytes: 0,
      reclaimableBytes: 0,
      reusableFreelistBytes: 0,
      modelWeightsBytes: 0,
      breakdown: {
        activeDbBytes: 0,
        walBytes: 0,
        shmBytes: 0,
        annBytes: 0,
        ocrExternalBytes: 0,
        tempBytes: 0,
        backupBytes: 0,
        protectedBackupBytes: 0,
        reusableFreelistBytes: 0,
        modelWeightsBytes: 0,
      },
      annFiles: [],
      backupFiles: [],
      tempFiles: [],
      ocrFiles: [],
      measurementErrors: [],
      isDegraded: false,
      timestamp: Date.now(),
    }
  }

  private createDegradedReport(errorMessage: string): StorageAccountingReport {
    const dbPath = this.store.dbPath
    const dbSizeBytes = safeGetFileSize(dbPath)
    const walSizeBytes = safeGetFileSize(`${dbPath}-wal`)
    const shmSizeBytes = safeGetFileSize(`${dbPath}-shm`)
    const databaseBytes = dbSizeBytes + walSizeBytes + shmSizeBytes
    return {
      databaseBytes,
      dbSizeBytes,
      walSizeBytes,
      shmSizeBytes,
      sidecarSizeBytes: 0,
      annSizeBytes: 0,
      ocrSizeBytes: 0,
      tempSizeBytes: 0,
      backupSizeBytes: 0,
      protectedBytes: 0,
      totalManagedBytes: databaseBytes,
      totalTrackedBytes: databaseBytes,
      reclaimableBytes: 0,
      reusableFreelistBytes: 0,
      modelWeightsBytes: 0,
      breakdown: {
        activeDbBytes: dbSizeBytes,
        walBytes: walSizeBytes,
        shmBytes: shmSizeBytes,
        annBytes: 0,
        ocrExternalBytes: 0,
        tempBytes: 0,
        backupBytes: 0,
        protectedBackupBytes: 0,
        reusableFreelistBytes: 0,
        modelWeightsBytes: 0,
      },
      annFiles: [],
      backupFiles: [],
      tempFiles: [],
      ocrFiles: [],
      measurementErrors: [{ path: dbPath, error: errorMessage }],
      isDegraded: true,
      timestamp: Date.now(),
    }
  }

  async runPeriodicMaintenance(): Promise<void> {
    if (this.isStopped() || this.periodicRunning) return
    if (this.isPaused()) {
      if (!this.isStopped()) {
        this.schedulePeriodicMaintenance(PERIODIC_MAINTENANCE_INTERVAL_MS)
      }
      return
    }

    this.periodicRunning = true
    const opEpoch = this.epoch
    try {
      let accounting = await this.collectAccountingSafe(opEpoch)
      if (!this.isValid(opEpoch)) return

      const snapshot = this.checkStorageBudget(accounting)
      if (!this.isValid(opEpoch) || this.isPaused()) return

      // Retention / redundancy compaction / release hooks / ANN follow-up run in the indexing worker (never on this
      // thread); this only decides to ask (normal >= 90%, urgent >= 100%, release-only below) and consumes the report.
      await this.compaction.runCycle(snapshot, 'periodic')
      if (!this.isValid(opEpoch) || this.isPaused()) return
      accounting = await this.collectAccountingSafe(opEpoch)
      if (!this.isValid(opEpoch)) return
      const afterCompaction = this.checkStorageBudget(accounting)
      if (!this.isValid(opEpoch) || this.isPaused()) return

      await this.runFtsMaintenance()
      if (!this.isValid(opEpoch) || this.isPaused()) return

      await this.compaction.optimizeFtsIfIdle(afterCompaction)
      if (!this.isValid(opEpoch) || this.isPaused()) return

      await this.runGcStep()
      if (!this.isValid(opEpoch) || this.isPaused()) return

      await this.runVacuumStep()
      if (!this.isValid(opEpoch) || this.isPaused()) return

      await this.runNameProjectionBackfill()
      if (!this.isValid(opEpoch) || this.isPaused()) return

      await this.runBackupRetentionMaintenance()
      if (!this.isValid(opEpoch)) return

      // Measure fresh accounting asynchronously off-main after backup retention maintenance
      accounting = await this.collectAccountingSafe(opEpoch)
      if (!this.isValid(opEpoch)) return
      await this.compaction.analyzeIfIdle(this.checkStorageBudget(accounting))
    } catch (error) {
      if (!this.isStopped()) {
        console.warn('[MaintenanceScheduler] Periodic maintenance step failed:', safeError(error))
      }
    } finally {
      this.periodicRunning = false
      if (this.isValid(opEpoch)) {
        this.schedulePeriodicMaintenance(PERIODIC_MAINTENANCE_INTERVAL_MS)
      }
    }
  }

  /** Last worker-run compaction (report incl. redundancy tiers and age buckets), for diagnostics / status. */
  getLastCompactionOutcome(): CompactionCycleOutcome | null {
    return this.compaction.getLastOutcome()
  }

  /**
   * Extraction-queue priority near the quota: true for a file modified within the fresh window while usage is at/over
   * the retention high watermark (90%). Cheap when there is no pressure (no database access at all).
   */
  isRecentUnderQuotaPressure(path: string): boolean {
    const snap = this.lastBudgetSnapshot
    if (!snap || this.isStopped()) return false
    const used = snap.totalManagedBytes ?? snap.databaseBytes
    if (!(used >= (snap.softBudgetBytes ?? snap.budgetBytes) * CACHE_RETENTION_HIGH_WATERMARK))
      return false
    const cutoff = Date.now() - resolveAgePolicy(this.budget).freshWindowDays * 86_400_000
    try {
      const mtime = this.store.documentByPath(path)?.mtimeMs
      return typeof mtime === 'number' && mtime >= cutoff
    } catch {
      return false
    }
  }

  /** Pause / disable: stop the in-flight worker run (it also ends on its own deadline). */
  cancelCompaction(): void {
    this.compaction.cancelInFlight()
  }

  isCompactionRunning(): boolean {
    return this.compaction.isRunning()
  }

  /** Runs one compaction decision now (tests / manual); skips when another run is in flight. */
  runCompactionCycle(
    reason: CompactionCycleOutcome['reason'] = 'manual',
  ): Promise<CompactionCycleOutcome> {
    return this.compaction.runCycle(this.checkStorageBudget(), reason)
  }

  /**
   * Admission by displacement: called by an admission that is about to be refused for quota. Frees the lowest value
   * content in the worker and answers whether to retry the admission once. See CompactionDriver.makeRoom.
   */
  makeRoom(request: MakeRoomRequest): Promise<MakeRoomOutcome> {
    return this.compaction.makeRoom(request)
  }

  getDocumentIndexProgress(path: string, activeSpaceId: string): DocumentIndexProgress {
    if (this.isStopped()) {
      return { state: 'idle', percent: null, completedChunks: 0, totalChunks: 0 }
    }
    const progress = this.store.chunkProgress(path, activeSpaceId)
    const doc = progress.document ?? this.store.documentByPath(path)
    if (!doc) {
      return { state: 'idle', percent: null, completedChunks: 0, totalChunks: 0 }
    }
    const totalChunks = Math.max(0, progress.totalChunks)
    const completedChunks = Math.min(Math.max(0, progress.completedChunks), totalChunks)
    const base = {
      path: doc.path,
      name: doc.name,
      completedChunks,
      totalChunks,
      truncated: doc.truncated,
    }
    const pct =
      totalChunks > 0 ? Math.min(100, Math.floor((completedChunks / totalChunks) * 100)) : null
    const paused = this.isPaused()

    if (doc.status === 'excluded') return { ...base, state: 'excluded', percent: null }

    const awaitingSnapshot = { ...base, completedChunks: 0, totalChunks: 0, percent: null }
    if (this.options.isExtracting?.(doc.path)) return { ...awaitingSnapshot, state: 'extracting' }
    if (this.options.isQueued?.(doc.path))
      return { ...awaitingSnapshot, state: paused ? 'paused' : 'queued' }

    if (doc.status === 'empty') return { ...base, state: 'empty', percent: 100 }
    if (doc.status === 'ready') {
      const isComplete = totalChunks === 0 || completedChunks >= totalChunks
      return {
        ...base,
        state: isComplete ? 'ready' : paused ? 'paused' : 'indexing',
        percent: isComplete ? 100 : pct,
      }
    }
    if (doc.status === 'error') {
      return {
        ...base,
        state: 'error',
        percent: pct,
        ...(doc.error ? { error: doc.error } : {}),
      }
    }
    if (doc.status === 'text-only') {
      const isComplete = totalChunks > 0 && completedChunks >= totalChunks
      return {
        ...base,
        state: isComplete ? 'ready' : paused ? 'paused' : 'indexing',
        percent: pct,
      }
    }
    return { ...base, state: paused ? 'paused' : 'queued', percent: null }
  }

  getFolderIndexProgress(
    folder?: string,
    discoveryCompleteOrSpace?: boolean | string,
    scanErrorsOrSpace: number | string = 0,
    activeSpaceId?: string,
  ): FolderIndexProgress {
    if (this.isStopped()) {
      return foldFolderProgress(
        {
          totalFiles: 0,
          readyFiles: 0,
          pendingFiles: 0,
          errorFiles: 0,
          totalChunks: 0,
          completedChunks: 0,
          partialFileProgress: 0,
          truncatedFiles: 0,
        },
        true,
        0,
      )
    }
    let discoveryComplete = true
    let scanErrors = 0
    let spaceId: string | undefined

    if (typeof discoveryCompleteOrSpace === 'string') {
      spaceId = discoveryCompleteOrSpace
    } else if (typeof discoveryCompleteOrSpace === 'boolean') {
      discoveryComplete = discoveryCompleteOrSpace
      if (typeof scanErrorsOrSpace === 'string') {
        spaceId = scanErrorsOrSpace
      } else {
        scanErrors = typeof scanErrorsOrSpace === 'number' ? scanErrorsOrSpace : 0
        spaceId = activeSpaceId
      }
    } else if (typeof activeSpaceId === 'string') {
      spaceId = activeSpaceId
    }
    const raw = this.store.folderChunkProgress(folder, spaceId)
    return foldFolderProgress(raw, discoveryComplete, scanErrors)
  }

  getFolderIndexCounts(folder?: string, activeEmbeddingSpace?: string): FolderChunkProgress {
    if (this.isStopped()) {
      return {
        totalFiles: 0,
        readyFiles: 0,
        pendingFiles: 0,
        errorFiles: 0,
        totalChunks: 0,
        completedChunks: 0,
        partialFileProgress: 0,
        truncatedFiles: 0,
      }
    }
    return this.store.folderChunkProgress(folder, activeEmbeddingSpace)
  }

  getLibraryIndexCounts(activeEmbeddingSpace?: string): FolderChunkProgress {
    if (this.isStopped()) {
      return {
        totalFiles: 0,
        readyFiles: 0,
        pendingFiles: 0,
        errorFiles: 0,
        totalChunks: 0,
        completedChunks: 0,
        partialFileProgress: 0,
        truncatedFiles: 0,
      }
    }
    return this.store.folderChunkProgress(undefined, activeEmbeddingSpace)
  }

  dispose(): void {
    this.compaction.cancelInFlight()
    this.compaction.dispose()
    this.disposed = true
    this.epoch++
    this.backupRetentionRunner.dispose()
    this.storageAccountingRunner.dispose()
    if (this.ftsTimer) {
      clearTimeout(this.ftsTimer)
      this.ftsTimer = null
    }
    if (this.gcTimer) {
      clearTimeout(this.gcTimer)
      this.gcTimer = null
    }
    if (this.vacuumTimer) {
      clearTimeout(this.vacuumTimer)
      this.vacuumTimer = null
    }
    if (this.periodicTimer) {
      clearTimeout(this.periodicTimer)
      this.periodicTimer = null
    }
  }
}
