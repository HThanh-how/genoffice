/**
 * The PDF export gate and the PDF writer must give the same answer.
 *
 * Before this, `canPdfWrite` and `authorizePdfWrite` kept two copies of the rule,
 * and the harness directory was recognized by one but not the other: a path the
 * gate waved through could be refused when the file was about to be written.
 * These tests run the single rule against a real filesystem, including a grant
 * directory that is a symlink and a renderer whose tab has been closed.
 *
 * The batch grant is not a standing permission on a folder. It authorizes a write
 * only when the request states the batch that currently holds the folder. A print
 * from the File menu that states no batch cannot use it, even when its path
 * happens to sit inside the folder a mail-merge dialog picked: the directory
 * string matching is not the permission. Ordinary exports keep their own grants —
 * a save-dialog path, an image-export temp, the harness directory — and those are
 * unaffected by a batch grant existing next to them.
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pdfWriteTarget, type PdfAuthContext } from '../src/shared/pdf-write-auth'
import { containedTarget, posixRules } from '../src/shared/output-containment'

const contained = (dir: string, path: string) =>
  containedTarget(dir, path, posixRules, existsSync, realpathSync)

const freshDir = () => mkdtemp(join(tmpdir(), 'genoffice-pdf-auth-'))

function context(overrides: Partial<PdfAuthContext> = {}): PdfAuthContext {
  return {
    tornDown: false,
    batchDir: null,
    allocated: new Set<string>(),
    testExportDir: null,
    isImageTemp: () => false,
    allowedPaths: new Set<string>(),
    contained,
    currentBatch: null,
    ...overrides,
  }
}

describe('the PDF write gate', () => {
  it('refuses a PDF print that claims a batch the tab no longer holds', async () => {
    // batch A picked this folder, was cancelled, and batch B picked the same one.
    // A print still in flight from A carries A's id; the directory string matches,
    // the permission does not.
    const dir = await freshDir()
    const stale = pdfWriteTarget(
      join(dir, '1_Bo Tran.pdf'),
      'overwrite',
      context({ batchDir: dir, currentBatch: 'batch-b', claimedBatch: 'batch-a' }),
    )
    expect(stale).toBeNull()
    expect(await readdir(dir)).toEqual([])
    // the batch that does hold the folder is still allowed
    const live = pdfWriteTarget(
      join(dir, '1_Bo Tran.pdf'),
      'overwrite',
      context({ batchDir: dir, currentBatch: 'batch-b', claimedBatch: 'batch-b' }),
    )
    expect(live?.name).toBe('1_Bo Tran.pdf')
  })

  it('refuses a batch directory path that states no batch at all', async () => {
    // the File menu export has no batch to name. It must not gain permission
    // merely because a mail-merge dialog picked this same folder.
    const dir = await freshDir()
    for (const claimed of [undefined, null, '', 0, false, 'batch-a']) {
      const target = pdfWriteTarget(
        join(dir, 'document.pdf'),
        'overwrite',
        context({ batchDir: dir, currentBatch: 'batch-b', claimedBatch: claimed }),
      )
      expect(target, `claimedBatch=${String(claimed)}`).toBeNull()
    }
    expect(await readdir(dir)).toEqual([])
  })

  it('accepts an ordinary export whose save-dialog path happens to sit in a batch folder', async () => {
    // The user chose this file in a save dialog. The batch grant next to it is
    // irrelevant: the independent authorization is what makes the write legal.
    const dir = await freshDir()
    const path = join(dir, 'report.pdf')
    const target = pdfWriteTarget(
      path,
      undefined,
      context({ batchDir: dir, currentBatch: 'batch-b', allowedPaths: new Set([path]) }),
    )
    expect(target?.path).toBe(path)
    expect(target?.batchDir).toBeNull()
    expect(target?.policy).toBe('overwrite')
  })

  it('accepts a batch target when the batch and the policy are both stated', async () => {
    const dir = await freshDir()
    const target = pdfWriteTarget(
      join(dir, '0001_Huy.pdf'),
      'rename',
      context({ batchDir: dir, currentBatch: 'batch-a', claimedBatch: 'batch-a' }),
    )
    expect(target).toEqual({
      path: join(realpathSync(dir), '0001_Huy.pdf'),
      batchDir: dir,
      name: '0001_Huy.pdf',
      policy: 'rename',
      allocated: new Set<string>(),
    })
  })

  it('refuses a batch target with no policy instead of defaulting to overwrite', async () => {
    const dir = await freshDir()
    for (const policy of [undefined, null, '', 'force', 1, true]) {
      expect(
        pdfWriteTarget(
          join(dir, 'x.pdf'),
          policy,
          context({ batchDir: dir, currentBatch: 'batch-a', claimedBatch: 'batch-a' }),
        ),
      ).toBeNull()
    }
    expect(await readdir(dir)).toEqual([])
  })

  it('accepts the harness directory the gate already approved', async () => {
    const harness = await freshDir()
    const batch = await freshDir()
    // the harness path is approved by the gate with no batch grant and no save
    // dialog; the writer must not then reject the very path it approved
    const gate = pdfWriteTarget(
      join(harness, 'run.pdf'),
      undefined,
      context({ testExportDir: harness }),
    )
    const writer = pdfWriteTarget(
      join(harness, 'run.pdf'),
      undefined,
      context({ testExportDir: harness, batchDir: batch, currentBatch: 'batch-a' }),
    )
    expect(gate?.path).toBe(join(realpathSync(harness), 'run.pdf'))
    expect(writer?.path).toBe(join(realpathSync(harness), 'run.pdf'))
    expect(writer?.policy).toBe('overwrite')
  })

  it('does not let the harness directory become a blanket grant for other formats', async () => {
    const harness = await freshDir()
    expect(
      pdfWriteTarget(join(harness, 'notes.md'), undefined, context({ testExportDir: harness })),
    ).toBeNull()
    expect(
      pdfWriteTarget(
        join(harness, '..', 'escape.pdf'),
        undefined,
        context({ testExportDir: harness }),
      ),
    ).toBeNull()
  })

  it('refuses a closed renderer, even one that still holds a grant', async () => {
    const dir = await freshDir()
    const ctx = context({
      batchDir: dir,
      currentBatch: 'batch-a',
      claimedBatch: 'batch-a',
      tornDown: true,
      allocated: new Set(['0001_Huy.pdf']),
    })
    expect(pdfWriteTarget(join(dir, '0001_Huy.pdf'), 'overwrite', ctx)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('follows a grant directory that is itself a symlink', async () => {
    const base = await freshDir()
    const real = join(base, 'real')
    const link = join(base, 'merge')
    await mkdir(real)
    await symlink(real, link)
    const target = pdfWriteTarget(
      join(link, 'Huy.pdf'),
      'skip',
      context({ batchDir: link, currentBatch: 'batch-a', claimedBatch: 'batch-a' }),
    )
    expect(target?.path).toBe(join(realpathSync(real), 'Huy.pdf'))
    expect(target?.batchDir).toBe(link)
  })

  it('rejects a symlink inside the grant that points out of it', async () => {
    const dir = await freshDir()
    const elsewhere = await freshDir()
    await symlink(elsewhere, join(dir, 'out'))
    expect(
      pdfWriteTarget(
        join(dir, 'out', 'Huy.pdf'),
        'overwrite',
        context({ batchDir: dir, currentBatch: 'batch-a', claimedBatch: 'batch-a' }),
      ),
    ).toBeNull()
    expect(await readdir(elsewhere)).toEqual([])
  })

  it('rejects a sibling directory that merely shares the grant name', async () => {
    const base = await freshDir()
    const dir = join(base, 'merge')
    const sibling = join(base, 'merge-elsewhere')
    await mkdir(dir)
    await mkdir(sibling)
    expect(
      pdfWriteTarget(
        join(sibling, 'Huy.pdf'),
        'overwrite',
        context({ batchDir: dir, currentBatch: 'batch-a', claimedBatch: 'batch-a' }),
      ),
    ).toBeNull()
  })

  it('honours a save-dialog path and an image-export temp', async () => {
    const dir = await freshDir()
    const allowed = join(dir, 'report.pdf')
    const temp = join(dir, 'staged.pdf')
    const ctx = context({ allowedPaths: new Set([allowed]), isImageTemp: (p) => p === temp })
    expect(pdfWriteTarget(allowed, undefined, ctx)?.policy).toBe('overwrite')
    expect(pdfWriteTarget(temp, undefined, ctx)?.path).toBe(temp)
    expect(pdfWriteTarget(join(dir, 'other.pdf'), undefined, ctx)).toBeNull()
  })
})
