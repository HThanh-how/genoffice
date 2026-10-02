import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import {
  EverythingSearch,
  esQueryWords,
  parseEsCsv,
  type EsRunner,
} from '../src/main/everything/es-client'
import { isJunkPath, isProgramFile } from '../src/main/everything/junk'

describe('esQueryWords', () => {
  it('keeps plain words and drops anything es.exe or Everything could read as syntax', () => {
    expect(esQueryWords('giấy ra viện')).toEqual(['giấy', 'ra', 'viện'])
    expect(esQueryWords('-export-txt C:\\x "a|b" <c> !d /s')).toEqual([
      'export-txt',
      'C:\\x',
      'ab',
      'c',
      'd',
      's',
    ])
    expect(esQueryWords('   ')).toEqual([])
  })
})

describe('parseEsCsv', () => {
  it('joins the Name and Path columns, with a BOM, quotes and Vietnamese letters', () => {
    const csv = '\ufeffName,Path\r\n"Mỹ Lệ, bản 2.docx","D:\\Hồ sơ"\r\nplain.pdf,E:\\a\r\n'
    expect(parseEsCsv(csv)).toEqual([
      { path: 'D:\\Hồ sơ\\Mỹ Lệ, bản 2.docx', name: 'Mỹ Lệ, bản 2.docx' },
      { path: 'E:\\a\\plain.pdf', name: 'plain.pdf' },
    ])
  })

  it('reads a single full-path column when there is no Path column', () => {
    expect(parseEsCsv('Filename\nD:\\x\\y.docx\n').map((hit) => hit.path)).toEqual([
      'D:\\x\\y.docx',
    ])
  })
})

describe('isJunkPath / isProgramFile', () => {
  it('drops system, program, cache and machinery files but keeps documents', () => {
    expect(isJunkPath('D:\\Hồ sơ\\giấy ra viện.pdf')).toBe(false)
    expect(isJunkPath('C:\\Users\\Admin\\Documents\\a.docx')).toBe(false)
    expect(isJunkPath('C:\\Windows\\System32\\drivers\\x.txt')).toBe(true)
    expect(isJunkPath('C:\\Program Files\\App\\readme.txt')).toBe(true)
    expect(isJunkPath('C:\\Users\\Admin\\AppData\\Local\\a.json')).toBe(true)
    expect(isJunkPath('D:\\proj\\node_modules\\x\\index.md')).toBe(true)
    expect(isJunkPath('D:\\proj\\.git\\config')).toBe(true)
    expect(isJunkPath('D:\\Docs\\x.dll')).toBe(true)
    expect(isJunkPath('D:\\Docs\\~$a.docx')).toBe(true)
  })

  it('treats files that run when opened as programs', () => {
    expect(isProgramFile('D:\\a\\setup.EXE')).toBe(true)
    expect(isProgramFile('D:\\a\\run.ps1')).toBe(true)
    expect(isProgramFile('D:\\a\\a.docx')).toBe(false)
  })
})

/** A fake es.exe: writes the CSV the real one would into the -export-csv file. */
function fakeEs(rows: string[], code = 0): { run: EsRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: EsRunner = async (_file, args) => {
    calls.push(args)
    const out = args[args.indexOf('-export-csv') + 1]!
    if (code === 0) writeFileSync(out, '\ufeffName,Path\r\n' + rows.join('\r\n') + '\r\n')
    return { code }
  }
  return { run, calls }
}

const winSearch = (
  run: EsRunner,
  extra: Partial<ConstructorParameters<typeof EverythingSearch>[0]> = {},
) =>
  new EverythingSearch({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: (path) => path.endsWith('es.exe'),
    run,
    ...extra,
  })

describe('EverythingSearch', () => {
  it('asks es.exe for a UTF-8 export of the words typed and filters the answer', async () => {
    const { run, calls } = fakeEs([
      'giấy ra viện.pdf,D:\\Hồ sơ',
      'x.dll,C:\\Windows',
      'setup.exe,D:\\Downloads',
      'a.docx,C:\\Users\\Admin\\AppData\\Local',
    ])
    const hits = await winSearch(run).search('giấy ra viện', 5)
    expect(hits.map((hit) => hit.path)).toEqual(['D:\\Hồ sơ\\giấy ra viện.pdf'])
    expect(calls[0]).toContain('-utf8-bom')
    expect(calls[0]!.slice(-3)).toEqual(['giấy', 'ra', 'viện'])
  })

  it('gives up for a while when Everything is not running instead of asking every time', async () => {
    const { run, calls } = fakeEs([], 8)
    let now = 1_000
    const search = winSearch(run, { now: () => now })
    expect(await search.search('abc', 3)).toEqual([])
    expect(await search.search('abc', 3)).toEqual([])
    expect(calls).toHaveLength(1)
    now += 31_000
    await search.search('abc', 3)
    expect(calls).toHaveLength(2)
  })

  it('retries without the sort option when es.exe does not accept it', async () => {
    const calls: string[][] = []
    const run: EsRunner = async (_file, args) => {
      calls.push(args)
      if (args.includes('-sort')) return { code: 1 }
      writeFileSync(args[args.indexOf('-export-csv') + 1]!, 'Name,Path\nb.docx,D:\\x\n')
      return { code: 0 }
    }
    const hits = await winSearch(run).search('b', 3)
    expect(hits).toHaveLength(1)
    expect(calls.map((args) => args.includes('-sort'))).toEqual([true, false])
  })

  it('does nothing when it is switched off, off Windows, or without es.exe', async () => {
    const { run, calls } = fakeEs(['a.docx,D:\\x'])
    expect(await winSearch(run, { enabled: () => false }).search('a', 3)).toEqual([])
    expect(await winSearch(run, { platform: 'darwin' }).search('a', 3)).toEqual([])
    expect(await winSearch(run, { exists: () => false }).search('a', 3)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('prefers the es.exe the person set', () => {
    const search = winSearch(fakeEs([]).run, {
      configuredPath: () => 'F:\\tools\\es.exe',
      exists: (path) => path === 'F:\\tools\\es.exe',
    })
    expect(search.locate()).toBe('F:\\tools\\es.exe')
  })
})

class QuietWorker extends EventEmitter {
  postMessage(message: { id: number; type: string; texts?: string[] }): void {
    setTimeout(() => {
      this.emit('message', { type: 'model', state: 'ready' })
      this.emit('message', { id: message.id, result: (message.texts ?? []).map(() => [1, 0]) })
    }, 0)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('document search with an outside file-name source', () => {
  let dir: string
  let manager: DocumentMemoryManager | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-ext-'))
  })
  afterEach(() => {
    manager?.close()
    manager = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds files found only by name, and opens only the paths it handed out', async () => {
    const real = join(dir, 'Mỹ Lệ bản vẽ.dwg')
    writeFileSync(real, 'x')
    manager = new DocumentMemoryManager(join(dir, 'user'), {
      workerFactory: () => new QuietWorker() as unknown as Worker,
      pollIntervalMs: 3_600_000,
      externalNames: async () => [{ path: real, name: 'Mỹ Lệ bản vẽ.dwg' }],
    })

    const { hits } = await manager.search('mỹ lệ', 5)
    const found = hits.find((hit) => hit.path === real)!
    expect(found).toMatchObject({ documentId: 0, contentUnread: true, location: 'file name' })

    expect(manager.openOffered(real)).toBe(real)
    // a path nobody offered cannot be opened through the assistant
    expect(manager.openOffered(join(dir, 'secret.txt'))).toBeNull()
  })

  it('does not list a file twice when it is already in the index', async () => {
    const indexed = join(dir, 'Giấy ra viện.txt')
    writeFileSync(indexed, 'Giấy ra viện của bệnh nhân. '.repeat(20))
    manager = new DocumentMemoryManager(join(dir, 'user'), {
      workerFactory: () => new QuietWorker() as unknown as Worker,
      pollIntervalMs: 3_600_000,
      externalNames: async () => [{ path: indexed, name: 'Giấy ra viện.txt' }],
    })
    manager.indexDiscoveredFile(indexed)
    const { hits } = await manager.search('giấy ra viện', 5)
    expect(hits.filter((hit) => hit.path === indexed)).toHaveLength(1)
  })
})
