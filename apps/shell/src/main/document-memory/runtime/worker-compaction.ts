import type { DatabaseSync } from 'node:sqlite'
import { getStorageFreelistStats } from '../storage-gc'
import {
  calculateStorageLimitState,
  hardCapBytes,
  safeGetFileSize,
  type DocumentIndexStorageBudget,
} from '../storage-budget'
import type { AnnSpaceDirtySpec } from '../storage/repositories/cache-retention-repository'
import { scheduleAnnRebuildAfterCompaction, type AnnRebuildRequest } from './ann-rebuild-after-compaction'
import { executeCacheRetentionPolicy, type CacheRetentionReport } from './cache-retention-policy'
import { analyzeRedundancyFully } from './redundancy-analyzer'
import { freeSpaceForImportantDoc } from './redundancy-compaction'
import { collectStorageAccounting } from './storage-accounting'
import { optimizeFts } from './storage-optimizer'
import { releaseEvictedVectorsIfRoom } from './vector-eviction-release'
import { releaseSkeletonsIfRoom } from './skeleton-rehydration'
import { ensureRedundancySchema } from '../storage/redundancy-schema'
import { resolveAgePolicy } from './value-density'
import type {
  CompactionResultBase,
  CompactionRunStatus,
  CompactionWorkerRequest,
  CompactionWorkerResult,
  FreeSpaceWorkerResult,
  OptimizeFtsWorkerResult,
  RedundancyAnalyzeWorkerResult,
  RetentionWorkerResult,
} from './worker-compaction-types'

/**
 * Worker-side executor of the storage-compaction lane (see worker-compaction-types.ts for the protocol).
 *
 * Why here: retention, redundancy compaction, FTS optimisation and the release hooks are bounded-batch SQLite
 * loops. On the Electron main thread each batch blocks the UI (the audit measured ~0.6 s per batch and tens of
 * seconds for the old orphan GC). In the indexing worker they only share the worker's event loop, are yielded
 * between batches (duty-cycle aware), can be cancelled out-of-band and never touch the UI thread.
 *
 * Invariants:
 * - one run at a time (`busy` otherwise); cancel is the only message handled while a run is active;
 * - a run starts only when the main thread's `configVersion` equals the version this worker applied through the
 *   set-storage-budget handshake, and stops (`cancelled`) if the applied version changes mid-run;
 * - nothing here reads or writes a user's original file; compaction only shrinks the index;
 * - the module is database-handle driven (no globals besides the single-flight state) so it is unit-testable
 *   with a real SQLite file and an in-process "worker".
 */

export const DEFAULT_COMPACTION_DEADLINE_MS = 10 * 60_000
/** Batches stay small in the worker so the main thread's own writes never wait long on the writer lock. */
export const COMPACTION_BATCH_DOCUMENTS = 10

export interface CompactionStoreLike {
  readonly rawDb: DatabaseSync
  readonly dbPath: string
  mergeFtsStep(pages?: number): boolean
  invalidateAnnInMemory(spaceId: string): void
  getAnnCanonicalMeta(spaceId: string): { canonicalCount: number; desiredGeneration: number; currentGeneration: number }
}

export interface CompactionWorkerContext {
  store: CompactionStoreLike
  getBudget(): DocumentIndexStorageBudget
  /** Version applied through the set-storage-budget handshake; null before the first handshake. */
  getConfigVersion(): number | null
  /** Cooperative yield between batches. Urgent runs skip the duty-cycle cool-down. */
  yieldNow(urgent: boolean): Promise<void>
  now?: () => number
}

interface ActiveRun {
  runId: string
  type: CompactionWorkerRequest['type']
  cancelled: boolean
  startedAt: number
}

let active: ActiveRun | null = null

export function isCompactionActive(): boolean {
  return active !== null
}

/** Out-of-band cancel (pause, close, budget change). Returns whether a matching run was active. */
export function cancelCompaction(runId?: string): boolean {
  if (!active || (runId !== undefined && active.runId !== runId)) return false
  active.cancelled = true
  return true
}

/** Test hook: forget a stuck single-flight record (a previous test crashed mid-run). */
export function resetCompactionLaneForTests(): void {
  active = null
}

/**
 * Physical bytes the quota counts (db + wal + shm + ann + ocr + temp + backups). The full inventory runs once per
 * run; after every batch only the three SQLite files are re-stat'ed (cheap, exact after vacuum + wal truncate).
 */
export function createPhysicalMeter(store: CompactionStoreLike): () => number {
  const db = store.rawDb
  let annIndexesMeta: Array<{ space_id: string; file_path: string | null }> | undefined
  try {
    annIndexesMeta = db.prepare('SELECT space_id, file_path FROM ann_indexes').all() as typeof annIndexesMeta
  } catch {
    annIndexesMeta = undefined
  }
  let reusableFreelistBytes: number | undefined
  try {
    reusableFreelistBytes = getStorageFreelistStats(db).reclaimableBytes
  } catch {
    reusableFreelistBytes = undefined
  }
  const base = collectStorageAccounting({ dbPath: store.dbPath, annIndexesMeta, reusableFreelistBytes })
  if (base.isDegraded) throw new Error('Storage accounting degraded; retention stopped')
  const other = Math.max(0, base.totalManagedBytes - base.databaseBytes)
  const dbPath = store.dbPath
  return () => other + safeGetFileSize(dbPath) + safeGetFileSize(`${dbPath}-wal`) + safeGetFileSize(`${dbPath}-shm`)
}

function baseResult(run: ActiveRun, req: { epoch?: number }, status: CompactionRunStatus, now: () => number): CompactionResultBase {
  return { runId: run.runId, ...(req.epoch !== undefined ? { epoch: req.epoch } : {}), status, durationMs: now() - run.startedAt }
}

function refusal(
  req: Exclude<CompactionWorkerRequest, { type: 'cancel-compaction' }>,
  status: 'busy' | 'stale-config',
  error: string,
): CompactionWorkerResult {
  const base = { runId: req.runId, ...(req.epoch !== undefined ? { epoch: req.epoch } : {}), status, durationMs: 0, error }
  switch (req.type) {
    case 'run-retention':
      return {
        ...base, kind: 'run-retention', urgency: req.urgency, report: null, bytesBefore: 0, bytesAfter: 0, belowSoftQuota: false,
        release: { vectorDocuments: 0, vectorChunks: 0, skeletonDocuments: 0, skeletonEstimatedBytes: 0 }, affectedAnnSpaces: [], annRequests: [],
      }
    case 'free-space':
      return {
        ...base, kind: 'free-space', displacement: null, agedStage: null, neededBytes: req.neededBytes, freedBytes: 0, usedBefore: 0, usedAfter: 0,
        fitsHardCap: false, affectedAnnSpaces: [], annRequests: [],
      }
    case 'optimize-fts':
      return { ...base, kind: 'optimize-fts', result: null }
    default:
      return { ...base, kind: 'redundancy-analyze', complete: false, documentsAnalyzed: 0 }
  }
}

function mergeSpaces(...lists: Array<AnnSpaceDirtySpec[] | undefined>): AnnSpaceDirtySpec[] {
  const bySpace = new Map<string, number>()
  for (const list of lists) for (const s of list ?? []) bySpace.set(s.spaceId, Math.max(bySpace.get(s.spaceId) ?? 0, s.desiredGeneration))
  return [...bySpace.entries()].map(([spaceId, desiredGeneration]) => ({ spaceId, desiredGeneration }))
}

function annFollowUp(ctx: CompactionWorkerContext, spaces: AnnSpaceDirtySpec[]): AnnRebuildRequest[] {
  if (spaces.length === 0) return []
  try {
    return scheduleAnnRebuildAfterCompaction(ctx.store, spaces).requests
  } catch {
    // metadata only: the next cycle retries, semantic search keeps using the exact scan meanwhile
    return []
  }
}

/** The single entry point the worker calls for every lane request. Never throws. */
export async function handleCompactionRequest(
  ctx: CompactionWorkerContext,
  req: CompactionWorkerRequest,
): Promise<CompactionWorkerResult | { cancelled: boolean }> {
  if (req.type === 'cancel-compaction') return { cancelled: cancelCompaction(req.runId) }
  if (active) return refusal(req, 'busy', `compaction lane busy with ${active.type}`)
  const applied = ctx.getConfigVersion()
  if (req.configVersion !== undefined && applied !== req.configVersion) {
    return refusal(req, 'stale-config', `worker applied budget version ${applied ?? 'none'}, request ${req.configVersion}`)
  }
  const now = ctx.now ?? Date.now
  const run: ActiveRun = { runId: req.runId, type: req.type, cancelled: false, startedAt: now() }
  active = run
  const deadline = run.startedAt + (req.deadlineMs ?? DEFAULT_COMPACTION_DEADLINE_MS)
  const shouldContinue = (): boolean =>
    !run.cancelled && now() < deadline && (req.configVersion === undefined || ctx.getConfigVersion() === req.configVersion)
  const expired = (): boolean => now() >= deadline
  try {
    const finish = (status: CompactionRunStatus): CompactionRunStatus =>
      status === 'completed' && run.cancelled ? 'cancelled' : status === 'completed' && expired() ? 'timeout' : status
    switch (req.type) {
      case 'run-retention':
        return await runRetention(ctx, req, run, shouldContinue, finish)
      case 'free-space':
        return await runFreeSpace(ctx, req, run, shouldContinue, finish)
      case 'optimize-fts':
        return await runOptimizeFts(ctx, req, run, shouldContinue, finish)
      case 'redundancy-analyze':
        return await runAnalyze(ctx, req, run, shouldContinue, finish)
      default:
        return { ...refusal(req, 'busy', ''), status: 'error' as const, error: 'unknown compaction request', durationMs: now() - run.startedAt }
    }
  } catch (err) {
    const failed = refusal(req, 'busy', '')
    return { ...failed, status: 'error' as const, error: err instanceof Error ? err.message : String(err), durationMs: now() - run.startedAt }
  } finally {
    if (active === run) active = null
  }
}

type RetentionReq = Extract<CompactionWorkerRequest, { type: 'run-retention' }>
type Finish = (status: CompactionRunStatus) => CompactionRunStatus

async function runRetention(
  ctx: CompactionWorkerContext,
  req: RetentionReq,
  run: ActiveRun,
  shouldContinue: () => boolean,
  finish: Finish,
): Promise<RetentionWorkerResult> {
  const now = ctx.now ?? Date.now
  const db = ctx.store.rawDb
  const budget = ctx.getBudget()
  const soft = budget.maxDatabaseBytes
  const urgent = req.urgency === 'urgent'
  let report: CacheRetentionReport | null = null
  let bytesBefore = req.usage?.usedBytes ?? 0
  let bytesAfter = bytesBefore
  let error: string | undefined

  if (req.urgency !== 'none' || req.force) {
    report = await executeCacheRetentionPolicy(db, ctx.store.dbPath, soft, {
      force: req.force,
      allowContentEviction: true,
      agePolicy: resolveAgePolicy(budget),
      allowFreshVectorEviction: urgent,
      nowMs: req.nowMs,
      batchSize: COMPACTION_BATCH_DOCUMENTS,
      redundancy: { batchDocuments: 4 },
      yieldHook: () => ctx.yieldNow(urgent),
      shouldContinue,
      settleFtsDeletes: () => settleFtsDeletesNow(db),
      measurePhysicalBytes: createPhysicalMeterLazy(ctx.store),
      onPostCommitAnnInvalidation: (spaces) => {
        for (const s of spaces) ctx.store.invalidateAnnInMemory(s.spaceId)
      },
    })
    bytesBefore = report.bytesBefore
    bytesAfter = report.bytesAfter
    if (report.stoppedReason === 'error') error = report.error
  }

  const affectedAnnSpaces = mergeSpaces(report?.affectedAnnSpaces)
  const annRequests = annFollowUp(ctx, affectedAnnSpaces)

  // Release hooks: only far below the quota (60%), on a fresh measurement, so a release can never re-trigger retention.
  const release = { vectorDocuments: 0, vectorChunks: 0, skeletonDocuments: 0, skeletonEstimatedBytes: 0 }
  const measured = Boolean(report && report.stoppedReason !== 'error' && report.stoppedReason !== 'cancelled' && bytesAfter > 0)
  const usedForRelease = measured ? bytesAfter : req.usage?.usedBytes
  if (shouldContinue() && typeof usedForRelease === 'number' && soft > 0) {
    const usage = {
      limitState: measured ? calculateStorageLimitState(usedForRelease, soft, budget.overshootRatio) : (req.usage?.limitState ?? 'ok'),
      usedBytes: usedForRelease,
      budgetBytes: soft,
      isDegraded: measured ? false : req.usage?.isDegraded,
      measurementStatus: measured ? 'fresh' : req.usage?.measurementStatus,
    }
    try {
      const v = releaseEvictedVectorsIfRoom(db, usage)
      release.vectorDocuments = v.documents
      release.vectorChunks = v.chunks
    } catch {
      // best effort: the marker simply stays
    }
    try {
      const k = releaseSkeletonsIfRoom(db, usage)
      release.skeletonDocuments = k.documents
      release.skeletonEstimatedBytes = k.estimatedBytes
    } catch {
      // best effort: skeletons stay until the next idle cycle
    }
  }

  const status: CompactionRunStatus =
    report?.stoppedReason === 'error'
      ? 'error'
      : report?.stoppedReason === 'cancelled'
        ? 'cancelled'
        : report
          ? finish('completed')
          : release.vectorDocuments + release.skeletonDocuments > 0
            ? finish('completed')
            : 'not-needed'
  return {
    ...baseResult(run, req, status, now),
    ...(error ? { error } : {}),
    kind: 'run-retention',
    urgency: req.urgency,
    report,
    bytesBefore,
    bytesAfter,
    belowSoftQuota: bytesAfter > 0 && bytesAfter < soft,
    release,
    affectedAnnSpaces,
    annRequests,
  }
}

/**
 * FTS5 'optimize' (rewrites the index without the delete markers): the only step that turns deleted chunk text
 * into free pages (see CacheRetentionOptions.settleFtsDeletes). Runs in the worker, one atomic statement.
 */
export function settleFtsDeletesNow(db: DatabaseSync): void {
  db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')")
}

/** The meter is built on first use so a run that never needs a measurement does not pay for the inventory. */
function createPhysicalMeterLazy(store: CompactionStoreLike): () => number {
  let meter: (() => number) | null = null
  return () => {
    meter ??= createPhysicalMeter(store)
    return meter()
  }
}

async function runFreeSpace(
  ctx: CompactionWorkerContext,
  req: Extract<CompactionWorkerRequest, { type: 'free-space' }>,
  run: ActiveRun,
  shouldContinue: () => boolean,
  finish: Finish,
): Promise<FreeSpaceWorkerResult> {
  const now = ctx.now ?? Date.now
  const db = ctx.store.rawDb
  const budget = ctx.getBudget()
  const soft = budget.maxDatabaseBytes
  const hard = hardCapBytes(budget)
  const agePolicy = resolveAgePolicy(budget)
  const meter = createPhysicalMeterLazy(ctx.store)
  const yieldHook = (): Promise<void> => ctx.yieldNow(true)
  const needed = Math.max(1, Math.floor(req.neededBytes))
  const usedBefore = meter()
  const result: FreeSpaceWorkerResult = {
    ...baseResult(run, req, 'completed', now),
    kind: 'free-space',
    displacement: null,
    agedStage: null,
    neededBytes: needed,
    freedBytes: 0,
    usedBefore,
    usedAfter: usedBefore,
    fitsHardCap: false,
    affectedAnnSpaces: [],
    annRequests: [],
  }

  // Stage 1: redundant / boilerplate / duplicate content, lowest value density first (T-A vectors, T-B skeleton).
  const displacement = await freeSpaceForImportantDoc(
    db,
    { neededBytes: needed, budgetBytes: hard, incomingImportance: req.incomingImportance, force: true },
    {
      measurePhysicalBytes: meter,
      yieldHook,
      shouldContinue,
      agePolicy,
      now: req.nowMs,
      batchDocuments: COMPACTION_BATCH_DOCUMENTS / 5,
    },
  )
  result.displacement = displacement
  // fresh measurement: the analysis step of stage 1 adds a little (fingerprints), what counts is the NET result
  let used = meter()
  const floor = Math.max(0, usedBefore - needed)
  let freed = Math.max(0, usedBefore - used)
  let spaces = mergeSpaces(displacement.report?.affectedAnnSpaces)
  let cancelled = displacement.status === 'cancelled' || !shouldContinue()

  // Stage 2: age policy. Archive documents (12 months untouched) first; for a normal/important incoming document
  // also the non-fresh normal documents, and as the very last resort the VECTORS of the oldest fresh normal ones (a
  // new file is never refused while anything but important documents and bare identities is evictable). A 'low'
  // incoming document may only displace archive content.
  if (used > floor && !cancelled) {
    const aged = await executeCacheRetentionPolicy(db, ctx.store.dbPath, soft, {
      ignoreTrigger: true,
      targetFloorBytes: floor,
      allowContentEviction: true,
      agePolicy,
      archiveOnly: req.incomingImportance === 'low',
      // last resort for a normal/important newcomer: vectors (never text) of the oldest fresh normal documents
      allowFreshVectorEviction: req.incomingImportance !== 'low',
      redundancy: false,
      nowMs: req.nowMs,
      batchSize: COMPACTION_BATCH_DOCUMENTS,
      yieldHook,
      shouldContinue,
      settleFtsDeletes: () => settleFtsDeletesNow(db),
      measurePhysicalBytes: meter,
      onPostCommitAnnInvalidation: (s) => {
        for (const x of s) ctx.store.invalidateAnnInMemory(x.spaceId)
      },
    })
    result.agedStage = aged
    if (aged.stoppedReason !== 'error') used = aged.bytesAfter
    freed = Math.max(0, usedBefore - used)
    spaces = mergeSpaces(spaces, aged.affectedAnnSpaces)
    cancelled = aged.stoppedReason === 'cancelled'
    if (aged.stoppedReason === 'error') result.error = aged.error
  }

  result.usedAfter = used
  result.freedBytes = freed
  result.fitsHardCap = used + needed <= hard
  result.affectedAnnSpaces = spaces
  result.annRequests = annFollowUp(ctx, spaces)
  result.status = cancelled ? 'cancelled' : result.error ? 'error' : finish('completed')
  result.durationMs = now() - run.startedAt
  return result
}

async function runOptimizeFts(
  ctx: CompactionWorkerContext,
  req: Extract<CompactionWorkerRequest, { type: 'optimize-fts' }>,
  run: ActiveRun,
  shouldContinue: () => boolean,
  finish: Finish,
): Promise<OptimizeFtsWorkerResult> {
  const now = ctx.now ?? Date.now
  const result = await optimizeFts(ctx.store.rawDb, {
    maxPages: req.maxPages ?? 512,
    budgetMs: req.budgetMs ?? 5_000,
    stepPages: 16,
    yield: () => ctx.yieldNow(false),
    shouldContinue,
    // compose with the scheduler's existing merge step instead of issuing a second, parallel mechanism
    mergeStep: (table, pages) => (table === 'chunk_fts' ? ctx.store.mergeFtsStep(pages) : undefined),
  })
  const status: CompactionRunStatus =
    result.stoppedReason === 'error' ? 'error' : result.stoppedReason === 'cancelled' ? 'cancelled' : finish('completed')
  return {
    ...baseResult(run, req, status, now),
    ...(result.error ? { error: result.error } : {}),
    kind: 'optimize-fts',
    result,
  }
}

async function runAnalyze(
  ctx: CompactionWorkerContext,
  req: Extract<CompactionWorkerRequest, { type: 'redundancy-analyze' }>,
  run: ActiveRun,
  shouldContinue: () => boolean,
  finish: Finish,
): Promise<RedundancyAnalyzeWorkerResult> {
  const now = ctx.now ?? Date.now
  const db = ctx.store.rawDb
  ensureRedundancySchema(db)
  const stats = await analyzeRedundancyFully(db, {
    maxRounds: req.maxRounds ?? 5,
    yieldHook: () => ctx.yieldNow(false),
    shouldContinue,
  })
  return {
    ...baseResult(run, req, run.cancelled ? 'cancelled' : finish('completed'), now),
    kind: 'redundancy-analyze',
    complete: stats.complete,
    documentsAnalyzed: stats.documentsAnalyzed,
  }
}
