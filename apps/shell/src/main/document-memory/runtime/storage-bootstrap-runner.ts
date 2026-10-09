import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import bootstrapWorkerPath from './storage-bootstrap-worker?modulePath'
import {
  ensureDocumentMemoryStorageReady,
  type BootstrapResult,
  type StorageBootstrapOptions,
  type StorageBootstrapProgress,
} from '../storage-bootstrap'
import { appendBootstrapLog } from '../bootstrap-log'
import type {
  StorageBootstrapWorkerInput,
  StorageBootstrapWorkerMessage,
} from './storage-bootstrap-worker'

export interface StorageBootstrapWorkerLike {
  on(event: 'message', listener: (value: unknown) => void): this
  on(event: 'error', listener: (err: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number> | void
}

export type StorageBootstrapWorkerFactory = (
  scriptPath: string | undefined,
  data: StorageBootstrapWorkerInput,
) => StorageBootstrapWorkerLike

export interface StorageBootstrapRunnerOptions {
  workerPath?: string
  workerFactory?: StorageBootstrapWorkerFactory
  /** Progress, throttled to `progressIntervalMs` (phase changes always pass). */
  onProgress?: (progress: StorageBootstrapProgress) => void
  progressIntervalMs?: number
  /** Fallback when no worker can be started (default: the in-process bootstrap). */
  runInline?: (dbDir: string, options: StorageBootstrapOptions) => Promise<BootstrapResult>
}

const DEFAULT_PROGRESS_INTERVAL_MS = 250

function isWorkerMessage(value: unknown): value is StorageBootstrapWorkerMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'progress' || type === 'result'
}

function failClosed(error: string): BootstrapResult {
  return { ready: false, migrated: false, error }
}

/**
 * NOTE: the bundler inlines the other `?modulePath` workers that the storage code imports, so this worker's `workerData`
 * must never carry a `dbPath` key: the accounting / retention worker modules would mistake it for their own job.
 *
 * Runs `ensureDocumentMemoryStorageReady` in a worker thread and resolves with its result, so a database check or
 * migration that takes minutes never freezes the main thread (a blank, unresponsive window). Fail-closed: a worker
 * that errors or exits without a result resolves `ready: false`. Only a worker that cannot even be created falls back
 * to running the same bootstrap in-process, which is slower for the UI but identical in outcome.
 */
export function runStorageBootstrapOffThread(
  dbDir: string,
  options: Omit<StorageBootstrapOptions, 'onProgress'>,
  runner: StorageBootstrapRunnerOptions = {},
): Promise<BootstrapResult> {
  const logDir = options.logDir ?? join(options.settingsDir ?? dbDir, 'logs')
  const workerPath = runner.workerPath ?? bootstrapWorkerPath
  const factory: StorageBootstrapWorkerFactory =
    runner.workerFactory ??
    ((scriptPath, data) => {
      if (!scriptPath) throw new Error('No worker script path configured for the storage bootstrap')
      return new Worker(scriptPath, { workerData: data, execArgv: process.execArgv })
    })
  const interval = runner.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS

  return new Promise<BootstrapResult>((resolve) => {
    let settled = false
    let worker: StorageBootstrapWorkerLike | null = null
    let lastPhase: string | null = null
    let lastEmit = 0

    const settle = (result: BootstrapResult): void => {
      if (settled) return
      settled = true
      if (worker) {
        try {
          const done = worker.terminate()
          if (done && typeof (done as Promise<number>).catch === 'function')
            (done as Promise<number>).catch(() => {})
        } catch {
          // already gone
        }
      }
      resolve(result)
    }

    const emit = (progress: StorageBootstrapProgress): void => {
      const now = Date.now()
      if (progress.phase === lastPhase && now - lastEmit < interval) return
      lastPhase = progress.phase
      lastEmit = now
      try {
        runner.onProgress?.(progress)
      } catch {
        // a UI listener must never decide whether the index opens
      }
    }

    try {
      worker = factory(workerPath, { dbDir, options })
    } catch (error) {
      appendBootstrapLog(
        logDir,
        'warn',
        `Storage bootstrap worker could not start (${(error as Error)?.message ?? error}); running it in-process.`,
      )
      const inline = runner.runInline ?? ensureDocumentMemoryStorageReady
      inline(dbDir, { ...options, onProgress: emit }).then(settle, (err: unknown) =>
        settle(
          failClosed(
            `Storage bootstrap threw: ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      )
      return
    }

    worker.on('message', (message) => {
      if (!isWorkerMessage(message)) return
      if (message.type === 'progress') emit(message.progress)
      else settle(message.result)
    })
    worker.on('error', (err) => {
      if (settled) return
      const text = err instanceof Error ? err.message : String(err)
      appendBootstrapLog(logDir, 'error', `Storage bootstrap worker failed: ${text}`)
      settle(failClosed(`Storage bootstrap worker failed: ${text}`))
    })
    worker.on('exit', (code) => {
      // after a result the worker is terminated on purpose; reaching here unsettled means it died on its own
      if (settled) return
      appendBootstrapLog(
        logDir,
        'error',
        `Storage bootstrap worker exited (code ${code}) without a result.`,
      )
      settle(failClosed(`Storage bootstrap worker exited (code ${code}) without a result.`))
    })
  })
}
