/**
 * The PDF commit boundary: authorization at the moment the file is opened.
 *
 * A PDF export is authorized, then assembled — pdf-lib parses every fragment,
 * copies pages, serialises — and only then written. Both PDF paths (the single
 * print and the grouped merge) end in `commitPdfOutput`, and both must satisfy
 * the same two guarantees:
 *
 *   1. the batch that authorized the target still owns it at the moment of the
 *      commit, and
 *   2. every candidate name the writer might open — the proposed one and every
 *      collision variant it invents — resolves inside the granted directory.
 *
 * The grouped path used to call the writer without a containment resolver while
 * the DOCX path supplied one, so the identical operation had two different rules.
 * These tests run the real gate, the real writer and a real filesystem.
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MailMergeGrantRegistry } from '../src/shared/mail-merge-grants'
import { commitMergedPdf, commitPdfOutput } from '../src/shared/pdf-merge-commit'
import { pdfWriteTarget } from '../src/shared/pdf-write-auth'
import { containedTarget, posixRules } from '../src/shared/output-containment'

const contained = (dir: string, path: string) =>
  containedTarget(dir, path, posixRules, existsSync, realpathSync)

const freshDir = () => mkdtemp(join(tmpdir(), 'genoffice-pdf-commit-'))
const listing = async (dir: string) => (await readdir(dir)).sort()
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Mirrors the main process: the gate reads the registry, the commit re-asks it. */
function wire(registry: MailMergeGrantRegistry, allowedPaths: Set<string> = new Set()) {
  const opened: string[] = []
  const gate = (wcId: number, filePath: string, overwrite: unknown, batch: unknown) =>
    pdfWriteTarget(filePath, overwrite, {
      tornDown: registry.isTornDown(wcId),
      batchDir: registry.pdfDir(wcId),
      currentBatch: registry.currentBatch(wcId),
      claimedBatch: batch,
      allocated: registry.allocatedNames(wcId),
      testExportDir: null,
      isImageTemp: () => false,
      allowedPaths,
      contained,
    })
  const options = (wcId: number, batch: unknown, target: { batchDir: string | null }) => ({
    assemble: async (parts: Buffer[]) => Buffer.concat(parts),
    batchStillLive: () => registry.batchLive(wcId, batch),
    resolvePath: (candidate: string) =>
      target.batchDir ? contained(target.batchDir, join(target.batchDir, candidate)) : null,
    writeDirect: async (path: string, data: Buffer) => {
      await writeFile(path, data)
    },
    isImageTemp: () => false,
    openGenerated: (path: string) => opened.push(path),
  })
  return { gate, options, opened }
}

describe('the batch must still be live when the PDF is committed', () => {
  it('writes when nothing changes across the assembly', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(dir, '1_Alpha.pdf'), 'overwrite', batch)
    expect(target).not.toBeNull()
    const result = await commitMergedPdf(
      target!,
      [Buffer.from('%PDF-1.4 alpha')],
      [],
      options(1, batch, target!),
    )
    expect(result.ok).toBe(true)
    expect(result.name).toBe('1_Alpha.pdf')
    expect(await listing(dir)).toEqual(['1_Alpha.pdf'])
  })

  it('writes nothing when the renderer is torn down while Chromium is printing', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(dir, '1_Alpha.pdf'), 'overwrite', batch)
    expect(target).not.toBeNull()
    const result = await commitMergedPdf(target!, [Buffer.from('%PDF-1.4 alpha')], [], {
      ...options(1, batch, target!),
      // the tab dies inside the print/assembly await
      assemble: async () => {
        registry.teardown(1)
        return Buffer.from('%PDF-1.4 alpha')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no longer authorized')
    expect(await listing(dir)).toEqual([])
  })

  it('writes nothing when the batch is released during the assembly', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(dir, '1_Alpha.pdf'), 'overwrite', batch)
    const result = await commitMergedPdf(target!, [Buffer.from('%PDF-1.4 alpha')], [], {
      ...options(1, batch, target!),
      assemble: async () => {
        registry.release(1, batch)
        return Buffer.from('%PDF-1.4 alpha')
      },
    })
    expect(result.ok).toBe(false)
    expect(await listing(dir)).toEqual([])
  })

  it('a stale request from batch A cannot write after batch B took the same folder', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batchA = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const staleTarget = gate(1, join(dir, '1_Alpha.pdf'), 'overwrite', batchA)
    expect(staleTarget).not.toBeNull()
    // the user cancels and picks the identical folder for a second export
    registry.release(1, batchA)
    const batchB = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const stale = await commitPdfOutput(
      staleTarget!,
      Buffer.from('%PDF-1.4 stale'),
      options(1, batchA, staleTarget!),
    )
    expect(stale.ok).toBe(false)
    expect(stale.error).toContain('no longer authorized')
    expect(await listing(dir)).toEqual([])
    // the live batch writes into the same folder without difficulty
    const freshTarget = gate(1, join(dir, '1_Alpha.pdf'), 'overwrite', batchB)
    const fresh = await commitPdfOutput(
      freshTarget!,
      Buffer.from('%PDF-1.4 fresh'),
      options(1, batchB, freshTarget!),
    )
    expect(fresh.ok).toBe(true)
    expect(await listing(dir)).toEqual(['1_Alpha.pdf'])
  })

  it('an ordinary File-menu export keeps working beside a live batch grant', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    registry.completePick(1, registry.beginPick(1), dir)
    const savePath = join(dir, 'report.pdf')
    const { gate, options, opened } = wire(registry, new Set([savePath]))
    // no batch is named: the save-dialog authorization is what makes it legal
    const target = gate(1, savePath, undefined, undefined)
    expect(target).not.toBeNull()
    expect(target!.batchDir).toBeNull()
    const result = await commitPdfOutput(
      target!,
      Buffer.from('%PDF-1.4 report'),
      options(1, undefined, target!),
    )
    expect(result.ok).toBe(true)
    expect(await listing(dir)).toEqual(['report.pdf'])
    // an ordinary export is revealed to the user; a batch output is not
    expect(opened).toEqual([savePath])
  })

  it('teardown revokes the ordinary export path too', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const savePath = join(dir, 'report.pdf')
    const { gate } = wire(registry, new Set([savePath]))
    registry.teardown(1)
    expect(gate(1, savePath, undefined, undefined)).toBeNull()
  })
})

describe('the final destination is contained at the moment of the write', () => {
  it('refuses a path that resolves out of the granted directory', async () => {
    const base = await freshDir()
    const dir = join(base, 'merge')
    await writeFile(join(base, 'outside.pdf'), '')
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate } = wire(registry)
    expect(gate(1, join(dir, '..', 'outside.pdf'), 'overwrite', batch)).toBeNull()
    expect(gate(1, join(base, 'outside.pdf'), 'overwrite', batch)).toBeNull()
  })

  it('refuses a symlink inside the grant that points out of it', async () => {
    const dir = await freshDir()
    const elsewhere = await freshDir()
    await symlink(elsewhere, join(dir, 'out'))
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate } = wire(registry)
    const target = gate(1, join(dir, 'out', 'Huy.pdf'), 'overwrite', batch)
    expect(target).toBeNull()
    expect(await listing(elsewhere)).toEqual([])
    // nothing was written; the only entry in the grant is the symlink itself
    expect(await listing(dir)).toEqual(['out'])
  })

  it('follows a granted directory that is itself a symlink', async () => {
    const base = await freshDir()
    const real = join(base, 'real')
    const link = join(base, 'merge')
    await mkdirSafe(real)
    await symlink(real, link)
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), link)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(link, 'Huy.pdf'), 'overwrite', batch)
    expect(target?.path).toBe(join(realpathSync(real), 'Huy.pdf'))
    const result = await commitPdfOutput(
      target!,
      Buffer.from('%PDF-1.4 Huy'),
      options(1, batch, target!),
    )
    expect(result.ok).toBe(true)
    expect(await listing(real)).toEqual(['Huy.pdf'])
    expect(await listing(link)).toEqual(['Huy.pdf'])
  })

  it('the writer routes every collision candidate through the resolver', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(dir, 'Same.pdf'), 'rename', batch)
    expect(target).not.toBeNull()
    // record what the writer asks for, then let the real containment rule answer
    const seen: string[] = []
    const result = await commitPdfOutput(target!, Buffer.from('%PDF-1.4 same'), {
      ...options(1, batch, target!),
      resolvePath: (candidate: string) => {
        seen.push(candidate)
        return contained(dir, join(dir, candidate))
      },
    })
    expect(result.ok).toBe(true)
    // the second recipient of the same batch gets a renamed name, and that name
    // is contained before it is opened — not joined onto the directory blindly
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(await listing(dir)).toEqual(['Same.pdf'])
  })

  it('a resolver that refuses a candidate stops the write instead of falling back to join(dir, name)', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate } = wire(registry)
    const target = gate(1, join(dir, 'Huy.pdf'), 'overwrite', batch)
    expect(target).not.toBeNull()
    const result = await commitPdfOutput(target!, Buffer.from('%PDF-1.4 Huy'), {
      batchStillLive: () => true,
      resolvePath: () => null,
      writeDirect: async () => {
        throw new Error('must not be reached')
      },
      isImageTemp: () => false,
      openGenerated: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the directory')
    expect(await listing(dir)).toEqual([])
  })

  it('renames a colliding recipient name inside the granted directory', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const first = gate(1, join(dir, 'Notes.pdf'), 'overwrite', batch)
    const second = gate(1, join(dir, 'Notes.pdf'), 'overwrite', batch)
    expect(first && second).toBeTruthy()
    await commitPdfOutput(first!, Buffer.from('%PDF-1.4 one'), options(1, batch, first!))
    const again = await commitPdfOutput(
      second!,
      Buffer.from('%PDF-1.4 two'),
      options(1, batch, second!),
    )
    expect(again.ok).toBe(true)
    expect(again.name).not.toBe('Notes.pdf')
    const names = await listing(dir)
    expect(names.length).toBe(2)
    expect(names).toContain('Notes.pdf')
    // both files are inside the grant, not in a sibling directory
    for (const name of names) expect(contained(dir, join(dir, name))).not.toBeNull()
  })

  it('treats case and Unicode-equivalent names as the same file', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const a = gate(1, join(dir, 'Huy.pdf'), 'overwrite', batch)
    const b = gate(1, join(dir, 'HUY.pdf'), 'overwrite', batch)
    const c = gate(1, join(dir, 'Huy\u0301.pdf'), 'overwrite', batch)
    await commitPdfOutput(a!, Buffer.from('a'), options(1, batch, a!))
    const second = await commitPdfOutput(b!, Buffer.from('b'), options(1, batch, b!))
    const third = await commitPdfOutput(c!, Buffer.from('c'), options(1, batch, c!))
    expect(second.ok && third.ok).toBe(true)
    expect(second.name).not.toBe('HUY.pdf')
    const names = await listing(dir)
    expect(names.length).toBe(3)
  })

  it('two recipients racing for the same name both land, neither clobbered', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const t1 = gate(1, join(dir, 'Same.pdf'), 'rename', batch)
    const t2 = gate(1, join(dir, 'Same.pdf'), 'rename', batch)
    const [r1, r2] = await Promise.all([
      commitPdfOutput(t1!, Buffer.from('%PDF-1.4 first'), options(1, batch, t1!)),
      commitPdfOutput(t2!, Buffer.from('%PDF-1.4 second'), options(1, batch, t2!)),
    ])
    expect(r1.ok && r2.ok).toBe(true)
    expect(r1.name).not.toBe(r2.name)
    const names = await listing(dir)
    expect(names.length).toBe(2)
  })

  it("skip leaves the user's existing file untouched", async () => {
    const dir = await freshDir()
    const existing = join(dir, 'Keep.pdf')
    await writeFile(existing, 'the user put this here')
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, existing, 'skip', batch)
    expect(target).not.toBeNull()
    const result = await commitPdfOutput(
      target!,
      Buffer.from('%PDF-1.4 new'),
      options(1, batch, target!),
    )
    expect(result.ok).toBe(false)
    expect(result.skipped).toBe(true)
    const content = await (await import('node:fs/promises')).readFile(existing, 'utf8')
    expect(content).toBe('the user put this here')
    expect(await listing(dir)).toEqual(['Keep.pdf'])
  })

  it('a grant revoked between assembly and commit produces no file', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(dir, 'Late.pdf'), 'overwrite', batch)
    const result = await commitPdfOutput(target!, Buffer.from('%PDF-1.4 late'), {
      ...options(1, batch, target!),
      batchStillLive: () => {
        registry.release(1, batch)
        return registry.batchLive(1, batch)
      },
    })
    expect(result.ok).toBe(false)
    expect(await listing(dir)).toEqual([])
  })

  it('a committed file survives a later release', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(dir, 'Done.pdf'), 'overwrite', batch)
    const result = await commitPdfOutput(
      target!,
      Buffer.from('%PDF-1.4 done'),
      options(1, batch, target!),
    )
    expect(result.ok).toBe(true)
    registry.release(1, batch)
    expect(await listing(dir)).toEqual(['Done.pdf'])
  })

  it('the grouped merge and the single print obey the same rule', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const single = gate(1, join(dir, 'single.pdf'), 'overwrite', batch)
    const grouped = gate(1, join(dir, 'grouped.pdf'), 'overwrite', batch)
    registry.teardown(1)
    const a = await commitPdfOutput(
      single!,
      Buffer.from('%PDF-1.4 single'),
      options(1, batch, single!),
    )
    const b = await commitMergedPdf(
      grouped!,
      [Buffer.from('%PDF-1.4 grouped')],
      [],
      options(1, batch, grouped!),
    )
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    expect(a.error).toBe(b.error)
    expect(await listing(dir)).toEqual([])
  })

  it('a long assembly does not outlive the batch that authorized it', async () => {
    const dir = await freshDir()
    const registry = new MailMergeGrantRegistry()
    const batch = registry.completePick(1, registry.beginPick(1), dir)!.batch
    const { gate, options } = wire(registry)
    const target = gate(1, join(dir, 'slow.pdf'), 'rename', batch)
    const inFlight = commitMergedPdf(target!, [Buffer.from('%PDF-1.4 slow')], [], {
      ...options(1, batch, target!),
      assemble: async () => {
        await sleep(40)
        return Buffer.from('%PDF-1.4 slow')
      },
    })
    setTimeout(() => registry.release(1, batch), 10)
    const result = await inFlight
    expect(result.ok).toBe(false)
    expect(await listing(dir)).toEqual([])
  })
})

async function mkdirSafe(path: string) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path)
}
