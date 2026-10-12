import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
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
    // "ra viện" is also written "xuất viện": Everything is asked for either
    expect(calls[0]!.slice(-3)).toEqual(['giấy', '<ra|xuất>', 'viện'])
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
    // the sort option is dropped for good once it has been refused: whole-word, retry, substring
    expect(calls.map((args) => args.includes('-sort'))).toEqual([true, false, false])
  })

  it('looks for whole words first and only widens to parts of words when that finds too few', async () => {
    const { run, calls } = fakeEs(['Mỹ Lệ bản vẽ.docx,D:\\DNTT'])
    const hits = await winSearch(run).search('mỹ lệ', 3)
    expect(calls.map((args) => args.includes('-whole-word'))).toEqual([true, false])
    // the same file in both answers is listed once
    expect(hits).toHaveLength(1)
  })

  it('stays with whole words when they already fill the page', async () => {
    const { run, calls } = fakeEs(['baocao1.docx,D:\\x', 'baocao2.docx,D:\\x'])
    const hits = await winSearch(run).search('baocao', 2)
    expect(calls).toHaveLength(1)
    expect(hits).toHaveLength(2)
  })

  it('drops filler words, then widens to all-but-one of the words (folders counted) and ranks by words matched', async () => {
    const calls: string[][] = []
    const run: EsRunner = async (_file, args) => {
      calls.push(args)
      const out = args[args.indexOf('-export-csv') + 1]!
      // only the loose pass finds anything: no name has all six words
      const rows = args.includes('-match-path')
        ? ['pham huu cong.pdf,D:\\other', 'giay ra vien.pdf,D:\\huucong']
        : []
      writeFileSync(out, 'Name,Path\n' + rows.join('\n') + '\n')
      return { code: 0 }
    }
    const hits = await winSearch(run).search('tôi tìm file giấy ra viện của ông phạm hữu công', 5)

    const wordsOf = (args: string[]): string[] => args.slice(args.indexOf('-utf8-bom') + 1)
    expect(wordsOf(calls[0]!)).toEqual(['giấy', '<ra|xuất>', 'viện', 'phạm', 'hữu', 'công'])
    expect(
      calls.map((args) => [args.includes('-whole-word'), args.includes('-match-path')]),
    ).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ])
    // six groups of five words, each its own argument (one argument with spaces is a phrase)
    const loose = wordsOf(calls[2]!)
    expect(loose.filter((token) => token === '|')).toHaveLength(5)
    expect(
      loose.filter((token) => token.startsWith('<') && !token.startsWith('<ra|')),
    ).toHaveLength(6)
    expect(loose.every((token) => !/\s/.test(token))).toBe(true)
    // the paper in the folder named after the person has more of the words than the person's own file
    expect(hits.map((hit) => hit.path)).toEqual([
      'D:\\huucong\\giay ra vien.pdf',
      'D:\\other\\pham huu cong.pdf',
    ])
  })

  it('does not widen a two-word search to either word', async () => {
    const { run, calls } = fakeEs([])
    await winSearch(run).search('mỹ lệ', 5)
    expect(calls.map((args) => args.includes('-match-path'))).toEqual([false, false])
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
      this.emit('message', {
        id: message.id,
        result: (message.texts ?? []).map(() =>
          new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1),
        ),
      })
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
  afterEach(async () => {
    await manager?.closeAsync()
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
