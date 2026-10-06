import { stat } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import type { DocumentMemoryStore } from '../store'
import { volumeRootOf } from '../volume-root'
import { discoveredPathAdmission } from '../artifact-policy'

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
  onEnqueue?: (path: string, prioritize?: boolean) => void
  onTombstone?: (path: string) => Promise<void>
}

export class FreshnessCoordinator {
  private readonly missing = new Map<
    string,
    { candidate: MissingCandidate | null; timer: NodeJS.Timeout }
  >()
  private readonly tombstoneGraceMs: number

  constructor(private readonly options: FreshnessCoordinatorOptions) {
    this.tombstoneGraceMs = options.tombstoneGraceMs ?? 300_000
  }

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  indexDiscoveredFile(
    path: string,
    meta: { mtimeMs: number; sizeBytes: number },
  ): boolean {
    const p = resolve(path)
    const admission = discoveredPathAdmission(p)
    if (!admission.allowed) return false
    const needed = this.store.enrollDiscovered(p, meta.mtimeMs, meta.sizeBytes)
    if (needed) this.options.onEnqueue?.(p)
    return needed
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

  moveIndexed(
    oldPath: string,
    newPath: string,
    meta: { mtimeMs: number; sizeBytes: number },
  ): boolean {
    const pending = this.missing.get(oldPath)
    if (pending) {
      clearTimeout(pending.timer)
      this.missing.delete(oldPath)
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

  markMissing(path: string): void {
    if (this.missing.has(path)) return
    const doc = this.store.documentByPath(path)
    if (!doc || doc.status === 'excluded') return
    const candidate: MissingCandidate | null =
      doc.hash && doc.sizeBytes !== null ? { path, sizeBytes: doc.sizeBytes, hash: doc.hash } : null
    const timer = setTimeout(() => void this.finalizeMissing(path), this.tombstoneGraceMs)
    timer.unref?.()
    this.missing.set(path, { candidate, timer })
  }

  private async finalizeMissing(path: string): Promise<void> {
    this.missing.delete(path)
    if (await this.isGone(path)) {
      await this.options.onTombstone?.(path)
    }
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

  clearMissing(): void {
    for (const entry of this.missing.values()) clearTimeout(entry.timer)
    this.missing.clear()
  }
}
