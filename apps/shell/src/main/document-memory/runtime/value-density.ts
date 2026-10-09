import type { DatabaseSync } from 'node:sqlite'
import { REDUNDANCY_DEFAULTS } from './redundancy-plan'

/**
 * Value model (A): value density = value / index bytes, lowest density is compacted first.
 *
 *   value = importanceWeight x recency x (1 + opened bonus) x (1 - redundancy discount)
 *
 *   importance  override 'important' or (override auto/NULL + suggestion 'important') -> 100, override 'low' -> 2,
 *               everything else -> 10 (manual override > inference > default, like computeEffectiveImportance)
 *   recency     AGE POLICY ("recent files matter, year-old files do not"); age = now - max(last_opened_at, mtime_ms)
 *                 (updated_at as fallback when both are unknown):
 *                 age <= freshWindowDays (30 d)          -> 1.0  'fresh': strongly protected from non-critical eviction
 *                 age >  freshWindowDays                 -> 1 / (1 + (age - fresh) / RECENCY_SCALE_DAYS)
 *                 age >  archiveAfterDays (12 months)    -> x ARCHIVE_VALUE_FACTOR  'archive': neither opened nor
 *                                                           modified for a year, the first victims after boilerplate
 *   opened      +50% when the person ever opened the file (documents.last_opened_at > 0). No search/open counter
 *               exists and adding one would put a write on the hot search path, so this is the usage signal.
 *   redundancy  0.9 x boilerplate_ratio x min(1, (family_size - 1) / 3); an exact copy counts as 0.95
 *   bytes       text_bytes x 2 (chunk text + FTS copy) + vector_bytes (measured at analysis time)
 *
 * The SQL expression and computeValueDensity() implement the same formula (tested to agree).
 */
export const IMPORTANCE_WEIGHT = Object.freeze({ important: 100, normal: 10, low: 2 })
/** Decay time constant after the fresh window; 45 days halves the value 45 days after the window ends. */
export const RECENCY_SCALE_DAYS = 45
/** Extra multiplier for 'archive' documents (untouched for longer than the archive threshold). */
export const ARCHIVE_VALUE_FACTOR = 0.1
/** Touched within this window: 'fresh'. Overridable through the budget object (`freshWindowDays`). */
export const FRESH_WINDOW_DAYS = 30
/** Neither opened nor modified for this long: 'archive' (12 months). Overridable (`archiveAfterMonths`). */
export const ARCHIVE_AFTER_DAYS = 365
export const OPENED_BONUS = 0.5
export const REDUNDANCY_MAX_DISCOUNT = 0.9
export const DUPLICATE_DISCOUNT = 0.95

const DAY_MS = 86_400_000
const DAYS_PER_MONTH = 365 / 12

/**
 * Age buckets of the retention policy, by days since the document was last opened OR modified:
 *   fresh   <= freshWindowDays   strongly protected from non-critical eviction (only 'low'-marked documents and a
 *                                last-resort vector drop in the grace zone can touch them)
 *   recent  in between           normal LRU/value-density treatment
 *   archive > archiveAfterDays   first victims after redundant boilerplate: vectors, then body, then identity-only
 * Important / manually protected documents are never evicted whatever their age.
 */
export interface AgePolicy {
  freshWindowDays: number
  archiveAfterDays: number
}

export type AgeBucket = 'fresh' | 'recent' | 'archive'

export const DEFAULT_AGE_POLICY: Readonly<AgePolicy> = Object.freeze({
  freshWindowDays: FRESH_WINDOW_DAYS,
  archiveAfterDays: ARCHIVE_AFTER_DAYS,
})

/** Settings-shaped override (the storage budget object carries these two optional numbers). */
export interface AgePolicyOverrides {
  freshWindowDays?: number
  archiveAfterMonths?: number
}

/** Validates untrusted overrides; anything invalid falls back to the documented defaults. */
export function resolveAgePolicy(overrides?: AgePolicyOverrides | null): AgePolicy {
  const fresh =
    typeof overrides?.freshWindowDays === 'number' && Number.isFinite(overrides.freshWindowDays) && overrides.freshWindowDays > 0
      ? overrides.freshWindowDays
      : FRESH_WINDOW_DAYS
  const months = overrides?.archiveAfterMonths
  const archive =
    typeof months === 'number' && Number.isFinite(months) && months > 0 ? months * DAYS_PER_MONTH : ARCHIVE_AFTER_DAYS
  // the archive threshold must stay clearly behind the fresh window
  return { freshWindowDays: fresh, archiveAfterDays: Math.max(archive, fresh * 2) }
}

export function ageBucketOf(lastTouchMs: number, nowMs: number, policy: AgePolicy = DEFAULT_AGE_POLICY): AgeBucket {
  const ageDays = Math.max(0, nowMs - (lastTouchMs > 0 ? lastTouchMs : 0)) / DAY_MS
  if (lastTouchMs <= 0) return 'recent' // unknown age is never treated as archive
  return ageDays <= policy.freshWindowDays ? 'fresh' : ageDays > policy.archiveAfterDays ? 'archive' : 'recent'
}

/** Recency factor of the age policy (shared by the TS formula; the SQL twin below spells out the same CASE). */
export function recencyFactor(ageDays: number, policy: AgePolicy = DEFAULT_AGE_POLICY): number {
  const age = Math.max(0, ageDays)
  const decay = age <= policy.freshWindowDays ? 1 : 1 / (1 + (age - policy.freshWindowDays) / RECENCY_SCALE_DAYS)
  return age > policy.archiveAfterDays ? decay * ARCHIVE_VALUE_FACTOR : decay
}

/** SQL for "last touch in ms" of a `documents d` row: opened or modified, whichever is newer (0 = unknown). */
export const LAST_TOUCH_SQL = `CASE WHEN max(coalesce(d.last_opened_at, 0), coalesce(d.mtime_ms, 0)) > 0 THEN max(coalesce(d.last_opened_at, 0), coalesce(d.mtime_ms, 0)) WHEN coalesce(d.updated_at, 0) BETWEEN 1 AND 99999999999 THEN d.updated_at * 1000 ELSE 0 END`

export type ImportanceClass = 'important' | 'normal' | 'low'

/** Protected = important docs and manual overrides: untouched by every redundancy tier. */
export const PROTECTED_SQL = `(d.importance_override = 'important'
  OR ((d.importance_override = 'auto' OR d.importance_override IS NULL) AND d.importance_suggestion = 'important'))`

export interface ValueInput {
  importance: ImportanceClass
  /** max(last_opened_at, mtime_ms) in ms; 0 when unknown. */
  lastTouchMs: number
  opened: boolean
  nowMs: number
  boilerplateRatio: number
  familySize: number
  isDuplicate: boolean
  textBytes: number
  vectorBytes: number
}

export function computeValueDensity(input: ValueInput, policy: AgePolicy = DEFAULT_AGE_POLICY): number {
  const ageDays = Math.max(0, input.nowMs - input.lastTouchMs) / DAY_MS
  const recency = recencyFactor(ageDays, policy)
  const discount = input.isDuplicate
    ? DUPLICATE_DISCOUNT
    : REDUNDANCY_MAX_DISCOUNT * Math.max(0, input.boilerplateRatio) * Math.min(1, Math.max(0, input.familySize - 1) / 3)
  const value = IMPORTANCE_WEIGHT[input.importance] * recency * (1 + (input.opened ? OPENED_BONUS : 0)) * (1 - discount)
  return value / (input.textBytes * 2 + input.vectorBytes + 1)
}

/** SQL twin of computeValueDensity over `documents d` JOIN `document_redundancy r`. `nowMs` is inlined (validated). */
export function valueDensitySql(nowMs: number, policy: AgePolicy = DEFAULT_AGE_POLICY): string {
  const now = Math.trunc(Number.isFinite(nowMs) ? nowMs : Date.now())
  const age = `max(0.0, (${now} - ${LAST_TOUCH_SQL}) / ${DAY_MS}.0)`
  const fresh = Number(policy.freshWindowDays)
  const archive = Number(policy.archiveAfterDays)
  return `(
    (CASE WHEN d.importance_override = 'low' THEN ${IMPORTANCE_WEIGHT.low}.0
          WHEN ${PROTECTED_SQL} THEN ${IMPORTANCE_WEIGHT.important}.0
          ELSE ${IMPORTANCE_WEIGHT.normal}.0 END)
    * (CASE WHEN ${age} <= ${fresh} THEN 1.0 ELSE 1.0 / (1.0 + (${age} - ${fresh}) / ${RECENCY_SCALE_DAYS}.0) END)
    * (CASE WHEN ${age} > ${archive} THEN ${ARCHIVE_VALUE_FACTOR} ELSE 1.0 END)
    * (1.0 + CASE WHEN d.last_opened_at > 0 THEN ${OPENED_BONUS} ELSE 0.0 END)
    * (1.0 - CASE WHEN r.duplicate_of IS NOT NULL THEN ${DUPLICATE_DISCOUNT}
                  ELSE ${REDUNDANCY_MAX_DISCOUNT} * max(0.0, r.boilerplate_ratio) * min(1.0, max(0, r.family_size - 1) / 3.0) END)
    / (r.text_bytes * 2.0 + r.vector_bytes + 1.0))`
}

export type CompactionStage = 'none' | 'vectors' | 'skeleton'

export interface CompactionCandidate {
  documentId: number
  path: string
  name: string
  hash: string | null
  activeChunkSetId: number | null
  status: string
  importance: ImportanceClass
  familyKey: string
  familySize: number
  boilerplateRatio: number
  duplicateOf: number | null
  textBytes: number
  boilerplateBytes: number
  vectorBytes: number
  stage: CompactionStage
  density: number
}

export interface CandidateQuery {
  /** 'vectors' = T-A candidates, 'skeleton' = T-B candidates. */
  tier: 'vectors' | 'skeleton'
  limit: number
  nowMs: number
  minRatio?: number
  includeProtected?: boolean
  /** Only documents strictly below this density (admission by displacement). */
  maxDensity?: number
  /** Keyset pagination: continue after this (density, id). */
  after?: { density: number; documentId: number }
  /** Age policy of the recency factor (default: 30 days fresh / 12 months archive). */
  agePolicy?: AgePolicy
}

interface CandidateRow {
  id: number
  path: string
  name: string
  hash: string | null
  set_id: number | null
  status: string
  importance: ImportanceClass
  family_key: string
  family_size: number
  ratio: number
  duplicate_of: number | null
  text_bytes: number
  boilerplate_bytes: number
  vector_bytes: number
  stage: string | null
  density: number
}

/** Bounded, deterministic (density asc, id asc) page of redundancy candidates. Never loads the whole table. */
export function selectCompactionCandidates(db: DatabaseSync, q: CandidateQuery): CompactionCandidate[] {
  const minRatio = q.minRatio ?? REDUNDANCY_DEFAULTS.minDocRatio
  const stageClause =
    q.tier === 'vectors'
      ? 's.document_id IS NULL AND r.vector_bytes >= 1024'
      : "(s.document_id IS NULL OR s.stage = 'vectors') AND r.boilerplate_bytes >= 256"
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT d.id AS id, d.path AS path, d.name AS name, d.hash AS hash, d.active_chunk_set_id AS set_id, d.status AS status,
                CASE WHEN d.importance_override = 'low' THEN 'low' WHEN ${PROTECTED_SQL} THEN 'important' ELSE 'normal' END AS importance,
                r.family_key AS family_key, r.family_size AS family_size, r.boilerplate_ratio AS ratio,
                r.duplicate_of AS duplicate_of, r.text_bytes AS text_bytes, r.boilerplate_bytes AS boilerplate_bytes,
                r.vector_bytes AS vector_bytes, s.stage AS stage, ${valueDensitySql(q.nowMs, q.agePolicy)} AS density
         FROM document_redundancy r
         JOIN documents d ON d.id = r.document_id
         LEFT JOIN document_skeleton s ON s.document_id = d.id
         WHERE d.excluded = 0 AND d.status IN ('ready', 'text-only') AND coalesce(d.chunk_total, 0) >= 2
           AND r.boilerplate_ratio >= 0 AND (r.boilerplate_ratio >= ? OR r.duplicate_of IS NOT NULL)
           AND ${stageClause}
           ${q.includeProtected ? '' : `AND NOT ${PROTECTED_SQL}`}
       ) WHERE (? IS NULL OR density < ?) AND (? IS NULL OR density > ? OR (density = ? AND id > ?))
       ORDER BY density ASC, id ASC LIMIT ?`,
    )
    .all(
      minRatio,
      q.maxDensity ?? null,
      q.maxDensity ?? null,
      q.after ? q.after.density : null,
      q.after ? q.after.density : null,
      q.after ? q.after.density : null,
      q.after ? q.after.documentId : 0,
      Math.max(1, Math.min(q.limit, 500)),
    ) as unknown as CandidateRow[]
  return rows.map((r) => ({
    documentId: r.id,
    path: r.path,
    name: r.name,
    hash: r.hash,
    activeChunkSetId: r.set_id,
    status: r.status,
    importance: r.importance,
    familyKey: r.family_key,
    familySize: r.family_size,
    boilerplateRatio: r.ratio,
    duplicateOf: r.duplicate_of,
    textBytes: r.text_bytes,
    boilerplateBytes: r.boilerplate_bytes,
    vectorBytes: r.vector_bytes,
    stage: (r.stage as CompactionStage | null) ?? 'none',
    density: r.density,
  }))
}


export interface AgeBucketStats {
  documents: number
  /** Chunk count (the cheap proxy for index size that needs no table scan of the blobs). */
  chunks: number
}

export interface AgeBucketReport {
  freshWindowDays: number
  archiveAfterDays: number
  fresh: AgeBucketStats
  recent: AgeBucketStats
  archive: AgeBucketStats
  /** Documents the policy never evicts (important / manually protected), regardless of age. */
  protectedDocuments: number
}

/** Histogram of the age buckets over live, non-excluded documents (single bounded aggregate query). */
export function countAgeBuckets(db: DatabaseSync, nowMs: number, policy: AgePolicy = DEFAULT_AGE_POLICY): AgeBucketReport {
  const now = Math.trunc(Number.isFinite(nowMs) ? nowMs : Date.now())
  const freshCut = now - policy.freshWindowDays * DAY_MS
  const archiveCut = now - policy.archiveAfterDays * DAY_MS
  const rows = db
    .prepare(
      `SELECT CASE WHEN t <= 0 THEN 'recent' WHEN t >= ? THEN 'fresh' WHEN t < ? THEN 'archive' ELSE 'recent' END AS bucket,
              count(*) AS docs, coalesce(sum(chunks), 0) AS chunks
       FROM (SELECT ${LAST_TOUCH_SQL} AS t, coalesce(d.chunk_total, 0) AS chunks FROM documents d
             WHERE d.excluded = 0 AND NOT ${PROTECTED_SQL})
       GROUP BY bucket`,
    )
    .all(freshCut, archiveCut) as Array<{ bucket: AgeBucket; docs: number; chunks: number }>
  const protectedRow = db
    .prepare(`SELECT count(*) AS c FROM documents d WHERE d.excluded = 0 AND ${PROTECTED_SQL}`)
    .get() as { c: number }
  const stat = (b: AgeBucket): AgeBucketStats => {
    const r = rows.find((x) => x.bucket === b)
    return { documents: r?.docs ?? 0, chunks: r?.chunks ?? 0 }
  }
  return {
    freshWindowDays: policy.freshWindowDays,
    archiveAfterDays: policy.archiveAfterDays,
    fresh: stat('fresh'),
    recent: stat('recent'),
    archive: stat('archive'),
    protectedDocuments: protectedRow.c,
  }
}
