import { Worker } from 'node:worker_threads'
import accountingWorkerPath from './storage-accounting-worker?modulePath'
import type {
  StorageAccountingOptions,
  StorageAccountingReport,
} from './storage-accounting'
import { safeGetFileSize } from '../storage-budget'

export interface StorageAccountingWorkerLike {
  postMessage?(message: any): void
  on(event: 'message', listener: (value: any) => void): this
  on(event: 'error', listener: (err: any) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number> | void
}

export type StorageAccountingWorkerFactory = (
  scriptPath: string | undefined,
  data: StorageAccountingOptions,
) => StorageAccountingWorkerLike

export interface StorageAccountingRunnerOptions {
  workerPath?: string
  workerFactory?: StorageAccountingWorkerFactory
  timeoutMs?: number
}

export const DEFAULT_ACCOUNTING_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_PENDING_PATHS = 32

/**
 * Dedicated process/worker runner for off-main storage accounting inventory scans.
 * Isolates heavy filesystem traversals and backup SQLite integrity verification
 * away from the main Electron thread and UI event loop.
 *
 * Enforces single-worker concurrency, per-dbPath isolation (never returns DB A
 * report for DB B request), option mismatch awareness, timeout guards, and clean
 * lifecycle termination.
 */
export class StorageAccountingRunner {
  private inFlightByPath = new Map<
    string,
    { promise: Promise<StorageAccountingReport>; options: StorageAccountingOptions }
  >()
  private activeExecution: Promise<void> = Promise.resolve()
  private settleInFlight: ((result: StorageAccountingReport) => void) | null = null
  private activeWorker: StorageAccountingWorkerLike | null = null
  private readonly workerPath: string | undefined
  private readonly workerFactory: StorageAccountingWorkerFactory
  private readonly timeoutMs: number
  private disposed = false

  constructor(options: StorageAccountingRunnerOptions = {}) {
    this.workerPath = options.workerPath ?? accountingWorkerPath
    this.workerFactory =
      options.workerFactory ??
      ((scriptPath, data) => {
        if (!scriptPath) {
          throw new Error('No worker script path configured for storage accounting runner')
        }
        return new Worker(scriptPath, {
          workerData: data,
          execArgv: process.execArgv,
        })
      })
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ACCOUNTING_TIMEOUT_MS
  }

  isJobRunning(): boolean {
    return this.inFlightByPath.size > 0 || this.activeWorker !== null
  }

  run(
    options: StorageAccountingOptions,
    fallbackReport?: StorageAccountingReport | null,
  ): Promise<StorageAccountingReport> {
    if (this.disposed || !options.dbPath) {
      return Promise.resolve(
        fallbackReport ?? this.createDegradedFallback(options.dbPath || '', 'Accounting runner disposed'),
      )
    }

    // Per-dbPath coalescence with option compatibility check:
    // If an in-flight measurement for the EXACT same dbPath with matching options exists,
    // safely share its result. Never return a report from DB A to DB B!
    const existing = this.inFlightByPath.get(options.dbPath)
    if (existing && this.areOptionsCompatible(existing.options, options)) {
      return existing.promise
    }

    if (this.inFlightByPath.size >= MAX_CONCURRENT_PENDING_PATHS) {
      return Promise.resolve(
        this.makeDegradedOrPreserve(
          options.dbPath,
          fallbackReport,
          'Storage accounting queue capacity reached',
        ),
      )
    }

    // Serialized execution: at most 1 worker thread runs at any given time.
    let capturedResolve: (res: StorageAccountingReport) => void
    const jobPromise = new Promise<StorageAccountingReport>((resolve) => {
      capturedResolve = resolve
    })

    const runTask = async (): Promise<void> => {
      if (this.disposed) {
        capturedResolve(
          fallbackReport ?? this.createDegradedFallback(options.dbPath, 'Accounting runner disposed'),
        )
        return
      }
      try {
        const result = await this.executeAccounting(options, fallbackReport)
        capturedResolve(result)
      } catch (err: any) {
        capturedResolve(
          this.makeDegradedOrPreserve(
            options.dbPath,
            fallbackReport,
            err?.message || 'Accounting execution failed',
          ),
        )
      } finally {
        if (this.inFlightByPath.get(options.dbPath)?.promise === jobPromise) {
          this.inFlightByPath.delete(options.dbPath)
        }
      }
    }

    this.inFlightByPath.set(options.dbPath, { promise: jobPromise, options })
    this.activeExecution = this.activeExecution.then(runTask, runTask)

    return jobPromise
  }

  private areOptionsCompatible(
    a: StorageAccountingOptions,
    b: StorageAccountingOptions,
  ): boolean {
    if (a.dbPath !== b.dbPath) return false
    if (a.reusableFreelistBytes !== b.reusableFreelistBytes) return false
    if (
      a.vectorsDir !== b.vectorsDir ||
      a.ocrDir !== b.ocrDir ||
      a.tempDir !== b.tempDir ||
      a.modelDir !== b.modelDir
    ) {
      return false
    }
    const aMeta = a.annIndexesMeta
    const bMeta = b.annIndexesMeta
    if (Boolean(aMeta) !== Boolean(bMeta)) return false
    if (aMeta && bMeta && aMeta.length !== bMeta.length) return false
    return true
  }

  private executeAccounting(
    options: StorageAccountingOptions,
    fallbackReport?: StorageAccountingReport | null,
  ): Promise<StorageAccountingReport> {
    return new Promise((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null
      let worker: StorageAccountingWorkerLike | null = null

      const cleanup = () => {
        if (this.settleInFlight === settle) {
          this.settleInFlight = null
        }
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (worker) {
          try {
            const p = worker.terminate()
            if (p && typeof (p as any).catch === 'function') {
              ;(p as any).catch(() => {})
            }
          } catch {
            // ignore termination error
          }
        }
        if (this.activeWorker === worker) {
          this.activeWorker = null
        }
      }

      const settle = (result: StorageAccountingReport) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      this.settleInFlight = settle

      // Prepare payload: ensure DatabaseSync is stripped to prevent structured clone errors
      const safeData: StorageAccountingOptions = {
        dbPath: options.dbPath,
        vectorsDir: options.vectorsDir,
        ocrDir: options.ocrDir,
        tempDir: options.tempDir,
        modelDir: options.modelDir,
        annIndexesMeta: options.annIndexesMeta,
        reusableFreelistBytes: options.reusableFreelistBytes,
      }

      try {
        worker = this.workerFactory(this.workerPath, safeData)
        this.activeWorker = worker
      } catch (err: any) {
        settle(
          this.makeDegradedOrPreserve(
            options.dbPath,
            fallbackReport,
            `Worker spawn failed: ${err?.message || String(err)}`,
          ),
        )
        return
      }

      timer = setTimeout(() => {
        settle(
          this.makeDegradedOrPreserve(
            options.dbPath,
            fallbackReport,
            `Storage accounting timed out after ${this.timeoutMs}ms`,
          ),
        )
      }, this.timeoutMs)
      timer.unref?.()

      worker.on('message', (msg: any) => {
        if (msg && typeof msg === 'object' && msg.ok === true && msg.report) {
          settle(msg.report as StorageAccountingReport)
        } else {
          settle(
            this.makeDegradedOrPreserve(
              options.dbPath,
              fallbackReport,
              msg?.error || 'Worker reported accounting failure',
            ),
          )
        }
      })

      worker.on('error', (err: any) => {
        settle(
          this.makeDegradedOrPreserve(
            options.dbPath,
            fallbackReport,
            `Worker error: ${err?.message || String(err)}`,
          ),
        )
      })

      worker.on('exit', (code: number) => {
        if (code !== 0) {
          settle(
            this.makeDegradedOrPreserve(
              options.dbPath,
              fallbackReport,
              `Worker exited with code ${code}`,
            ),
          )
        }
      })
    })
  }

  private makeDegradedOrPreserve(
    dbPath: string,
    fallbackReport: StorageAccountingReport | null | undefined,
    errorMessage: string,
  ): StorageAccountingReport {
    const now = Date.now()
    if (fallbackReport) {
      return {
        ...fallbackReport,
        isDegraded: true,
        // Preserve last successful measurement timestamp; record attempt time truthfully
        timestamp: fallbackReport.timestamp,
        lastAttemptTimestamp: now,
        measurementErrors: [
          ...fallbackReport.measurementErrors,
          { path: dbPath, error: errorMessage },
        ],
      }
    }
    return this.createDegradedFallback(dbPath, errorMessage)
  }

  private createDegradedFallback(dbPath: string, errorMessage: string): StorageAccountingReport {
    const dbSize = safeGetFileSize(dbPath)
    const walSize = safeGetFileSize(`${dbPath}-wal`)
    const shmSize = safeGetFileSize(`${dbPath}-shm`)
    const databaseBytes = dbSize + walSize + shmSize
    const now = Date.now()
    return {
      databaseBytes,
      dbSizeBytes: dbSize,
      walSizeBytes: walSize,
      shmSizeBytes: shmSize,
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
        activeDbBytes: dbSize,
        walBytes: walSize,
        shmBytes: shmSize,
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
      timestamp: now,
      lastAttemptTimestamp: now,
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.settleInFlight) {
      const settle = this.settleInFlight
      this.settleInFlight = null
      settle(this.createDegradedFallback('', 'Accounting runner disposed'))
    }
    if (this.activeWorker) {
      try {
        const p = this.activeWorker.terminate()
        if (p && typeof (p as any).catch === 'function') {
          ;(p as any).catch(() => {})
        }
      } catch {
        // ignore
      }
      this.activeWorker = null
    }
    this.inFlightByPath.clear()
  }
}
