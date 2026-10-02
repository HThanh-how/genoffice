import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hiddenNamesIn, parseHiddenNames, resetHiddenNamesCache } from '../src/main/windows-hidden'
import { isHiddenEntry, listFolder } from '../src/main/folder-tree'
import { shouldSkipDirectory } from '../src/main/document-memory/folder-scan'
import { showDefaultFolderFrom } from '../src/main/folder-roots'

// what `attrib /d D:\*` printed on a real drive (UTF-8 code page), trimmed
const ATTRIB = [
  'The system cannot find the path specified.',
  '   SH                D:\\$RECYCLE.BIN',
  '                     D:\\.claude',
  '                     D:\\03_Giấy tờ',
  '                     D:\\Bravo 8',
  'A                    D:\\conan29-4k.mp4',
  'A  SH                D:\\pagefile.sys',
  '   SH                D:\\System Volume Information',
  '                     D:\\_kddi_restore',
  '    H                D:\\Hồ sơ riêng',
  'A                    D:\\Đề nghị thanh toán.docx',
  '',
].join('\r\n')

beforeEach(resetHiddenNamesCache)

describe('what Windows hides', () => {
  it('picks the Hidden and System entries out of attrib, Vietnamese names included', () => {
    expect([...parseHiddenNames(ATTRIB)].sort()).toEqual(
      ['$recycle.bin', 'hồ sơ riêng', 'pagefile.sys', 'system volume information'].sort(),
    )
  })

  it('asks attrib once per folder for a few seconds, and only on Windows', async () => {
    const run = vi.fn(async () => ATTRIB)
    let now = 1_000
    const options = { platform: 'win32' as const, run, now: () => now }
    expect((await hiddenNamesIn('D:\\', options)).has('$recycle.bin')).toBe(true)
    await hiddenNamesIn('D:\\', options)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('"chcp 65001>nul & attrib /d "D:\\*""')
    now += 20_000
    await hiddenNamesIn('D:\\', options)
    expect(run).toHaveBeenCalledTimes(2)

    expect((await hiddenNamesIn('/home/a', { platform: 'linux', run })).size).toBe(0)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not hand a path cmd.exe could read as syntax to the shell', async () => {
    const run = vi.fn(async () => ATTRIB)
    for (const dir of ['D:\\100%\\x', 'D:\\a"b', '\\\\server\\share', 'relative'])
      expect((await hiddenNamesIn(dir, { platform: 'win32', run })).size).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('folders of the system and the drive', () => {
  it('stay out of the tree and out of indexing', () => {
    for (const name of [
      '$RECYCLE.BIN',
      '$WinREAgent',
      'System Volume Information',
      'Recovery',
      'Config.Msi',
      'lost+found',
    ]) {
      expect(isHiddenEntry('D:\\', name, true), name).toBe(true)
      expect(shouldSkipDirectory(name), name).toBe(true)
    }
    // a person's own folders are never taken for system ones
    for (const name of ['03_Giấy tờ', '_kddi_restore', 'Bravo 8', 'Recovery plan 2026'])
      expect(shouldSkipDirectory(name), name).toBe(false)
  })

  describe('in a real folder', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'genoffice-sys-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('the listing leaves them out', () => {
      for (const name of ['$RECYCLE.BIN', 'System Volume Information', 'Hồ sơ'])
        mkdirSync(join(dir, name))
      writeFileSync(join(dir, 'a.docx'), 'x')
      const listing = listFolder(dir, new Set())
      expect(listing.folders.map((folder) => folder.name)).toEqual(['Hồ sơ'])
      expect(listing.files.map((file) => file.name)).toEqual(['a.docx'])
    })
  })
})

describe("the app's own folder in the tree", () => {
  it('is hidden until it is switched on', () => {
    expect(showDefaultFolderFrom({})).toBe(false)
    expect(showDefaultFolderFrom({ showDefaultFolder: 'true' })).toBe(false)
    expect(showDefaultFolderFrom({ showDefaultFolder: true })).toBe(true)
  })
})
