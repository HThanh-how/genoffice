/**
 * The grouped PDF merge commits only while its batch still owns the folder.
 *
 * `docs:save-merged-pdf` authorizes the target, then spends several awaits
 * assembling the PDF (import pdf-lib, load every fragment, copy pages, save).
 * A batch cancelled or re-picked during that window has released its grant. The
 * pipeline therefore re-checks the batch identity after the assembly and before
 * the filesystem commit — the same protection `docs:export-pdf` already has.
 *
 * The merge itself is injected so a test can pause inside it and revoke the
 * grant at each await boundary, without launching Electron.
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pdfWriteTarget } from '../src/shared/pdf-write-auth'
import { containedTarget, posixRules } from '../src/shared/output-containment'
import {
  commitMergedPdf,
  MAX_PDF_PART_BYTES,
  MAX_PDF_PARTS,
  MAX_PDF_TOTAL_BYTES,
  validatePdfMergeParts,
} from '../src/shared/pdf-merge-commit'

const contained = (dir: string, path: string) =>
  containedTarget(dir, path, posixRules, existsSync, realpathSync)

const freshDir = () => mkdtemp(join(tmpdir(), 'genoffice-pdf-merge-'))

/** A batch grant plus the identity captured when the target was authorized.
 *  `allocated` is the batch's own claim set, shared by every recipient's write. */
function batchTarget(
  dir: string,
  batch: string,
  name: string,
  overwrite: string,
  allocated: Set<string> = new Set<string>(),
) {
  return pdfWriteTarget(join(dir, name), overwrite, {
    tornDown: false,
    batchDir: dir,
    allocated,
    testExportDir: null,
    isImageTemp: () => false,
    allowedPaths: new Set<string>(),
    contained,
    currentBatch: batch,
    claimedBatch: batch,
  })
}

function commit(
  target: NonNullable<ReturnType<typeof batchTarget>>,
  batch: string,
  liveBatch: { value: string },
  assemble: () => Promise<Buffer>,
  opened: string[],
) {
  return commitMergedPdf(target, [Buffer.from('%PDF-1.4 merged')], [], {
    assemble,
    // the identity captured when the target was authorized, checked against the
    // batch the tab still holds — exactly what the main process does
    batchStillLive: () => liveBatch.value === batch,
    // the same containment resolver the DOCX batch path uses: every candidate
    // name the writer might open is resolved inside the grant before it is opened
    resolvePath: (candidate) => contained(target.batchDir!, join(target.batchDir!, candidate)),
    writeDirect: async (path, data) => {
      await writeFile(path, data)
    },
    isImageTemp: () => false,
    openGenerated: (path) => opened.push(path),
  })
}

describe('the grouped PDF merge gate', () => {
  it('writes nothing when the grant is released while the PDF is being assembled', async () => {
    const dir = await freshDir()
    const live = { value: 'batch-a' }
    const target = batchTarget(dir, 'batch-a', '1_Alpha.pdf', 'overwrite')
    expect(target).not.toBeNull()

    const result = await commit(
      target!,
      'batch-a',
      live,
      async () => {
        // the await boundary: the user cancels the batch mid-assembly
        live.value = ''
        return Buffer.from('%PDF-1.4 assembled')
      },
      [],
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('output directory is no longer authorized')
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses a stale batch when the same folder was re-picked under a new batch', async () => {
    const dir = await freshDir()
    const live = { value: 'batch-a' }
    const target = batchTarget(dir, 'batch-a', '1_Alpha.pdf', 'overwrite')
    expect(target).not.toBeNull()

    const result = await commit(
      target!,
      'batch-a',
      live,
      async () => {
        // a second export picked the same folder: the grant now belongs to it
        live.value = 'batch-b'
        return Buffer.from('%PDF-1.4 assembled')
      },
      [],
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('output directory is no longer authorized')
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses a revoked grant that was released during the save step', async () => {
    const dir = await freshDir()
    const live = { value: 'batch-a' }
    const target = batchTarget(dir, 'batch-a', '2_Beta.pdf', 'rename')
    expect(target).not.toBeNull()

    const result = await commit(
      target!,
      'batch-a',
      live,
      async () => {
        // revoke at the last await, immediately before the commit
        await new Promise((resolve) => setTimeout(resolve, 5))
        live.value = ''
        return Buffer.from('%PDF-1.4 assembled')
      },
      [],
    )

    expect(result.ok).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('writes the file when the batch is unchanged across the whole assembly', async () => {
    const dir = await freshDir()
    const live = { value: 'batch-a' }
    const target = batchTarget(dir, 'batch-a', '3_Gamma.pdf', 'overwrite')
    expect(target).not.toBeNull()

    const opened: string[] = []
    const result = await commit(
      target!,
      'batch-a',
      live,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return Buffer.from('%PDF-1.4 assembled')
      },
      opened,
    )

    expect(result.ok).toBe(true)
    expect(result.name).toBe('3_Gamma.pdf')
    expect(await readdir(dir)).toEqual(['3_Gamma.pdf'])
    // a batch output is not opened in a tab: only an ordinary export is revealed
    expect(opened).toEqual([])
  })

  it('honours the skip policy for a destination that already exists', async () => {
    const dir = await freshDir()
    const existing = join(dir, '4_Skip.pdf')
    await writeFile(existing, 'the user put this file here')
    const live = { value: 'batch-a' }
    const target = batchTarget(dir, 'batch-a', '4_Skip.pdf', 'skip')
    expect(target).not.toBeNull()

    const result = await commit(
      target!,
      'batch-a',
      live,
      async () => Buffer.from('%PDF-1.4 new'),
      [],
    )

    expect(result.ok).toBe(false)
    expect(result.skipped).toBe(true)
    expect(await readdir(dir)).toEqual(['4_Skip.pdf'])
    expect((await readFileAsString(existing)).trim()).toBe('the user put this file here')
  })

  it('renames rather than clobbering a name this batch already wrote', async () => {
    const dir = await freshDir()
    const live = { value: 'batch-a' }
    const allocated = new Set<string>()
    const first = batchTarget(dir, 'batch-a', '5_Same.pdf', 'overwrite', allocated)
    const second = batchTarget(dir, 'batch-a', '5_Same.pdf', 'overwrite', allocated)
    expect(first && second).toBeTruthy()

    await commit(first!, 'batch-a', live, async () => Buffer.from('%PDF-1.4 first'), [])
    const again = await commit(
      second!,
      'batch-a',
      live,
      async () => Buffer.from('%PDF-1.4 second'),
      [],
    )

    expect(again.ok).toBe(true)
    expect(again.name).not.toBe('5_Same.pdf')
    const names = await readdir(dir)
    expect(names.length).toBe(2)
    expect(names).toContain('5_Same.pdf')
  })

  it('keeps a committed file when the batch is released afterwards', async () => {
    const dir = await freshDir()
    const live = { value: 'batch-a' }
    const target = batchTarget(dir, 'batch-a', '6_Done.pdf', 'overwrite')
    expect(target).not.toBeNull()

    const result = await commit(
      target!,
      'batch-a',
      live,
      async () => Buffer.from('%PDF-1.4 done'),
      [],
    )
    expect(result.ok).toBe(true)

    // the user closes the dialog: releasing the grant must not undo a file that
    // was already written
    live.value = ''
    expect(await readdir(dir)).toEqual(['6_Done.pdf'])
  })

  it('writes an ordinary export through its own authorization, not a batch grant', async () => {
    const dir = await freshDir()
    const path = join(dir, 'normal.pdf')
    const target = pdfWriteTarget(path, undefined, {
      tornDown: false,
      batchDir: dir,
      allocated: new Set<string>(),
      testExportDir: null,
      isImageTemp: () => false,
      allowedPaths: new Set([path]),
      contained,
      currentBatch: 'batch-b',
    })
    expect(target).not.toBeNull()

    const opened: string[] = []
    const result = await commitMergedPdf(target!, [Buffer.from('%PDF-1.4 normal')], [], {
      assemble: async () => Buffer.from('%PDF-1.4 normal'),
      batchStillLive: () => false,
      // a non-batch target has no grant to contain it in
      resolvePath: () => null,
      writeDirect: async (p, data) => {
        await writeFile(p, data)
      },
      isImageTemp: () => false,
      openGenerated: (p) => opened.push(p),
    })

    expect(result.ok).toBe(true)
    expect(result.path).toBe(path)
    expect(await readdir(dir)).toEqual(['normal.pdf'])
    expect(opened).toEqual([path])
  })
})

describe('the grouped PDF fragment limits', () => {
  const fragment = (n: number) => Buffer.from('a'.repeat(n)).toString('base64')

  /** The refusal message a request should get, or a thrown error if it was accepted. */
  function refusal(parts: unknown, links: unknown): string {
    const decision = validatePdfMergeParts(parts, links)
    if (decision.ok) return 'ACCEPTED (expected a refusal)'
    return decision.error
  }

  it('rejects a fragment list that is not a list or is empty', () => {
    expect(refusal(undefined, [])).toMatch(/not a list/)
    expect(refusal('not an array', [])).toMatch(/not a list/)
    expect(refusal([], [])).toMatch(/no PDF pages/)
  })

  it('rejects a fragment that is not printable data', () => {
    for (const bad of [null, 12345, '']) {
      expect(refusal([bad], [])).toMatch(/empty/)
    }
    // base64 that decodes to nothing is not a page either
    expect(refusal(['===='], [])).toMatch(/not valid base64/)
  })

  it('rejects base64 that does not round-trip', () => {
    // Buffer.from accepts all of these; the writer would then store bytes the
    // sender never sent, and the size limit would describe a different buffer
    // than the file on disk
    for (const bad of ['A', 'AAAA=', 'A===', 'a-b', 'AA A', 'AA\nA', 'AA==AA==']) {
      expect(refusal([bad], [])).toMatch(/not valid base64/)
    }
  })

  it('accepts a fragment whose encoding is canonical at the size boundary', () => {
    const exact = Buffer.from('a'.repeat(MAX_PDF_PART_BYTES)).toString('base64')
    const decision = validatePdfMergeParts([exact], [])
    if (!decision.ok) throw new Error(`a legal fragment was refused: ${decision.error}`)
    expect(decision.parts[0].length).toBe(MAX_PDF_PART_BYTES)
  })

  it('rejects more fragments than a print path can produce', () => {
    const parts = Array.from({ length: MAX_PDF_PARTS + 1 }, () => fragment(16))
    expect(refusal(parts, [])).toMatch(/at most 512/)
  })

  it('rejects an oversized fragment before decoding it', () => {
    const huge = 'a'.repeat(4 * Math.ceil((16 * 1024 * 1024) / 3) + 4)
    expect(refusal([huge], [])).toMatch(/larger than/)
  })

  it('bounds the aggregate well below the worst case of individually legal parts', () => {
    // the ceiling has to bite before the fragment count alone could fill it,
    // otherwise the aggregate check is decorative
    expect(MAX_PDF_TOTAL_BYTES).toBeLessThan(MAX_PDF_PARTS * MAX_PDF_PART_BYTES)
  })

  it('rejects an aggregate that exceeds the export ceiling', () => {
    // 17 full-size fragments is 272 MB: each one is legal on its own, the sum
    // is not
    const parts = Array.from({ length: 17 }, () => fragment(MAX_PDF_PART_BYTES))
    expect(refusal(parts, [])).toMatch(/larger than an export can be/)
  })

  it('refuses a malformed internal link instead of dropping it quietly', () => {
    const links = [
      { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1, toPage: 2, toY: 0.5 },
      { page: 'x', x: 0, y: 0, w: 0, h: 0, toPage: 1, toY: 0 },
    ]
    expect(refusal([fragment(100), fragment(200)], links)).toMatch(/malformed/)
    for (const bad of [
      { page: 1.5, x: 0, y: 0, w: 0.1, h: 0.1, toPage: 1, toY: 0 },
      { page: -1, x: 0, y: 0, w: 0.1, h: 0.1, toPage: 1, toY: 0 },
      { page: 1, x: Number.NaN, y: 0, w: 0.1, h: 0.1, toPage: 1, toY: 0 },
      { page: 1, x: Number.POSITIVE_INFINITY, y: 0, w: 0.1, h: 0.1, toPage: 1, toY: 0 },
      null,
      'link',
    ]) {
      expect(refusal([fragment(100)], [bad])).toMatch(/malformed/)
    }
    // a non-list of links is not a document with no links, it is a broken request
    expect(refusal([fragment(100)], undefined)).toMatch(/links are not a list/)
  })

  it('accepts a legitimate multi-fragment document and keeps its links', () => {
    const links = [{ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1, toPage: 2, toY: 0.5 }]
    const decision = validatePdfMergeParts([fragment(100), fragment(200)], links)
    if (!decision.ok) throw new Error(`a legitimate document was refused: ${decision.error}`)
    expect(decision.parts.length).toBe(2)
    expect(decision.links.length).toBe(1)
  })
})

async function readFileAsString(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
