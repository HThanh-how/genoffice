import { statSync, createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, extname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { DocumentMemoryStore, DocumentMemoryHit, StoredDocument } from '../store'
import type { FreshDocumentMemoryHit } from './search-service'
import type { FileStabilityGate } from '../file-stability'
import { volumeRootOf } from '../volume-root'
import { discoveredPathAdmission } from '../artifact-policy'
import { isIndexableExtension, isJunkFileName } from '../scan-policy'
import { mediaKindOfPath } from '../media/media-kinds'
import { MediaMetadataFiller } from '../media/media-filler'
import { MAX_DOCUMENT_BYTES } from '../folder-scan'
import type { PendingMetadataIntakeAdapter } from './pending-metadata-intake'

export type StatOutcome =
  | { kind: 'file'; mtimeMs: number; sizeBytes: number }
  | { kind: 'other' }
  | { kind: 'gone' }
  | { kind: 'unknown' }

export interface MissingCandidate {
  path: string
  sizeBytes: number
  hash: string
}

export interface FreshnessCoordinatorOptions {
  store: DocumentMemoryStore
  tombstoneGraceMs?: number
  onEnqueue?: (path: string, prioritize?: boolean, sizeBytes?: number) => void
  onTombstone?: (path: string) => Promise<void>
  onInvalidatePath?: (path: string) => void
  isStopped?: () => boolean
  isEnabled?: () => boolean
  stabilityRetryScheduleMs?: number[]
  intakeAdapter?: PendingMetadataIntakeAdapter
}

const RENAME_HASH_MAX_BYTES = 64 * 1024 * 1024
const FRESHNESS_STAT_TIMEOUT_MS = 1_500

function pathKey(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

function safeStat(path: string): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const s = statSync(path)
    return s.isFile() ? { mtimeMs: s.mtimeMs, sizeBytes: s.size } : null
  } catch {
    return null
  }
}

/** Documents are read (and capped); media is only listed and header-probed, so no size cap applies. */
function withinSizeLimit(path: string, sizeBytes: number): boolean {
  return mediaKindOfPath(path) !== null || sizeBytes <= MAX_DOCUMENT_BYTES
}

function addCandidate(map: Map<number, MissingCandidate[]>, c: MissingCandidate): void {
  const list = map.get(c.sizeBytes)
  if (list) list.push(c)
  else map.set(c.sizeBytes, [c])
}

function createYielder(intervalMs = 8): () => Promise<void> {
  let last = Date.now()
  return async () => {
    if (Date.now() - last >= intervalMs) {
      await new Promise<void>((r) => setImmediate(r))
      last = Date.now()
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  return new Promise((resolve, reject) => {
    stream.on('data', (data) => hash.update(data))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export class FreshnessCoordinator {
  private readonly missing = new Map<
    string,
    { candidate: MissingCandidate | null; timer: NodeJS.Timeout }
  >()
  private readonly stabilityRetries = new Map<string, { timer: NodeJS.Timeout }>()
  private readonly stabilityRetryScheduleMs: number[]
  private readonly tombstoneGraceMs: number

  constructor(private readonly options: FreshnessCoordinatorOptions) {
    this.tombstoneGraceMs = options.tombstoneGraceMs ?? 300_000
    this.stabilityRetryScheduleMs = options.stabilityRetryScheduleMs ?? [15_000, 30_000, 60_000]
  }

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  private mediaFiller: MediaMetadataFiller | null = null
  private mediaStarted = false

  private filler(): MediaMetadataFiller {
    return (this.mediaFiller ??= new MediaMetadataFiller(this.store.rawDb, {
      shouldRun: () => !this.options.isStopped?.() && (this.options.isEnabled?.() ?? true),
    }))
  }

  /** Read every pending image/video header now (the background filler does this by itself, a few files at a time). */
  drainMediaMetadata(): Promise<number> {
    return this.filler().drain()
  }

  /** Images/videos: name + metadata row, no extraction queue. True when a row was created or its file changed. */
  private indexMedia(path: string, current: { mtimeMs: number; sizeBytes: number }): boolean {
    const { outcome } = this.store.enrollMedia(path, current.mtimeMs, current.sizeBytes)
    if (outcome === 'skipped' || outcome === 'excluded' || outcome === 'refused') return false
    // Unchanged rows have nothing to read; the first call also resumes headers left over from a previous session.
    if (outcome !== 'unchanged' || !this.mediaStarted) {
      this.mediaStarted = true
      this.filler().kick()
    }
    return outcome === 'created' || outcome === 'updated'
  }

  indexDiscoveredFile(
    path: string,
    metadata?: { mtimeMs: number; sizeBytes: number },
  ): boolean {
    if (this.options.isStopped?.()) return false
    const p = resolve(path)
    const admission = discoveredPathAdmission(p)
    if (!admission.allowed) return false
    const current = metadata ?? safeStat(p)
    if (!current) return false
    if (this.options.isEnabled && !this.options.isEnabled()) {
      this.options.intakeAdapter?.onDiscovered(p, current)
      return false
    }
    if (mediaKindOfPath(p)) return this.indexMedia(p, current)
    const needsIndex = this.store.enrollDiscovered(p, current.mtimeMs, current.sizeBytes)
    const document = this.store.documentByPath(p)
    if (!document || document.status === 'excluded') {
      if (!document) {
        this.options.intakeAdapter?.onDiscovered(p, current)
      }
      return false
    }
    if (!needsIndex && (document.mtimeMs !== current.mtimeMs || document.sizeBytes !== current.sizeBytes)) {
      this.options.intakeAdapter?.onDiscovered(p, current)
    }
    if (needsIndex && document.status !== 'pending' && document.status !== 'text-only') {
      try {
        this.store.rawDb
          .prepare(
            "UPDATE documents SET status = 'pending', priority_at = max(priority_at, ?) WHERE id = ?",
          )
          .run(current.mtimeMs, document.id)
      } catch {}
    }
    if (
      needsIndex &&
      (this.options.isEnabled?.() ?? true) &&
      (document.status === 'pending' ||
        document.status === 'text-only' ||
        document.mtimeMs !== current.mtimeMs ||
        document.sizeBytes !== current.sizeBytes)
    ) {
      this.options.onEnqueue?.(p, false, current.sizeBytes)
    }
    return needsIndex
  }

  prioritizeFolder(folder: string): number {
    const now = Date.now()
    this.store.boostFolder(folder, now)
    let moved = 0
    for (const doc of this.store.documentsUnder(folder)) {
      if (doc.status === 'pending') {
        this.options.onEnqueue?.(doc.path, true)
        moved++
      }
    }
    return moved
  }

  async reconcileFolder(
    root: string,
    files: Map<string, { mtimeMs: number; sizeBytes: number }>,
  ): Promise<{ added: number; changed: number; moved: number; removed: number }> {
    const result = { added: 0, changed: 0, moved: 0, removed: 0 }
    if (this.options.isStopped?.()) return result
    const seen = new Set<string>()
    for (const path of files.keys()) seen.add(pathKey(path))
    const candidates = new Map<number, MissingCandidate[]>()
    const gone: StoredDocument[] = []
    const maybeYield = createYielder()

    for (let afterId = 0; ;) {
      const page = this.store.documentsUnderPage(root, afterId, 500)
      if (!page.length) break
      afterId = page[page.length - 1]!.id
      for (const row of page) {
        if (seen.has(pathKey(row.path))) continue
        await maybeYield()
        if (this.options.isStopped?.()) return result
        if (!(await this.isGone(row.path))) continue
        gone.push(row)
        if (row.hash && row.sizeBytes !== null)
          addCandidate(candidates, { path: row.path, sizeBytes: row.sizeBytes, hash: row.hash })
      }
      await maybeYield()
    }

    for (const [path, meta] of files) {
      if (this.options.isStopped?.()) return result
      await maybeYield()
      if (this.store.documentByPath(path)) {
        if (this.indexDiscoveredFile(path, meta)) result.changed++
        continue
      }
      const outcome = await this.enrollNew(path, meta, candidates)
      if (outcome === 'moved') result.moved++
      else if (outcome === 'indexed') result.added++
    }

    for (const row of gone) {
      if (this.options.isStopped?.()) return result
      if (!this.store.documentByPath(row.path)) continue
      await this.tombstone(row.path)
      result.removed++
    }
    return result
  }

  private async enrollNew(
    path: string,
    meta: { mtimeMs: number; sizeBytes: number },
    candidates: Map<number, MissingCandidate[]>,
  ): Promise<'moved' | 'indexed' | 'skipped'> {
    // Photos and videos are never hashed for rename detection (that would read every file in full).
    if (mediaKindOfPath(path)) return this.indexDiscoveredFile(path, meta) ? 'indexed' : 'skipped'
    let fileSha: string | null | undefined
    const list = candidates.get(meta.sizeBytes)
    if (list?.length && meta.sizeBytes <= RENAME_HASH_MAX_BYTES) {
      fileSha = await hashFile(path).catch(() => null)
      const index = fileSha ? list.findIndex((candidate) => candidate.hash === fileSha) : -1
      if (index >= 0 && this.moveIndexed(list[index]!.path, path, meta)) {
        list.splice(index, 1)
        return 'moved'
      }
    }
    if (meta.sizeBytes <= RENAME_HASH_MAX_BYTES && this.hasOtherDocumentOfSize(path, meta.sizeBytes)) {
      // A moved file keeps its size, so a file no other document matches in size is new and is never read or hashed.
      if (fileSha === undefined) fileSha = await hashFile(path).catch(() => null)
      if (fileSha) {
        try {
          const rows = this.store.rawDb
            .prepare(
              'SELECT path FROM documents WHERE hash = ? AND size_bytes = ? AND path != ? AND excluded = 0',
            )
            .all(fileSha, meta.sizeBytes, path) as Array<{ path: string }>
          for (const row of rows) {
            if (await this.isGone(row.path)) {
              if (this.moveIndexed(row.path, path, meta)) return 'moved'
            }
          }
        } catch {}
      }
    }
    return this.indexDiscoveredFile(path, meta) ? 'indexed' : 'skipped'
  }

  /** Indexed probe (documents_size_bytes): a full table scan per new file made a folder scan of a big index saturate the main thread. */
  private hasOtherDocumentOfSize(path: string, sizeBytes: number): boolean {
    try {
      return !!this.store.rawDb
        .prepare('SELECT 1 FROM documents WHERE size_bytes = ? AND path != ? AND excluded = 0 LIMIT 1')
        .get(sizeBytes, path)
    } catch {
      return true
    }
  }

  moveIndexed(
    oldPath: string,
    newPath: string,
    meta: { mtimeMs: number; sizeBytes: number },
  ): boolean {
    if (this.options.isStopped?.()) return false
    this.options.onInvalidatePath?.(oldPath)
    this.options.intakeAdapter?.onMoved?.(oldPath, newPath)
    const oldKey = pathKey(oldPath)
    const pending = this.missing.get(oldKey)
    if (pending) {
      clearTimeout(pending.timer)
      this.missing.delete(oldKey)
    }
    if (this.store.documentByPath(newPath)) return false
    try {
      this.store.move(oldPath, newPath)
    } catch {
      return false
    }
    this.store.touchMetadata(newPath, meta.mtimeMs, meta.sizeBytes)
    const status = this.store.documentByPath(newPath)?.status
    if (status === 'pending' || status === 'text-only') {
      this.options.onEnqueue?.(newPath)
    }
    return true
  }

  async tombstone(path: string): Promise<void> {
    this.options.intakeAdapter?.onCanceled?.(path)
    if (this.options.onTombstone) {
      await this.options.onTombstone(path)
    } else {
      await this.store.tombstoneSliced(path)
    }
  }

  markMissing(path: string): void {
    const key = pathKey(path)
    if (this.missing.has(key)) return
    const doc = this.store.documentByPath(path)
    if (!doc || doc.status === 'excluded') return
    const candidate: MissingCandidate | null =
      doc.hash && doc.sizeBytes !== null ? { path, sizeBytes: doc.sizeBytes, hash: doc.hash } : null
    const timer = setTimeout(() => void this.finalizeMissing(path), this.tombstoneGraceMs)
    timer.unref?.()
    this.missing.set(key, { candidate, timer })
  }

  async finalizeMissing(path: string): Promise<void> {
    this.missing.delete(pathKey(path))
    if (await this.isGone(path)) {
      await this.tombstone(path)
    }
  }

  async annotateFreshness(hits: DocumentMemoryHit[]): Promise<FreshDocumentMemoryHit[]> {
    const byPath = new Map<string, Promise<'fresh' | 'stale' | 'missing' | 'unverified'>>()
    for (const hit of hits) {
      const key = pathKey(hit.path)
      if (!byPath.has(key)) byPath.set(key, this.checkFreshness(hit))
    }
    const outcomes = new Map<string, 'fresh' | 'stale' | 'missing' | 'unverified'>()
    for (const [key, outcome] of byPath) outcomes.set(key, await outcome)
    for (const hit of hits) {
      if (this.options.isStopped?.()) break
      const key = pathKey(hit.path)
      const outcome = outcomes.get(key) ?? 'fresh'
      if (outcome === 'stale') this.options.onEnqueue?.(hit.path, true)
      else if (outcome === 'missing') this.markMissing(hit.path)
    }
    return hits.map((hit) => {
      const outcome = outcomes.get(pathKey(hit.path)) ?? 'fresh'
      return {
        ...hit,
        stale: outcome !== 'fresh',
        missing: outcome === 'missing',
        unverified: outcome === 'unverified',
      }
    })
  }

  private async checkFreshness(hit: DocumentMemoryHit): Promise<'fresh' | 'stale' | 'missing' | 'unverified'> {
    if (hit.mtimeMs === null || hit.sizeBytes === null) return 'unverified'
    const current = await this.statOutcome(hit.path, FRESHNESS_STAT_TIMEOUT_MS)
    if (current.kind === 'gone') return 'missing'
    if (current.kind === 'file')
      return current.mtimeMs !== hit.mtimeMs || current.sizeBytes !== hit.sizeBytes
        ? 'stale'
        : 'fresh'
    return 'unverified'
  }

  async handleFileEvents(paths: string[], stabilityGate: FileStabilityGate): Promise<void> {
    if (this.options.isStopped?.()) return
    const present: Array<{ path: string; meta: { mtimeMs: number; sizeBytes: number } }> = []

    await Promise.all(
      paths.map(async (raw) => {
        if (this.options.isStopped?.()) return
        const path = resolve(raw)
        if (this.store.documentByPath(path)?.status === 'excluded') {
          this.clearStabilityRetry(path)
          return
        }
        const outcome = await stabilityGate.waitForStability(path)
        if (this.options.isStopped?.()) return
        if (outcome.kind === 'gone') {
          this.clearStabilityRetry(path)
          if (this.store.documentByPath(path)) this.markMissing(path)
        } else if (
          outcome.kind === 'stable' &&
          isIndexableExtension(extname(path)) && !isJunkFileName(basename(path)) &&
          withinSizeLimit(path, outcome.file.sizeBytes)
        ) {
          this.clearStabilityRetry(path)
          present.push({
            path,
            meta: { mtimeMs: outcome.file.mtimeMs, sizeBytes: outcome.file.sizeBytes },
          })
        } else if (outcome.kind === 'timeout' || outcome.kind === 'unavailable') {
          this.scheduleStabilityRetry(path, 0, stabilityGate)
        }
      }),
    )

    // Candidates MUST be gathered AFTER Promise.all has marked missing files (e.g. from rename / move)
    const candidates = new Map<number, MissingCandidate[]>()
    for (const entry of this.missing.values()) {
      if (entry.candidate) addCandidate(candidates, entry.candidate)
    }

    const maybeYield = createYielder()
    for (const { path, meta } of present) {
      if (this.options.isStopped?.()) return
      await maybeYield()
      if (this.store.documentByPath(path)) this.indexDiscoveredFile(path, meta)
      else await this.enrollNew(path, meta, candidates)
    }
  }

  private scheduleStabilityRetry(path: string, attempt: number, stabilityGate: FileStabilityGate): void {
    if (this.options.isStopped?.()) return
    if (!isIndexableExtension(extname(path)) || isJunkFileName(basename(path))) return
    const doc = this.store.documentByPath(path)
    if (doc?.status === 'excluded') {
      this.clearStabilityRetry(path)
      return
    }
    if (attempt >= this.stabilityRetryScheduleMs.length) {
      this.clearStabilityRetry(path)
      return
    }

    const key = pathKey(path)
    const existing = this.stabilityRetries.get(key)
    if (existing) clearTimeout(existing.timer)

    const delayMs = this.stabilityRetryScheduleMs[attempt] ?? 15_000
    const timer = setTimeout(() => {
      this.stabilityRetries.delete(key)
      void this.retryStabilityCheck(path, attempt + 1, stabilityGate)
    }, delayMs)
    timer.unref?.()
    this.stabilityRetries.set(key, { timer })
  }

  private async retryStabilityCheck(path: string, nextAttempt: number, stabilityGate: FileStabilityGate): Promise<void> {
    if (this.options.isStopped?.()) return
    const outcome = await stabilityGate.waitForStability(path)
    if (this.options.isStopped?.()) return
    if (outcome.kind === 'stable') {
      this.clearStabilityRetry(path)
      if (isIndexableExtension(extname(path)) && !isJunkFileName(basename(path)) && withinSizeLimit(path, outcome.file.sizeBytes)) {
        const meta = { mtimeMs: outcome.file.mtimeMs, sizeBytes: outcome.file.sizeBytes }
        if (this.store.documentByPath(path)) {
          this.indexDiscoveredFile(path, meta)
        } else {
          const candidates = new Map<number, MissingCandidate[]>()
          for (const entry of this.missing.values()) {
            if (entry.candidate) addCandidate(candidates, entry.candidate)
          }
          await this.enrollNew(path, meta, candidates)
        }
      }
    } else if (outcome.kind === 'gone') {
      this.clearStabilityRetry(path)
      if (this.store.documentByPath(path)) {
        this.markMissing(path)
      }
    } else if (outcome.kind === 'timeout' || outcome.kind === 'unavailable') {
      this.scheduleStabilityRetry(path, nextAttempt, stabilityGate)
    }
  }

  clearStabilityRetry(path: string): void {
    const key = pathKey(path)
    const entry = this.stabilityRetries.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      this.stabilityRetries.delete(key)
    }
  }

  clearAllStabilityRetries(): void {
    for (const entry of this.stabilityRetries.values()) clearTimeout(entry.timer)
    this.stabilityRetries.clear()
  }

  async isGone(path: string): Promise<boolean> {
    if ((await this.statOutcome(path, 1000)).kind !== 'gone') return false
    const root = await this.statOutcome(volumeRootOf(path), 1000)
    return root.kind === 'other' || root.kind === 'file'
  }

  async sourceUnavailable(path: string): Promise<boolean> {
    const root = await this.statOutcome(volumeRootOf(path), 1000)
    return root.kind === 'gone' || root.kind === 'unknown'
  }

  async statOutcome(path: string, timeoutMs = 1000): Promise<StatOutcome> {
    let timer: NodeJS.Timeout | undefined
    const lookup: Promise<StatOutcome> = stat(path).then(
      (value): StatOutcome =>
        value.isFile()
          ? { kind: 'file', mtimeMs: value.mtimeMs, sizeBytes: value.size }
          : { kind: 'other' },
      (error: NodeJS.ErrnoException): StatOutcome =>
        error.code === 'ENOENT' || error.code === 'ENOTDIR'
          ? { kind: 'gone' }
          : { kind: 'unknown' },
    )
    const timeout = new Promise<StatOutcome>((done) => {
      timer = setTimeout(() => done({ kind: 'unknown' }), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([lookup, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async verifyExtractedFreshness(
    path: string,
    extracted: { mtimeMs: number; sizeBytes: number },
  ): Promise<{ kind: 'fresh' | 'modified'; meta: { mtimeMs: number; sizeBytes: number } } | { kind: 'gone' }> {
    const outcome = await this.statOutcome(path, 1500)
    if (outcome.kind !== 'file') return { kind: 'gone' }
    if (outcome.mtimeMs !== extracted.mtimeMs || outcome.sizeBytes !== extracted.sizeBytes) {
      return { kind: 'modified', meta: outcome }
    }
    return { kind: 'fresh', meta: outcome }
  }

  async handleExtractedFreshness(
    path: string,
    extracted: { mtimeMs: number; sizeBytes: number },
  ): Promise<boolean> {
    const check = await this.verifyExtractedFreshness(path, extracted)
    if (check.kind === 'fresh') return true
    this.options.onInvalidatePath?.(path)
    if (check.kind === 'modified') {
      this.indexDiscoveredFile(path, check.meta)
    } else {
      this.markMissing(path)
    }
    return false
  }

  clearMissing(): void {
    for (const entry of this.missing.values()) clearTimeout(entry.timer)
    this.missing.clear()
    this.clearAllStabilityRetries()
  }
}
