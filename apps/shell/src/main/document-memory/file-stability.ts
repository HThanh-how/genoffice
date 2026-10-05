import { open, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

export interface StableFile {
  path: string
  mtimeMs: number
  sizeBytes: number
}

export type StabilityResult =
  | { kind: 'stable'; file: StableFile }
  | { kind: 'gone' }
  | { kind: 'unavailable' }
  | { kind: 'timeout' }

export interface FileStabilityGateOptions {
  /** Interval between two consecutive samples to confirm stability (default: 1500 ms) */
  sampleIntervalMs?: number
  /** Exponential backoff schedule when file is actively mutating (default: [2s, 3s, 5s, 8s, 15s, 30s]) */
  backoffScheduleMs?: number[]
  /** Maximum overall wait time before reporting timeout (default: 120_000 ms / ~2 minutes) */
  totalTimeoutMs?: number
  /** Maximum concurrent fs.stat operations permitted (default: 16, max 32) */
  maxConcurrentStats?: number
  /** Custom stat function seam for unit testing and virtualization */
  statFn?: (path: string) => Promise<{ isFile(): boolean; size: number; mtimeMs: number }>
  /** Custom file open probe seam for testing lock states */
  openFn?: (path: string, flags: string) => Promise<{ close: () => Promise<void> }>
}

/** Temporary download and lock file extensions to immediately ignore */
export const TEMPORARY_EXTENSIONS = new Set([
  '.crdownload',
  '.part',
  '.partial',
  '.tmp',
  '.temp',
  '.lock',
])

/** Check whether a file path points to a known temporary download or lock artifact */
export function isTemporaryDownloadFile(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return TEMPORARY_EXTENSIONS.has(ext)
}

interface StabilityEntry {
  path: string
  promise: Promise<StabilityResult>
  timer: NodeJS.Timeout | null
  abortController: AbortController
}

/** Asynchronous concurrency limiter (semaphore) to prevent I/O saturation */
class AsyncSemaphore {
  private current = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }
    return new Promise<void>((res) => {
      this.queue.push(() => {
        this.current++
        res()
      })
    })
  }

  release(): void {
    this.current--
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  get active(): number {
    return this.current
  }
}

/**
 * FileStabilityGate watches files entering the indexing pipeline to ensure writes
 * (downloads, large file copies, unpacks) are fully finished before indexing starts.
 *
 * Implements an asynchronous per-path state machine with event coalescing,
 * two-point sampling, backoff retries, concurrency throttling, and immediate ENOENT detection.
 */
export class FileStabilityGate {
  private readonly entries = new Map<string, StabilityEntry>()
  private readonly semaphore: AsyncSemaphore
  private readonly statFn: (
    path: string,
  ) => Promise<{ isFile(): boolean; size: number; mtimeMs: number }>
  private readonly openFn: (
    path: string,
    flags: string,
  ) => Promise<{ close: () => Promise<void> }>
  private readonly sampleIntervalMs: number
  private readonly backoffScheduleMs: number[]
  private readonly totalTimeoutMs: number
  private disposed = false

  constructor(options: FileStabilityGateOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1500
    this.backoffScheduleMs = options.backoffScheduleMs ?? [2000, 3000, 5000, 8000, 15000, 30000]
    this.totalTimeoutMs = options.totalTimeoutMs ?? 120_000
    const concurrency = Math.min(Math.max(options.maxConcurrentStats ?? 16, 1), 32)
    this.semaphore = new AsyncSemaphore(concurrency)
    this.statFn = options.statFn ?? ((targetPath: string) => stat(targetPath))
    this.openFn =
      options.openFn ??
      (options.statFn
        ? async () => ({ close: async () => {} })
        : (targetPath: string, flags: string) => open(targetPath, flags))
  }

  /**
   * Monitor a file until its size and mtime stabilize across two samples.
   * If called multiple times for the same file, coalesces into the active check.
   */
  waitForStability(path: string): Promise<StabilityResult> {
    const normalized = resolve(path)

    if (this.disposed) {
      return Promise.resolve({ kind: 'unavailable' })
    }

    if (isTemporaryDownloadFile(normalized)) {
      return Promise.resolve({ kind: 'unavailable' })
    }

    const existing = this.entries.get(normalized)
    if (existing) {
      return existing.promise
    }

    const abortController = new AbortController()
    const entry: StabilityEntry = {
      path: normalized,
      timer: null,
      abortController,
      promise: Promise.resolve({ kind: 'unavailable' as const }),
    }

    entry.promise = this.runStateMachine(entry, normalized).finally(() => {
      this.entries.delete(normalized)
    })

    this.entries.set(normalized, entry)
    return entry.promise
  }

  /** Alias for {@link waitForStability} */
  wait(path: string): Promise<StabilityResult> {
    return this.waitForStability(path)
  }

  /** Alias for {@link waitForStability} */
  check(path: string): Promise<StabilityResult> {
    return this.waitForStability(path)
  }

  /** Check if a path currently has an active stability inspection underway */
  isPending(path: string): boolean {
    return this.entries.has(resolve(path))
  }

  /** Total count of files currently being tracked for stability */
  activeCount(): number {
    return this.entries.size
  }

  /** Check whether this gate has been disposed */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Cancel an ongoing stability check for a specific path if present */
  cancel(path: string): boolean {
    const normalized = resolve(path)
    const entry = this.entries.get(normalized)
    if (!entry) return false
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.abortController.abort()
    this.entries.delete(normalized)
    return true
  }

  /** Dispose all active timers and cancel pending checks */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      entry.abortController.abort()
    }
    this.entries.clear()
  }

  /** Internal state machine handling 2-sample verification with backoff and timeout */
  private async runStateMachine(
    entry: StabilityEntry,
    normalizedPath: string,
  ): Promise<StabilityResult> {
    const startedAt = Date.now()
    let backoffIndex = 0

    while (true) {
      if (this.disposed || entry.abortController.signal.aborted) {
        return { kind: 'unavailable' }
      }

      if (Date.now() - startedAt >= this.totalTimeoutMs) {
        return { kind: 'timeout' }
      }

      // Sample 1
      const sample1 = await this.safeStat(normalizedPath)
      if (sample1.kind === 'gone') return { kind: 'gone' }
      if (sample1.kind === 'unavailable') return { kind: 'unavailable' }

      // Sleep between sample 1 and sample 2
      const sleep1Ok = await this.sleep(this.sampleIntervalMs, entry)
      if (!sleep1Ok || this.disposed || entry.abortController.signal.aborted) {
        return { kind: 'unavailable' }
      }

      if (Date.now() - startedAt >= this.totalTimeoutMs) {
        return { kind: 'timeout' }
      }

      // Sample 2
      const sample2 = await this.safeStat(normalizedPath)
      if (sample2.kind === 'gone') return { kind: 'gone' }
      if (sample2.kind === 'unavailable') return { kind: 'unavailable' }

      // Stability verification: size and mtime unchanged
      if (sample1.sizeBytes === sample2.sizeBytes && sample1.mtimeMs === sample2.mtimeMs) {
        const probe = await this.probeReadable(normalizedPath)
        if (probe === 'stable') {
          return {
            kind: 'stable',
            file: {
              path: normalizedPath,
              mtimeMs: sample2.mtimeMs,
              sizeBytes: sample2.sizeBytes,
            },
          }
        }
        if (probe === 'gone') {
          return { kind: 'gone' }
        }
        // probe === 'busy' (exclusive lock / open in other app) -> fallthrough to backoff ladder
      }

      // Content or metadata changed -> reset timer and apply backoff ladder
      const delay =
        this.backoffScheduleMs[Math.min(backoffIndex, this.backoffScheduleMs.length - 1)] ?? 2000
      backoffIndex++

      const elapsed = Date.now() - startedAt
      if (elapsed + delay >= this.totalTimeoutMs) {
        const remaining = this.totalTimeoutMs - elapsed
        if (remaining > 0) {
          await this.sleep(remaining, entry)
        }
        return { kind: 'timeout' }
      }

      const backoffSleepOk = await this.sleep(delay, entry)
      if (!backoffSleepOk || this.disposed || entry.abortController.signal.aborted) {
        return { kind: 'unavailable' }
      }
    }
  }

  /** Execute fs.stat under semaphore concurrency control with error categorization */
  private async safeStat(
    targetPath: string,
  ): Promise<
    { kind: 'file'; sizeBytes: number; mtimeMs: number } | { kind: 'gone' } | { kind: 'unavailable' }
  > {
    return this.semaphore.run(async () => {
      try {
        const s = await this.statFn(targetPath)
        if (!s.isFile()) {
          return { kind: 'unavailable' }
        }
        return {
          kind: 'file',
          sizeBytes: s.size,
          mtimeMs: s.mtimeMs,
        }
      } catch (err: unknown) {
        const isEnoent =
          typeof err === 'object' &&
          err !== null &&
          (('code' in err && (err as { code: unknown }).code === 'ENOENT') ||
            ('name' in err && (err as { name: unknown }).name === 'NotFoundError'))
        if (isEnoent) {
          return { kind: 'gone' }
        }
        return { kind: 'unavailable' }
      }
    })
  }

  /** Probe readability/lock status before declaring file stable */
  private async probeReadable(targetPath: string): Promise<'stable' | 'gone' | 'busy'> {
    return this.semaphore.run(async () => {
      try {
        const handle = await this.openFn(targetPath, 'r')
        try {
          await handle.close()
        } catch {
          // ignore close error
        }
        return 'stable'
      } catch (err: unknown) {
        const code =
          typeof err === 'object' && err !== null && 'code' in err
            ? (err as { code: string }).code
            : ''
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return 'gone'
        }
        if (code === 'EBUSY' || code === 'ETXTBSY' || code === 'EPERM' || code === 'EACCES') {
          return 'busy'
        }
        return 'busy'
      }
    })
  }

  /** Interruptible sleep linked to the stability entry's timer and AbortSignal */
  private sleep(ms: number, entry: StabilityEntry): Promise<boolean> {
    if (this.disposed || entry.abortController.signal.aborted) {
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolveSleep) => {
      const onAbort = () => {
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = null
        }
        entry.abortController.signal.removeEventListener('abort', onAbort)
        resolveSleep(false)
      }

      entry.timer = setTimeout(() => {
        entry.timer = null
        entry.abortController.signal.removeEventListener('abort', onAbort)
        resolveSleep(true)
      }, ms)
      entry.timer.unref?.()

      entry.abortController.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
