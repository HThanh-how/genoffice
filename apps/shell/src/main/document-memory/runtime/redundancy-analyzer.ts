import type { DatabaseSync } from 'node:sqlite'
import { ensureRedundancySchema } from '../storage/redundancy-schema'
import { copyPenalty, familyKeyFor } from './redundancy-family'
import {
  FamilyLineCounter,
  REDUNDANCY_DEFAULTS,
  emptyFamilyModel,
  planSkeleton,
  type DocumentPlan,
  type FamilyModel,
  type PlanChunkInput,
  type RedundancyParams,
} from './redundancy-plan'
import { chunkFingerprint, foldText, fp53, splitLines } from './redundancy-text'

/**
 * Incremental redundancy analysis (B). Everything is bounded per call and cooperative:
 *   1. fingerprintChunks   - cursor on chunk id, N chunks per step (persisted `chunk_fingerprints`)
 *   2. registerDocuments   - one cheap row per new/changed document (family key from path + name)
 *   3. analyzeFamilies     - reads the text of ONE family at a time, writes ratio/bytes/duplicate links
 * Repeated maintenance only touches new or changed documents (hash / chunk set differ).
 */
export interface AnalysisOptions {
  params?: Partial<RedundancyParams>
  /** Chunks fingerprinted per call (default 4000). */
  maxChunks?: number
  /** Documents registered per call (default 500). */
  maxDocuments?: number
  /** Families analysed per call (default 20). */
  maxFamilies?: number
  yieldHook?: () => Promise<void>
  shouldContinue?: () => boolean
  now?: number
}

export interface AnalysisStats {
  fingerprintedChunks: number
  boilerplateFingerprints: number
  documentsRegistered: number
  familiesAnalyzed: number
  documentsAnalyzed: number
  duplicateGroups: number
  /** Nothing left to do for the data seen so far. */
  complete: boolean
}

export function resolveParams(partial?: Partial<RedundancyParams>): RedundancyParams {
  return { ...REDUNDANCY_DEFAULTS, ...(partial ?? {}) }
}

const FP_CURSOR_KEY = 'redundancy_fp_cursor'
const FP_BATCH = 400
const MAX_PERSISTED_LINES_PER_FAMILY = 4000

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // already closed by SQLite
    }
    throw err
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

function readCursor(db: DatabaseSync): number {
  const row = db.prepare('SELECT value FROM document_memory_meta WHERE key = ?').get(FP_CURSOR_KEY) as
    | { value: string }
    | undefined
  const n = row ? Number(row.value) : 0
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Step 1. Returns the number of chunks fingerprinted and whether the cursor reached the end. */
export async function fingerprintChunks(
  db: DatabaseSync,
  options: AnalysisOptions = {},
): Promise<{ fingerprinted: number; boilerplateAdded: number; done: boolean }> {
  ensureRedundancySchema(db)
  const params = resolveParams(options.params)
  const limit = Math.max(1, options.maxChunks ?? 4000)
  let fingerprinted = 0
  let boilerplateAdded = 0
  let cursor = readCursor(db)
  const select = db.prepare('SELECT id, document_id, text FROM chunks WHERE id > ? ORDER BY id LIMIT ?')
  const upsert = db.prepare('INSERT OR REPLACE INTO chunk_fingerprints (chunk_id, document_id, fp) VALUES (?, ?, ?)')
  const setCursor = db.prepare(
    'INSERT INTO document_memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  const upsertBoiler = db.prepare(
    `INSERT INTO boilerplate_fingerprints (fp, doc_count) VALUES (?, ?)
     ON CONFLICT(fp) DO UPDATE SET doc_count = max(doc_count, excluded.doc_count)`,
  )
  while (fingerprinted < limit) {
    if (options.shouldContinue && !options.shouldContinue()) return { fingerprinted, boilerplateAdded, done: false }
    const rows = select.all(cursor, Math.min(FP_BATCH, limit - fingerprinted)) as Array<{
      id: number
      document_id: number
      text: string
    }>
    if (rows.length === 0) return { fingerprinted, boilerplateAdded, done: true }
    inTransaction(db, () => {
      const batchFps = new Set<number>()
      for (const row of rows) {
        const fp = chunkFingerprint(row.text)
        if (fp !== null) {
          upsert.run(row.id, row.document_id, fp)
          batchFps.add(fp)
        }
      }
      if (batchFps.size > 0) {
        const fps = [...batchFps]
        const repeated = db
          .prepare(
            `SELECT fp, count(DISTINCT document_id) AS docs FROM chunk_fingerprints
             WHERE fp IN (${placeholders(fps.length)}) GROUP BY fp HAVING count(DISTINCT document_id) >= ?`,
          )
          .all(...fps, params.k) as Array<{ fp: number; docs: number }>
        for (const r of repeated) {
          upsertBoiler.run(r.fp, r.docs)
          boilerplateAdded++
        }
      }
      cursor = rows[rows.length - 1]!.id
      setCursor.run(FP_CURSOR_KEY, String(cursor))
    })
    fingerprinted += rows.length
    if (options.yieldHook) await options.yieldHook()
  }
  return { fingerprinted, boilerplateAdded, done: false }
}

/** Step 2. Cheap rows for new / changed documents (no text is read). */
export function registerDocuments(
  db: DatabaseSync,
  options: AnalysisOptions = {},
): { registered: number; done: boolean } {
  ensureRedundancySchema(db)
  const limit = Math.max(1, options.maxDocuments ?? 500)
  const now = options.now ?? Date.now()
  const rows = db
    .prepare(
      `SELECT d.id, d.path, d.name, d.hash, d.active_chunk_set_id AS set_id, coalesce(d.chunk_total, 0) AS chunks
       FROM documents d LEFT JOIN document_redundancy r ON r.document_id = d.id
       WHERE d.excluded = 0 AND coalesce(d.chunk_total, 0) >= 2 AND d.status IN ('ready', 'text-only')
         AND (r.document_id IS NULL OR r.hash IS NOT d.hash OR r.chunk_set_id IS NOT d.active_chunk_set_id)
       ORDER BY d.id LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number
    path: string
    name: string
    hash: string | null
    set_id: number | null
    chunks: number
  }>
  if (rows.length === 0) return { registered: 0, done: true }
  const keys = new Set<string>()
  inTransaction(db, () => {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO document_redundancy
         (document_id, family_key, family_size, boilerplate_ratio, content_fp, duplicate_of, chunk_count,
          text_bytes, boilerplate_bytes, vector_bytes, hash, chunk_set_id, computed_at)
       VALUES (?, ?, 1, -1, NULL, NULL, ?, 0, 0, 0, ?, ?, ?)`,
    )
    for (const row of rows) {
      const key = familyKeyFor(row.path, row.name)
      keys.add(key)
      insert.run(row.id, key, row.chunks, row.hash, row.set_id, now)
    }
    refreshFamilySizes(db, [...keys])
    // A replaced document is no longer the original / copy it was: forget links that point at it.
    const unlink = db.prepare('UPDATE document_redundancy SET duplicate_of = NULL WHERE duplicate_of = ?')
    for (const row of rows) unlink.run(row.id)
  })
  return { registered: rows.length, done: rows.length < limit }
}

function refreshFamilySizes(db: DatabaseSync, keys: string[]): void {
  const update = db.prepare(
    `UPDATE document_redundancy SET family_size =
       (SELECT count(*) FROM document_redundancy r2 WHERE r2.family_key = document_redundancy.family_key)
     WHERE family_key = ?`,
  )
  for (const key of keys) update.run(key)
}

const ACTIVE_CHUNK = '(c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)'

export interface StoredChunk {
  id: number
  ordinal: number
  text: string
  fp: number | null
}

/** Active-set chunks of a document in reading order (optionally capped by characters). */
export function readDocumentChunks(db: DatabaseSync, documentId: number, maxChars = Infinity): StoredChunk[] {
  const stmt = db.prepare(
    `SELECT c.id, c.ordinal, c.text, f.fp
     FROM chunks c JOIN documents d ON d.id = c.document_id
     LEFT JOIN chunk_fingerprints f ON f.chunk_id = c.id
     WHERE c.document_id = ? AND ${ACTIVE_CHUNK}
     ORDER BY c.ordinal, c.id`,
  )
  const out: StoredChunk[] = []
  let chars = 0
  for (const row of stmt.iterate(documentId) as Iterable<StoredChunk>) {
    out.push({ id: row.id, ordinal: row.ordinal, text: row.text, fp: row.fp ?? null })
    chars += row.text.length
    if (chars >= maxChars) break
  }
  return out
}

function globalBoilerSet(db: DatabaseSync, fps: number[]): Set<number> {
  const out = new Set<number>()
  const unique = [...new Set(fps)]
  for (let i = 0; i < unique.length; i += 500) {
    const slice = unique.slice(i, i + 500)
    const rows = db
      .prepare(`SELECT fp FROM boilerplate_fingerprints WHERE fp IN (${placeholders(slice.length)})`)
      .all(...slice) as Array<{ fp: number }>
    for (const r of rows) out.add(r.fp)
  }
  return out
}

function toPlanChunks(db: DatabaseSync, chunks: StoredChunk[]): PlanChunkInput[] {
  const globals = globalBoilerSet(
    db,
    chunks.flatMap((c) => (c.fp === null ? [] : [c.fp])),
  )
  return chunks.map((c) => ({
    id: c.id,
    ordinal: c.ordinal,
    text: c.text,
    globalBoiler: c.fp !== null && globals.has(c.fp),
  }))
}

/**
 * Family model: persisted template lines of the family + lines found in >= K distinct sibling documents of a
 * bounded sample. Skeleton-compacted siblings are not sampled (their text is already reduced); the persisted
 * lines keep recognising their template.
 */
export function buildFamilyModel(
  db: DatabaseSync,
  familyKey: string,
  paramsInput?: Partial<RedundancyParams>,
  persist = false,
): FamilyModel {
  const params = resolveParams(paramsInput)
  const persisted = db
    .prepare('SELECT fp FROM family_boilerplate_lines WHERE family_key = ?')
    .all(familyKey) as Array<{ fp: number }>
  const sampleRows = db
    .prepare(
      `SELECT r.document_id AS id, r.content_fp AS content_fp FROM document_redundancy r
       WHERE r.family_key = ?
         AND NOT EXISTS (SELECT 1 FROM document_skeleton s WHERE s.document_id = r.document_id AND s.stage = 'skeleton')
       ORDER BY r.document_id DESC LIMIT ?`,
    )
    .all(familyKey, params.maxSampleDocs * 4) as Array<{ id: number; content_fp: number | null }>
  const counter = new FamilyLineCounter()
  const seenContent = new Set<number>()
  for (const row of sampleRows) {
    if (counter.docs >= params.maxSampleDocs) break
    if (row.content_fp !== null) {
      if (seenContent.has(row.content_fp)) continue
      seenContent.add(row.content_fp)
    }
    const lines = readDocumentChunks(db, row.id, params.maxDocChars).flatMap((c) => splitLines(c.text))
    if (lines.length > 0) counter.addDocument(lines)
  }
  const derived = counter.derivedBoilerplate(params)
  if (persist && derived.length > 0) {
    const have = persisted.length
    if (have < MAX_PERSISTED_LINES_PER_FAMILY) {
      const insert = db.prepare('INSERT OR IGNORE INTO family_boilerplate_lines (family_key, fp) VALUES (?, ?)')
      inTransaction(db, () => {
        for (const fp of derived.slice(0, MAX_PERSISTED_LINES_PER_FAMILY - have)) insert.run(familyKey, fp)
      })
    }
  }
  if (!persisted.length && !derived.length && counter.docs === 0) return emptyFamilyModel(familyKey)
  return {
    familyKey,
    boiler: new Set([...persisted.map((r) => r.fp), ...derived]),
    exactFreq: counter.exact,
    sampleDocs: counter.docs,
  }
}

/** Skeleton plan of one document against its family model (reads the document's chunks). */
export function planDocument(
  db: DatabaseSync,
  documentId: number,
  model: FamilyModel,
  paramsInput?: Partial<RedundancyParams>,
  options: { duplicate?: boolean } = {},
): DocumentPlan | null {
  const chunks = readDocumentChunks(db, documentId)
  if (chunks.length < 2) return null
  return planSkeleton(toPlanChunks(db, chunks), model, resolveParams(paramsInput), options)
}

/**
 * Whole-document fingerprint for EXACT copies. Unlike the chunk fingerprints it keeps digits: invoices or contracts
 * that differ only in numbers/amounts are different documents, never copies of each other.
 */
function contentFingerprint(chunks: StoredChunk[]): number | null {
  if (chunks.length === 0) return null
  const parts = chunks.map((c) => foldText(c.text).replace(/[^\p{L}\p{N}]+/gu, ''))
  const joined = parts.join('|')
  return joined.length < 8 ? null : fp53(joined)
}

interface RedundancyRow {
  document_id: number
  family_key: string
  boilerplate_ratio: number
  hash: string | null
}

/** Step 3. Analyse up to `maxFamilies` families that still have unanalysed members. */
export async function analyzeFamilies(
  db: DatabaseSync,
  options: AnalysisOptions = {},
): Promise<{ families: number; documents: number; duplicateGroups: number; done: boolean }> {
  ensureRedundancySchema(db)
  const params = resolveParams(options.params)
  const now = options.now ?? Date.now()
  const limit = Math.max(1, options.maxFamilies ?? 20)
  const pendingFamilies = db
    .prepare(
      `SELECT family_key FROM document_redundancy WHERE boilerplate_ratio < 0
       GROUP BY family_key ORDER BY min(document_id) LIMIT ?`,
    )
    .all(limit) as Array<{ family_key: string }>
  let documents = 0
  let families = 0
  const touchedContent = new Set<number>()
  for (const { family_key: familyKey } of pendingFamilies) {
    if (options.shouldContinue && !options.shouldContinue()) break
    const pending = db
      .prepare('SELECT document_id, family_key, boilerplate_ratio, hash FROM document_redundancy WHERE family_key = ? AND boilerplate_ratio < 0')
      .all(familyKey) as unknown as RedundancyRow[]
    // 3a. content fingerprints of the pending members (exact-copy detection + sample de-duplication)
    inTransaction(db, () => {
      const setFp = db.prepare('UPDATE document_redundancy SET content_fp = ? WHERE document_id = ?')
      for (const row of pending) {
        const fp = contentFingerprint(readDocumentChunks(db, row.document_id))
        setFp.run(fp, row.document_id)
        if (fp !== null) touchedContent.add(fp)
      }
    })
    // 3b. family model, template lines persisted
    const model = buildFamilyModel(db, familyKey, params, true)
    // 3c. per-document statistics
    const vectorBytes = db.prepare(
      `SELECT coalesce(sum(length(e.vector)), 0) AS b FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = ?`,
    )
    const results = pending.map((row) => {
      const chunks = readDocumentChunks(db, row.document_id)
      const plan = planSkeleton(toPlanChunks(db, chunks), model, params)
      const textBytes = chunks.reduce((sum, c) => sum + c.text.length, 0)
      const boilerplateBytes = Math.round(plan.boilerplateRatio * plan.totalChars)
      const vb = (vectorBytes.get(row.document_id) as { b: number }).b
      return { id: row.document_id, ratio: plan.boilerplateRatio, textBytes, boilerplateBytes, vb }
    })
    inTransaction(db, () => {
      const update = db.prepare(
        `UPDATE document_redundancy SET boilerplate_ratio = ?, text_bytes = ?, boilerplate_bytes = ?, vector_bytes = ?, computed_at = ?
         WHERE document_id = ?`,
      )
      for (const r of results) update.run(r.ratio, r.textBytes, r.boilerplateBytes, r.vb, now, r.id)
    })
    documents += results.length
    families++
    if (options.yieldHook) await options.yieldHook()
  }
  const duplicateGroups = resolveDuplicates(db, [...touchedContent])
  const remaining = db.prepare('SELECT 1 FROM document_redundancy WHERE boilerplate_ratio < 0 LIMIT 1').get()
  return { families, documents, duplicateGroups, done: !remaining }
}

/** Exact copies: same content fingerprint -> the cleanest-named, shortest-path, oldest document is the original. */
function resolveDuplicates(db: DatabaseSync, contentFps: number[]): number {
  let groups = 0
  inTransaction(db, () => {
    const members = db.prepare(
      `SELECT r.document_id AS id, d.name, d.path FROM document_redundancy r JOIN documents d ON d.id = r.document_id
       WHERE r.content_fp = ? AND d.excluded = 0`,
    )
    const setDup = db.prepare('UPDATE document_redundancy SET duplicate_of = ? WHERE document_id = ?')
    for (const fp of contentFps) {
      const rows = members.all(fp) as Array<{ id: number; name: string; path: string }>
      if (rows.length < 2) {
        for (const r of rows) setDup.run(null, r.id)
        continue
      }
      rows.sort(
        (a, b) => copyPenalty(a.name) - copyPenalty(b.name) || a.path.length - b.path.length || a.id - b.id,
      )
      const original = rows[0]!
      setDup.run(null, original.id)
      for (const r of rows.slice(1)) setDup.run(original.id, r.id)
      groups++
    }
  })
  return groups
}

/** Run the three steps once (each bounded by its own limit). Call repeatedly until `complete`. */
export async function analyzeRedundancy(db: DatabaseSync, options: AnalysisOptions = {}): Promise<AnalysisStats> {
  ensureRedundancySchema(db)
  const fp = await fingerprintChunks(db, options)
  const reg = registerDocuments(db, options)
  const fam = await analyzeFamilies(db, options)
  const stats: AnalysisStats = {
    fingerprintedChunks: fp.fingerprinted,
    boilerplateFingerprints: fp.boilerplateAdded,
    documentsRegistered: reg.registered,
    familiesAnalyzed: fam.families,
    documentsAnalyzed: fam.documents,
    duplicateGroups: fam.duplicateGroups,
    complete: fp.done && reg.done && fam.done,
  }
  return stats
}

/** Drive analyzeRedundancy until complete / cancelled / `maxRounds`. Returns the summed stats. */
export async function analyzeRedundancyFully(
  db: DatabaseSync,
  options: AnalysisOptions & { maxRounds?: number } = {},
): Promise<AnalysisStats> {
  const total: AnalysisStats = {
    fingerprintedChunks: 0,
    boilerplateFingerprints: 0,
    documentsRegistered: 0,
    familiesAnalyzed: 0,
    documentsAnalyzed: 0,
    duplicateGroups: 0,
    complete: false,
  }
  for (let round = 0; round < (options.maxRounds ?? 200); round++) {
    if (options.shouldContinue && !options.shouldContinue()) break
    const s = await analyzeRedundancy(db, options)
    total.fingerprintedChunks += s.fingerprintedChunks
    total.boilerplateFingerprints += s.boilerplateFingerprints
    total.documentsRegistered += s.documentsRegistered
    total.familiesAnalyzed += s.familiesAnalyzed
    total.documentsAnalyzed += s.documentsAnalyzed
    total.duplicateGroups += s.duplicateGroups
    if (s.complete) {
      total.complete = true
      break
    }
    if (options.yieldHook) await options.yieldHook()
  }
  return total
}
