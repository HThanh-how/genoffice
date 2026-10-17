/**
 * Who owns a mail-merge output directory, and for how long.
 *
 * A batch grant is not a standing permission on a folder. It is minted when the
 * user picks the folder, it belongs to exactly one export, and it dies when that
 * export releases it or when the renderer that asked for it is closed, detached
 * or destroyed. Three separate maps used to hold the directory, the batch id and
 * the claimed names, and the teardown paths cleared two of them while leaving the
 * third behind — so a print that was still in flight could find its batch id
 * sitting in the map after the tab that started it had gone.
 *
 * One registry means one liveness predicate: `batchLive` is the only answer to
 * "may this request still write here?", and every handler — DOCX write, single
 * PDF export, grouped PDF merge, directory listing, release — asks the same
 * question of the same state. It lives in `shared/` rather than in the main
 * process so the lifecycle can be exercised against the real gate and the real
 * writer without launching Electron.
 */
import { randomUUID } from 'node:crypto'

/** The grant one batch holds: a directory, the names it has claimed, its identity. */
export interface MailMergeGrant {
  dir: string
  allocated: Set<string>
  batch: string
}

export interface PickResult {
  dir: string
  batch: string
}

export interface ReleaseResult {
  ok: boolean
  error?: string
}

export class MailMergeGrantRegistry {
  /** the directory each renderer picked for a batch */
  private dirs = new Map<number, string>()
  /** the same directory, as the PDF export gate sees it */
  private pdfDirs = new Map<number, string>()
  /** names this batch has already claimed, per renderer */
  private allocated = new Map<number, Set<string>>()
  /** the batch that currently owns the directory, per renderer */
  private batches = new Map<number, string>()
  /** renderers that have been closed, detached or destroyed */
  private tornDown = new Set<number>()
  /** how many pick requests each renderer has started, to retire superseded ones */
  private pickTokens = new Map<number, number>()

  isTornDown(wcId: number): boolean {
    return this.tornDown.has(wcId)
  }

  /**
   * A renderer is gone: every grant it held goes with it.
   *
   * The batch id is deleted as well as the directory. Keeping it would let a
   * request that captured the id before the tab closed still compare equal to the
   * map after the tab closed, which is exactly the check the PDF handlers rely on.
   */
  teardown(wcId: number): void {
    this.tornDown.add(wcId)
    this.dirs.delete(wcId)
    this.pdfDirs.delete(wcId)
    this.allocated.delete(wcId)
    this.batches.delete(wcId)
    this.pickTokens.delete(wcId)
  }

  /**
   * Start a directory pick.
   *
   * The dialog is an await: the tab can be closed, or a second pick can be
   * started, while it is open. The token returned here is what `completePick`
   * requires, so only the most recent request from a still-live renderer can
   * create a grant.
   */
  beginPick(wcId: number): number {
    const token = (this.pickTokens.get(wcId) ?? 0) + 1
    this.pickTokens.set(wcId, token)
    return token
  }

  /**
   * Finish a pick, or refuse it.
   *
   * Returns null when the renderer that asked has since been torn down, or when a
   * newer pick superseded this one. A cancelled dialog never calls this at all,
   * so it creates no grant. Re-picking the folder — even the identical folder —
   * mints a new batch id, which is what makes a released batch unable to write
   * into a folder the user chose again afterwards.
   */
  completePick(wcId: number, token: number, dir: string): PickResult | null {
    if (this.tornDown.has(wcId)) return null
    if (this.pickTokens.get(wcId) !== token) return null
    const batch = randomUUID()
    this.dirs.set(wcId, dir)
    this.pdfDirs.set(wcId, dir)
    this.allocated.set(wcId, new Set<string>())
    this.batches.set(wcId, batch)
    return { dir, batch }
  }

  /**
   * Give up a batch's grant.
   *
   * The release names the batch it owns. A release that names no batch, or names
   * one the tab no longer holds, is refused rather than silently revoking whatever
   * is live: a delayed close of an old dialog must not cancel a batch the user
   * started after it. Releasing the batch that is live is idempotent — releasing
   * it twice is not an error, it is just nothing left to do.
   */
  release(wcId: number, batch: unknown): ReleaseResult {
    if (this.tornDown.has(wcId)) return { ok: false, error: 'the tab is closed' }
    const current = this.batches.get(wcId)
    if (current === undefined) return { ok: true }
    if (typeof batch !== 'string' || batch.length === 0) {
      return { ok: false, error: 'the release must name the batch it owns' }
    }
    if (batch !== current) {
      return { ok: false, error: 'that batch no longer owns the output directory' }
    }
    this.dirs.delete(wcId)
    this.pdfDirs.delete(wcId)
    this.allocated.delete(wcId)
    this.batches.delete(wcId)
    return { ok: true }
  }

  /** The grant this renderer holds, or undefined when it holds none. */
  grant(wcId: number): MailMergeGrant | undefined {
    if (this.tornDown.has(wcId)) return undefined
    const dir = this.dirs.get(wcId)
    const batch = this.batches.get(wcId)
    if (!dir || !batch) return undefined
    return { dir, allocated: this.allocated.get(wcId) ?? new Set<string>(), batch }
  }

  /** Is the batch this request belongs to still the one holding the directory? */
  batchLive(wcId: number, batch: unknown): boolean {
    if (this.tornDown.has(wcId)) return false
    return typeof batch === 'string' && batch.length > 0 && this.batches.get(wcId) === batch
  }

  pdfDir(wcId: number): string | null {
    return this.pdfDirs.get(wcId) ?? null
  }

  currentBatch(wcId: number): string | null {
    return this.batches.get(wcId) ?? null
  }

  allocatedNames(wcId: number): Set<string> {
    return this.allocated.get(wcId) ?? new Set<string>()
  }
}
