import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertBeside, looksLikeOoxml, type ConvertBesideDeps } from '../src/main/legacy-convert'

const zip = new Uint8Array(200).map((_, i) => (i === 0 ? 0x50 : i === 1 ? 0x4b : 7))
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'legacy-convert-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function deps(over: Partial<ConvertBesideDeps> = {}): ConvertBesideDeps & {
  written: string[]
} {
  const written: string[] = []
  return {
    written,
    uniquePathIn: (directory, name) => join(directory, name),
    fallbackDir: null,
    write: async (path, bytes) => {
      written.push(path)
      await writeFile(path, bytes)
    },
    linkedCopy: async () => null,
    remember: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    ...over,
  }
}

describe('converting an old file beside itself', () => {
  it('writes the new file next to the old one and archives the old one', async () => {
    const source = join(dir, 'Bang diem.xls')
    await writeFile(source, 'old workbook')
    const d = deps()
    const result = await convertBeside(source, '.xlsx', async () => ({ bytes: zip }), d)
    expect(result).toEqual({
      convertedPath: join(dir, 'Bang diem.xlsx'),
      archived: true,
      reused: false,
    })
    expect(await readFile(join(dir, 'Bang diem.xlsx'))).toHaveLength(200)
    expect(d.archive).toHaveBeenCalledWith(source, join(dir, 'Bang diem.xlsx'), expect.any(String))
  })

  it('reuses an earlier conversion instead of making a second copy', async () => {
    const produce = vi.fn(async () => ({ bytes: zip }))
    const d = deps({ linkedCopy: async () => '/x/a.xlsx' })
    const result = await convertBeside('/x/a.xls', '.xlsx', produce, d)
    expect(result).toEqual({ convertedPath: '/x/a.xlsx', archived: true, reused: true })
    expect(produce).not.toHaveBeenCalled()
  })

  it('refuses a converter answer that is not an office file, and writes nothing', async () => {
    const d = deps()
    await expect(
      convertBeside('/x/a.doc', '.docx', async () => ({ bytes: new Uint8Array(300) }), d),
    ).rejects.toThrow(/invalid file/)
    expect(d.written).toEqual([])
  })

  it('remembers the pair when the old file cannot be moved, so it is not converted again', async () => {
    const source = join(dir, 'a.ppt')
    await writeFile(source, 'old')
    const d = deps({
      archive: vi.fn(async () => {
        throw new Error('locked')
      }),
    })
    const result = await convertBeside(source, '.pptx', async () => ({ bytes: zip }), d)
    expect(result.archived).toBe(false)
    expect(d.remember).toHaveBeenCalledTimes(1)
  })

  it('does not write elsewhere when the folder is read-only and no fallback is allowed', async () => {
    const source = join(dir, 'a.xls')
    await writeFile(source, 'old')
    const d = deps({
      write: async () => {
        throw Object.assign(new Error('read-only'), { code: 'EROFS' })
      },
    })
    await expect(convertBeside(source, '.xlsx', async () => ({ bytes: zip }), d)).rejects.toThrow(
      'read-only',
    )
  })

  it('writes to the fallback folder when it is allowed, and then leaves the old file alone', async () => {
    const source = join(dir, 'a.xls')
    await writeFile(source, 'old')
    let first = true
    const d = deps({
      fallbackDir: () => join(dir, 'saved'),
      write: async (path) => {
        if (first) {
          first = false
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
        d.written.push(path)
      },
    })
    const result = await convertBeside(source, '.xlsx', async () => ({ bytes: zip }), d)
    expect(result).toEqual({
      convertedPath: join(dir, 'saved', 'a.xlsx'),
      archived: false,
      reused: false,
    })
    expect(d.archive).not.toHaveBeenCalled()
  })

  it('knows a zip from junk', () => {
    expect(looksLikeOoxml(zip)).toBe(true)
    expect(looksLikeOoxml(new Uint8Array(300))).toBe(false)
    expect(looksLikeOoxml(new Uint8Array([0x50, 0x4b]))).toBe(false)
  })
})
