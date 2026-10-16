/**
 * The mail-merge writer against a real filesystem.
 *
 * These tests check what is actually on disk, not what a counter says: the
 * invariant is that a successful recipient never destroys another recipient's
 * output, and that the chosen policy is honoured for files that were already
 * there before the batch.
 */
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSafeFileName } from '../src/shared/mail-merge-names'
import { writeMailMergeOutput } from '../src/shared/mail-merge-write'

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'genoffice-mail-merge-'))
}

const listing = async (dir: string): Promise<string[]> => (await readdir(dir)).sort()

const read = async (dir: string, name: string): Promise<string> =>
  (await readFile(join(dir, name))).toString()

describe('batch writes to a real directory', () => {
  it('gives two recipients with the same name two files under skip', async () => {
    const dir = await freshDir()
    const allocated = new Set<string>()
    const a = await writeMailMergeOutput(dir, 'Huy.docx', Buffer.from('first'), 'skip', allocated)
    const b = await writeMailMergeOutput(dir, 'Huy.docx', Buffer.from('second'), 'skip', allocated)
    expect(a.skipped).toBe(false)
    expect(b.skipped).toBe(false)
    expect(await listing(dir)).toEqual(['Huy (2).docx', 'Huy.docx'])
    expect(await read(dir, 'Huy.docx')).toBe('first')
    expect(await read(dir, 'Huy (2).docx')).toBe('second')
  })

  it('skips a file that predates the batch under skip', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.docx'), 'pre-existing')
    const outcome = await writeMailMergeOutput(dir, 'Huy.docx', Buffer.from('new'), 'skip')
    expect(outcome.skipped).toBe(true)
    expect(await listing(dir)).toEqual(['Huy.docx'])
    expect(await read(dir, 'Huy.docx')).toBe('pre-existing')
  })

  it('renames around a pre-existing PDF', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.pdf'), 'pre-existing')
    const outcome = await writeMailMergeOutput(dir, 'Huy.pdf', Buffer.from('new'), 'rename')
    expect(outcome.skipped).toBe(false)
    expect(outcome.name).toBe('Huy (2).pdf')
    expect(await listing(dir)).toEqual(['Huy (2).pdf', 'Huy.pdf'])
    expect(await read(dir, 'Huy.pdf')).toBe('pre-existing')
    expect(await read(dir, 'Huy (2).pdf')).toBe('new')
  })

  it('replaces a pre-existing file only when the user chose overwrite', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.pdf'), 'pre-existing')
    const outcome = await writeMailMergeOutput(dir, 'Huy.pdf', Buffer.from('new'), 'overwrite')
    expect(outcome.skipped).toBe(false)
    expect(await listing(dir)).toEqual(['Huy.pdf'])
    expect(await read(dir, 'Huy.pdf')).toBe('new')
  })

  it('finds the first free name when the obvious ones are taken', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.pdf'), 'a')
    await writeFile(join(dir, 'Huy (2).pdf'), 'b')
    await writeFile(join(dir, 'Huy (3).pdf'), 'c')
    const outcome = await writeMailMergeOutput(dir, 'Huy.pdf', Buffer.from('d'), 'rename')
    expect(outcome.name).toBe('Huy (4).pdf')
    expect(await listing(dir)).toEqual(['Huy (2).pdf', 'Huy (3).pdf', 'Huy (4).pdf', 'Huy.pdf'])
  })

  it('separates three recipients with the same name', async () => {
    const dir = await freshDir()
    const allocated = new Set<string>()
    for (const text of ['one', 'two', 'three']) {
      await writeMailMergeOutput(dir, 'Huy.docx', Buffer.from(text), 'skip', allocated)
    }
    expect(await listing(dir)).toEqual(['Huy (2).docx', 'Huy (3).docx', 'Huy.docx'])
    expect(await read(dir, 'Huy.docx')).toBe('one')
    expect(await read(dir, 'Huy (3).docx')).toBe('three')
  })

  it('does not clobber a file another process created between the checks', async () => {
    const dir = await freshDir()
    // the renderer picked "Huy.pdf"; a competing process writes it first
    await writeFile(join(dir, 'Huy.pdf'), 'someone else')
    const outcome = await writeMailMergeOutput(dir, 'Huy.pdf', Buffer.from('mine'), 'rename')
    expect(outcome.name).toBe('Huy (2).pdf')
    expect(await read(dir, 'Huy.pdf')).toBe('someone else')
    expect(await read(dir, 'Huy (2).pdf')).toBe('mine')
  })

  it('keeps two concurrent writes to the same destination apart', async () => {
    const dir = await freshDir()
    const [a, b] = await Promise.all([
      writeMailMergeOutput(dir, 'Huy.pdf', Buffer.from('A'), 'rename'),
      writeMailMergeOutput(dir, 'Huy.pdf', Buffer.from('B'), 'rename'),
    ])
    expect(a.name).not.toBe(b.name)
    expect((await listing(dir)).length).toBe(2)
    const contents = (await listing(dir)).map((n) => read(dir, n))
    expect((await Promise.all(contents)).sort()).toEqual(['A', 'B'])
  })

  it('shortens long names without losing the extension, and keeps them distinct', async () => {
    const dir = await freshDir()
    const allocated = new Set<string>()
    const first = await writeMailMergeOutput(
      dir,
      `${'x'.repeat(190)}-first.pdf`,
      Buffer.from('1'),
      'overwrite',
      allocated,
    )
    const second = await writeMailMergeOutput(
      dir,
      `${'x'.repeat(190)}-second.pdf`,
      Buffer.from('2'),
      'overwrite',
      allocated,
    )
    expect(first.name.endsWith('.pdf')).toBe(true)
    expect(second.name.endsWith('.pdf')).toBe(true)
    expect(first.name).not.toBe(second.name)
    expect(Buffer.byteLength(second.name, 'utf8')).toBeLessThanOrEqual(200)
    expect((await listing(dir)).length).toBe(2)
  })

  it('treats a case-insensitive destination as occupied', () => {
    // Windows and macOS report `HUY.docx` and `Huy.docx` as the same file; the
    // policy must see the collision rather than write over it
    const taken = new Set(['huy.docx'])
    const decision = resolveSafeFileName('HUY.docx', 'rename', (candidate) =>
      taken.has(candidate.toLowerCase()),
    )
    expect(decision.name).toBe('HUY (2).docx')
    expect(decision.skipped).toBe(false)
  })
})
