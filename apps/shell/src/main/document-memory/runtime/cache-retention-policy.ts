import type { DatabaseSync } from 'node:sqlite'
import { garbageCollectObsoleteStorage, getStorageFreelistStats } from '../storage-gc'
import { compactAfterRetentionBatch } from './retention-compaction'
import {
  CACHE_RETENTION_HIGH_WATERMARK,
  CACHE_RETENTION_LOW_WATERMARK,
} from '../storage-budget'
import {
  CacheRetentionRepository,
  type AgeEvictionCutoffs,
  type AnnSpaceDirtySpec,
  type EvictionCandidateDoc,
} from '../storage/repositories/cache-retention-repository'
import { countAgeBuckets, type AgeBucketReport, type AgePolicy } from './value-density'
import { FTS_SETTLE_FACTOR } from './fts-settle'
import { collectStorageAccountingAsync } from './storage-accounting-async'
import {
  runRedundancyCompaction,
  type RedundancyCompactionOptions,
  type RedundancyCompactionReport,
} from './redundancy-compaction'

export { CACHE_RETENTION_HIGH_WATERMARK, CACHE_RETENTION_LOW_WATERMARK }

export type CacheRetentionStoppedReason =
  | 'target-reached'
  | 'not-triggered'
  | 'budget-zero'
  | 'cancelled'
  | 'exhausted-candidates'
  | 'protected-floor-reached'
  | 'error'

/**
 * Hook invoked after atomic transactional commit of cache retention eviction.
 * Contract: Invalidates in-memory indexes and caches ONLY.
 * MUST NOT increment desired_generation in SQLite again.
 */
export type AnnPostCommitInvalidationHook = (affectedSpaces: AnnSpaceDirtySpec[]) => void

export type PhysicalBytesMeasurementHook = () => Promise<number> | number

export interface CacheRetentionOptions {
  force?: boolean
  allowCriticalImportantEviction?: boolean
  allowContentEviction?: boolean
  batchSize?: number
  yieldHook?: () => Promise<void>
  shouldContinue?: () => boolean
  onPostCommitAnnDirty?: AnnPostCommitInvalidationHook
  onPostCommitAnnInvalidation?: AnnPostCommitInvalidationHook
  vectorsDir?: string
  ocrDir?: string
  tempDir?: string
  measurePhysicalBytes?: PhysicalBytesMeasurementHook
  /**
   * Redundancy-aware tiers T-A / T-B (drop vectors, then template text, of redundant document families while
   * keeping a searchable skeleton). On by default; pass `false` to run only the classic tiers.
   */
  redundancy?: false | Pick<RedundancyCompactionOptions, 'params' | 'batchDocuments' | 'skipAnalysis' | 'tiers'>
  /**
   * AGE POLICY ("recent matters", off unless given; the worker always passes it). Adds the archive stages (vectors,
   * then identity-only content of documents neither opened nor modified for 12 months, ahead of the LRU tiers),
   * excludes 'fresh' documents (touched in the last 30 days) from the normal-importance tiers, and reports the
   * age buckets. Important / manually protected documents are never evicted regardless of age.
   */
  agePolicy?: AgePolicy
  /**
   * Last resort, only with agePolicy: when everything else is exhausted and usage is still above the floor, drop
   * the VECTORS (never the text) of 'fresh' normal documents, oldest first. Used by the urgent (grace zone) run so
   * that a new file is never refused while evictable bytes exist.
   */
  allowFreshVectorEviction?: boolean
  /** Clock for the age cutoffs (tests). */
  nowMs?: number
  /** Run regardless of the 90% trigger (displacement); unlike `force` it still stops at the target floor. */
  ignoreTrigger?: boolean
  /** Absolute byte target replacing the 80% floor (displacement: "free exactly this much"). */
  targetFloorBytes?: number
  /** With agePolicy: only the archive stages (+ low-marked documents); skip the normal-importance LRU tiers. */
  archiveOnly?: boolean
  /**
   * Realises the space of deleted FTS rows. Deleting rows from an FTS5 table only ADDS delete markers (the index grows
   * ~1x the deleted text) until the segments are rewritten, so a content eviction looks like a small gain on the
   * disk until FTS5 'optimize' runs (measured: 34.5 MB -> 24.3 MB after eviction, -> 0.3 MB after optimize). Without
   * this hook the policy keeps evicting against a measurement that has not moved (over-eviction). With it, content
   * stages predict the settled size, run the hook once that prediction reaches the target (and at the end of a
   * stage), then re-measure. Optional and inert for callers that do not pass it.
   */
  settleFtsDeletes?: () => void | Promise<void>
}


export interface CacheRetentionAgeReport {
  buckets: AgeBucketReport
  archiveVectorDocsPruned: number
  archiveContentDocsPruned: number
  freshVectorDocsPruned: number
}

export interface CacheRetentionReport {
  triggered: boolean
  bytesBefore: number
  budgetBytes: number
  targetBytesToReclaim: number
  targetFloor: number
  protectedFloor: number
  tier1OrphansFreed: number
  tier2LowImportanceDocsPruned: number
  tier3NormalDocsPruned: number
  tier4ProtectedDocsCount: number
  tier4ImportantDocsPruned: number
  contentEvictedDocsCount: number
  estimatedBytesReclaimed: number
  bytesAfter: number
  targetReached: boolean
  reusableFreelistBytes: number
  stoppedReason: CacheRetentionStoppedReason
  error?: string
  affectedAnnSpaces: AnnSpaceDirtySpec[]
  floorCannotFitQuota?: boolean
  protectedFloorBytes?: number
  /** JSON-serialisable telemetry of tiers T-A / T-B (bytes per tier, families, skeleton kept vs dropped). */
  redundancy?: RedundancyCompactionReport
  /** Age policy telemetry (only when `agePolicy` was given): bucket histogram and per-stage document counts. */
  age?: CacheRetentionAgeReport
}

export function shouldTriggerCacheRetention(currentBytes: number, budgetBytes: number): boolean {
  if (!Number.isFinite(budgetBytes) || !Number.isFinite(currentBytes)) return false
  if (budgetBytes <= 0 || currentBytes <= 0) return false
  return currentBytes >= budgetBytes * CACHE_RETENTION_HIGH_WATERMARK
}

export function calculateReclaimTarget(currentBytes: number, budgetBytes: number): number {
  if (!Number.isFinite(budgetBytes) || !Number.isFinite(currentBytes) || budgetBytes <= 0) return 0
  const targetFloor = budgetBytes * CACHE_RETENTION_LOW_WATERMARK
  return Math.max(0, currentBytes - targetFloor)
}

/**
 * Enterprise Tiered Cache Retention & Cleanup Policy.
 *
 * Implements strict 90% (high watermark trigger) -> 80% (low watermark target floor) hysteresis:
 *
 * Order of Reclamation:
 * 1. Tier 1: Obsolete/orphan storage (garbageCollectObsoleteStorage).
 * 1b. Tiers T-A / T-B: redundancy-aware compaction (vectors, then template text, of redundant families; skeleton kept).
 * 2. Tier 2: Low-importance documents (override='low' strictly).
 * 3. Tier 3: Normal documents LRU (oldest last_opened_at first).
 * 4. Content Eviction: Prune OCR/chunks/FTS cache content when storage remains above target.
 * 5. Tier 4: Important documents (protected; only pruned in critical force mode).
 *
 * Safety Invariants:
 * - Document identity, name, path, and importance overrides are ALWAYS preserved.
 * - Transactions are strictly bounded per batch; never loads entire document lists with .all().
 * - Cooperative yielding via yieldHook and cancellation via shouldContinue.
 * - Freelist space is reported as reusable freelist, not physical reclaimed bytes.
 * - targetReached is assessed via actual physical file re-accounting after vacuuming.
 * - Post-commit ANN invalidation: dirty spaces are only notified after atomic SQLite commits.
 * - Failures report stoppedReason='error' and preserve error details without swallowing.
 */
export async function executeCacheRetentionPolicy(
  db: DatabaseSync,
  dbPath: string,
  budgetBytes: number,
  options?: CacheRetentionOptions,
): Promise<CacheRetentionReport> {

  const measurePhysicalBytes = async (): Promise<number> => {
    if (options?.measurePhysicalBytes) {
      const value = await options.measurePhysicalBytes()
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid storage measurement')
      return value
    }
    const accounting = await collectStorageAccountingAsync({
      dbPath, db, vectorsDir: options?.vectorsDir,
      ocrDir: options?.ocrDir, tempDir: options?.tempDir,
    })
    if (accounting.isDegraded) throw new Error('Storage accounting is degraded; retention stopped')
    return accounting.totalManagedBytes
  }

  let bytesBefore = 0
  const targetFloor = Math.max(
    0,
    typeof options?.targetFloorBytes === 'number' && Number.isFinite(options.targetFloorBytes)
      ? options.targetFloorBytes
      : budgetBytes * CACHE_RETENTION_LOW_WATERMARK,
  )
  let targetBytesToReclaim = 0
  let triggered = false
  let protectedDocsCount = 0

  const report: CacheRetentionReport = {
    triggered,
    bytesBefore,
    budgetBytes,
    targetBytesToReclaim,
    targetFloor,
    protectedFloor: protectedDocsCount,
    tier1OrphansFreed: 0,
    tier2LowImportanceDocsPruned: 0,
    tier3NormalDocsPruned: 0,
    tier4ProtectedDocsCount: protectedDocsCount,
    tier4ImportantDocsPruned: 0,
    contentEvictedDocsCount: 0,
    estimatedBytesReclaimed: 0,
    bytesAfter: bytesBefore,
    targetReached: false,
    reusableFreelistBytes: 0,
    stoppedReason: triggered ? 'exhausted-candidates' : 'not-triggered',
    affectedAnnSpaces: [],
  }

  // An async measurement can outlive the owning database. Check lifecycle before any query.
  if (options?.shouldContinue && !options.shouldContinue()) {
    report.stoppedReason = 'cancelled'
    return report
  }
  try {
    bytesBefore = await measurePhysicalBytes()
    report.bytesBefore = bytesBefore
    report.bytesAfter = bytesBefore
    if (options?.shouldContinue && !options.shouldContinue()) {
      report.stoppedReason = 'cancelled'
      return report
    }
    triggered =
      options?.force === true || options?.ignoreTrigger === true || shouldTriggerCacheRetention(bytesBefore, budgetBytes)
    targetBytesToReclaim = Math.max(0, bytesBefore - targetFloor)
    protectedDocsCount = new CacheRetentionRepository(db).countProtectedDocuments()
    Object.assign(report, {
      triggered, targetBytesToReclaim, protectedFloor: protectedDocsCount,
      tier4ProtectedDocsCount: protectedDocsCount,
      stoppedReason: triggered ? 'exhausted-candidates' : 'not-triggered',
    })
  } catch (error) {
    report.stoppedReason = options?.shouldContinue && !options.shouldContinue() ? 'cancelled' : 'error'
    report.error = error instanceof Error ? error.message : String(error)
    return report
  }
  const repo = new CacheRetentionRepository(db)

  if (budgetBytes <= 0) {
    report.stoppedReason = 'budget-zero'
    return report
  }

  if (!triggered) {
    report.stoppedReason = 'not-triggered'
    return report
  }

  if (options?.shouldContinue && !options.shouldContinue()) {
    report.stoppedReason = 'cancelled'
    report.bytesAfter = bytesBefore
    return report
  }

  const dirtySpacesMap = new Map<string, number>()
  const recordDirtySpaces = (spaces: AnnSpaceDirtySpec[]): void => {
    for (const s of spaces) {
      const existingGen = dirtySpacesMap.get(s.spaceId) ?? 0
      dirtySpacesMap.set(s.spaceId, Math.max(existingGen, s.desiredGeneration))
    }
  }

  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 25, 200))
  let lastKnownPhysical = bytesBefore

  try {
    // -------------------------------------------------------------
    // TIER 1: Obsolete & Orphan Chunks / Sets / Embeddings
    // -------------------------------------------------------------
    try {
      const gcStats = garbageCollectObsoleteStorage(db)
      report.tier1OrphansFreed =
        gcStats.orphanChunksDeleted +
        gcStats.obsoleteEmbeddingsDeleted +
        gcStats.retiredSetsDeleted
      report.estimatedBytesReclaimed += report.tier1OrphansFreed * 1500
    } catch (err: any) {
      report.stoppedReason = 'error'
      report.error = `Tier 1 GC failed: ${err?.message || String(err)}`
      report.bytesAfter = bytesBefore
      finalizeReport(report, null, dirtySpacesMap, options)
      return report
    }

    if (options?.shouldContinue && !options.shouldContinue()) {
      report.stoppedReason = 'cancelled'
      report.bytesAfter = bytesBefore
      finalizeReport(report, null, dirtySpacesMap, options)
      return report
    }

    // Attempt incremental vacuum to free freelist pages after Tier 1
    compactAfterRetentionBatch(db)
    let currentPhysical = await measurePhysicalBytes()
    lastKnownPhysical = currentPhysical

    // ---- age policy helpers (inert unless options.agePolicy is given) ----
    const agePolicy = options?.agePolicy
    const ageNow = options?.nowMs ?? Date.now()
    const cutoffs: AgeEvictionCutoffs | null = agePolicy
      ? {
          freshCutMs: ageNow - agePolicy.freshWindowDays * 86_400_000,
          archiveCutMs: ageNow - agePolicy.archiveAfterDays * 86_400_000,
        }
      : null
    if (agePolicy) {
      try {
        report.age = {
          buckets: countAgeBuckets(db, ageNow, agePolicy),
          archiveVectorDocsPruned: 0,
          archiveContentDocsPruned: 0,
          freshVectorDocsPruned: 0,
        }
      } catch {
        // telemetry only
      }
    }
    type StageOutcome = 'exhausted' | 'target' | 'cancelled'
    /** One bounded-batch eviction stage with the same cancel / yield / re-measure / target contract as the tiers. */
    const textBytesOf = (ids: number[]): number => {
      try {
        const row = db
          .prepare(`SELECT coalesce(sum(length(text)), 0) AS b FROM chunks WHERE document_id IN (${ids.map(() => '?').join(',')})`)
          .get(...ids) as { b: number }
        return Number(row.b)
      } catch {
        return 0
      }
    }
    const settle = async (): Promise<void> => {
      try {
        await options!.settleFtsDeletes!()
      } catch {
        // best effort: the measured size simply stays higher and the stage continues
      }
      compactAfterRetentionBatch(db)
      currentPhysical = await measurePhysicalBytes()
      lastKnownPhysical = currentPhysical
    }
    const runStage = async (
      fetch: () => EvictionCandidateDoc[],
      kind: 'vectors' | 'content',
      account: (docs: number) => void,
    ): Promise<StageOutcome> => {
      let unsettledTextBytes = 0
      const settleFts = kind === 'content' && typeof options?.settleFtsDeletes === 'function'
      while (true) {
        if (options?.shouldContinue && !options.shouldContinue()) return 'cancelled'
        if (options?.yieldHook) {
          await options.yieldHook()
          if (options?.shouldContinue && !options.shouldContinue()) return 'cancelled'
        }
        const candidates = fetch()
        if (candidates.length === 0) {
          if (settleFts && unsettledTextBytes > 0) {
            await settle()
            if (options?.shouldContinue && !options.shouldContinue()) return 'cancelled'
            if (currentPhysical <= targetFloor && !options?.force) return 'target'
          }
          return 'exhausted'
        }
        const ids = candidates.map((c) => c.id)
        if (kind === 'vectors') {
          const res = repo.evictEmbeddingsBatch(ids)
          report.estimatedBytesReclaimed += res.deletedEmbeddings * 1024
          recordDirtySpaces(res.affectedSpaces)
          account(res.affectedDocumentIds.length)
        } else {
          const evictedText = settleFts ? textBytesOf(ids) : 0
          const res = repo.evictCacheContentBatch(ids)
          report.estimatedBytesReclaimed += res.deletedChunks * 1024
          recordDirtySpaces(res.affectedSpaces)
          account(res.affectedDocumentIds.length)
          unsettledTextBytes += evictedText
        }
        compactAfterRetentionBatch(db)
        currentPhysical = await measurePhysicalBytes()
        lastKnownPhysical = currentPhysical
        if (options?.shouldContinue && !options.shouldContinue()) return 'cancelled'
        if (settleFts && unsettledTextBytes > 0 && currentPhysical - FTS_SETTLE_FACTOR * unsettledTextBytes <= targetFloor) {
          unsettledTextBytes = 0
          await settle()
          if (options?.shouldContinue && !options.shouldContinue()) return 'cancelled'
        }
        if (currentPhysical <= targetFloor && !options?.force) return 'target'
      }
    }
    /** Applies a stage outcome to the report; returns true when the run must end now. */
    const endIf = (outcome: StageOutcome): boolean => {
      if (outcome === 'cancelled') {
        report.stoppedReason = 'cancelled'
        report.bytesAfter = currentPhysical
        finalizeReport(report, null, dirtySpacesMap, options)
        return true
      }
      if (outcome === 'target') {
        report.bytesAfter = currentPhysical
        report.targetReached = true
        report.stoppedReason = 'target-reached'
        finalizeReport(report, db, dirtySpacesMap, options)
        return true
      }
      return false
    }
    const ageStage = async (
      scope: 'archive' | 'normal-non-fresh' | 'normal-fresh',
      kind: 'vectors' | 'content',
      account: (docs: number) => void,
    ): Promise<StageOutcome> =>
      runStage(() => repo.getAgeScopedCandidates(kind, scope, cutoffs!, batchSize), kind, account)

    if (options?.shouldContinue && !options.shouldContinue()) {
      report.stoppedReason = 'cancelled'
      report.bytesAfter = currentPhysical
      finalizeReport(report, null, dirtySpacesMap, options)
      return report
    }

    if (currentPhysical <= targetFloor && !options?.force) {
      report.bytesAfter = currentPhysical
      report.targetReached = true
      report.stoppedReason = 'target-reached'
      finalizeReport(report, db, dirtySpacesMap, options)
      return report
    }

    // -------------------------------------------------------------
    // TIERS T-A / T-B: redundancy-aware compaction BEFORE the blunt tiers below. Drops the vectors, then the
    // template text, of the lowest value-density redundant documents (lesson-plan families, copies, repeated
    // forms); a searchable skeleton (title, locator lines, unique lines) stays and re-extraction restores it.
    // Important documents are never candidates. A failure here must not block the classic tiers.
    // -------------------------------------------------------------
    if (options?.redundancy !== false) {
      const red = await runRedundancyCompaction(db, {
        ...(options?.redundancy ?? {}),
        measurePhysicalBytes,
        targetFloorBytes: options?.force ? -1 : targetFloor,
        yieldHook: options?.yieldHook,
        shouldContinue: options?.shouldContinue,
        agePolicy: options?.agePolicy,
        settleFtsDeletes: options?.settleFtsDeletes,
      })
      report.redundancy = red.report
      report.estimatedBytesReclaimed += red.report.freedBytes
      recordDirtySpaces(red.report.affectedAnnSpaces)
      if (red.report.stoppedReason === 'cancelled') {
        report.stoppedReason = 'cancelled'
        report.bytesAfter = red.bytesAfter
        finalizeReport(report, null, dirtySpacesMap, options)
        return report
      }
      if (red.report.stoppedReason !== 'error') {
        currentPhysical = red.bytesAfter
        lastKnownPhysical = currentPhysical
        if (currentPhysical <= targetFloor && !options?.force) {
          report.bytesAfter = currentPhysical
          report.targetReached = true
          report.stoppedReason = 'target-reached'
          finalizeReport(report, db, dirtySpacesMap, options)
          return report
        }
      }
    }

    // -------------------------------------------------------------
    // ARCHIVE (age policy): neither opened nor modified for 12 months. Vectors first; identity-only content
    // eviction follows Tier 2, still ahead of the LRU vector tier of the 'recent' documents.
    // -------------------------------------------------------------
    if (agePolicy) {
      if (endIf(await ageStage('archive', 'vectors', (n) => { if (report.age) report.age.archiveVectorDocsPruned += n }))) return report
    }

    // -------------------------------------------------------------
    // TIER 2: Prune Low-importance documents (override='low')
    // -------------------------------------------------------------
    while (true) {
      if (options?.shouldContinue && !options.shouldContinue()) {
        report.stoppedReason = 'cancelled'
        report.bytesAfter = currentPhysical
        finalizeReport(report, null, dirtySpacesMap, options)
        return report
      }
      if (options?.yieldHook) {
        await options.yieldHook()
        if (options?.shouldContinue && !options.shouldContinue()) {
          report.stoppedReason = 'cancelled'
          report.bytesAfter = currentPhysical
          finalizeReport(report, null, dirtySpacesMap, options)
          return report
        }
      }

      const candidates = repo.getEmbeddingEvictionCandidates('low', batchSize, 0)
      if (candidates.length === 0) {
        break
      }

      const docIds = candidates.map((c) => c.id)
      const batchRes = repo.evictEmbeddingsBatch(docIds)

      report.tier2LowImportanceDocsPruned += batchRes.affectedDocumentIds.length
      report.estimatedBytesReclaimed += batchRes.deletedEmbeddings * 1024
      recordDirtySpaces(batchRes.affectedSpaces)

      compactAfterRetentionBatch(db)
      currentPhysical = await measurePhysicalBytes()
      lastKnownPhysical = currentPhysical

      if (options?.shouldContinue && !options.shouldContinue()) {
        report.stoppedReason = 'cancelled'
        report.bytesAfter = currentPhysical
        finalizeReport(report, null, dirtySpacesMap, options)
        return report
      }

      if (currentPhysical <= targetFloor && !options?.force) {
        report.bytesAfter = currentPhysical
        report.targetReached = true
        report.stoppedReason = 'target-reached'
        finalizeReport(report, db, dirtySpacesMap, options)
        return report
      }
    }

    if (agePolicy) {
      if (endIf(await ageStage('archive', 'content', (n) => { if (report.age) report.age.archiveContentDocsPruned += n }))) return report
    }

    // -------------------------------------------------------------
    // TIER 3: Prune Normal documents LRU (oldest last_opened_at first)
    // With the age policy 'fresh' documents (touched within the fresh window) are not part of this tier.
    // -------------------------------------------------------------
    while (true) {
      if (options?.shouldContinue && !options.shouldContinue()) {
        report.stoppedReason = 'cancelled'
        report.bytesAfter = currentPhysical
        finalizeReport(report, null, dirtySpacesMap, options)
        return report
      }
      if (options?.yieldHook) {
        await options.yieldHook()
        if (options?.shouldContinue && !options.shouldContinue()) {
          report.stoppedReason = 'cancelled'
          report.bytesAfter = currentPhysical
          finalizeReport(report, null, dirtySpacesMap, options)
          return report
        }
      }

      const candidates = cutoffs
        ? options?.archiveOnly
          ? []
          : repo.getAgeScopedCandidates('vectors', 'normal-non-fresh', cutoffs, batchSize)
        : repo.getEmbeddingEvictionCandidates('normal', batchSize, 0)
      if (candidates.length === 0) {
        break
      }

      const docIds = candidates.map((c) => c.id)
      const batchRes = repo.evictEmbeddingsBatch(docIds)

      report.tier3NormalDocsPruned += batchRes.affectedDocumentIds.length
      report.estimatedBytesReclaimed += batchRes.deletedEmbeddings * 1024
      recordDirtySpaces(batchRes.affectedSpaces)

      compactAfterRetentionBatch(db)
      currentPhysical = await measurePhysicalBytes()
      lastKnownPhysical = currentPhysical

      if (options?.shouldContinue && !options.shouldContinue()) {
        report.stoppedReason = 'cancelled'
        report.bytesAfter = currentPhysical
        finalizeReport(report, null, dirtySpacesMap, options)
        return report
      }

      if (currentPhysical <= targetFloor && !options?.force) {
        report.bytesAfter = currentPhysical
        report.targetReached = true
        report.stoppedReason = 'target-reached'
        finalizeReport(report, db, dirtySpacesMap, options)
        return report
      }
    }

    // -------------------------------------------------------------
    // CONTENT EVICTION: Evict OCR / Chunks / FTS if storage remains full
    // -------------------------------------------------------------
    if (options?.allowContentEviction && currentPhysical > targetFloor) {
      // Evict content for Low first, then Normal
      for (const tier of ['low', 'normal'] as const) {
        const outcome = await runStage(
          () =>
            cutoffs && tier === 'normal'
              ? options?.archiveOnly
                ? []
                : repo.getAgeScopedCandidates('content', 'normal-non-fresh', cutoffs, batchSize)
              : repo.getContentEvictionCandidates(tier, batchSize, 0),
          'content',
          (n) => {
            report.contentEvictedDocsCount += n
          },
        )
        if (endIf(outcome)) return report
      }
    }

    // -------------------------------------------------------------
    // LAST RESORT (age policy, opt-in): vectors only of 'fresh' normal documents, oldest first.
    // -------------------------------------------------------------
    if (agePolicy && options?.allowFreshVectorEviction && currentPhysical > targetFloor) {
      if (endIf(await ageStage('normal-fresh', 'vectors', (n) => { if (report.age) report.age.freshVectorDocsPruned += n }))) return report
    }

    // -------------------------------------------------------------
    // TIER 4: Important documents (Critical emergency override ONLY)
    // -------------------------------------------------------------
    if (options?.allowCriticalImportantEviction && currentPhysical > targetFloor) {
      while (true) {
        if (options?.shouldContinue && !options.shouldContinue()) {
          report.stoppedReason = 'cancelled'
          report.bytesAfter = currentPhysical
          finalizeReport(report, null, dirtySpacesMap, options)
          return report
        }
        if (options?.yieldHook) {
          await options.yieldHook()
          if (options?.shouldContinue && !options.shouldContinue()) {
            report.stoppedReason = 'cancelled'
            report.bytesAfter = currentPhysical
            finalizeReport(report, null, dirtySpacesMap, options)
            return report
          }
        }

        const candidates = repo.getEmbeddingEvictionCandidates('important', batchSize, 0)
        if (candidates.length === 0) {
          break
        }

        const docIds = candidates.map((c) => c.id)
        const batchRes = repo.evictEmbeddingsBatch(docIds)

        report.tier4ImportantDocsPruned += batchRes.affectedDocumentIds.length
        report.estimatedBytesReclaimed += batchRes.deletedEmbeddings * 1024
        recordDirtySpaces(batchRes.affectedSpaces)

        compactAfterRetentionBatch(db)
        currentPhysical = await measurePhysicalBytes()
        lastKnownPhysical = currentPhysical

        if (options?.shouldContinue && !options.shouldContinue()) {
          report.stoppedReason = 'cancelled'
          report.bytesAfter = currentPhysical
          finalizeReport(report, null, dirtySpacesMap, options)
          return report
        }

        if (currentPhysical <= targetFloor && !options?.force) {
          report.bytesAfter = currentPhysical
          report.targetReached = true
          report.stoppedReason = 'target-reached'
          finalizeReport(report, db, dirtySpacesMap, options)
          return report
        }
      }
    }

    if (options?.shouldContinue && !options.shouldContinue()) {
      report.stoppedReason = 'cancelled'
      report.bytesAfter = currentPhysical
      finalizeReport(report, null, dirtySpacesMap, options)
      return report
    }

    // Final physical re-accounting
    compactAfterRetentionBatch(db)
    currentPhysical = await measurePhysicalBytes()
    lastKnownPhysical = currentPhysical

    if (options?.shouldContinue && !options.shouldContinue()) {
      report.stoppedReason = 'cancelled'
      report.bytesAfter = currentPhysical
      finalizeReport(report, null, dirtySpacesMap, options)
      return report
    }

    report.bytesAfter = currentPhysical
    report.targetReached = report.bytesAfter <= targetFloor

    if (report.targetReached) {
      report.stoppedReason = 'target-reached'
    } else if (report.tier4ProtectedDocsCount > 0 && !options?.allowCriticalImportantEviction) {
      report.stoppedReason = 'protected-floor-reached'
      report.floorCannotFitQuota = report.bytesAfter > report.budgetBytes
    } else {
      report.stoppedReason = 'exhausted-candidates'
      report.floorCannotFitQuota = report.bytesAfter > report.budgetBytes
    }

    finalizeReport(report, db, dirtySpacesMap, options)
    return report
  } catch (err: any) {
    report.stoppedReason = options?.shouldContinue && !options.shouldContinue() ? 'cancelled' : 'error'
    report.error = err?.message || String(err)
    report.bytesAfter = lastKnownPhysical > 0 ? lastKnownPhysical : bytesBefore
    report.targetReached = false
    report.floorCannotFitQuota = report.bytesAfter > report.budgetBytes
    finalizeReport(report, null, dirtySpacesMap, options)
    return report
  }
}

function finalizeReport(
  report: CacheRetentionReport,
  db: DatabaseSync | null,
  dirtySpacesMap: Map<string, number>,
  options?: CacheRetentionOptions,
): void {
  if (db) {
    try {
      const freelist = getStorageFreelistStats(db)
      report.reusableFreelistBytes = freelist.reclaimableBytes
    } catch {
      report.reusableFreelistBytes = 0
    }
  } else {
    report.reusableFreelistBytes = 0
  }

  report.affectedAnnSpaces = Array.from(dirtySpacesMap.entries()).map(
    ([spaceId, desiredGeneration]) => ({ spaceId, desiredGeneration }),
  )

  // Notify post-commit invalidation hook safely to caller (prefers new hook with else-if)
  if (report.affectedAnnSpaces.length > 0) {
    if (options?.onPostCommitAnnInvalidation) {
      try {
        options.onPostCommitAnnInvalidation(report.affectedAnnSpaces)
      } catch {
        // Non-blocking
      }
    } else if (options?.onPostCommitAnnDirty) {
      try {
        options.onPostCommitAnnDirty(report.affectedAnnSpaces)
      } catch {
        // Non-blocking
      }
    }
  }
}
