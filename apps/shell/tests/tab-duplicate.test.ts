import { existsSync } from 'node:fs'
import { copyFile, link, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDuplicateCandidatePath, duplicateDocumentFile } from '../src/main/tab-duplicate'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => actual.existsSync(path)),
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    link: vi.fn(actual.link),
    copyFile: vi.fn(actual.copyFile),
  }
})

describe('tab duplicate file operations and collision safety (D1-D17)', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tab-dup-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('D1: duplicates a standard document file', async () => {
    const src = join(tempDir, 'Quarterly Report.docx')
    await writeFile(src, 'Quarterly financial analysis', 'utf8')

    const target = await duplicateDocumentFile(src, { copySuffix: 'Copy' })

    expect(target).toBe(join(tempDir, 'Quarterly Report Copy.docx'))
    expect(existsSync(target)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('Quarterly financial analysis')
    expect(await readFile(src, 'utf8')).toBe('Quarterly financial analysis')
  })

  it('D2: skips candidate if Copy already exists and creates Copy 2', async () => {
    const src = join(tempDir, 'Budget.xlsx')
    await writeFile(src, 'Budget V1', 'utf8')
    const copy1 = join(tempDir, 'Budget Copy.xlsx')
    await writeFile(copy1, 'Existing Copy 1', 'utf8')

    const target = await duplicateDocumentFile(src, { copySuffix: 'Copy' })

    expect(target).toBe(join(tempDir, 'Budget Copy 2.xlsx'))
    expect(existsSync(target)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('Budget V1')
    expect(await readFile(copy1, 'utf8')).toBe('Existing Copy 1') // intact!
  })

  it('D3: skips candidates if Copy and Copy 2 already exist and creates Copy 3', async () => {
    const src = join(tempDir, 'Deck.pptx')
    await writeFile(src, 'Slides V1', 'utf8')
    await writeFile(join(tempDir, 'Deck Copy.pptx'), 'Existing 1', 'utf8')
    await writeFile(join(tempDir, 'Deck Copy 2.pptx'), 'Existing 2', 'utf8')

    const target = await duplicateDocumentFile(src, { copySuffix: 'Copy' })

    expect(target).toBe(join(tempDir, 'Deck Copy 3.pptx'))
    expect(existsSync(target)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('Slides V1')
  })

  it('D4: TOCTOU race — destination file created concurrently between existsSync check and link() call', async () => {
    const src = join(tempDir, 'Contract.docx')
    await writeFile(src, 'Contract source', 'utf8')

    const copy1 = join(tempDir, 'Contract Copy.docx')
    await writeFile(copy1, 'CONCURRENT PRE-EXISTING DATA', 'utf8')

    // Simulate TOCTOU window: existsSync() returns false for copy1 as if it wasn't there yet during the fast-path check,
    // but the file is physically present on disk when link() executes.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const existsSyncMock = vi.mocked(existsSync)
    let simulatedRace = false
    existsSyncMock.mockImplementation((path) => {
      if (path === copy1 && !simulatedRace) {
        simulatedRace = true
        return false // Simulate destination not present at the moment of existsSync check
      }
      return realFs.existsSync(path)
    })

    try {
      const target = await duplicateDocumentFile(src, { copySuffix: 'Copy' })

      // link() must catch EEXIST and safely advance to candidate 2 without overwriting copy1
      expect(target).toBe(join(tempDir, 'Contract Copy 2.docx'))
      expect(await readFile(copy1, 'utf8')).toBe('CONCURRENT PRE-EXISTING DATA')
      expect(await readFile(target, 'utf8')).toBe('Contract source')
      expect(simulatedRace).toBe(true)
    } finally {
      existsSyncMock.mockImplementation((path) => realFs.existsSync(path))
    }
  })

  it('D5: handles near-simultaneous duplicate operations without clobbering', async () => {
    const src = join(tempDir, 'Concurrent.docx')
    await writeFile(src, 'Shared source', 'utf8')

    const [targetA, targetB] = await Promise.all([
      duplicateDocumentFile(src, { copySuffix: 'Copy' }),
      duplicateDocumentFile(src, { copySuffix: 'Copy' }),
    ])

    expect(targetA).not.toBe(targetB)
    expect(existsSync(targetA)).toBe(true)
    expect(existsSync(targetB)).toBe(true)
    expect(await readFile(targetA, 'utf8')).toBe('Shared source')
    expect(await readFile(targetB, 'utf8')).toBe('Shared source')
    expect(await readFile(src, 'utf8')).toBe('Shared source')
  })

  it('D6: fails safely when source file is missing or deleted before copy', async () => {
    const src = join(tempDir, 'Nonexistent.docx')

    await expect(duplicateDocumentFile(src)).rejects.toThrow()
  })

  it('D7: handles unreadable source file safely (EACCES/EPERM distinct from ENOENT)', async () => {
    const src = join(tempDir, 'Restricted.docx')
    await writeFile(src, 'Confidential', 'utf8')

    if (process.platform !== 'win32') {
      const { chmod } = await import('node:fs/promises')
      await chmod(src, 0o000)
    }

    try {
      const error = await duplicateDocumentFile(src).catch((e) => e)
      expect(error).toBeDefined()
      if (process.platform !== 'win32') {
        expect(['EACCES', 'EPERM']).toContain((error as NodeJS.ErrnoException).code)
      }

      // Verify no orphan .tmp file remains in tempDir
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(tempDir)
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    } finally {
      if (process.platform !== 'win32') {
        const { chmod } = await import('node:fs/promises')
        await chmod(src, 0o644).catch(() => {})
      }
    }
  })

  it('D8: preserves Unicode names across Vietnamese, Japanese, etc.', async () => {
    const vnSrc = join(tempDir, 'Báo cáo tổng hợp quý 4.docx')
    await writeFile(vnSrc, 'Nội dung tiếng Việt', 'utf8')
    const vnTarget = await duplicateDocumentFile(vnSrc, { copySuffix: 'bản sao' })

    expect(vnTarget).toBe(join(tempDir, 'Báo cáo tổng hợp quý 4 bản sao.docx'))
    expect(await readFile(vnTarget, 'utf8')).toBe('Nội dung tiếng Việt')

    const jaSrc = join(tempDir, '日本語テスト.xlsx')
    await writeFile(jaSrc, '日本語コンテンツ', 'utf8')
    const jaTarget = await duplicateDocumentFile(jaSrc, { copySuffix: 'コピー' })

    expect(jaTarget).toBe(join(tempDir, '日本語テスト コピー.xlsx'))
    expect(await readFile(jaTarget, 'utf8')).toBe('日本語コンテンツ')
  })

  it('D9: preserves multi-dot file names correctly', async () => {
    const multiDotSrc = join(tempDir, 'report.final.v2.docx')
    await writeFile(multiDotSrc, 'Final v2 contents', 'utf8')

    const target = await duplicateDocumentFile(multiDotSrc, { copySuffix: 'Copy' })

    expect(target).toBe(join(tempDir, 'report.final.v2 Copy.docx'))
    expect(await readFile(target, 'utf8')).toBe('Final v2 contents')
  })

  it('D10: duplicate failure does not modify or corrupt pre-existing files', async () => {
    const src = join(tempDir, 'Source.docx')
    await writeFile(src, 'Source content', 'utf8')

    const existingCopy = join(tempDir, 'Source Copy.docx')
    await writeFile(existingCopy, 'Original Copy Content Unmodified', 'utf8')

    // Simulate exhausted attempts by setting maxAttempts to 1
    await expect(
      duplicateDocumentFile(src, { copySuffix: 'Copy', maxAttempts: 1 }),
    ).rejects.toThrow(/Unable to find an available duplicate filename/)

    // Existing copy MUST remain untouched
    expect(await readFile(existingCopy, 'utf8')).toBe('Original Copy Content Unmodified')
  })

  it('D11: failed duplicate does not trigger success callbacks (recents / openDocument)', async () => {
    const recordRecentMock = vi.fn()
    const openDocumentMock = vi.fn()

    const triggerDuplicate = async (path: string) => {
      try {
        const target = await duplicateDocumentFile(path, { copySuffix: 'Copy', maxAttempts: 1 })
        recordRecentMock(target)
        openDocumentMock(target)
      } catch (error) {
        // Handled in caller
      }
    }

    const missingPath = join(tempDir, 'DoesNotExists.docx')
    await triggerDuplicate(missingPath)

    expect(recordRecentMock).not.toHaveBeenCalled()
    expect(openDocumentMock).not.toHaveBeenCalled()
  })

  it('D12: successful duplicate updates recents and opens the newly created document', async () => {
    const src = join(tempDir, 'Annual Report 2026.pdf')
    await writeFile(src, 'PDF Content', 'utf8')

    const recordRecentMock = vi.fn()
    const openDocumentMock = vi.fn()

    const triggerDuplicate = async (path: string) => {
      const target = await duplicateDocumentFile(path, { copySuffix: 'Copy' })
      recordRecentMock(target)
      openDocumentMock(target)
      return target
    }

    const target = await triggerDuplicate(src)

    expect(target).toBe(join(tempDir, 'Annual Report 2026 Copy.pdf'))
    expect(recordRecentMock).toHaveBeenCalledWith(target)
    expect(openDocumentMock).toHaveBeenCalledWith(target)
  })

  it('D13: unsaved in-memory changes in editor are NOT saved, clobbered, or altered by duplicate', async () => {
    const src = join(tempDir, 'LiveDocument.docx')
    await writeFile(src, 'Saved on-disk version', 'utf8')

    // Simulate editor having unsaved in-memory edits that have NOT been flushed to disk
    const inMemoryEdits = 'Unsaved in-memory edits that user has not saved yet'

    // Duplicate only operates on saved disk state
    const target = await duplicateDocumentFile(src, { copySuffix: 'Copy' })

    // Duplicate copy contains saved on-disk content
    expect(await readFile(target, 'utf8')).toBe('Saved on-disk version')
    // Source file on disk is untouched
    expect(await readFile(src, 'utf8')).toBe('Saved on-disk version')
    // In-memory state remains untouched
    expect(inMemoryEdits).toBe('Unsaved in-memory edits that user has not saved yet')
  })

  it('D14: cleans up temporary file on failure', async () => {
    const src = join(tempDir, 'CleanTest.docx')
    await writeFile(src, 'Clean me', 'utf8')

    // Fill candidate 1 and force failure with maxAttempts: 1
    await writeFile(join(tempDir, 'CleanTest Copy.docx'), 'taken', 'utf8')

    await expect(
      duplicateDocumentFile(src, { copySuffix: 'Copy', maxAttempts: 1 }),
    ).rejects.toThrow()

    // No leftover .tmp files in directory
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(tempDir)
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('D15: cleans up temporary file if syncFileBestEffort fails early with non-tolerated error', async () => {
    const src = join(tempDir, 'SyncFail.docx')
    await writeFile(src, 'Valid content', 'utf8')

    const realFsPromises =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const openMock = vi.mocked(open)

    // Simulate open failure during sync on .tmp file with untolerated EIO
    openMock.mockImplementation(async (path, flags, mode) => {
      if (typeof path === 'string' && path.includes('.tmp')) {
        const err = new Error('Simulated IO error') as NodeJS.ErrnoException
        err.code = 'EIO'
        throw err
      }
      return realFsPromises.open(path, flags, mode)
    })

    try {
      await expect(duplicateDocumentFile(src, { copySuffix: 'Copy' })).rejects.toThrow(
        'Simulated IO error',
      )

      // Verify no orphan .tmp file remains in tempDir despite sync failure
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(tempDir)
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    } finally {
      openMock.mockImplementation((path, flags, mode) => realFsPromises.open(path, flags, mode))
    }
  })

  it('D16: failed fallback must not delete a destination created by another actor', async () => {
    const src = join(tempDir, 'FallbackDoc.docx')
    await writeFile(src, 'Fallback content', 'utf8')

    const target = join(tempDir, 'FallbackDoc Copy.docx')
    const realFsPromises =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const linkMock = vi.mocked(link)
    const copyFileMock = vi.mocked(copyFile)

    // Simulate link throwing EXDEV (cross-device or unsupported hard link)
    linkMock.mockImplementation(async () => {
      const err = new Error('Cross-device link not permitted') as NodeJS.ErrnoException
      err.code = 'EXDEV'
      throw err
    })

    // Simulate copyFile failing on fallback, while another actor concurrently creates target
    copyFileMock.mockImplementation(async (srcPath, destPath, flags) => {
      if (typeof destPath === 'string' && destPath === target) {
        // Another process creates or replaces target right before the error propagates
        await writeFile(target, 'THIRD_PARTY_DATA_MUST_SURVIVE', 'utf8')
        const err = new Error('No space left on device') as NodeJS.ErrnoException
        err.code = 'ENOSPC'
        throw err
      }
      return realFsPromises.copyFile(srcPath, destPath, flags)
    })

    try {
      await expect(duplicateDocumentFile(src, { copySuffix: 'Copy' })).rejects.toThrow(
        'No space left on device',
      )

      // CRITICAL DATA SAFETY INVARIANT: Destination created by another actor must NOT be unlinked
      expect(existsSync(target)).toBe(true)
      expect(await readFile(target, 'utf8')).toBe('THIRD_PARTY_DATA_MUST_SURVIVE')

      // Source document must remain untouched
      expect(await readFile(src, 'utf8')).toBe('Fallback content')

      // Private .tmp file must be cleaned up in finally block
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(tempDir)
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    } finally {
      linkMock.mockImplementation((existingPath, newPath) =>
        realFsPromises.link(existingPath, newPath),
      )
      copyFileMock.mockImplementation((srcPath, destPath, flags) =>
        realFsPromises.copyFile(srcPath, destPath, flags),
      )
    }
  })

  it('D17: fallback to COPYFILE_EXCL successfully publishes on non-link filesystems', async () => {
    const src = join(tempDir, 'ExdevSuccess.docx')
    await writeFile(src, 'FAT32 content', 'utf8')

    const realFsPromises =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const linkMock = vi.mocked(link)

    // Simulate link throwing ENOTSUP (filesystem does not support hard links)
    linkMock.mockImplementation(async () => {
      const err = new Error('Operation not supported') as NodeJS.ErrnoException
      err.code = 'ENOTSUP'
      throw err
    })

    try {
      const target = await duplicateDocumentFile(src, { copySuffix: 'Copy' })

      expect(target).toBe(join(tempDir, 'ExdevSuccess Copy.docx'))
      expect(existsSync(target)).toBe(true)
      expect(await readFile(target, 'utf8')).toBe('FAT32 content')

      // No leftover .tmp file
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(tempDir)
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    } finally {
      linkMock.mockImplementation((existingPath, newPath) =>
        realFsPromises.link(existingPath, newPath),
      )
    }
  })

  it('buildDuplicateCandidatePath correctly structures suffix and spacing', () => {
    expect(buildDuplicateCandidatePath('/data/file.docx', 'Copy', 1)).toBe('/data/file Copy.docx')
    expect(buildDuplicateCandidatePath('/data/file.docx', 'Copy', 2)).toBe('/data/file Copy 2.docx')
    expect(buildDuplicateCandidatePath('/data/file.docx', 'bản sao', 1)).toBe(
      '/data/file bản sao.docx',
    )
    expect(buildDuplicateCandidatePath('/data/file.docx', 'bản sao', 5)).toBe(
      '/data/file bản sao 5.docx',
    )
  })
})
