import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAction, PendingFileAction } from '@genoffice/agent-core'
import { FileManagementService, FILE_ACTION_TTL_MS } from '../src/main/file-management'
import { setActiveIgnoreRules } from '../src/main/document-memory/ignore-policy'

let sandbox: string
let root: string
let userData: string
let clock: number
let service: FileManagementService
let trash: ReturnType<typeof vi.fn>
let exporter: ReturnType<typeof vi.fn>
let merger: ReturnType<typeof vi.fn>
const file = (name: string) => join(root, name)
const propose = (action: FileAction, owner = 1): PendingFileAction => {
  const proposal = service.propose(owner, action)
  if (!('pending' in proposal)) throw new Error('Expected pending action')
  return proposal.pending
}

beforeEach(() => {
  // Test data stays inside this worktree; never use a running app's userData.
  const scratch = resolve('../../working_dir/file-management-tests')
  mkdirSync(scratch, { recursive: true })
  sandbox = mkdtempSync(join(scratch, 'case-'))
  root = join(sandbox, 'allowed')
  userData = join(root, 'app-data')
  mkdirSync(root)
  mkdirSync(userData)
  clock = 1000
  trash = vi.fn(async () => {})
  exporter = vi.fn(async (_input: string, output: string) => {
    writeFileSync(output, '%PDF-test')
  })
  merger = vi.fn(async (_action: FileAction, output: string) => writeFileSync(output, '# Merged'))
  service = new FileManagementService({
    roots: () => [root],
    userData: () => userData,
    trashItem: trash,
    exportPdf: exporter,
    mergeDocuments: merger,
    now: () => clock,
  })
  setActiveIgnoreRules([])
})

afterEach(() => {
  // Resolve and check the target before recursive fixture cleanup on Windows.
  const scratch = resolve('../../working_dir/file-management-tests')
  if (!sandbox.startsWith(scratch + '\\') && !sandbox.startsWith(scratch + '/'))
    throw new Error('Unsafe cleanup target')
  rmSync(sandbox, { recursive: true, force: true })
})

describe('main-process file permissions', () => {
  const merge = (): FileAction => ({
    tool: 'merge_documents',
    sources: [file('a.md'), file('b.md')],
    title: 'Combined',
    format: 'md',
    separator: 'heading',
  })

  it('gates merging, lists every source and exact destination, and never mutates sources', async () => {
    writeFileSync(file('a.md'), '# A')
    writeFileSync(file('b.md'), '- B')
    let p = propose(merge())
    expect(p.action.sources).toEqual(merge().sources)
    expect(p.action.destination).toBe(file('Combined.md'))
    expect(merger).not.toHaveBeenCalled()
    await service.decide(1, p.id, false)
    expect(merger).not.toHaveBeenCalled()
    expect(existsSync(file('Combined.md'))).toBe(false)
    p = propose(merge())
    await expect(service.decide(2, p.id, true)).rejects.toThrow(/missing/)
    await service.decide(1, p.id, true)
    expect(merger).toHaveBeenCalledOnce()
    expect(readFileSync(file('a.md'), 'utf8')).toBe('# A')
    expect(readFileSync(file('b.md'), 'utf8')).toBe('- B')
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/missing/)
    expect(() => propose(merge())).toThrow(/exists/)
  })

  it('rejects invalid merge inputs, excluded paths, symlinks and total source size', () => {
    writeFileSync(file('a.md'), 'A')
    writeFileSync(file('b.md'), 'B')
    writeFileSync(file('c.txt'), 'C')
    for (const change of [
      { sources: [file('a.md')] },
      { sources: Array(21).fill(file('a.md')) },
      { sources: [file('a.md'), 'relative.md'] },
      { sources: [file('a.md'), file('c.txt')] },
      { sources: [file('a.md'), join(userData, 'private.md')] },
      { title: '../escape' },
      { outputFolder: sandbox },
      { format: 'pdf' },
      { separator: 'invalid' },
    ])
      expect(() => propose({ ...merge(), ...change } as FileAction)).toThrow()
    symlinkSync(root, file('alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => propose({ ...merge(), sources: [file('a.md'), file('alias/b.md')] })).toThrow(
      /Symlink/,
    )
    truncateSync(file('a.md'), 70 * 1024 * 1024)
    truncateSync(file('b.md'), 70 * 1024 * 1024)
    expect(() => propose(merge())).toThrow(/128 MiB/)
  })

  it('allows an explicit approved output folder while keeping source files in place', async () => {
    writeFileSync(file('a.md'), 'A')
    writeFileSync(file('b.md'), 'B')
    const outputFolder = file('outputs')
    mkdirSync(outputFolder)
    const p = propose({ ...merge(), outputFolder })
    expect(p.action.destination).toBe(join(outputFolder, 'Combined.md'))
    await service.decide(1, p.id, true)
    expect(readFileSync(join(outputFolder, 'Combined.md'), 'utf8')).toBe('# Merged')
    expect(readFileSync(file('a.md'), 'utf8')).toBe('A')
    expect(readFileSync(file('b.md'), 'utf8')).toBe('B')
  })

  it('rechecks all merge sources after approval and refuses a destination race', async () => {
    writeFileSync(file('a.md'), 'A')
    writeFileSync(file('b.md'), 'B')
    let p = propose(merge())
    writeFileSync(file('b.md'), 'changed')
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/changed/)
    expect(merger).not.toHaveBeenCalled()
    p = propose(merge())
    merger.mockImplementationOnce(async (_a: FileAction, output: string) => {
      writeFileSync(output, 'new')
      writeFileSync(file('Combined.md'), 'keep')
    })
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/exists/)
    expect(readFileSync(file('Combined.md'), 'utf8')).toBe('keep')
  })

  it('rechecks sources during merge and bounds generated output', async () => {
    writeFileSync(file('a.md'), 'A')
    writeFileSync(file('b.md'), 'B')
    let p = propose(merge())
    merger.mockImplementationOnce(async (_a: FileAction, output: string) => {
      writeFileSync(output, 'new')
      writeFileSync(file('a.md'), 'external edit')
    })
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/changed/)
    expect(existsSync(file('Combined.md'))).toBe(false)
    p = propose(merge())
    merger.mockImplementationOnce(async (_a: FileAction, output: string) => {
      writeFileSync(output, '')
      truncateSync(output, 129 * 1024 * 1024)
    })
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/oversized/)
    expect(existsSync(file('Combined.md'))).toBe(false)
  })
  it('rejects relative paths, traversal, siblings outside roots, userData and existing destinations', () => {
    writeFileSync(file('a.md'), 'a')
    writeFileSync(file('b.md'), 'b')
    for (const path of [
      'relative',
      join(root, '..', 'outside.md'),
      root + '/child/../a.md',
      join(userData, 'secret.md'),
    ]) {
      expect(() => propose({ tool: 'delete_file', path })).toThrow()
    }
    expect(() => propose({ tool: 'create_folder', path: root })).toThrow(/exists/)
    expect(() =>
      propose({ tool: 'move_file', source: file('a.md'), destination: file('b.md') }),
    ).toThrow(/exists/)
    expect(() =>
      propose({ tool: 'move_file', source: file('a.md'), destination: join(sandbox, 'out.md') }),
    ).toThrow(/outside/)
  })

  it('rejects system locations even when configured as roots', () => {
    const system = process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc'
    const s = new FileManagementService({
      roots: () => [system],
      userData: () => userData,
      trashItem: trash,
      exportPdf: exporter,
    })
    expect(() => s.propose(1, { tool: 'list_folder', path: system })).toThrow(/System/)
  })

  it('rejects symlink escapes, including not-yet-existing destinations', () => {
    const outside = join(sandbox, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, file('escape'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(outside, 'a.md'), 'secret')
    expect(() => propose({ tool: 'delete_file', path: file('escape/a.md') })).toThrow()
    expect(() => propose({ tool: 'create_folder', path: file('escape/new') })).toThrow()
  })

  it('does nothing before approval, consumes denial, scopes tokens to a window and prevents replay', async () => {
    writeFileSync(file('a.md'), 'a')
    const p = propose({ tool: 'delete_file', path: file('a.md') })
    expect(trash).not.toHaveBeenCalled()
    await expect(service.decide(2, p.id, true)).rejects.toThrow(/missing/)
    expect(trash).not.toHaveBeenCalled()
    expect(await service.decide(1, p.id, false)).toMatchObject({ denied: true })
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/missing/)
    const approved = propose({ tool: 'delete_file', path: file('a.md') })
    await service.decide(1, approved.id, true)
    expect(trash).toHaveBeenCalledExactlyOnceWith(file('a.md'))
    // A trash adapter is the only deletion path: a no-op adapter leaves the file intact.
    expect(readFileSync(file('a.md'), 'utf8')).toBe('a')
    await expect(service.decide(1, approved.id, true)).rejects.toThrow(/missing/)
  })

  it('rejects expired, changed, newly ignored and newly conflicting proposals', async () => {
    writeFileSync(file('a.md'), 'a')
    let p = propose({ tool: 'delete_file', path: file('a.md') })
    clock += FILE_ACTION_TTL_MS
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/expired/)
    p = propose({ tool: 'delete_file', path: file('a.md') })
    writeFileSync(file('a.md'), 'changed')
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/changed/)
    p = propose({ tool: 'delete_file', path: file('a.md') })
    setActiveIgnoreRules([{ id: 'test', enabled: true, pattern: '*.md', scope: 'global' }])
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/excluded/)
    setActiveIgnoreRules([])
    p = propose({ tool: 'move_file', source: file('a.md'), destination: file('b.md') })
    writeFileSync(file('b.md'), 'existing')
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/exists/)
    expect(readFileSync(file('b.md'), 'utf8')).toBe('existing')
    expect(trash).not.toHaveBeenCalled()
  })

  it('creates one folder and moves/renames a file without overwriting', async () => {
    const folder = propose({ tool: 'create_folder', path: file('new') })
    expect(existsSync(file('new'))).toBe(false)
    await service.decide(1, folder.id, true)
    expect(lstatSync(file('new')).isDirectory()).toBe(true)
    writeFileSync(file('a.md'), 'a')
    const move = propose({ tool: 'move_file', source: file('a.md'), destination: file('new/b.md') })
    expect(existsSync(file('a.md'))).toBe(true)
    expect(existsSync(file('new/b.md'))).toBe(false)
    await service.decide(1, move.id, true)
    expect(existsSync(file('a.md'))).toBe(false)
    expect(readFileSync(file('new/b.md'), 'utf8')).toBe('a')
    expect(() => propose({ tool: 'delete_file', path: file('new') })).toThrow(/regular/)
  })

  it('checks symlinks again when approved and refuses oversized files', async () => {
    mkdirSync(file('parent'))
    writeFileSync(file('parent/a.md'), 'a')
    const p = propose({ tool: 'delete_file', path: file('parent/a.md') })
    renameSync(file('parent'), join(sandbox, 'relocated'))
    symlinkSync(
      join(sandbox, 'relocated'),
      file('parent'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(service.decide(1, p.id, true)).rejects.toThrow()
    expect(trash).not.toHaveBeenCalled()
    writeFileSync(file('big.md'), '')
    truncateSync(file('big.md'), 129 * 1024 * 1024)
    expect(() => propose({ tool: 'delete_file', path: file('big.md') })).toThrow(/128 MiB/)
  })

  it('bounds listings, withholds ignored files, and returns sizes and timestamps', () => {
    for (let i = 0; i < 205; i++) writeFileSync(file(`${i}.md`), 'data')
    writeFileSync(file('.secret'), 'secret')
    const result = service.propose(1, { tool: 'list_folder', path: root })
    expect('result' in result).toBe(true)
    if (!('result' in result)) return
    const listing = result.result as {
      entries: { name: string; size: number; mtimeMs: number }[]
      truncated: boolean
    }
    expect(listing.entries).toHaveLength(200)
    expect(listing.truncated).toBe(true)
    expect(listing.entries.every((e) => e.size === 4 && e.mtimeMs > 0)).toBe(true)
    expect(listing.entries.some((e) => e.name === '.secret' || e.name === 'app-data')).toBe(false)
  })

  it('exports only after approval, beside the source, and refuses overwrite even during export', async () => {
    writeFileSync(file('a.md'), '# Document')
    let p = propose({ tool: 'export_pdf', path: file('a.md') })
    expect(p.action.destination).toBe(file('a.pdf'))
    expect(exporter).not.toHaveBeenCalled()
    await service.decide(1, p.id, true)
    expect(exporter).toHaveBeenCalledOnce()
    expect(readFileSync(file('a.pdf'), 'utf8')).toBe('%PDF-test')
    expect(() => propose({ tool: 'export_pdf', path: file('a.md') })).toThrow(/exists/)
    writeFileSync(file('b.md'), '# B')
    p = propose({ tool: 'export_pdf', path: file('b.md') })
    exporter.mockImplementationOnce(async (_input: string, output: string) => {
      writeFileSync(output, '%PDF-new')
      writeFileSync(file('b.pdf'), 'existing')
    })
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/exists/)
    expect(readFileSync(file('b.pdf'), 'utf8')).toBe('existing')
  })

  it('never falls back to permanent deletion when OS trash fails', async () => {
    writeFileSync(file('a.md'), 'keep')
    const p = propose({ tool: 'delete_file', path: file('a.md') })
    trash.mockRejectedValueOnce(new Error('trash unavailable'))
    await expect(service.decide(1, p.id, true)).rejects.toThrow(/trash unavailable/)
    expect(readFileSync(file('a.md'), 'utf8')).toBe('keep')
  })
})
