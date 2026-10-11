import {
  compactionTarget,
  contentWriteCapBytes,
  type CompactionUrgency,
  type DocumentIndexStorageBudget,
  type StorageBudgetSnapshot,
} from '../storage-budget'
import type { WorkerReply, WorkerRequest } from '../worker-types'
import type { AnnRebuildRequest } from './ann-rebuild-after-compaction'
import type { CacheRetentionReport } from './cache-retention-policy'
import type { ImportanceClass } from './value-density'
import {
  DISPLACEMENT_MARGIN_MAX_BYTES,
  DISPLACEMENT_MARGIN_RATIO,
  type CompactionRunStatus,
  type CompactionWorkerResult,
  type FreeSpaceWorkerResult,
  type OptimizeFtsWorkerResult,
  type RedundancyAnalyzeWorkerResult,
  type RetentionWorkerResult,
} from './worker-compaction-types'

/**
 * Main-thread side of the storage-compaction lane. It owns exactly one decision: WHEN to ask the indexing worker
 * to compact, and what to do with the JSON report that comes back. It never opens the database for compaction.
 *
 *   - normal  (>= 90% of the soft quota): one run towards the 80% floor, then idle back-off if nothing is left;
 *   - urgent  (>= 100%, the grace zone):  run immediately and again as soon as the previous run ended, with a
 *                                         short interval, until usage is back under the soft quota;
 *   - none:   one cheap pass per periodic cycle for the release hooks, plus idle FTS optimisation / analysis.
 *
 * Safety: single flight (a second cycle or a displacement joins/skips, it never starts a parallel run), replies
 * from a stale epoch or a different runId are dropped, the budget handshake gate (`isWriteReady`) is checked
 * before every send and the worker re-checks the applied configVersion.
 */
export const URGENT_REPEAT_MS = 2_000
export const URGENT_NO_PROGRESS_BACKOFF_MS = 30_000
export const NORMAL_START_DELAY_MS = 2_000
export const NORMAL_NO_PROGRESS_BACKOFF_MS = 10 * 60_000
export const RETRY_AFTER_BUSY_MS = 5_000
export const COMPACTION_ASK_TIMEOUT_MS = 10 * 60_000 + 30_000
export const FREE_SPACE_ASK_TIMEOUT_MS = 2 * 60_000 + 30_000
export const MAKE_ROOM_COOLDOWN_MS = 30_000
export const MAKE_ROOM_WAIT_FOR_RETENTION_MS = 60_000
export const FTS_OPTIMIZE_INTERVAL_MS = 15 * 60_000
export const FTS_OPTIMIZE_PENDING_INTERVAL_MS = 2 * 60_000
export const ANALYZE_INTERVAL_MS = 10 * 60_000
/** A run must shrink the index by at least this much to count as progress (re-run / no back-off). */
export const PROGRESS_MIN_BYTES = 512 * 1024

export interface CompactionCycleOutcome {
  at: number
  reason: 'periodic' | 'pressure' | 'manual'
  urgency: CompactionUrgency
  status: CompactionRunStatus | 'skipped' | 'stale'
  skippedReason?: string
  runId?: string
  bytesBefore: number
  bytesAfter: number
  reclaimedBytes: number
  belowSoftQuota: boolean
  /** Full worker JSON report (includes `redundancy` and the `age` buckets). */
  report: CacheRetentionReport | null
  release?: RetentionWorkerResult['release']
  annRebuildRequests: number
  error?: string
}

export interface MakeRoomRequest {
  /** A real admission refusal includes concurrent leases and disk headroom, not just measured usage. */
  admissionDenied?: boolean
  /** Bytes that must become free for the incoming document / vectors. */
  neededBytes: number
  importance?: ImportanceClass
  reason: 'content' | 'metadata' | 'embedding' | 'name-metadata'
}

export interface MakeRoomOutcome {
  attempted: boolean
  /** True when admission should be retried once (the hard cap now has room, or a run just freed space). */
  retry: boolean
  freedBytes: number
  reason?: string
  status?: CompactionRunStatus
}

export interface CompactionDriverOptions {
  askWorker?: (request: WorkerRequest, timeoutMs?: number) => Promise<WorkerReply | null>
  getBudget: () => DocumentIndexStorageBudget
  getSnapshot: () => StorageBudgetSnapshot
  refreshAccounting: () => Promise<StorageBudgetSnapshot>
  isStopped: () => boolean
  isPaused: () => boolean
  isWriteReady?: () => boolean
  getEpoch: () => number
  /** Invalidate the main thread's in-memory ANN state of a space the worker just compacted. */
  invalidateMainAnn?: (spaceId: string) => void
  onOutcome?: (outcome: CompactionCycleOutcome) => void
  /** Vectors / skeletons were released for re-hydration: the caller re-queues them (poll). */
  onReleased?: (release: NonNullable<CompactionCycleOutcome['release']>) => void
  /** ANN rebuilds to dispatch through the admission-guarded host path (manager.triggerAnnSync). */
  onAnnRebuildRequests?: (requests: AnnRebuildRequest[]) => void | Promise<void>
  now?: () => number
}

function resultOf<T extends CompactionWorkerResult>(
  reply: WorkerReply | null,
  kind: T['kind'],
): T | null {
  if (!reply || !('result' in reply)) return null
  const r = reply.result as { kind?: string } | null
  return r && typeof r === 'object' && r.kind === kind ? (r as T) : null
}

export class CompactionDriver {
  private inflight: Promise<CompactionCycleOutcome> | null = null
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  private runSeq = 0
  private backoffUntil = 0
  private makeRoomInflight: Promise<MakeRoomOutcome> | null = null
  private makeRoomCooldownUntil = 0
  private lastOutcome: CompactionCycleOutcome | null = null
  private lastFtsOptimizeAt = 0
  private ftsPending = true
  private lastAnalyzeAt = 0
  private currentRunId: string | null = null
  private starting = false

  constructor(private readonly options: CompactionDriverOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private get stopped(): boolean {
    return this.disposed || this.options.isStopped()
  }

  getLastOutcome(): CompactionCycleOutcome | null {
    return this.lastOutcome
  }

  isRunning(): boolean {
    return this.inflight !== null
  }

  /** Called by the scheduler whenever a fresh budget snapshot exists: arms a pressure run when one is due. */
  onSnapshot(snapshot: StorageBudgetSnapshot): void {
    if (this.stopped || !this.options.askWorker || this.timer || this.inflight || this.starting)
      return
    const target = compactionTarget(snapshot)
    if (target.urgency === 'none') return
    if (this.now() < this.backoffUntil) {
      this.schedule(Math.max(NORMAL_START_DELAY_MS, this.backoffUntil - this.now()))
      return
    }
    this.schedule(target.urgency === 'urgent' ? 250 : NORMAL_START_DELAY_MS)
  }

  schedule(delayMs: number): void {
    if (this.stopped || this.timer || !this.options.askWorker) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        void this.runScheduled()
      },
      Math.max(0, delayMs),
    )
    this.timer.unref?.()
  }

  private async runScheduled(): Promise<void> {
    if (this.stopped) return
    if (this.options.isPaused() || (this.options.isWriteReady && !this.options.isWriteReady())) {
      // gate closed (paused / awaiting the budget ACK): do not spend a measurement per snapshot until it can run
      this.backoffUntil = this.now() + RETRY_AFTER_BUSY_MS
      this.schedule(RETRY_AFTER_BUSY_MS)
      return
    }
    this.starting = true // the refresh below produces a snapshot; it must not arm a second timer
    try {
      const snapshot = await this.options.refreshAccounting()
      if (this.stopped) return
      // pressure is gone (another cycle compacted meanwhile): the periodic cycle owns the release-only pass
      if (compactionTarget(snapshot).urgency === 'none') return
      this.starting = false
      await this.runCycle(snapshot, 'pressure')
    } catch {
      // the next snapshot / periodic cycle re-arms
    } finally {
      this.starting = false
    }
  }

  /** One compaction decision + worker round trip. Skips (never queues) when another run is in flight. */
  runCycle(
    snapshot: StorageBudgetSnapshot,
    reason: CompactionCycleOutcome['reason'],
  ): Promise<CompactionCycleOutcome> {
    const skip = (why: string): Promise<CompactionCycleOutcome> =>
      Promise.resolve(this.skipped(reason, why, compactionTarget(snapshot).urgency))
    if (this.stopped) return skip('stopped')
    if (!this.options.askWorker) return skip('no-worker')
    if (this.options.isPaused()) return skip('paused')
    if (this.options.isWriteReady && !this.options.isWriteReady()) return skip('write-gate-closed')
    if (this.inflight) return skip('already-running')
    const run = this.execute(snapshot, reason).finally(() => {
      if (this.inflight === run) this.inflight = null
    })
    this.inflight = run
    return run
  }

  private skipped(
    reason: CompactionCycleOutcome['reason'],
    why: string,
    urgency: CompactionUrgency,
  ): CompactionCycleOutcome {
    return {
      at: this.now(),
      reason,
      urgency,
      status: 'skipped',
      skippedReason: why,
      bytesBefore: 0,
      bytesAfter: 0,
      reclaimedBytes: 0,
      belowSoftQuota: false,
      report: null,
      annRebuildRequests: 0,
    }
  }

  private async execute(
    snapshot: StorageBudgetSnapshot,
    reason: CompactionCycleOutcome['reason'],
  ): Promise<CompactionCycleOutcome> {
    const askWorker = this.options.askWorker!
    const budget = this.options.getBudget()
    const target = compactionTarget(snapshot)
    const epoch = this.options.getEpoch()
    const runId = `ret:${epoch}:${++this.runSeq}:${this.now()}`
    this.currentRunId = runId
    const used = snapshot.totalManagedBytes ?? snapshot.databaseBytes
    const reply = await askWorker(
      {
        type: 'run-retention',
        runId,
        epoch,
        ...(budget.version !== undefined ? { configVersion: budget.version } : {}),
        urgency: target.urgency,
        reclaimToFloorBytes: target.reclaimToFloorBytes,
        reclaimToSoftBytes: target.reclaimToSoftBytes,
        usage: {
          usedBytes: used,
          limitState: snapshot.limitState,
          isDegraded: snapshot.isDegraded,
          measurementStatus: snapshot.measurementStatus,
        },
      },
      COMPACTION_ASK_TIMEOUT_MS,
    )
    if (this.currentRunId === runId) this.currentRunId = null
    const result = resultOf<RetentionWorkerResult>(reply, 'run-retention')
    // Stale-reply safety: dispose/close bumped the epoch, or the reply belongs to another run.
    if (
      this.stopped ||
      epoch !== this.options.getEpoch() ||
      (result && (result.runId !== runId || (result.epoch !== undefined && result.epoch !== epoch)))
    ) {
      return this.skipped(reason, 'stale-reply', target.urgency)
    }
    if (!result) {
      // No usable report. A null reply is a timeout / worker restart: tell a possibly still-running worker to stop and
      // back off. A reply without a matching report is a worker that does not know the request: just back off.
      if (reply === null)
        void askWorker({ type: 'cancel-compaction', runId }, 5_000).catch(() => null)
      this.backoffUntil = this.now() + RETRY_AFTER_BUSY_MS * 6
      const why = reply && 'error' in reply ? String(reply.error) : reply ? 'no-report' : 'no-reply'
      const out = this.skipped(reason, why, target.urgency)
      this.lastOutcome = reply === null ? { ...out, status: 'timeout' } : out
      return this.lastOutcome
    }

    let after = snapshot
    try {
      after = await this.options.refreshAccounting()
    } catch {
      // keep the worker-measured numbers below
    }
    if (this.stopped || epoch !== this.options.getEpoch())
      return this.skipped(reason, 'stale-reply', target.urgency)

    for (const s of result.affectedAnnSpaces) this.options.invalidateMainAnn?.(s.spaceId)
    const reclaimed = Math.max(0, result.bytesBefore - result.bytesAfter)
    const outcome: CompactionCycleOutcome = {
      at: this.now(),
      reason,
      urgency: target.urgency,
      status: result.status,
      runId,
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
      reclaimedBytes: reclaimed,
      belowSoftQuota: result.belowSoftQuota,
      report: result.report,
      release: result.release,
      annRebuildRequests: result.annRequests.length,
      ...(result.error ? { error: result.error } : {}),
    }
    this.lastOutcome = outcome
    try {
      this.options.onOutcome?.(outcome)
    } catch {
      // diagnostics only
    }
    const rel = result.release
    if (rel.vectorDocuments + rel.skeletonDocuments > 0) {
      try {
        this.options.onReleased?.(rel)
      } catch {
        // the next poll picks the released documents up anyway
      }
    }
    if (result.annRequests.length > 0 && this.options.onAnnRebuildRequests) {
      Promise.resolve(this.options.onAnnRebuildRequests(result.annRequests)).catch(() => undefined)
    }
    this.planFollowUp(after, result, reclaimed)
    return outcome
  }

  private planFollowUp(
    after: StorageBudgetSnapshot,
    result: RetentionWorkerResult,
    reclaimed: number,
  ): void {
    const next = compactionTarget(after)
    if (next.urgency === 'none') {
      this.backoffUntil = 0
      return
    }
    const progressed = reclaimed >= PROGRESS_MIN_BYTES
    if (
      result.status === 'busy' ||
      result.status === 'stale-config' ||
      result.status === 'cancelled' ||
      result.status === 'timeout'
    ) {
      this.backoffUntil = this.now() + RETRY_AFTER_BUSY_MS
      this.schedule(RETRY_AFTER_BUSY_MS)
      return
    }
    if (next.urgency === 'urgent') {
      if (progressed) {
        this.backoffUntil = 0
        this.schedule(URGENT_REPEAT_MS)
      } else {
        this.backoffUntil = this.now() + URGENT_NO_PROGRESS_BACKOFF_MS
        this.schedule(URGENT_NO_PROGRESS_BACKOFF_MS)
      }
      return
    }
    // normal pressure: the run already went to the floor or exhausted its candidates; idle back-off
    this.backoffUntil =
      progressed && result.report?.targetReached === false
        ? 0
        : this.now() + NORMAL_NO_PROGRESS_BACKOFF_MS
  }

  // ---------------------------------------------------------------------------------------------------------
  // Admission by displacement
  // ---------------------------------------------------------------------------------------------------------

  /**
   * An admission is about to be refused for quota while usage >= the soft quota: free `neededBytes` of the lowest
   * value content in the worker, then tell the caller to retry ONCE. Single flight (concurrent refusals share one
   * displacement), cooldown after a displacement that could not make room, never grows the index.
   */
  makeRoom(request: MakeRoomRequest): Promise<MakeRoomOutcome> {
    const no = (reason: string): Promise<MakeRoomOutcome> =>
      Promise.resolve({ attempted: false, retry: false, freedBytes: 0, reason })
    if (this.stopped || !this.options.askWorker) return no('unavailable')
    if (this.options.isWriteReady && !this.options.isWriteReady()) return no('write-gate-closed')
    if (this.makeRoomInflight) return this.makeRoomInflight
    const snap = this.options.getSnapshot()
    const budget = this.options.getBudget()
    if (snap.isDegraded || snap.measurementStatus === 'unknown') return no('accounting-unknown')
    const used = snap.totalManagedBytes ?? snap.databaseBytes
    if (
      !request.admissionDenied &&
      request.reason !== 'name-metadata' &&
      used + request.neededBytes < contentWriteCapBytes(budget)
    )
      return no('below-content-cap')
    if (this.now() < this.makeRoomCooldownUntil) return no('cooldown')
    const flight = this.doMakeRoom(request).finally(() => {
      if (this.makeRoomInflight === flight) this.makeRoomInflight = null
    })
    this.makeRoomInflight = flight
    return flight
  }

  private async doMakeRoom(request: MakeRoomRequest): Promise<MakeRoomOutcome> {
    const askWorker = this.options.askWorker!
    const epoch = this.options.getEpoch()
    const budget = this.options.getBudget()
    const usedNow = (s: StorageBudgetSnapshot): number => s.totalManagedBytes ?? s.databaseBytes
    const usedAtStart = usedNow(this.options.getSnapshot())
    // A retention run is already freeing space: wait for it instead of starting a competing one.
    if (this.inflight) {
      await Promise.race([
        this.inflight.catch(() => undefined),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, MAKE_ROOM_WAIT_FOR_RETENTION_MS)
          t.unref?.()
        }),
      ])
      if (this.stopped || epoch !== this.options.getEpoch())
        return { attempted: false, retry: false, freedBytes: 0, reason: 'stale' }
    }
    let snap = this.options.getSnapshot()
    try {
      snap = await this.options.refreshAccounting()
    } catch {
      // use the last snapshot
    }
    if (request.reason === 'name-metadata') {
      const before = snap.nameMetadataBytes
      const runId = `names:${epoch}:${++this.runSeq}:${this.now()}`
      const reply = await askWorker(
        {
          type: 'optimize-fts',
          runId,
          epoch,
          ...(budget.version !== undefined ? { configVersion: budget.version } : {}),
          maxPages: 512,
          budgetMs: 5_000,
        },
        60_000,
      )
      const result = resultOf<OptimizeFtsWorkerResult>(reply, 'optimize-fts')
      if (
        this.stopped ||
        epoch !== this.options.getEpoch() ||
        result?.runId !== runId ||
        result.status !== 'completed'
      ) {
        this.makeRoomCooldownUntil = this.now() + MAKE_ROOM_COOLDOWN_MS
        return {
          attempted: true,
          retry: false,
          freedBytes: 0,
          reason: 'name-compaction-incomplete',
        }
      }
      const after = await this.options.refreshAccounting()
      const freed =
        before !== undefined && after.nameMetadataBytes !== undefined && !after.isDegraded
          ? Math.max(0, before - after.nameMetadataBytes)
          : 0
      const retry = freed >= request.neededBytes
      if (!retry) this.makeRoomCooldownUntil = this.now() + MAKE_ROOM_COOLDOWN_MS
      return {
        attempted: true,
        retry,
        freedBytes: freed,
        ...(retry ? {} : { reason: 'name-metadata-full' }),
      }
    }
    const freedMeanwhile = Math.max(0, usedAtStart - usedNow(snap))
    if (freedMeanwhile >= request.neededBytes)
      return {
        attempted: false,
        retry: true,
        freedBytes: freedMeanwhile,
        reason: 'freed-by-retention',
      }
    const margin = Math.min(
      Math.floor(budget.maxDatabaseBytes * DISPLACEMENT_MARGIN_RATIO),
      DISPLACEMENT_MARGIN_MAX_BYTES,
    )
    const runId = `free:${epoch}:${++this.runSeq}:${this.now()}`
    const reply = await askWorker(
      {
        type: 'free-space',
        runId,
        epoch,
        ...(budget.version !== undefined ? { configVersion: budget.version } : {}),
        neededBytes: Math.max(1, request.neededBytes) + margin,
        ...(request.importance ? { incomingImportance: request.importance } : {}),
      },
      FREE_SPACE_ASK_TIMEOUT_MS,
    )
    const result = resultOf<FreeSpaceWorkerResult>(reply, 'free-space')
    if (this.stopped || epoch !== this.options.getEpoch() || (result && result.runId !== runId)) {
      return { attempted: true, retry: false, freedBytes: 0, reason: 'stale-reply' }
    }
    if (!result || result.status === 'busy' || result.status === 'stale-config') {
      this.makeRoomCooldownUntil =
        this.now() + (result ? RETRY_AFTER_BUSY_MS : MAKE_ROOM_COOLDOWN_MS)
      return {
        attempted: true,
        retry: false,
        freedBytes: 0,
        reason: result?.status ?? 'no-reply',
        ...(result ? { status: result.status } : {}),
      }
    }
    try {
      await this.options.refreshAccounting()
    } catch {
      // admission re-measures anyway
    }
    for (const s of result.affectedAnnSpaces) this.options.invalidateMainAnn?.(s.spaceId)
    if (result.annRequests.length > 0 && this.options.onAnnRebuildRequests) {
      Promise.resolve(this.options.onAnnRebuildRequests(result.annRequests)).catch(() => undefined)
    }
    const retry = result.freedBytes >= request.neededBytes
    // Nothing (more) evictable: do not hammer the worker for every refused file.
    if (!retry) this.makeRoomCooldownUntil = this.now() + MAKE_ROOM_COOLDOWN_MS
    return {
      attempted: true,
      retry,
      freedBytes: result.freedBytes,
      status: result.status,
      ...(retry ? {} : { reason: 'insufficient' }),
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Idle work
  // ---------------------------------------------------------------------------------------------------------

  /** Idle FTS segment optimisation (composes with the scheduler's merge step, runs in the worker). */
  async optimizeFtsIfIdle(
    snapshot: StorageBudgetSnapshot,
  ): Promise<OptimizeFtsWorkerResult | null> {
    if (this.stopped || !this.options.askWorker || this.inflight || this.options.isPaused())
      return null
    if (this.options.isWriteReady && !this.options.isWriteReady()) return null
    if (compactionTarget(snapshot).urgency === 'urgent') return null
    const interval = this.ftsPending ? FTS_OPTIMIZE_PENDING_INTERVAL_MS : FTS_OPTIMIZE_INTERVAL_MS
    if (this.now() - this.lastFtsOptimizeAt < interval) return null
    this.lastFtsOptimizeAt = this.now()
    const epoch = this.options.getEpoch()
    const budget = this.options.getBudget()
    const runId = `fts:${epoch}:${++this.runSeq}:${this.now()}`
    const reply = await this.options.askWorker(
      {
        type: 'optimize-fts',
        runId,
        epoch,
        ...(budget.version !== undefined ? { configVersion: budget.version } : {}),
      },
      60_000,
    )
    const result = resultOf<OptimizeFtsWorkerResult>(reply, 'optimize-fts')
    if (this.stopped || epoch !== this.options.getEpoch() || !result || result.runId !== runId)
      return null
    this.ftsPending = (result.result?.pending.length ?? 0) > 0
    return result
  }

  /** Keeps the redundancy analysis current at moderate usage so a later displacement is a pure shrink. */
  async analyzeIfIdle(
    snapshot: StorageBudgetSnapshot,
  ): Promise<RedundancyAnalyzeWorkerResult | null> {
    if (this.stopped || !this.options.askWorker || this.inflight || this.options.isPaused())
      return null
    if (this.options.isWriteReady && !this.options.isWriteReady()) return null
    const budget = this.options.getBudget()
    const used = snapshot.totalManagedBytes ?? snapshot.databaseBytes
    if (!(used >= budget.maxDatabaseBytes * 0.7) || snapshot.isDegraded) return null
    if (this.now() - this.lastAnalyzeAt < ANALYZE_INTERVAL_MS) return null
    this.lastAnalyzeAt = this.now()
    const epoch = this.options.getEpoch()
    const runId = `ana:${epoch}:${++this.runSeq}:${this.now()}`
    const reply = await this.options.askWorker(
      {
        type: 'redundancy-analyze',
        runId,
        epoch,
        ...(budget.version !== undefined ? { configVersion: budget.version } : {}),
      },
      60_000,
    )
    const result = resultOf<RedundancyAnalyzeWorkerResult>(reply, 'redundancy-analyze')
    if (this.stopped || epoch !== this.options.getEpoch() || !result || result.runId !== runId)
      return null
    return result
  }

  /** Cancels the in-flight worker run (pause / close). Idempotent; the worker also stops on its own deadline. */
  cancelInFlight(): void {
    const runId = this.currentRunId
    if (!runId || !this.options.askWorker) return
    void this.options.askWorker({ type: 'cancel-compaction', runId }, 5_000).catch(() => null)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.backoffUntil = 0
  }
}
