import { statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { discoveredPathAdmission } from '../artifact-policy'
import { isIndexableExtension, isJunkFileName } from '../scan-policy'

export type PendingMetadataKind = 'remember' | 'discovered'

export interface PendingMetadataItem {
  path: string
  kind: PendingMetadataKind
  metadata?: { mtimeMs: number; sizeBytes: number }
  retries: number
  enqueuedAt: number
}

export type IntakeEnqueueStatus = 'deferred' | 'rejected' | 'ignored'

export interface IntakeEnqueueResult {
  status: IntakeEnqueueStatus
  reason?: string
}

export type RememberReplayOutcome = 'admitted' | 'denied' | 'excluded' | 'missing'
export interface RememberReplayResult {
  outcome: RememberReplayOutcome
  reason?: string
}

export type DiscoveredReplayOutcome =
  | 'enrolled'
  | 'unchanged'
  | 'denied'
  | 'excluded'
  | 'unsupported'
  | 'missing'

export interface DiscoveredReplayResult {
  outcome: DiscoveredReplayOutcome
  reason?: string
}

export interface PendingMetadataIntakeAdapter {
  onDiscovered(path: string, metadata: { mtimeMs: number; sizeBytes: number }): void
  onCanceled?(path: string): void
  onMoved?(oldPath: string, newPath: string): void
}

export interface PendingMetadataIntakeOptions {
  maxCapacity?: number
  maxRetries?: number
  batchSize?: number
  isWriteReady: () => boolean
  isAccountingReady: () => boolean
  isFreeDiskReady: () => boolean
  refreshAccountingAsync?: () => Promise<unknown>
  isStopped: () => boolean
  isEnabled: () => boolean
  onRemember: (path: string) => RememberReplayResult | boolean
  onDiscovered: (path: string, meta?: { mtimeMs: number; sizeBytes: number }) => DiscoveredReplayResult | boolean
  onLastError?: (error: string | undefined) => void
  onSuccess?: (path: string) => void
}

export function safeStat(filePath: string): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const s = statSync(filePath)
    return s.isFile() ? { mtimeMs: s.mtimeMs, sizeBytes: s.size } : null
  } catch {
    return null
  }
}

/**
 * Bounded queue coordinator for metadata intents that arrive before
 * write-ready config ACK, fresh storage accounting, or verified free disk headroom.
 */
export class PendingMetadataIntake {
  private readonly intents = new Map<string, PendingMetadataItem>()
  private readonly maxCapacity: number
  private readonly maxRetries: number
  private readonly batchSize: number
  private replaying = false
  private disposed = false
  private diskRetryAttempts = 0
  private static readonly MAX_DISK_RETRIES = 3
  private diskRetryTimer: NodeJS.Timeout | null = null
  private replayRetryAttempts = 0
  private replayRetryTimer: NodeJS.Timeout | null = null
  /** Bounded backoff (ms) of replay retries after a state change (e.g. leaving 'full'): ~11s in total. */
  static readonly REPLAY_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1_000, 2_000, 3_000, 4_000]

  constructor(private readonly options: PendingMetadataIntakeOptions) {
    this.maxCapacity = options.maxCapacity ?? 500
    this.maxRetries = options.maxRetries ?? 3
    this.batchSize = options.batchSize ?? 50
  }

  get size(): number {
    return this.intents.size
  }

  has(rawPath: string): boolean {
    return this.intents.has(resolve(rawPath))
  }

  get(rawPath: string): PendingMetadataItem | undefined {
    return this.intents.get(resolve(rawPath))
  }

  list(): PendingMetadataItem[] {
    return Array.from(this.intents.values())
  }

  enqueue(
    rawPath: string,
    kind: PendingMetadataKind,
    metadata?: { mtimeMs: number; sizeBytes: number },
    rejectionReason?: string,
  ): IntakeEnqueueResult {
    if (this.disposed || this.options.isStopped()) {
      return { status: 'rejected', reason: 'stopped' }
    }
    const path = resolve(rawPath)

    if (kind === 'discovered') {
      const ext = extname(path).toLowerCase()
      if ((ext && !isIndexableExtension(ext)) || isJunkFileName(basename(path))) {
        return { status: 'ignored', reason: 'unsupported-extension' }
      }
      const admission = discoveredPathAdmission(path)
      if (!admission.allowed) {
        return { status: 'ignored', reason: 'policy-denied' }
      }
      const stat = metadata ?? safeStat(path)
      if (!stat) {
        return { status: 'ignored', reason: 'missing-source' }
      }
      metadata = stat
    }

    const existing = this.intents.get(path)
    if (existing) {
      if (kind === 'remember' && existing.kind !== 'remember') {
        existing.kind = 'remember'
        existing.enqueuedAt = Date.now()
        existing.retries = 0
      }
      if (metadata) {
        existing.metadata = metadata
      }
      if (rejectionReason) {
        this.options.onLastError?.(rejectionReason)
      }
      return { status: 'deferred', reason: rejectionReason ?? 'already-queued' }
    }

    if (this.intents.size >= this.maxCapacity) {
      const err = 'Metadata admission queue full'
      this.options.onLastError?.(err)
      return { status: 'rejected', reason: err }
    }

    const item: PendingMetadataItem = {
      path,
      kind,
      metadata,
      retries: 0,
      enqueuedAt: Date.now(),
    }
    this.intents.set(path, item)

    const defReason = rejectionReason ?? 'Metadata admission deferred: awaiting startup readiness'
    this.options.onLastError?.(defReason)

    this.triggerWarmup()
    return { status: 'deferred', reason: defReason }
  }

  remove(rawPath: string): boolean {
    return this.intents.delete(resolve(rawPath))
  }

  transfer(oldPath: string, newPath: string): void {
    const oldNorm = resolve(oldPath)
    const newNorm = resolve(newPath)
    const item = this.intents.get(oldNorm)
    if (!item) return
    this.intents.delete(oldNorm)
    item.path = newNorm
    const existing = this.intents.get(newNorm)
    if (existing) {
      if (item.kind === 'remember') existing.kind = 'remember'
      if (item.metadata) existing.metadata = item.metadata
    } else {
      this.intents.set(newNorm, item)
    }
  }

  clear(): void {
    this.intents.clear()
    if (this.diskRetryTimer) {
      clearTimeout(this.diskRetryTimer)
      this.diskRetryTimer = null
    }
    this.diskRetryAttempts = 0
    this.clearReplayRetry()
  }

  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
  }

  getAdapter(): PendingMetadataIntakeAdapter {
    return {
      onDiscovered: (p, meta) => {
        if (!this.disposed && !this.options.isStopped()) {
          this.enqueue(p, 'discovered', meta)
        }
      },
      onCanceled: (p) => {
        this.remove(p)
      },
      onMoved: (oldP, newP) => {
        this.transfer(oldP, newP)
      },
    }
  }

  isReadyForReplay(): boolean {
    if (this.disposed || this.options.isStopped()) return false
    if (!this.options.isEnabled()) return false
    if (!this.options.isWriteReady()) return false
    if (!this.options.isAccountingReady()) return false
    if (!this.options.isFreeDiskReady()) return false
    return true
  }

  private triggerWarmup(): void {
    if (this.disposed || this.options.isStopped()) return
    if (!this.options.isAccountingReady() && this.options.refreshAccountingAsync) {
      void this.options
        .refreshAccountingAsync()
        .then(() => {
          if (!this.disposed && !this.options.isStopped() && this.isReadyForReplay()) {
            void this.triggerReplay()
          }
        })
        .catch(() => {})
    }
    if (!this.options.isFreeDiskReady()) {
      this.scheduleDiskRetry()
    }
  }

  private scheduleDiskRetry(): void {
    if (this.disposed || this.options.isStopped() || this.diskRetryTimer) return
    if (this.diskRetryAttempts >= PendingMetadataIntake.MAX_DISK_RETRIES) return

    const delayMs = 50 * Math.pow(2, this.diskRetryAttempts)
    this.diskRetryAttempts++
    this.diskRetryTimer = setTimeout(() => {
      this.diskRetryTimer = null
      if (this.disposed || this.options.isStopped()) return
      if (this.isReadyForReplay()) {
        this.diskRetryAttempts = 0
        void this.triggerReplay()
      } else if (this.diskRetryAttempts < PendingMetadataIntake.MAX_DISK_RETRIES) {
        this.scheduleDiskRetry()
      }
    }, delayMs)
    this.diskRetryTimer.unref?.()
  }

  private clearReplayRetry(): void {
    if (this.replayRetryTimer) {
      clearTimeout(this.replayRetryTimer)
      this.replayRetryTimer = null
    }
    this.replayRetryAttempts = 0
  }

  /**
   * A replay requested on a state change (leaving 'full', write-ready, enable) can find the intake not ready
   * yet, typically because the cached free-disk measurement went stale while the budget was full. The readiness
   * check itself starts the async refresh, so retry a few times with a bounded backoff instead of dropping
   * the request (which stranded queued files until the next unrelated trigger).
   */
  private scheduleReplayRetry(): void {
    if (this.disposed || this.options.isStopped() || this.replayRetryTimer || this.intents.size === 0) return
    const delays = PendingMetadataIntake.REPLAY_RETRY_DELAYS_MS
    if (this.replayRetryAttempts >= delays.length) return
    const delayMs = delays[this.replayRetryAttempts]!
    this.replayRetryAttempts++
    this.replayRetryTimer = setTimeout(() => {
      this.replayRetryTimer = null
      if (this.disposed || this.options.isStopped()) return
      void this.triggerReplay(true)
    }, delayMs)
    this.replayRetryTimer.unref?.()
  }

  async triggerReplay(isRetry = false): Promise<void> {
    if (!isRetry) this.replayRetryAttempts = 0
    if (this.replaying || this.intents.size === 0) return
    if (!this.isReadyForReplay()) {
      this.scheduleReplayRetry()
      return
    }
    this.replaying = true

    try {
      const items = Array.from(this.intents.values())
      const remembers = items.filter((i) => i.kind === 'remember')
      const discovered = items.filter((i) => i.kind === 'discovered')
      const ordered = [...remembers, ...discovered]

      let processedCount = 0
      for (const item of ordered) {
        if (this.disposed || this.options.isStopped() || !this.options.isEnabled()) break
        if (!this.isReadyForReplay()) break
        if (this.intents.get(item.path) !== item) continue

        if (item.kind === 'remember') {
          const res = this.options.onRemember(item.path)
          const outcome = typeof res === 'boolean' ? (res ? 'admitted' : 'denied') : res.outcome
          const reason = typeof res === 'object' ? res.reason : undefined

          if (outcome === 'admitted' || outcome === 'excluded' || outcome === 'missing') {
            this.intents.delete(item.path)
            if (outcome === 'admitted') this.options.onSuccess?.(item.path)
          } else {
            if (reason === 'budget-full' || !this.options.isAccountingReady()) {
              this.options.onLastError?.(reason ?? 'Storage budget full')
              break
            }
            item.retries++
            if (item.retries >= this.maxRetries) {
              this.intents.delete(item.path)
              this.options.onLastError?.(`Metadata admission retry limit exhausted: ${reason ?? 'denied'}`)
            }
          }
        } else {
          const currentStat = safeStat(item.path)
          if (!currentStat) {
            this.intents.delete(item.path)
            continue
          }
          const admission = discoveredPathAdmission(item.path)
          if (!admission.allowed) {
            this.intents.delete(item.path)
            continue
          }

          const res = this.options.onDiscovered(item.path, currentStat)
          const outcome = typeof res === 'boolean' ? (res ? 'enrolled' : 'denied') : res.outcome
          const reason = typeof res === 'object' ? res.reason : undefined

          if (
            outcome === 'enrolled' ||
            outcome === 'unchanged' ||
            outcome === 'excluded' ||
            outcome === 'unsupported' ||
            outcome === 'missing'
          ) {
            this.intents.delete(item.path)
            if (outcome === 'enrolled') this.options.onSuccess?.(item.path)
          } else {
            if (reason === 'budget-full' || !this.options.isAccountingReady()) {
              this.options.onLastError?.(reason ?? 'Storage budget full')
              break
            }
            item.retries++
            if (item.retries >= this.maxRetries) {
              this.intents.delete(item.path)
            }
          }
        }

        processedCount++
        if (processedCount >= this.batchSize) {
          await new Promise<void>((r) => setImmediate(r))
          if (this.disposed || this.options.isStopped() || !this.options.isEnabled()) break
          processedCount = 0
        }
      }

      if (this.intents.size === 0) {
        this.options.onLastError?.(undefined)
        this.clearReplayRetry()
      } else if (!this.disposed && this.options.isEnabled() && !this.isReadyForReplay()) {
        this.scheduleReplayRetry()
      }
    } finally {
      this.replaying = false
    }
  }
}
