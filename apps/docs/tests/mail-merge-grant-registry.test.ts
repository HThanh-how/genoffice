/**
 * The grant registry: who owns an output directory, and when that ownership ends.
 *
 * These are the four lifecycle defects the audit found, exercised against the
 * registry the main process actually uses, the gate that answers "is this path
 * authorized?" (`pdfWriteTarget`) and the writer that opens the file
 * (`writeMailMergeOutput` through `commitPdfOutput`). Nothing here is a boolean
 * stand-in: every assertion is about a file that either is or is not on disk.
 *
 * S1 — a renderer torn down while Chromium is printing still held a batch id in
 *      the map, so the post-print identity check compared equal and the PDF was
 *      written by a tab that no longer exists.
 * S3 — release revoked whatever the tab held, so a delayed close of an old dialog
 *      cancelled a batch the user had started afterwards.
 * S4 — the directory dialog is an await; a pick that resolved after the tab was
 *      closed, or after a newer pick, created a grant for a renderer that no
 *      longer owned the request.
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MailMergeGrantRegistry } from '../src/shared/mail-merge-grants'
import { pdfWriteTarget, type PdfAuthContext } from '../src/shared/pdf-write-auth'
import { containedTarget, posixRules } from '../src/shared/output-containment'

const contained = (dir: string, path: string) =>
  containedTarget(dir, path, posixRules, existsSync, realpathSync)

const freshDir = () => mkdtemp(join(tmpdir(), 'genoffice-grants-'))
const listing = async (dir: string) => (await readdir(dir)).sort()

/**
 * The same wiring `docs:export-pdf` / `docs:save-merged-pdf` build in the main
 * process: the gate reads its state from the registry, and the commit re-asks
 * the registry at the moment the file is opened.
 */
function harness(registry: MailMergeGrantRegistry, allowedPaths: Set<string> = new Set()) {
  return {
    target(wcId: number, filePath: string, overwrite: unknown, batch: unknown) {
      const ctx: PdfAuthContext = {
        tornDown: registry.isTornDown(wcId),
        batchDir: registry.pdfDir(wcId),
        currentBatch: registry.currentBatch(wcId),
        claimedBatch: batch,
        allocated: registry.allocatedNames(wcId),
        testExportDir: null,
        isImageTemp: () => false,
        allowedPaths,
        contained,
      }
      return pdfWriteTarget(filePath, overwrite, ctx)
    },
  }
}

describe('S4: a pick that resolves after its renderer is gone creates no grant', () => {
  it('creates a grant when the picker completes normally', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const token = registry.beginPick(1)
    const picked = registry.completePick(1, token, dir)
    expect(picked).not.toBeNull()
    expect(registry.batchLive(1, picked!.batch)).toBe(true)
    expect(registry.grant(1)?.dir).toBe(dir)
  })

  it('refuses a pick whose renderer closed while the dialog was open', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const token = registry.beginPick(1)
    // the tab is closed before the native dialog returns
    registry.teardown(1)
    expect(registry.completePick(1, token, dir)).toBeNull()
    expect(registry.grant(1)).toBeUndefined()
    expect(registry.pdfDir(1)).toBeNull()
    expect(await listing(dir)).toEqual([])
  })

  it('a superseded pick cannot overwrite the grant the newest pick created', async () => {
    const dirA = await freshDir()
    const dirB = await freshDir()
    const registry = new MailMergeGrantRegistry()
    // two dialogs are open at once; the second one resolves first, the first
    // resolves later — the older result must not replace the newer grant
    const tokenA = registry.beginPick(1)
    const tokenB = registry.beginPick(1)
    const pickedB = registry.completePick(1, tokenB, dirB)
    const pickedA = registry.completePick(1, tokenA, dirA)
    expect(pickedA).toBeNull()
    expect(registry.grant(1)?.dir).toBe(dirB)
    expect(registry.currentBatch(1)).toBe(pickedB!.batch)
  })

  it('a cancelled pick creates no grant at all', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    registry.beginPick(1)
    // the user cancelled: completePick is never reached, so nothing is granted
    // and nothing is written
    expect(registry.grant(1)).toBeUndefined()
    expect(registry.pdfDir(1)).toBeNull()
    expect(await listing(dir)).toEqual([])
  })

  it('re-picking the same folder mints a distinct identity', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const first = registry.completePick(1, registry.beginPick(1), dir)
    const second = registry.completePick(1, registry.beginPick(1), dir)
    expect(first!.batch).not.toBe(second!.batch)
    expect(registry.batchLive(1, first!.batch)).toBe(false)
    expect(registry.batchLive(1, second!.batch)).toBe(true)
  })

  it('a stale pick cannot resurrect a revoked authorization', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const token = registry.beginPick(1)
    const first = registry.completePick(1, token, dir)
    registry.release(1, first!.batch)
    expect(registry.grant(1)).toBeUndefined()
    // a newer pick has been started (and cancelled); the older request's late
    // result must not re-create a grant for a request that no longer owns it
    registry.beginPick(1)
    expect(registry.completePick(1, token, dir)).toBeNull()
    expect(registry.grant(1)).toBeUndefined()
  })
})

describe('S3: release is batch-specific', () => {
  it('releases the batch that owns the directory', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    expect(registry.release(1, batch)).toEqual({ ok: true })
    expect(registry.grant(1)).toBeUndefined()
    expect(registry.pdfDir(1)).toBeNull()
  })

  it('releasing twice is not an error', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    expect(registry.release(1, batch).ok).toBe(true)
    expect(registry.release(1, batch).ok).toBe(true)
  })

  it('a release from the old batch does not revoke the new one', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const old = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const fresh = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const result = registry.release(1, old)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no longer owns')
    // the batch that actually holds the folder is still live
    expect(registry.batchLive(1, fresh)).toBe(true)
    expect(registry.grant(1)?.dir).toBe(dir)
  })

  it('a release that names no batch is refused rather than revoking the live grant', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    for (const bad of [undefined, null, '', 0, false, {}, 'not-a-batch']) {
      const result = registry.release(1, bad)
      expect(result.ok, `release(${String(bad)}) must not revoke the grant`).toBe(false)
    }
    expect(registry.batchLive(1, batch)).toBe(true)
  })

  it('release after teardown reports the tab is closed', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    registry.teardown(1)
    const result = registry.release(1, batch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('closed')
    expect(registry.grant(1)).toBeUndefined()
  })

  it('one tab grant is independent of another tab grant', async () => {
    const dirA = await freshDir()
    const dirB = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const a = registry.completePick(1, registry.beginPick(1), dirA)!.batch
    const b = registry.completePick(2, registry.beginPick(2), dirB)!.batch
    registry.release(1, a)
    expect(registry.grant(1)).toBeUndefined()
    expect(registry.grant(2)?.dir).toBe(dirB)
    expect(registry.batchLive(2, b)).toBe(true)
  })
})

describe('S1: teardown invalidates every batch grant', () => {
  it('a torn-down renderer cannot authorize a PDF write, even with its own token', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const gate = harness(registry)
    const before = gate.target(1, join(dir, '1_Alpha.pdf'), 'overwrite', batch)
    expect(before).not.toBeNull()
    registry.teardown(1)
    // the batch id is gone from the registry, so a request that captured it
    // before the tab closed compares equal to nothing
    expect(registry.currentBatch(1)).toBeNull()
    expect(registry.batchLive(1, batch)).toBe(false)
    expect(gate.target(1, join(dir, '1_Alpha.pdf'), 'overwrite', batch)).toBeNull()
    expect(await listing(dir)).toEqual([])
  })

  it('teardown clears the directory, the batch and the claimed names together', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    registry.allocatedNames(1).add('1_Alpha.pdf')
    registry.teardown(1)
    expect(registry.pdfDir(1)).toBeNull()
    expect(registry.currentBatch(1)).toBeNull()
    expect(registry.batchLive(1, batch)).toBe(false)
    expect(registry.allocatedNames(1)).toEqual(new Set<string>())
    expect(registry.grant(1)).toBeUndefined()
  })

  it('a grant created after teardown is not resurrected by the old token', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    registry.teardown(1)
    // a destroyed webContents id is never reused, so nothing can re-grant it
    expect(registry.completePick(1, registry.beginPick(1), dir)).toBeNull()
    expect(registry.batchLive(1, batch)).toBe(false)
    expect(await listing(dir)).toEqual([])
  })
})
