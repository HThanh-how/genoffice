import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderScanManager } from '../src/main/document-memory/folder-scan'

let dir: string
let scanners: FolderScanManager[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-folder-scan-'))
  scanners = []
})
afterEach(() => {
  for (const scanner of scanners) scanner.close()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for folder scan')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function scanner(userData: string, indexer: (path: string) => boolean) {
  const instance = new FolderScanManager(userData, { indexDiscoveredFile: indexer })
  scanners.push(instance)
  return instance
}

describe('FolderScanManager', () => {
  it('never reconciles deletions from a partial unavailable inventory', async () => {
    const root = join(dir, 'company')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'report.txt'), 'report')
    const reconcileFolder = vi.fn(async () => {})
    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: () => true,
      reconcileFolder,
    })
    scanners.push(instance)
    instance.start(root)
    await until(() => !instance.status().running)
    const walker = instance as unknown as {
      traverse(
        root: string,
        handlers: { onError(error: unknown): void },
        stop: () => boolean,
      ): Promise<boolean>
    }
    const original = walker.traverse.bind(instance)
    vi.spyOn(walker, 'traverse').mockImplementation(async (_root, handlers) => {
      handlers.onError(new Error('share disconnected midway'))
      return true
    })
    expect(await instance.reconcile(root)).toEqual({ ok: false, reason: 'unavailable' })
    expect(reconcileFolder).not.toHaveBeenCalled()
    vi.mocked(walker.traverse).mockImplementation(original)
    expect(await instance.reconcile(root)).toEqual({ ok: true, files: 1 })
    expect(reconcileFolder).toHaveBeenCalledOnce()
  })

  it('recursively enrolls supported files and skips generated folders and symlinks', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(join(root, 'nested'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, '.private'), { recursive: true })
    writeFileSync(join(root, 'notes.md'), 'notes')
    writeFileSync(join(root, 'nested', 'report.xlsx'), 'sheet')
    writeFileSync(join(root, 'archive.zip'), 'not supported')
    writeFileSync(join(root, 'node_modules', 'ignored.pdf'), 'generated')
    writeFileSync(join(root, '.private', 'hidden.pdf'), 'hidden')
    const outside = join(dir, 'outside.pdf')
    writeFileSync(outside, 'outside selected folder')
    let hasSymlink = false
    try {
      symlinkSync(outside, join(root, 'linked.pdf'))
      hasSymlink = true
    } catch {
      // Windows may require developer mode or elevated privileges for symlinks.
    }

    const enrolled: string[] = []
    const instance = scanner(join(dir, 'state'), (path) => {
      enrolled.push(path)
      return true
    })
    instance.start(root)
    await until(() => !instance.status().running)

    expect(enrolled.sort()).toEqual(
      [join(root, 'nested', 'report.xlsx'), join(root, 'notes.md')].sort(),
    )
    expect(instance.status()).toMatchObject({ discovered: 2, enrolled: 2, errors: 0 })
    expect(instance.status().skipped).toBeGreaterThanOrEqual(hasSymlink ? 4 : 3)
  })

  it('resumes a persisted selected root after restart and enrollment remains idempotent', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'one.txt'), 'one')
    writeFileSync(join(root, 'two.pdf'), 'two')
    const userData = join(dir, 'state')
    const indexed = new Set<string>()
    const indexer = (path: string) => {
      const isNew = !indexed.has(path)
      indexed.add(path)
      return isNew
    }

    const first = scanner(userData, indexer)
    first.start(root)
    first.close()

    const resumed = scanner(userData, indexer)
    await until(() => !resumed.status().running && resumed.status().discovered === 2)

    expect(indexed.size).toBe(2)
    expect(resumed.status()).toMatchObject({ root, discovered: 2, enrolled: 2, errors: 0 })
  })

  it('persists an explicit stop so the selected folder is not rescanned after restart', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'one.txt'), 'one')
    let enrollments = 0
    const userData = join(dir, 'state')
    const first = scanner(userData, () => {
      enrollments++
      return true
    })

    first.start(root)
    first.stop()
    first.close()
    const resumed = scanner(userData, () => {
      enrollments++
      return true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(enrollments).toBe(0)
    expect(resumed.status()).toMatchObject({ running: false, root, discovered: 0 })
  })

  it('rejects the filesystem root so a scan never walks the operating system', () => {
    const instance = scanner(join(dir, 'state'), () => true)
    const systemRoot = process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/'
    expect(() => instance.start(systemRoot)).toThrow(/below the system drive root/)
  })

  it('scans a folder added while another is being scanned, once that one is done', async () => {
    const first = join(dir, 'first')
    const second = join(dir, 'second')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(join(first, 'a.txt'), 'a')
    writeFileSync(join(second, 'b.txt'), 'b')
    const enrolled: string[] = []
    const instance = scanner(join(dir, 'state'), (path) => {
      enrolled.push(path)
      return true
    })

    instance.start(first)
    expect(() => instance.start(second)).not.toThrow()
    await until(() => enrolled.length === 2 && !instance.status().running)

    expect(enrolled.sort()).toEqual([join(first, 'a.txt'), join(second, 'b.txt')].sort())
    expect(
      instance
        .folders()
        .map((entry) => entry.root)
        .sort(),
    ).toEqual([first, second].sort())
  })

  it('continues after a file enrollment error and reports it', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'bad.txt'), 'bad')
    writeFileSync(join(root, 'good.txt'), 'good')
    const instance = scanner(join(dir, 'state'), (path) => {
      if (path.endsWith('bad.txt')) throw new Error('test enrollment failure')
      return true
    })

    instance.start(root)
    await until(() => !instance.status().running)

    expect(instance.status()).toMatchObject({ discovered: 2, enrolled: 1, errors: 1 })
    expect(instance.status().lastError).toBe('test enrollment failure')
  })

  it('keeps a history of scans, can prioritise a folder and can forget it', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.md'), 'a')
    writeFileSync(join(root, 'b.md'), 'b')
    const prioritized: string[] = []
    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: () => true,
      prioritizeFolder: (folder) => {
        prioritized.push(folder)
        return 0
      },
    })
    scanners.push(instance)
    instance.start(root)
    await until(() => !instance.status().running)

    const [folder] = instance.folders()
    expect(folder).toMatchObject({ root, state: 'complete', priority: false })
    expect(folder!.completedAt).toBeGreaterThan(0)
    expect(folder!.history).toHaveLength(1)
    expect(folder!.history[0]).toMatchObject({ kind: 'scan', state: 'complete', discovered: 2 })

    expect(instance.setPriority(root, true)).toBe(true)
    expect(prioritized).toEqual([root])
    expect(instance.folders()[0]!.priority).toBe(true)
    // the flag survives a restart
    const again = new FolderScanManager(join(dir, 'state'), { indexDiscoveredFile: () => true })
    scanners.push(again)
    expect(again.folders()[0]!.priority).toBe(true)

    expect(instance.setPriority(join(dir, 'unknown'), true)).toBe(false)
    expect(instance.forget(root)).toBe(true)
    expect(instance.folders()).toEqual([])
  })

  it('A-03 & A-04: Bật B khi A đang scan -> B vào waiting. Tắt B ngay lập tức -> B bị xóa khỏi waiting, B không bao giờ được scan!', async () => {
    const folderA = join(dir, 'folderA')
    const folderB = join(dir, 'folderB')
    mkdirSync(folderA, { recursive: true })
    mkdirSync(folderB, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderA, `docA_${i}.txt`), `contentA_${i}`)
    }
    writeFileSync(join(folderB, 'docB.txt'), 'contentB')

    const enrolledB: string[] = []
    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: (path) => {
        if (path.includes('folderB')) {
          enrolledB.push(path)
        }
        return true
      },
    })
    scanners.push(instance)

    // Start A
    instance.start(folderA, 'manual')

    // Bật B khi A đang scan -> B vào waiting
    instance.start(folderB, 'known:downloads')
    expect(instance.isWaiting(folderB)).toBe(true)

    // Tắt B ngay lập tức
    const unregisterResult = await instance.unregisterRoot(folderB, 'known:downloads')
    expect(unregisterResult).toBe(true)

    // B phải bị xóa khỏi waiting ngay lập tức
    expect(instance.isWaiting(folderB)).toBe(false)

    // Chờ A hoàn thành
    await until(() => !instance.status().running)

    // B không bao giờ được scan
    expect(enrolledB).toHaveLength(0)
    expect(instance.folders().map((f) => f.root)).not.toContain(resolve(folderB))
  })

  it('A-05: Tắt B đang active scan -> dừng an toàn và gỡ bỏ sau khi runner exit', async () => {
    const folderB = join(dir, 'folderB')
    mkdirSync(folderB, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderB, `file_${i}.txt`), `content ${i}`)
    }

    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: () => true,
    })
    scanners.push(instance)

    instance.start(folderB, 'manual')
    expect(instance.status().running).toBe(true)

    const result = await instance.unregisterRoot(folderB, 'manual')
    expect(result).toBe(true)

    expect(instance.status().running).toBe(false)
    expect(instance.folders()).toHaveLength(0)
  })
})
