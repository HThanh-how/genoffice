import type { DatabaseSync } from 'node:sqlite'
import { CACHE_RETENTION_HIGH_WATERMARK } from '../storage-budget'
import { ensureRedundancySchema } from '../storage/redundancy-schema'
import type { AnnSpaceDirtySpec } from '../storage/repositories/cache-retention-repository'
import {
  applySkeletonBatch,
  dropBoilerplateVectors,
  type CompactionBatchResult,
  type SkeletonItem,
  type VectorDropItem,
} from '../storage/repositories/skeleton-repository'
import {
  analyzeRedundancyFully,
  buildFamilyModel,
  planDocument,
  resolveParams,
  type AnalysisStats,
} from './redundancy-analyzer'
import { familyLabel } from './redundancy-family'
import type { DocumentPlan, FamilyModel, RedundancyParams } from './redundancy-plan'
import { compactAfterRetentionBatch } from './retention-compaction'
import { FTS_SETTLE_FACTOR } from './fts-settle'
import {
  computeValueDensity,
  selectCompactionCandidates,
  type AgePolicy,
  type CompactionCandidate,
  type ImportanceClass,
} from './value-density'

/**
 * Redundancy-aware compaction (the "smart janitor"), tiers T-A and T-B. Pure functions over a DatabaseSync handle,
 * bounded batches, cooperative (`yieldHook` / `shouldContinue`), so it can run on the main thread today and move
 * into the worker unchanged.
 *
 *   T-A  drop the VECTORS of boilerplate-heavy chunks of redundant documents (text + FTS stay)
 *   T-B  drop template text + FTS of those documents, keep the SKELETON (title, locator lines, unique lines)
 *
 * Both tiers visit candidates by ascending value density (value.density.ts). Protected (important) documents are
 * never candidates. Originals on disk are never read or written here; compaction only shrinks the index, and a
 * re-extraction (retry / read-now / open) restores a skeleton document completely.
 */
export type RedundancyStoppedReason = 'target-reached' | 'exhausted-candidates' | 'cancelled' | 'error'

export interface RedundancyCompactionOptions {
  params?: Partial<RedundancyParams>
  /** Physical bytes (db + wal + shm + ...); called after every batch, after vacuum + WAL truncate. */
  measurePhysicalBytes?: () => Promise<number> | number
  /** Stop as soon as the measurement is at or below this (use -1 to run all candidates). */
  targetFloorBytes: number
  /** Displacement: stop once this many bytes were freed since the run started. */
  stopAtFreedBytes?: number
  /** Displacement: only documents with a value density below this are candidates. */
  maxDensity?: number
  batchDocuments?: number
  /** Skip the (incremental) analysis step, e.g. when the caller just ran it. */
  skipAnalysis?: boolean
  analysisMaxRounds?: number
  yieldHook?: () => Promise<void>
  shouldContinue?: () => boolean
  now?: number
  tiers?: Array<'vectors' | 'skeleton'>
  /**
   * Realises the space of FTS rows deleted by the skeleton tier (FTS5 only adds delete markers until optimised, see
   * CacheRetentionOptions.settleFtsDeletes). Called when the predicted settled size reaches the target and at the end
   * of the tier; the measurement is retaken afterwards. Inert when absent.
   */
  settleFtsDeletes?: () => void | Promise<void>
  /** Age policy of the value density (fresh window / archive threshold); default 30 days / 12 months. */
  agePolicy?: AgePolicy
}

export interface TierReport {
  documents: number
  vectorsDeleted: number
  vectorBytesDeleted: number
  chunksRewritten: number
  chunksDropped: number
  textBytesRemoved: number
  /** Measured physical bytes freed while this tier ran (after vacuum + checkpoint). */
  bytesFreed: number
}

export interface FamilySummary {
  label: string
  documents: number
  avgBoilerplateRatio: number
  boilerplateBytes: number
}

export interface RedundancyCompactionReport {
  ran: boolean
  stoppedReason: RedundancyStoppedReason
  bytesBefore: number
  bytesAfter: number
  freedBytes: number
  targetFloorBytes: number
  durationMs: number
  analysis: AnalysisStats | null
  families: {
    found: number
    documentsInFamilies: number
    exactCopies: number
    protectedDocuments: number
    top: FamilySummary[]
  }
  tiers: { vectors: TierReport; skeleton: TierReport }
  /** Characters kept as skeleton vs removed, over the documents compacted in this run. */
  skeleton: { documents: number; keptChars: number; droppedChars: number }
  skippedDocuments: number
  staleSkipped: number
  affectedAnnSpaces: AnnSpaceDirtySpec[]
  error?: string
}

function emptyTier(): TierReport {
  return {
    documents: 0,
    vectorsDeleted: 0,
    vectorBytesDeleted: 0,
    chunksRewritten: 0,
    chunksDropped: 0,
    textBytesRemoved: 0,
    bytesFreed: 0,
  }
}

/** Used pages x page size after a checkpoint: the file size once the freelist is vacuumed. Cheap, no filesystem. */
export function logicalDatabaseBytes(db: DatabaseSync): number {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // busy reader: the number below is still a correct logical size
  }
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
  const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
  return Math.max(0, pages - free) * pageSize
}

export function describeFamilies(
  db: DatabaseSync,
  minRatio: number,
  limit = 5,
): RedundancyCompactionReport['families'] {
  const base = db
    .prepare(
      `SELECT count(DISTINCT family_key) AS families, count(*) AS docs
       FROM document_redundancy WHERE family_size >= 3 AND boilerplate_ratio >= ?`,
    )
    .get(minRatio) as { families: number; docs: number }
  const copies = db
    .prepare('SELECT count(*) AS c FROM document_redundancy WHERE duplicate_of IS NOT NULL')
    .get() as { c: number }
  const protectedDocs = db
    .prepare(
      `SELECT count(*) AS c FROM documents d WHERE d.importance_override = 'important'
         OR ((d.importance_override = 'auto' OR d.importance_override IS NULL) AND d.importance_suggestion = 'important')`,
    )
    .get() as { c: number }
  const top = db
    .prepare(
      `SELECT family_key, count(*) AS docs, avg(boilerplate_ratio) AS ratio, sum(boilerplate_bytes) AS bytes
       FROM document_redundancy WHERE family_size >= 3 AND boilerplate_ratio >= ?
       GROUP BY family_key ORDER BY sum(boilerplate_bytes) DESC LIMIT ?`,
    )
    .all(minRatio, limit) as Array<{ family_key: string; docs: number; ratio: number; bytes: number }>
  return {
    found: base.families,
    documentsInFamilies: base.docs,
    exactCopies: copies.c,
    protectedDocuments: protectedDocs.c,
    top: top.map((t) => ({
      label: familyLabel(t.family_key),
      documents: t.docs,
      avgBoilerplateRatio: Number(t.ratio.toFixed(3)),
      boilerplateBytes: t.bytes,
    })),
  }
}

function originalIntact(db: DatabaseSync, originalId: number): boolean {
  const row = db
    .prepare(
      `SELECT d.excluded, d.content_evicted AS evicted, coalesce(d.chunk_total, 0) AS chunks,
              EXISTS (SELECT 1 FROM document_skeleton s WHERE s.document_id = d.id AND s.stage = 'skeleton') AS skel
       FROM documents d WHERE d.id = ?`,
    )
    .get(originalId) as { excluded: number; evicted: number; chunks: number; skel: number } | undefined
  return Boolean(row && row.excluded === 0 && row.evicted === 0 && row.chunks >= 1 && row.skel === 0)
}

export async function runRedundancyCompaction(
  db: DatabaseSync,
  options: RedundancyCompactionOptions,
): Promise<{ report: RedundancyCompactionReport; bytesAfter: number }> {
  const started = Date.now()
  const params = resolveParams(options.params)
  const now = options.now ?? Date.now()
  const measure = async (): Promise<number> => {
    const v = options.measurePhysicalBytes ? await options.measurePhysicalBytes() : logicalDatabaseBytes(db)
    if (!Number.isFinite(v) || v < 0) throw new Error('Invalid storage measurement')
    return v
  }
  const report: RedundancyCompactionReport = {
    ran: false,
    stoppedReason: 'exhausted-candidates',
    bytesBefore: 0,
    bytesAfter: 0,
    freedBytes: 0,
    targetFloorBytes: options.targetFloorBytes,
    durationMs: 0,
    analysis: null,
    families: { found: 0, documentsInFamilies: 0, exactCopies: 0, protectedDocuments: 0, top: [] },
    tiers: { vectors: emptyTier(), skeleton: emptyTier() },
    skeleton: { documents: 0, keptChars: 0, droppedChars: 0 },
    skippedDocuments: 0,
    staleSkipped: 0,
    affectedAnnSpaces: [],
  }
  const dirty = new Map<string, number>()
  const cancelled = (): boolean => Boolean(options.shouldContinue && !options.shouldContinue())
  const finish = (reason: RedundancyStoppedReason, bytesAfter: number): { report: RedundancyCompactionReport; bytesAfter: number } => {
    report.stoppedReason = reason
    report.bytesAfter = bytesAfter
    report.freedBytes = Math.max(0, report.bytesBefore - bytesAfter)
    report.durationMs = Date.now() - started
    report.affectedAnnSpaces = [...dirty.entries()].map(([spaceId, desiredGeneration]) => ({ spaceId, desiredGeneration }))
    try {
      report.families = describeFamilies(db, params.minDocRatio)
    } catch {
      // telemetry only
    }
    return { report, bytesAfter }
  }

  let current = 0
  try {
    ensureRedundancySchema(db)
    current = await measure()
    report.bytesBefore = current
    if (cancelled()) return finish('cancelled', current)

    if (!options.skipAnalysis) {
      report.analysis = await analyzeRedundancyFully(db, {
        params: options.params,
        maxRounds: options.analysisMaxRounds ?? 200,
        yieldHook: options.yieldHook,
        shouldContinue: options.shouldContinue,
        now,
      })
      if (cancelled()) return finish('cancelled', current)
    }
    report.ran = true

    const reached = (): boolean =>
      current <= options.targetFloorBytes ||
      (options.stopAtFreedBytes !== undefined && report.bytesBefore - current >= options.stopAtFreedBytes)
    if (reached()) return finish('target-reached', current)

    const models = new Map<string, FamilyModel>()
    const modelFor = (key: string): FamilyModel => {
      let m = models.get(key)
      if (!m) {
        m = buildFamilyModel(db, key, params, false)
        models.set(key, m)
      }
      return m
    }
    const batch = Math.max(1, Math.min(options.batchDocuments ?? 8, 50))
    for (const tier of options.tiers ?? (['vectors', 'skeleton'] as const)) {
      const tierReport = report.tiers[tier]
      const tierStart = current
      let unsettledTextBytes = 0
      const settleNow = async (): Promise<void> => {
        unsettledTextBytes = 0
        try {
          await options.settleFtsDeletes!()
        } catch {
          // best effort: the measured size simply stays higher
        }
        compactAfterRetentionBatch(db)
        current = await measure()
      }
      let after: { density: number; documentId: number } | undefined
      while (true) {
        if (cancelled()) {
          tierReport.bytesFreed += Math.max(0, tierStart - current)
          return finish('cancelled', current)
        }
        if (options.yieldHook) await options.yieldHook()
        if (cancelled()) return finish('cancelled', current)
        const candidates = selectCompactionCandidates(db, {
          tier,
          limit: batch,
          nowMs: now,
          minRatio: params.minDocRatio,
          maxDensity: options.maxDensity,
          after,
          agePolicy: options.agePolicy,
        })
        if (candidates.length === 0) {
          if (tier === 'skeleton' && options.settleFtsDeletes && unsettledTextBytes > 0) {
            await settleNow()
            if (reached()) {
              tierReport.bytesFreed += Math.max(0, tierStart - current)
              return finish('target-reached', current)
            }
          }
          break
        }
        const last = candidates[candidates.length - 1]!
        after = { density: last.density, documentId: last.documentId }
        const vectorItems: VectorDropItem[] = []
        const skeletonItems: SkeletonItem[] = []
        const plans = new Map<number, DocumentPlan>()
        for (const c of candidates) {
          const duplicate = c.duplicateOf !== null && originalIntact(db, c.duplicateOf)
          const plan = planDocument(db, c.documentId, modelFor(c.familyKey), params, { duplicate })
          const target = { documentId: c.documentId, hash: c.hash, activeChunkSetId: c.activeChunkSetId, familyKey: c.familyKey }
          if (!plan || plan.droppedChars < params.minReclaimChars) {
            report.skippedDocuments++
            continue
          }
          plans.set(c.documentId, plan)
          if (tier === 'vectors') {
            const chunkIds = plan.chunks
              .filter((a) => a.action !== 'keep' && a.droppedShare >= params.vectorChunkShare)
              .map((a) => a.chunkId)
            if (chunkIds.length === 0) {
              report.skippedDocuments++
              continue
            }
            vectorItems.push({ ...target, chunkIds })
          } else {
            skeletonItems.push({ ...target, plan })
          }
        }
        const res: CompactionBatchResult =
          tier === 'vectors' ? dropBoilerplateVectors(db, vectorItems) : applySkeletonBatch(db, skeletonItems)
        tierReport.documents += res.documents
        tierReport.vectorsDeleted += res.vectorsDeleted
        tierReport.vectorBytesDeleted += res.vectorBytesDeleted
        tierReport.chunksRewritten += res.chunksRewritten
        tierReport.chunksDropped += res.chunksDropped
        tierReport.textBytesRemoved += res.textBytesRemoved
        report.staleSkipped += res.skippedStale
        for (const s of res.affectedSpaces) dirty.set(s.spaceId, Math.max(dirty.get(s.spaceId) ?? 0, s.desiredGeneration))
        if (tier === 'skeleton') {
          for (const id of res.affectedDocumentIds) {
            const plan = plans.get(id)
            if (!plan) continue
            report.skeleton.documents++
            report.skeleton.keptChars += plan.keptChars
            report.skeleton.droppedChars += plan.droppedChars
          }
        }
        if (res.documents === 0) continue
        compactAfterRetentionBatch(db)
        current = await measure()
        if (tier === 'skeleton' && options.settleFtsDeletes) {
          unsettledTextBytes += res.textBytesRemoved
          if (unsettledTextBytes > 0 && current - FTS_SETTLE_FACTOR * unsettledTextBytes <= options.targetFloorBytes) await settleNow()
        }
        if (reached()) {
          tierReport.bytesFreed += Math.max(0, tierStart - current)
          return finish('target-reached', current)
        }
      }
      tierReport.bytesFreed += Math.max(0, tierStart - current)
    }
    return finish('exhausted-candidates', current)
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
    return finish('error', current > 0 ? current : report.bytesBefore)
  }
}

// ---------------------------------------------------------------------------------------------------------
// E. Admission by displacement
// ---------------------------------------------------------------------------------------------------------

export interface DisplacementCandidate {
  documentId: number
  name: string
  familyLabel: string
  density: number
  stage: CompactionCandidate['stage']
  /** Estimated bytes freed by T-A (vectors) and by T-B (template text + FTS + remaining vectors). */
  estimatedVectorBytes: number
  estimatedSkeletonBytes: number
}

export interface DisplacementPlan {
  neededBytes: number
  candidates: DisplacementCandidate[]
  estimatedFreeBytes: number
  sufficient: boolean
}

const FTS_COPY_FACTOR = 1.4 // bigram FTS text + index overhead relative to the chunk text it indexes

/**
 * Dry run: which redundant documents would be compacted (lowest value density first, T-A then T-B) to free
 * `neededBytes`, from the analysis rows alone (no text is read, nothing is written). Estimates only; the real
 * numbers come from freeSpaceForImportantDoc(). Protected documents are never listed.
 */
export function planDisplacement(
  db: DatabaseSync,
  neededBytes: number,
  options: { params?: Partial<RedundancyParams>; now?: number; incomingImportance?: ImportanceClass; incomingBytes?: number; agePolicy?: AgePolicy } = {},
): DisplacementPlan {
  const params = resolveParams(options.params)
  const now = options.now ?? Date.now()
  const plan: DisplacementPlan = { neededBytes, candidates: [], estimatedFreeBytes: 0, sufficient: false }
  if (!(neededBytes > 0)) {
    plan.sufficient = true
    return plan
  }
  ensureRedundancySchema(db)
  const maxDensity = incomingDensityCeiling(options.incomingImportance, options.incomingBytes ?? neededBytes, now, options.agePolicy)
  let after: { density: number; documentId: number } | undefined
  while (plan.estimatedFreeBytes < neededBytes) {
    const page = selectCompactionCandidates(db, { tier: 'skeleton', limit: 100, nowMs: now, minRatio: params.minDocRatio, maxDensity, after, agePolicy: options.agePolicy })
    if (page.length === 0) break
    const last = page[page.length - 1]!
    after = { density: last.density, documentId: last.documentId }
    for (const c of page) {
      const vectors = c.stage === 'none' ? Math.round(c.vectorBytes * Math.min(1, c.boilerplateRatio * 1.1)) : 0
      const text = Math.round(c.boilerplateBytes * (1 + FTS_COPY_FACTOR))
      const skeleton = text + (c.stage === 'none' ? c.vectorBytes - vectors : 0) + vectors
      plan.candidates.push({
        documentId: c.documentId,
        name: c.name,
        familyLabel: familyLabel(c.familyKey),
        density: c.density,
        stage: c.stage,
        estimatedVectorBytes: vectors,
        estimatedSkeletonBytes: skeleton,
      })
      plan.estimatedFreeBytes += skeleton
      if (plan.estimatedFreeBytes >= neededBytes) break
    }
  }
  plan.sufficient = plan.estimatedFreeBytes >= neededBytes
  return plan
}

/** Candidates must be worth less (per byte) than what is being admitted. */
function incomingDensityCeiling(importance: ImportanceClass | undefined, bytes: number, now: number, agePolicy?: AgePolicy): number {
  return computeValueDensity({
    importance: importance ?? 'important',
    lastTouchMs: now,
    opened: false,
    nowMs: now,
    boilerplateRatio: 0,
    familySize: 1,
    isDuplicate: false,
    textBytes: Math.max(1, bytes) / 2,
    vectorBytes: 0,
  }, agePolicy)
}

export interface DisplacementRequest {
  /** Bytes the incoming document needs. */
  neededBytes: number
  budgetBytes: number
  incomingImportance?: ImportanceClass
  /** Skip the "does it need room" guard: the caller already knows (e.g. admission refused on reserved bytes). */
  force?: boolean
}

export interface DisplacementResult {
  status: 'not-needed' | 'freed' | 'insufficient' | 'cancelled' | 'error'
  neededBytes: number
  freedBytes: number
  satisfied: boolean
  usedBefore: number
  usedAfter: number
  /** True when usedAfter + neededBytes fits the hard quota. */
  fitsQuota: boolean
  report: RedundancyCompactionReport | null
  error?: string
}

/**
 * Admission by displacement. When `usedBytes + neededBytes` would cross the quota, or usage is already at/above the
 * high watermark, free `neededBytes` from the LOWEST value-density redundant content (T-A then T-B only: never
 * important documents, never originals, never a document's identity) and say what was freed. Only ever shrinks
 * the index (the optional analysis step adds < 1% of fingerprint rows; keep analysis current from the maintenance
 * cycle so this call is a pure shrink at the moment of admission).
 *
 * INTEGRATION: call from the admission path (storage-admission / content-write-budget) when a new important or
 * high-density document is rejected with "quota" and retry the admission when `fitsQuota` is true.
 */
export async function freeSpaceForImportantDoc(
  db: DatabaseSync,
  request: DisplacementRequest,
  options: Omit<RedundancyCompactionOptions, 'targetFloorBytes' | 'stopAtFreedBytes' | 'maxDensity'> = {},
): Promise<DisplacementResult> {
  const measure = async (): Promise<number> =>
    options.measurePhysicalBytes ? await options.measurePhysicalBytes() : logicalDatabaseBytes(db)
  const now = options.now ?? Date.now()
  let used = 0
  try {
    used = await measure()
    const needsRoom =
      request.neededBytes > 0 &&
      (request.force === true || used >= request.budgetBytes * CACHE_RETENTION_HIGH_WATERMARK || used + request.neededBytes > request.budgetBytes)
    if (!needsRoom) {
      return {
        status: 'not-needed',
        neededBytes: request.neededBytes,
        freedBytes: 0,
        satisfied: true,
        usedBefore: used,
        usedAfter: used,
        fitsQuota: used + request.neededBytes <= request.budgetBytes,
        report: null,
      }
    }
    const { report, bytesAfter } = await runRedundancyCompaction(db, {
      ...options,
      now,
      targetFloorBytes: -1,
      stopAtFreedBytes: request.neededBytes,
      maxDensity: incomingDensityCeiling(request.incomingImportance, request.neededBytes, now, options.agePolicy),
      batchDocuments: options.batchDocuments ?? 2,
      analysisMaxRounds: options.analysisMaxRounds ?? 3,
    })
    const freed = Math.max(0, used - bytesAfter)
    const status: DisplacementResult['status'] =
      report.stoppedReason === 'cancelled'
        ? 'cancelled'
        : report.stoppedReason === 'error'
          ? 'error'
          : freed >= request.neededBytes
            ? 'freed'
            : 'insufficient'
    return {
      status,
      neededBytes: request.neededBytes,
      freedBytes: freed,
      satisfied: freed >= request.neededBytes,
      usedBefore: used,
      usedAfter: bytesAfter,
      fitsQuota: bytesAfter + request.neededBytes <= request.budgetBytes,
      report,
      ...(report.error ? { error: report.error } : {}),
    }
  } catch (err) {
    return {
      status: 'error',
      neededBytes: request.neededBytes,
      freedBytes: 0,
      satisfied: false,
      usedBefore: used,
      usedAfter: used,
      fitsQuota: false,
      report: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
