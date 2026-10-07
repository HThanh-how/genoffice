import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { enforceBackupRetentionPolicy } from '../storage/migration/backup-retention'

// If running inside dedicated worker thread, execute retention policy and report back
if (!isMainThread && parentPort) {
  const executeRetention = (dbPath: string) => {
    try {
      const purgedCount = enforceBackupRetentionPolicy(dbPath)
      parentPort?.postMessage({ purgedCount })
    } catch (error) {
      parentPort?.postMessage({
        purgedCount: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (workerData?.dbPath) {
    executeRetention(workerData.dbPath)
  }

  parentPort.on('message', (msg: any) => {
    if (msg?.type === 'run' && msg.dbPath) {
      executeRetention(msg.dbPath)
    }
  })
}

export interface BackupRetentionWorkerLike {
  postMessage?(message: any): void
  on(event: 'message', listener: (value: any) => void): this
  on(event: 'error', listener: (err: any) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number> | void
}

export type BackupRetentionWorkerFactory = (
  scriptPath: string | undefined,
  data: { dbPath: string },
) => BackupRetentionWorkerLike

export interface BackupRetentionRunnerOptions {
  workerPath?: string
  workerFactory?: BackupRetentionWorkerFactory
  timeoutMs?: number
}

export const DEFAULT_RETENTION_TIMEOUT_MS = 60_000

/**
 * Dedicated process/worker runner for backup retention maintenance (JOB-05-RET1).
 * Isolates heavy SQLite verification and candidate scanning away from both
 * the Electron UI thread and the search/indexing worker.
 */
export class BackupRetentionRunner {
  private inFlightPromise: Promise<{ purgedCount: number }> | null = null
  private activeWorker: BackupRetentionWorkerLike | null = null
  private readonly workerPath: string | undefined
  private readonly workerFactory: BackupRetentionWorkerFactory
  private readonly timeoutMs: number
  private disposed = false

  constructor(options: BackupRetentionRunnerOptions = {}) {
    this.workerPath =
      options.workerPath ??
      (typeof import.meta !== 'undefined' ? (import.meta as any).filename : undefined)
    this.workerFactory =
      options.workerFactory ??
      ((scriptPath, data) => {
        if (!scriptPath) {
          throw new Error('No worker script path configured for backup retention runner')
        }
        return new Worker(scriptPath, { workerData: data })
      })
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RETENTION_TIMEOUT_MS
  }

  isJobRunning(): boolean {
    return this.inFlightPromise !== null
  }

  run(dbPath: string): Promise<{ purgedCount: number }> {
    if (this.disposed || !dbPath) {
      return Promise.resolve({ purgedCount: 0 })
    }

    // Concurrency guard: Only one retention process runs at any given time
    if (this.inFlightPromise) {
      return this.inFlightPromise
    }

    const jobPromise = this.executeRetention(dbPath).finally(() => {
      if (this.inFlightPromise === jobPromise) {
        this.inFlightPromise = null
      }
    })
    this.inFlightPromise = jobPromise

    return jobPromise
  }

  private executeRetention(dbPath: string): Promise<{ purgedCount: number }> {
    return new Promise((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        this.activeWorker = null
      }

      const settle = (result: { purgedCount: number }) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      let worker: BackupRetentionWorkerLike
      try {
        worker = this.workerFactory(this.workerPath, { dbPath })
        this.activeWorker = worker
      } catch {
        settle({ purgedCount: 0 })
        return
      }

      timer = setTimeout(() => {
        // Timeout guard: terminate dedicated process/worker to prevent orphan disk scanning
        try {
          void worker.terminate()
        } catch {
          // ignore termination error
        }
        settle({ purgedCount: 0 })
      }, this.timeoutMs)
      timer.unref?.()

      worker.on('message', (msg: any) => {
        if (msg && typeof msg === 'object' && typeof msg.purgedCount === 'number') {
          settle({ purgedCount: Math.max(0, Math.floor(msg.purgedCount)) })
        } else {
          settle({ purgedCount: 0 })
        }
      })

      worker.on('error', () => {
        settle({ purgedCount: 0 })
      })

      worker.on('exit', () => {
        settle({ purgedCount: 0 })
      })

      if (typeof worker.postMessage === 'function') {
        try {
          worker.postMessage({ type: 'run', dbPath })
        } catch {
          settle({ purgedCount: 0 })
        }
      }
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.activeWorker) {
      try {
        void this.activeWorker.terminate()
      } catch {
        // ignore
      }
      this.activeWorker = null
    }
    this.inFlightPromise = null
  }
}
