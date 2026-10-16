/**
 * The PDF export gate and the PDF writer must give the same answer.
 *
 * Before this, `canPdfWrite` and `authorizePdfWrite` kept two copies of the rule,
 * and the harness directory was recognized by one but not the other: a path the
 * gate waved through could be refused when the file was about to be written.
 * These tests run the single rule against a real filesystem, including a grant
 * directory that is a symlink and a renderer whose tab has been closed.
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
    ...overrides,
  }
}

describe('the PDF write gate', () => {
  it('accepts a batch target when the policy is stated', async () => {
    const dir = await freshDir()
    const target = pdfWriteTarget(join(dir, '0001_Huy.pdf'), 'rename', context({ batchDir: dir }))
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
      expect(pdfWriteTarget(join(dir, 'x.pdf'), policy, context({ batchDir: dir }))).toBeNull()
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
      context({
        testExportDir: harness,
        batchDir: batch,
      }),
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
    const ctx = context({ batchDir: dir, tornDown: true, allocated: new Set(['0001_Huy.pdf']) })
    expect(pdfWriteTarget(join(dir, '0001_Huy.pdf'), 'overwrite', ctx)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('follows a grant directory that is itself a symlink', async () => {
    const base = await freshDir()
    const real = join(base, 'real')
    const link = join(base, 'merge')
    await mkdir(real)
    await symlink(real, link)
    const target = pdfWriteTarget(join(link, 'Huy.pdf'), 'skip', context({ batchDir: link }))
    expect(target?.path).toBe(join(realpathSync(real), 'Huy.pdf'))
    expect(target?.batchDir).toBe(link)
  })

  it('rejects a symlink inside the grant that points out of it', async () => {
    const dir = await freshDir()
    const elsewhere = await freshDir()
    await symlink(elsewhere, join(dir, 'out'))
    expect(
      pdfWriteTarget(join(dir, 'out', 'Huy.pdf'), 'overwrite', context({ batchDir: dir })),
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
      pdfWriteTarget(join(sibling, 'Huy.pdf'), 'overwrite', context({ batchDir: dir })),
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
