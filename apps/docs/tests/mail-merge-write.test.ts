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
  it('keeps a name that differs only in case from overwriting another recipient', async () => {
    // Windows and the default macOS volume treat `Notes.docx` and `NOTES.docx`
    // as the same file. On a case-sensitive test filesystem both could coexist,
    // but the writer must not assume it can: the second recipient gets a
    // different name and both contents survive.
    const dir = await freshDir()
    const allocated = new Set<string>()
    const first = await writeMailMergeOutput(
      dir,
      'Notes.docx',
      Buffer.from('a'),
      'overwrite',
      allocated,
    )
    const second = await writeMailMergeOutput(
      dir,
      'NOTES.docx',
      Buffer.from('b'),
      'overwrite',
      allocated,
    )
    expect(first.name).toBe('Notes.docx')
    expect(second.name).not.toBe('NOTES.docx')
    expect((await listing(dir)).length).toBe(2)
    expect(await read(dir, first.name)).toBe('a')
    expect(await read(dir, second.name)).toBe('b')
  })

  it('treats a name that only differs after Unicode normalisation as one name', async () => {
    const dir = await freshDir()
    const allocated = new Set<string>()
    const composed = await writeMailMergeOutput(
      dir,
      'Nótes.docx',
      Buffer.from('x'),
      'overwrite',
      allocated,
    )
    const decomposed = await writeMailMergeOutput(
      dir,
      'N\u006F\u0301tes.docx',
      Buffer.from('y'),
      'overwrite',
      allocated,
    )
    expect(composed.name).toBe('Nótes.docx')
    expect(decomposed.name).not.toBe(composed.name)
    expect((await listing(dir)).length).toBe(2)
  })

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

describe('a write that fails leaves nothing behind', () => {
  /** A handle that only takes part of the buffer, then dies — the disk-full case. */
  const partialWrite = async (handle: any, data: Buffer) => {
    await handle.write(data.subarray(0, Math.min(64, data.length)))
    throw new Error('ENOSPC: no space left on device')
  }

  /** A handle that accepts zero bytes: the short-write case `write` must not accept. */
  const stalledWrite = async (handle: any, data: Buffer) => {
    await handle.write(data.subarray(0, 0))
    throw new Error('the write stalled after 0 of ' + data.length + ' bytes')
  }

  it('writes the whole buffer, not just the first chunk', async () => {
    const dir = await freshDir()
    const data = Buffer.from('x'.repeat(1_000_000))
    const outcome = await writeMailMergeOutput(dir, 'big.docx', data, 'overwrite')
    const written = await readFile(join(dir, outcome.name))
    expect(written.length).toBe(data.length)
    expect(written.toString()).toBe(data.toString())
  })

  it('removes the file it created when the write fails partway', async () => {
    const dir = await freshDir()
    const error = await writeMailMergeOutput(
      dir,
      'Huy.docx',
      Buffer.from('x'.repeat(4096)),
      'rename',
      new Set<string>(),
      undefined,
      partialWrite,
    ).catch((err) => err)
    expect(String(error)).toContain('no space left')
    expect(await listing(dir)).toEqual([])
  })

  it('does not leave a truncated file when a later recipient of the batch succeeds', async () => {
    const dir = await freshDir()
    const allocated = new Set<string>()
    const failed = await writeMailMergeOutput(
      dir,
      'Huy.docx',
      Buffer.from('x'.repeat(4096)),
      'rename',
      allocated,
      undefined,
      partialWrite,
    ).catch(() => null)
    expect(failed).toBeNull()
    // the claim was released, so the next recipient can still use the name
    const second = await writeMailMergeOutput(
      dir,
      'Huy.docx',
      Buffer.from('good content'),
      'rename',
      allocated,
    )
    expect(second.name).toBe('Huy.docx')
    expect(await listing(dir)).toEqual(['Huy.docx'])
    expect(await read(dir, 'Huy.docx')).toBe('good content')
  })

  it('leaves a pre-existing destination untouched when the new write fails', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.docx'), 'the user file')
    const error = await writeMailMergeOutput(
      dir,
      'Huy.docx',
      Buffer.from('x'.repeat(4096)),
      'rename',
      new Set<string>(),
      undefined,
      partialWrite,
    ).catch((err) => err)
    expect(String(error)).toContain('no space left')
    expect(await listing(dir)).toEqual(['Huy.docx'])
    expect(await read(dir, 'Huy.docx')).toBe('the user file')
  })

  it('rejects a write that makes no progress instead of reporting success', async () => {
    const dir = await freshDir()
    const error = await writeMailMergeOutput(
      dir,
      'Huy.docx',
      Buffer.from('data'),
      'skip',
      new Set<string>(),
      undefined,
      stalledWrite,
    ).catch((err) => err)
    expect(String(error)).toContain('stalled')
    expect(await listing(dir)).toEqual([])
  })
})

describe('concurrent recipients of one batch under overwrite', () => {
  it('gives two recipients the same name two different files', async () => {
    const dir = await freshDir()
    const allocated = new Set<string>()
    const [a, b] = await Promise.all([
      writeMailMergeOutput(dir, 'Huy.docx', Buffer.from('first'), 'overwrite', allocated),
      writeMailMergeOutput(dir, 'Huy.docx', Buffer.from('second'), 'overwrite', allocated),
    ])
    expect(a.name).not.toBe(b.name)
    const files = await listing(dir)
    expect(files.length).toBe(2)
    const contents = (await Promise.all(files.map((n) => read(dir, n)))).sort()
    expect(contents).toEqual(['first', 'second'])
  })

  it('keeps the separation when the writes are staggered across awaits', async () => {
    const dir = await freshDir()
    const allocated = new Set<string>()
    const names: string[] = []
    for (const body of ['a', 'b', 'c']) {
      const outcome = await writeMailMergeOutput(
        dir,
        'Huy.docx',
        Buffer.from(body),
        'overwrite',
        allocated,
      )
      names.push(outcome.name)
    }
    expect(new Set(names).size).toBe(3)
    expect((await listing(dir)).length).toBe(3)
  })

  it('does not let a concurrent overwrite clobber a file the user already had', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.docx'), 'the user file')
    const allocated = new Set<string>()
    const [a, b] = await Promise.all([
      writeMailMergeOutput(dir, 'Huy.docx', Buffer.from('first'), 'overwrite', allocated),
      writeMailMergeOutput(dir, 'Huy.docx', Buffer.from('second'), 'overwrite', allocated),
    ])
    // the user's file is what "overwrite" means: the first recipient takes it,
    // the second must not silently replace it
    expect(a.name).toBe('Huy.docx')
    expect(b.name).not.toBe('Huy.docx')
    expect(await read(dir, 'Huy.docx')).toBe('first')
    expect(await read(dir, b.name)).toBe('second')
  })
})
