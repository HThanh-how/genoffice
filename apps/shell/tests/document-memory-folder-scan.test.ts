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

  it('FS-01: Clear index while A active, B queued -> B không bao giờ được scan, waiting rỗng', async () => {
    const folderA = join(dir, 'clear_folderA')
    const folderB = join(dir, 'clear_folderB')
    mkdirSync(folderA, { recursive: true })
    mkdirSync(folderB, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderA, `docA_${i}.txt`), `contentA_${i}`)
    }
    writeFileSync(join(folderB, 'docB.txt'), 'contentB')

    let clearHandler: (() => void) | undefined
    const enrolledB: string[] = []
    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: (path) => {
        if (path.includes('clear_folderB')) {
          enrolledB.push(path)
        }
        return true
      },
      onCleared: (listener) => {
        clearHandler = listener
        return () => {
          clearHandler = undefined
        }
      },
    })
    scanners.push(instance)

    // Khởi động A
    instance.start(folderA, 'manual')
    expect(instance.status().running).toBe(true)

    // Đưa B vào hàng đợi waiting
    instance.start(folderB, 'known:downloads')
    expect(instance.isWaiting(folderB)).toBe(true)

    // Gọi clear index
    expect(clearHandler).toBeDefined()
    clearHandler!()

    // Sau khi clear index, B phải lập tức bị dọn khỏi waiting
    expect(instance.isWaiting(folderB)).toBe(false)
    expect(instance.folders()).toHaveLength(0)

    // Chờ cho runner của A kết thúc hoàn toàn
    await until(() => !instance.status().running)

    // B không bao giờ được scan, và danh sách folders vẫn rỗng (không bị re-import)
    expect(enrolledB).toHaveLength(0)
    expect(instance.folders()).toHaveLength(0)
    expect(instance.isWaiting(folderB)).toBe(false)
  })

  it('FS-02: Queued B có cả manual và known:downloads, hủy known:downloads -> B vẫn nằm trong waiting và sẽ được scan dưới quyền manual!', async () => {
    const folderA = join(dir, 'multi_folderA')
    const folderB = join(dir, 'multi_folderB')
    mkdirSync(folderA, { recursive: true })
    mkdirSync(folderB, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderA, `docA_${i}.txt`), `contentA_${i}`)
    }
    writeFileSync(join(folderB, 'docB.txt'), 'contentB')

    const enrolledB: string[] = []
    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: (path) => {
        if (path.includes('multi_folderB')) {
          enrolledB.push(path)
        }
        return true
      },
    })
    scanners.push(instance)

    // Bắt đầu A (active scan)
    instance.start(folderA, 'manual')

    // Bắt đầu B với cả manual và known:downloads khi A đang chạy -> B vào waiting
    instance.start(folderB, 'manual')
    instance.start(folderB, 'known:downloads')
    expect(instance.isWaiting(folderB)).toBe(true)

    // Hủy known:downloads của B
    const unregisterResult = await instance.unregisterRoot(folderB, 'known:downloads')
    expect(unregisterResult).toBe(true)

    // Vì B vẫn còn owner 'manual', B TUYỆT ĐỐI KHÔNG bị xóa khỏi waiting!
    expect(instance.isWaiting(folderB)).toBe(true)

    // Chờ cho toàn bộ quá trình scan kết thúc (A xong -> B tự động được scan)
    await until(() => !instance.status().running && enrolledB.length > 0)

    // B đã được scan dưới quyền owner 'manual'
    expect(enrolledB).toHaveLength(1)
    const folderBEntry = instance.folders().find((f) => resolve(f.root) === resolve(folderB))
    expect(folderBEntry).toBeDefined()
    expect(folderBEntry?.owners).toEqual(['manual'])
  })

  it('FS-03: Rescan known-only root -> owners không bị thêm manual', async () => {
    const folderC = join(dir, 'known_folderC')
    mkdirSync(folderC, { recursive: true })
    writeFileSync(join(folderC, 'docC.txt'), 'contentC')

    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: () => true,
    })
    scanners.push(instance)

    // Đăng ký và scan dưới quyền known:downloads
    instance.start(folderC, 'known:downloads')
    await until(() => !instance.status().running)

    let entry = instance.folders().find((f) => resolve(f.root) === resolve(folderC))
    expect(entry?.owners).toEqual(['known:downloads'])

    // Gọi rescanExisting
    const rescanResult = await instance.rescanExisting(folderC)
    expect(rescanResult.ok).toBe(true)

    await until(() => !instance.status().running)

    // Sau khi rescan, owners vẫn giữ nguyên là ['known:downloads'], không có 'manual'
    entry = instance.folders().find((f) => resolve(f.root) === resolve(folderC))
    expect(entry?.owners).toEqual(['known:downloads'])
    expect(entry?.owners).not.toContain('manual')
  })

  it('FS-04: Re-enable root trong khi unregister trước đó đang stopping -> root khởi động lại thành công', async () => {
    const folderD = join(dir, 'restart_folderD')
    mkdirSync(folderD, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderD, `docD_${i}.txt`), `contentD_${i}`)
    }

    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: () => true,
    })
    scanners.push(instance)

    // Bắt đầu scan folderD
    instance.start(folderD, 'known:documents')
    expect(instance.status().running).toBe(true)

    // Gửi yêu cầu forget/unregister trong khi đang scan
    instance.forget(folderD, 'known:documents')

    // Bật lại folderD ngay lập tức trong khi runner cũ đang dừng
    instance.start(folderD, 'known:documents')

    // Chờ cho toàn bộ runner (kể cả runner restart) hoàn thành
    await until(() => !instance.status().running)

    // Thư mục D phải tồn tại trong danh sách folders với trạng thái complete
    const folderDEntry = instance.folders().find((f) => resolve(f.root) === resolve(folderD))
    expect(folderDEntry).toBeDefined()
    expect(folderDEntry?.state).toBe('complete')
    expect(folderDEntry?.owners).toContain('known:documents')
  })

  it('FS-05: hasOwner và registrationState phản ánh chính xác trạng thái lifecycle', async () => {
    const folderE = join(dir, 'state_folderE')
    const folderF = join(dir, 'state_folderF')
    mkdirSync(folderE, { recursive: true })
    mkdirSync(folderF, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderE, `docE_${i}.txt`), `contentE_${i}`)
    }
    writeFileSync(join(folderF, 'docF.txt'), 'contentF')

    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: () => true,
    })
    scanners.push(instance)

    // Khi chưa đăng ký
    expect(instance.registrationState(folderE)).toBe('none')
    expect(instance.hasOwner(folderE, 'manual')).toBe(false)

    // Start folderE (active)
    instance.start(folderE, 'manual')
    expect(instance.registrationState(folderE)).toBe('scanning')
    expect(instance.hasOwner(folderE, 'manual')).toBe(true)

    // Start folderF (queued vì E đang active)
    instance.start(folderF, 'known:desktop')
    expect(instance.registrationState(folderF)).toBe('queued')
    expect(instance.hasOwner(folderF, 'known:desktop')).toBe(true)
    expect(instance.hasOwner(folderF, 'manual')).toBe(false)
    expect(instance.registrationState(folderF, 'manual')).toBe('none')

    // Chờ E và F quét xong
    await until(() => !instance.status().running)

    // Sau khi quét xong: chuyển sang watching
    expect(instance.registrationState(folderE)).toBe('watching')
    expect(instance.registrationState(folderF)).toBe('watching')

    // Thử dừng folderE
    instance.stop()
    // Đổi state sang stopped trong manifest để test registrationState('stopped')
    const jobE = instance['jobFor'](resolve(folderE))
    if (jobE) jobE.state = 'stopped'
    expect(instance.registrationState(folderE)).toBe('stopped')
  })

  it('FS-06: A đang active scan, Clear Index được gọi. Trước khi runner cũ của A thoát, gọi start(A, manual) -> A tồn tại trong manifest, scan hoàn tất complete/watching, không bị stopped orphan', async () => {
    const folderA = join(dir, 'readd_folderA')
    mkdirSync(folderA, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderA, `docA_${i}.txt`), `contentA_${i}`)
    }

    let clearHandler: (() => void) | undefined
    const enrolledA: string[] = []
    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: (path) => {
        if (path.includes('readd_folderA')) {
          enrolledA.push(path)
        }
        return true
      },
      onCleared: (listener) => {
        clearHandler = listener
        return () => {
          clearHandler = undefined
        }
      },
    })
    scanners.push(instance)

    // Bắt đầu scan A
    instance.start(folderA, 'manual')
    expect(instance.status().running).toBe(true)

    // Clear Index được gọi trong khi A đang active
    expect(clearHandler).toBeDefined()
    clearHandler!()

    // Trước khi runner cũ của A thoát, gọi start(A, 'manual') ngay lập tức
    instance.start(folderA, 'manual')

    // Đợi cho runner cũ thoát và runner mới hoàn tất quá trình scan
    await until(() => !instance.status().running)

    // A phải tồn tại trong manifest
    const folderAEntry = instance.folders().find((f) => resolve(f.root) === resolve(folderA))
    expect(folderAEntry).toBeDefined()

    // Hoàn thành scan sang trạng thái complete / watching
    expect(folderAEntry?.state).toBe('complete')
    expect(instance.registrationState(folderA)).toBe('watching')

    // Có owner 'manual'
    expect(folderAEntry?.owners).toContain('manual')

    // Tuyệt đối không bị stopped orphan
    expect(folderAEntry?.state).not.toBe('stopped')
    expect(instance.registrationState(folderA)).not.toBe('stopped')

    // Các tệp của A đã được index thành công
    expect(enrolledA.length).toBeGreaterThan(0)
  })

  it('FS-07: A active, B manual queued. B bị unavailable khi đến lượt dequeue. Khi B xuất hiện trở lại và chu kỳ startup reconciliation / retry chạy -> B tự động được quét thành công', async () => {
    const folderA = join(dir, 'unavail_folderA')
    const folderB = join(dir, 'unavail_folderB')
    mkdirSync(folderA, { recursive: true })
    mkdirSync(folderB, { recursive: true })
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderA, `docA_${i}.txt`), `contentA_${i}`)
    }
    writeFileSync(join(folderB, 'docB.txt'), 'contentB')

    const enrolledFiles: string[] = []
    const instance = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: (path) => {
        enrolledFiles.push(path)
        return true
      },
    })
    scanners.push(instance)

    // Start A (active scan)
    instance.start(folderA, 'manual')
    expect(instance.status().running).toBe(true)

    // Start B dưới quyền manual -> B vào hàng đợi waiting (queued)
    instance.start(folderB, 'manual')
    expect(instance.isWaiting(folderB)).toBe(true)
    expect(instance.registrationState(folderB)).toBe('queued')

    // USB / Thư mục B bị tháo / xóa trước khi dequeue
    rmSync(folderB, { recursive: true, force: true })

    // Chờ A hoàn thành, runner A kết thúc và kích hoạt dequeue B
    await until(() => !instance.status().running)

    // B đã được dequeue khỏi waiting và ghi nhận lỗi unavailable
    expect(instance.isWaiting(folderB)).toBe(false)
    let folderBEntry = instance.folders().find((f) => resolve(f.root) === resolve(folderB))
    expect(folderBEntry).toBeDefined()
    expect(folderBEntry?.state).toBe('stopped')
    expect(folderBEntry?.unavailable).toBe(true)
    expect(folderBEntry?.lastError).toMatch(/unavailable/i)
    expect(enrolledFiles.some((f) => f.includes('docB.txt'))).toBe(false)

    // B xuất hiện trở lại (USB cắm lại)
    mkdirSync(folderB, { recursive: true })
    writeFileSync(join(folderB, 'docB.txt'), 'contentB')

    // Chu kỳ startup reconciliation / retry chạy
    const retriedRoots = instance.retryUnavailable()
    expect(retriedRoots).toContain(resolve(folderB))

    // Chờ B quét xong thành công
    await until(() => !instance.status().running && enrolledFiles.some((f) => f.includes('docB.txt')))

    // B đã hoàn thành sang complete / watching
    folderBEntry = instance.folders().find((f) => resolve(f.root) === resolve(folderB))
    expect(folderBEntry?.state).toBe('complete')
    expect(instance.registrationState(folderB)).toBe('watching')
    expect(folderBEntry?.unavailable).toBeFalsy()
  })

  it('FS-04: Interrupted job với known-only owner (known:downloads) chuyển thành stopped và không resume chạy nền khi khởi tạo FolderScanManager', async () => {
    const root = join(dir, 'interrupted_known_downloads')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'file1.txt'), 'content1')

    const userData = join(dir, 'state')
    mkdirSync(userData, { recursive: true })
    const manifestPath = join(userData, 'document-memory-folders.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            root,
            owners: ['known:downloads'],
            state: 'running',
            discovered: 10,
            enrolled: 5,
            skipped: 2,
            errors: 1,
            lastError: 'some error',
            unavailable: true,
          },
        ],
      }),
    )

    let enrollments = 0
    const instance = scanner(userData, () => {
      enrollments++
      return true
    })

    // Đợi để đảm bảo microtask hoặc background runner (nếu có) có cơ hội chạy
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Job chuyển thành stopped và KHÔNG resume chạy nền
    expect(enrollments).toBe(0)
    expect(instance.status().running).toBe(false)

    const folderEntry = instance.folders().find((f) => resolve(f.root) === resolve(root))
    expect(folderEntry).toBeDefined()
    expect(folderEntry?.state).toBe('stopped')
    expect(folderEntry?.owners).toEqual(['known:downloads'])
    expect(folderEntry?.discovered).toBe(0)
    expect(folderEntry?.enrolled).toBe(0)
    expect(folderEntry?.skipped).toBe(0)
    expect(folderEntry?.errors).toBe(0)
    expect(folderEntry?.lastError).toBeUndefined()
    expect(folderEntry?.unavailable).toBeUndefined()
    expect(instance.registrationState(root)).toBe('stopped')
  })

  it('P0-1 Kịch bản 1: Job có owners: [known:downloads], state: stopped, unavailable: true -> retryUnavailable không retry root này, job giữ nguyên stopped', async () => {
    const root = join(dir, 'p0_1_known_only')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'file.txt'), 'content')

    const userData = join(dir, 'state_p0_1')
    mkdirSync(userData, { recursive: true })
    const manifestPath = join(userData, 'document-memory-folders.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            root,
            owners: ['known:downloads'],
            state: 'stopped',
            discovered: 0,
            enrolled: 0,
            skipped: 0,
            errors: 1,
            lastError: 'The selected folder is unavailable.',
            unavailable: true,
          },
        ],
      }),
    )

    let enrollments = 0
    const instance = scanner(userData, () => {
      enrollments++
      return true
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const retried = instance.retryUnavailable()
    expect(retried).toEqual([])
    expect(enrollments).toBe(0)
    expect(instance.status().running).toBe(false)

    const folderEntry = instance.folders().find((f) => resolve(f.root) === resolve(root))
    expect(folderEntry).toBeDefined()
    expect(folderEntry?.state).toBe('stopped')
    expect(folderEntry?.unavailable).toBe(true)
    expect(folderEntry?.owners).toEqual(['known:downloads'])
    expect(instance.registrationState(root)).toBe('stopped')
  })

  it('P0-1 Kịch bản 2: Job có owners: [known:downloads, manual], state: stopped, unavailable: true -> retryUnavailable retry thành công và start root', async () => {
    const root = join(dir, 'p0_1_shared_owner')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'file.txt'), 'content')

    const userData = join(dir, 'state_p0_2')
    mkdirSync(userData, { recursive: true })
    const manifestPath = join(userData, 'document-memory-folders.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            root,
            owners: ['known:downloads', 'manual'],
            state: 'stopped',
            discovered: 0,
            enrolled: 0,
            skipped: 0,
            errors: 1,
            lastError: 'The selected folder is unavailable.',
            unavailable: true,
          },
        ],
      }),
    )

    const enrolled: string[] = []
    const instance = scanner(userData, (path) => {
      enrolled.push(path)
      return true
    })

    const retried = instance.retryUnavailable()
    expect(retried).toContain(resolve(root))

    await until(() => !instance.status().running && enrolled.length > 0)

    const folderEntry = instance.folders().find((f) => resolve(f.root) === resolve(root))
    expect(folderEntry).toBeDefined()
    expect(folderEntry?.state).toBe('complete')
    expect(folderEntry?.unavailable).toBeFalsy()
    expect(folderEntry?.lastError).toBeUndefined()
    expect(instance.registrationState(root)).toBe('watching')
  })

  it('P1-2: Khởi động scan root A, Clear Index gọi unregisterAll, lập tức thêm root C khi runner A chưa thoát -> C tự động được pick up và scan sau khi A thoát', async () => {
    const folderA = join(dir, 'p1_2_folderA')
    const folderC = join(dir, 'p1_2_folderC')
    mkdirSync(folderA, { recursive: true })
    mkdirSync(folderC, { recursive: true })

    for (let i = 0; i < 50; i++) {
      writeFileSync(join(folderA, `docA_${i}.txt`), `contentA_${i}`)
    }
    writeFileSync(join(folderC, 'docC.txt'), 'contentC')

    let clearHandler: (() => void) | undefined
    const enrolledFiles: string[] = []
    const instance = new FolderScanManager(join(dir, 'state_p1_2'), {
      indexDiscoveredFile: (path) => {
        enrolledFiles.push(path)
        return true
      },
      onCleared: (listener) => {
        clearHandler = listener
        return () => {
          clearHandler = undefined
        }
      },
    })
    scanners.push(instance)

    // Khởi động scan root A (đang running)
    instance.start(folderA, 'manual')
    expect(instance.status().running).toBe(true)

    // Clear Index (gọi unregisterAll qua onCleared)
    expect(clearHandler).toBeDefined()
    clearHandler!()

    // Lập tức thêm root C (trong khi runner A chưa thoát hoàn toàn khỏi event loop)
    instance.start(folderC, 'manual')
    expect(instance.isWaiting(folderC)).toBe(true)

    // Đợi đến khi toàn bộ hoàn tất
    await until(() => !instance.status().running && enrolledFiles.some((f) => f.includes('docC.txt')))

    // Khi runner A thoát, C phải được tự động pick up và scan, không bị kẹt trong waiting queue
    expect(instance.isWaiting(folderC)).toBe(false)

    const folderCEntry = instance.folders().find((f) => resolve(f.root) === resolve(folderC))
    expect(folderCEntry).toBeDefined()
    expect(folderCEntry?.state).toBe('complete')
    expect(instance.registrationState(folderC)).toBe('watching')

    // Root A đã bị unregister sạch sẽ
    const folderAEntry = instance.folders().find((f) => resolve(f.root) === resolve(folderA))
    expect(folderAEntry).toBeUndefined()
  })
})
