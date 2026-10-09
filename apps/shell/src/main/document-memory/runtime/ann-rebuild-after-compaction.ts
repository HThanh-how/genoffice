import type { DatabaseSync } from 'node:sqlite'
import { ANN_MIN_VECTORS } from '../ann-index'
import type { AnnSpaceDirtySpec } from '../storage/repositories/cache-retention-repository'
import { estimateAnnIndexBytes } from './ann-write-budget'
import {
  AnnHostAdmissionCoordinator,
  type AnnRebuildExecutionResult,
  type DispatchAnnRebuildOptions,
} from './ann-host-admission'

/**
 * ANN follow-up of a retention/compaction run (audit defect D6: nobody rebuilt the ANN index after bulk
 * eviction, so semantic search stayed on the exact scan and a stale `ann-*.usearch` kept counting against quota).
 *
 * Two small, independent steps so the scheduler stays in control of WHEN to spend CPU/disk:
 *   1. `scheduleAnnRebuildAfterCompaction` - metadata only (SQLite), cheap, no native code, idempotent.
 *   2. `dispatchAnnRebuildRequests`        - hands each request to the existing admission-guarded host path.
 *
 * Generation contract: the retention batches (`evictEmbeddingsBatch` / `evictCacheContentBatch`) already
 * bump `ann_indexes.desired_generation` by one inside the same transaction that deletes the vectors and report
 * the resulting value in `AnnSpaceDirtySpec.desiredGeneration`. This helper therefore NEVER adds another
 * bump: it only raises the row to the reported generation when the row is missing or behind (monotonic `max`,
 * so repeated calls and retries are no-ops). A rebuild permit is fenced to the live desired generation, so an
 * extra bump would invalidate the permit the host is about to issue (same class as the earlier
 * markAnnDirtyAfterFailedRebuild bug).
 */

export interface AnnCompactionStore {
  readonly rawDb: DatabaseSync
  getAnnCanonicalMeta(spaceId: string): { canonicalCount: number; desiredGeneration: number; currentGeneration: number }
}

export type AnnRebuildSkipReason =
  | 'unknown-space'
  | 'invalid-estimate'
  | 'below-ann-min-vectors'
  | 'already-current'

/** Everything `AnnHostAdmissionCoordinator.dispatchAnnRebuild` needs besides the host wiring. */
export interface AnnRebuildRequest {
  spaceId: string
  dimensions: number
  vectorCount: number
  /** desired_generation the rebuild is fenced to (becomes the permit's `generation`). */
  targetGeneration: number
  /** Conservative serialized size; use it to pre-gate on free disk / quota before dispatching. */
  estimatedBytes: number
  /** true when the space has no canonical vectors left: the rebuild only deletes the stale ANN file. */
  clearsStaleIndex: boolean
}

export interface AnnRebuildSkip {
  spaceId: string
  reason: AnnRebuildSkipReason
}

export interface ScheduleAnnRebuildResult {
  requests: AnnRebuildRequest[]
  skipped: AnnRebuildSkip[]
  /** Spaces this call had to mark dirty itself (row missing or behind the reported generation). */
  markedDirty: string[]
  /** Spaces the retention transaction had already marked dirty at (or beyond) the reported generation. */
  alreadyDirty: string[]
}

export interface ScheduleAnnRebuildOptions {
  /** Below this many canonical vectors search uses the exact scan anyway (default ANN_MIN_VECTORS). */
  minVectors?: number
}

interface AnnRow {
  generation: number
  desired_generation: number
  indexed_count: number
  file_path: string | null
  state: string
}

/** Collapse duplicate specs per space, keeping the highest reported generation. */
function collapse(spaces: readonly AnnSpaceDirtySpec[]): Map<string, number> {
  const bySpace = new Map<string, number>()
  for (const s of spaces) {
    if (!s || typeof s.spaceId !== 'string' || !s.spaceId) continue
    const gen = Number.isSafeInteger(s.desiredGeneration) && s.desiredGeneration > 0 ? s.desiredGeneration : 1
    bySpace.set(s.spaceId, Math.max(bySpace.get(s.spaceId) ?? 0, gen))
  }
  return bySpace
}

export function scheduleAnnRebuildAfterCompaction(
  store: AnnCompactionStore,
  affectedSpaces: readonly AnnSpaceDirtySpec[],
  options: ScheduleAnnRebuildOptions = {},
): ScheduleAnnRebuildResult {
  const db = store.rawDb
  const minVectors = options.minVectors ?? ANN_MIN_VECTORS
  const result: ScheduleAnnRebuildResult = { requests: [], skipped: [], markedDirty: [], alreadyDirty: [] }

  const readRow = db.prepare(
    'SELECT generation, desired_generation, indexed_count, file_path, state FROM ann_indexes WHERE space_id = ?',
  )
  const readDims = db.prepare('SELECT dimensions FROM embedding_spaces WHERE id = ?')
  // Monotonic raise: only writes when the row is behind the generation the retention batch reported.
  const raise = db.prepare(
    `INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
     VALUES (?, 0, ?, 0, 'dirty', unixepoch())
     ON CONFLICT(space_id) DO UPDATE SET
       desired_generation = excluded.desired_generation,
       state = 'dirty',
       updated_at = unixepoch()
     WHERE ann_indexes.desired_generation < excluded.desired_generation`,
  )

  for (const [spaceId, reportedGeneration] of collapse(affectedSpaces)) {
    const dims = readDims.get(spaceId) as { dimensions?: number } | undefined
    if (!dims || !Number.isSafeInteger(dims.dimensions) || (dims.dimensions ?? 0) <= 0) {
      result.skipped.push({ spaceId, reason: 'unknown-space' })
      continue
    }

    const before = readRow.get(spaceId) as AnnRow | undefined
    if (!before || before.desired_generation < reportedGeneration) {
      raise.run(spaceId, reportedGeneration)
      result.markedDirty.push(spaceId)
    } else if (before.state === 'ready' && before.generation >= before.desired_generation) {
      // A rebuild at/after the compaction generation already completed (e.g. a retried call).
      result.skipped.push({ spaceId, reason: 'already-current' })
      continue
    } else {
      result.alreadyDirty.push(spaceId)
    }

    const meta = store.getAnnCanonicalMeta(spaceId)
    const row = readRow.get(spaceId) as AnnRow | undefined
    const hasStaleIndex = Boolean(row && (row.file_path || row.indexed_count > 0))
    if (meta.canonicalCount < minVectors && !hasStaleIndex) {
      result.skipped.push({ spaceId, reason: 'below-ann-min-vectors' })
      continue
    }
    const estimatedBytes = estimateAnnIndexBytes(meta.canonicalCount, dims.dimensions!)
    if (estimatedBytes <= 0) {
      result.skipped.push({ spaceId, reason: 'invalid-estimate' })
      continue
    }
    result.requests.push({
      spaceId,
      dimensions: dims.dimensions!,
      vectorCount: meta.canonicalCount,
      targetGeneration: meta.desiredGeneration,
      estimatedBytes,
      clearsStaleIndex: meta.canonicalCount === 0,
    })
  }
  return result
}

export type AnnDispatchContext = Pick<
  DispatchAnnRebuildOptions,
  'admission' | 'maintScheduler' | 'budgetCoord' | 'askWorker' | 'workerTimeoutMs' | 'headroomBytes' | 'isStopped'
>

export interface AnnDispatchOutcome extends AnnRebuildExecutionResult {
  spaceId: string
  /** Request actually dispatched (dimensions/count/fence refreshed from live metadata). */
  request?: AnnRebuildRequest
  dispatched: boolean
}

export interface DispatchAnnRebuildRequestsOptions {
  shouldContinue?: () => boolean
  /** Injection point (tests / wrappers). Default: AnnHostAdmissionCoordinator.dispatchAnnRebuild. */
  dispatch?: (options: DispatchAnnRebuildOptions) => Promise<AnnRebuildExecutionResult>
}

/**
 * Dispatch requests one at a time through the existing host-admission path (host permit in the central
 * StorageAdmissionController, fresh accounting, config version, generation fence, worker-side validation).
 * Requests are refreshed against live metadata right before dispatch: if mutations advanced the fence since
 * scheduling, the newer generation/count is used instead of sending a permit the worker would reject.
 * Failures never mark anything dirty here (rebuildAnnIndex already fail-closes); the next cycle simply retries.
 */
export async function dispatchAnnRebuildRequests(
  store: AnnCompactionStore,
  requests: readonly AnnRebuildRequest[],
  context: AnnDispatchContext,
  options: DispatchAnnRebuildRequestsOptions = {},
): Promise<AnnDispatchOutcome[]> {
  const dispatch = options.dispatch ?? ((o) => AnnHostAdmissionCoordinator.dispatchAnnRebuild(o))
  const outcomes: AnnDispatchOutcome[] = []
  for (const req of requests) {
    if (options.shouldContinue && !options.shouldContinue()) break
    if (context.isStopped?.()) break
    const meta = store.getAnnCanonicalMeta(req.spaceId)
    const live: AnnRebuildRequest = {
      ...req,
      vectorCount: meta.canonicalCount,
      targetGeneration: meta.desiredGeneration,
      estimatedBytes: Math.max(estimateAnnIndexBytes(meta.canonicalCount, req.dimensions), 0),
      clearsStaleIndex: meta.canonicalCount === 0,
    }
    if (live.estimatedBytes <= 0) {
      outcomes.push({ spaceId: req.spaceId, ok: false, count: 0, error: 'invalid-estimate', dispatched: false })
      continue
    }
    const res = await dispatch({
      ...context,
      spaceId: live.spaceId,
      dimensions: live.dimensions,
      vectorCount: live.vectorCount,
      targetGeneration: live.targetGeneration,
    })
    outcomes.push({ ...res, spaceId: live.spaceId, request: live, dispatched: true })
  }
  return outcomes
}
