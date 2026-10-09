import type { AnnRebuildRequest } from './ann-rebuild-after-compaction'
import type { CacheRetentionReport } from './cache-retention-policy'
import type { DisplacementResult } from './redundancy-compaction'
import type { FtsOptimizeResult } from './storage-optimizer'
import type { AnnSpaceDirtySpec } from '../storage/repositories/cache-retention-repository'
import type { ImportanceClass } from './value-density'
import type { CompactionUrgency } from '../storage-budget'

/**
 * Wire protocol of the storage-compaction lane that runs inside the indexing worker (never on the Electron main
 * thread). Everything crossing the boundary is plain JSON. The main thread only decides WHEN to compact
 * (maintenance-scheduler.ts); the worker does all database work.
 *
 * Contract shared by every request:
 * - `runId`    unique per request; the reply echoes it, the scheduler ignores a reply whose runId/epoch is stale;
 * - `epoch`    the scheduler epoch at send time (echoed back; a bumped epoch means "dispose/close happened");
 * - `configVersion` the storage-budget version the main thread believes is applied. The worker runs only when it
 *   is its own applied version (the set-storage-budget handshake), otherwise it answers `stale-config`.
 * - single flight: while one lane request runs, another answers `busy` (cancel is the only out-of-band message).
 */
/** Headroom a displacement frees beyond the strict shortfall (limits per-document displacement churn). */
export const DISPLACEMENT_MARGIN_RATIO = 0.02
export const DISPLACEMENT_MARGIN_MAX_BYTES = 64 * 1024 * 1024

export interface CompactionRequestBase {
  runId: string
  epoch?: number
  configVersion?: number
  /** Hard wall-clock limit of the run inside the worker (default 10 min). */
  deadlineMs?: number
}

/** Usage snapshot the main thread already measured; used by the release hooks of an idle cycle. */
export interface CompactionUsageHint {
  usedBytes: number
  limitState: string
  isDegraded?: boolean
  measurementStatus?: string
}

export type { CompactionUrgency }

export type CompactionWorkerRequest =
  | (CompactionRequestBase & {
      type: 'run-retention'
      urgency: CompactionUrgency
      /** Main-thread view of the bytes to reclaim (compactionTarget); informational + sanity for the report. */
      reclaimToFloorBytes?: number
      reclaimToSoftBytes?: number
      usage?: CompactionUsageHint
      /** Run the policy even below the 90% trigger (tests / manual). */
      force?: boolean
      /** Clock for the age buckets (tests). */
      nowMs?: number
    })
  | (CompactionRequestBase & {
      type: 'free-space'
      /** Bytes the incoming document needs (already includes any margin the caller wants). */
      neededBytes: number
      incomingImportance?: ImportanceClass
      nowMs?: number
    })
  | (CompactionRequestBase & { type: 'optimize-fts'; budgetMs?: number; maxPages?: number })
  | (CompactionRequestBase & { type: 'redundancy-analyze'; maxRounds?: number })
  | { type: 'cancel-compaction'; runId?: string }

export type CompactionRunStatus =
  | 'completed'
  | 'not-needed'
  | 'busy'
  | 'stale-config'
  | 'cancelled'
  | 'timeout'
  | 'error'

export interface CompactionResultBase {
  runId: string
  epoch?: number
  status: CompactionRunStatus
  durationMs: number
  error?: string
}

export interface RetentionWorkerResult extends CompactionResultBase {
  kind: 'run-retention'
  urgency: CompactionUrgency
  /** Null when only the release hooks ran (nothing to evict) or the run did not start. */
  report: CacheRetentionReport | null
  bytesBefore: number
  bytesAfter: number
  /** True when the run ended with usage below the soft quota (the grace zone is over). */
  belowSoftQuota: boolean
  release: {
    vectorDocuments: number
    vectorChunks: number
    skeletonDocuments: number
    skeletonEstimatedBytes: number
  }
  affectedAnnSpaces: AnnSpaceDirtySpec[]
  /** ANN rebuilds the main thread should dispatch through its admission-guarded path. */
  annRequests: AnnRebuildRequest[]
}

export interface FreeSpaceWorkerResult extends CompactionResultBase {
  kind: 'free-space'
  displacement: DisplacementResult | null
  /** Second stage (age policy: archive / non-fresh normal documents) when redundancy alone was not enough. */
  agedStage: CacheRetentionReport | null
  neededBytes: number
  freedBytes: number
  usedBefore: number
  usedAfter: number
  /** usedAfter + neededBytes <= hard cap. */
  fitsHardCap: boolean
  affectedAnnSpaces: AnnSpaceDirtySpec[]
  annRequests: AnnRebuildRequest[]
}

export interface OptimizeFtsWorkerResult extends CompactionResultBase {
  kind: 'optimize-fts'
  result: FtsOptimizeResult | null
}

export interface RedundancyAnalyzeWorkerResult extends CompactionResultBase {
  kind: 'redundancy-analyze'
  complete: boolean
  documentsAnalyzed: number
}

export type CompactionWorkerResult =
  | RetentionWorkerResult
  | FreeSpaceWorkerResult
  | OptimizeFtsWorkerResult
  | RedundancyAnalyzeWorkerResult

export function isCompactionRequest(request: { type?: string }): request is CompactionWorkerRequest {
  return (
    request.type === 'run-retention' ||
    request.type === 'free-space' ||
    request.type === 'optimize-fts' ||
    request.type === 'redundancy-analyze' ||
    request.type === 'cancel-compaction'
  )
}
