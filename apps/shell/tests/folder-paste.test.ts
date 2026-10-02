import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClipboardFiles, writeClipboardFiles } from '../src/main/fork/clipboard-files'
import { parseClipboardFiles, pasteFiles } from '../src/main/fork/folder-paste'

describe('what the clipboard holds', () => {
  it("reads Explorer's Copy and Cut, Vietnamese names included", () => {
    expect(
      parseClipboardFiles('EFFECT=5\r\nD:\\Hồ sơ\\giấy ra viện.pdf\r\nD:\\Bravo 8\r\n'),
    ).toEqual({
      paths: ['D:\\Hồ sơ\\giấy ra viện.pdf', 'D:\\Bravo 8'],
      cut: false,
    })
    expect(parseClipboardFiles('EFFECT=2\r\nD:\\a.docx\r\n').cut).toBe(true)
    expect(parseClipboardFiles('').paths).toEqual([])
    // text that only looks like a path list is not taken for files
    expect(parseClipboardFiles('hello\nworld').paths).toEqual([])
  })

  it('asks PowerShell for the file list, and hands it the paths through the environment', async () => {
    const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const exec = async (file: string, args: string[], env?: NodeJS.ProcessEnv) => {
      calls.push({ file, args, env })
      return { ok: true, stdout: 'EFFECT=1\r\nC:\\x\\a.txt\r\n' }
    }
    expect(await readClipboardFiles('win32', exec)).toEqual({ paths: ['C:\\x\\a.txt'], cut: false })
    expect(calls[0]!.file).toBe('powershell.exe')
    expect(calls[0]!.args).toContain('-STA')

    expect(await writeClipboardFiles(['C:\\x\\a "b".txt', 'C:\\y&z\\Đề.docx'], 'win32', exec)).toBe(
      true,
    )
    const write = calls[1]!
    // the script never holds a path: nothing in a file name can become code
    expect(write.args.at(-1)).not.toContain('Đề')
    expect(JSON.parse(write.env!.GENOFFICE_PATHS!)).toEqual([
      'C:\\x\\a "b".txt',
      'C:\\y&z\\Đề.docx',
    ])

    expect(await readClipboardFiles('linux', exec)).toEqual({ paths: [], cut: false })
    expect(await writeClipboardFiles([], 'win32', exec)).toBe(false)
  })
})

describe('pasting files into a folder', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genoffice-paste-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const file = (path: string, text = 'x'): string => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
    return path
  }

  it('copies files and whole folders, and never overwrites a name that is taken', () => {
    const a = file(join(root, 'src', 'giấy ra viện.pdf'), 'new')
    const folder = join(root, 'src', 'Ba')
    file(join(folder, 'in.txt'))
    const target = join(root, 'dest')
    file(join(target, 'giấy ra viện.pdf'), 'old')

    const result = pasteFiles(target, { paths: [a, folder], cut: false })

    expect(result).toEqual({ pasted: 2, failed: 0 })
    expect(readFileSync(join(target, 'giấy ra viện.pdf'), 'utf8')).toBe('old')
    expect(readFileSync(join(target, 'giấy ra viện (2).pdf'), 'utf8')).toBe('new')
    expect(existsSync(join(target, 'Ba', 'in.txt'))).toBe(true)
    expect(existsSync(a)).toBe(true) // copy: the original stays
  })

  it('moves what was cut, and does nothing when it is cut into its own folder', () => {
    const a = file(join(root, 'src', 'a.docx'))
    const b = file(join(root, 'dest', 'b.docx'))
    const target = join(root, 'dest')

    expect(pasteFiles(target, { paths: [a], cut: true })).toEqual({ pasted: 1, failed: 0 })
    expect(existsSync(a)).toBe(false)
    expect(existsSync(join(target, 'a.docx'))).toBe(true)

    expect(pasteFiles(target, { paths: [b], cut: true })).toEqual({ pasted: 0, failed: 0 })
    expect(existsSync(b)).toBe(true)
  })

  it('refuses a folder into itself, reports a missing file, and carries on with the rest', () => {
    const outer = join(root, 'outer')
    mkdirSync(join(outer, 'inner'), { recursive: true })
    const ok = file(join(root, 'ok.txt'))
    const result = pasteFiles(join(outer, 'inner'), {
      paths: [outer, join(root, 'gone.txt'), ok],
      cut: false,
    })
    expect(result.pasted).toBe(1)
    expect(result.failed).toBe(2)
    expect(result.error).toBeTruthy()
    expect(existsSync(join(outer, 'inner', 'ok.txt'))).toBe(true)
  })

  it('says there was nothing to paste', () => {
    expect(pasteFiles(root, { paths: [], cut: false })).toEqual({
      pasted: 0,
      failed: 0,
      none: true,
    })
  })
})
