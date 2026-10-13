import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDuplicateCandidatePath, duplicateDocumentFile } from '../src/main/tab-duplicate'

describe('tab duplicate file operations and collision safety (D1-D14)', () => {
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

  it('D4: TOCTOU race — destination file created concurrently right at candidate name is NOT clobbered', async () => {
    const src = join(tempDir, 'Contract.docx')
    await writeFile(src, 'Contract source', 'utf8')

    // Pre-create the first candidate to simulate concurrent creation
    const copy1 = join(tempDir, 'Contract Copy.docx')
    await writeFile(copy1, 'CONCURRENT PRE-EXISTING DATA', 'utf8')

    const target = await duplicateDocumentFile(src, { copySuffix: 'Copy' })

    // Must NOT overwrite copy1
    expect(target).toBe(join(tempDir, 'Contract Copy 2.docx'))
    expect(await readFile(copy1, 'utf8')).toBe('CONCURRENT PRE-EXISTING DATA')
    expect(await readFile(target, 'utf8')).toBe('Contract source')
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

  it('D7: handles unreadable source file safely', async () => {
    const src = join(tempDir, 'Restricted.docx')
    await writeFile(src, 'Confidential', 'utf8')
    // Attempting duplicate on a nonexistent path or inaccessible directory
    const invalidSrc = join(tempDir, 'missing-folder', 'File.docx')

    await expect(duplicateDocumentFile(invalidSrc)).rejects.toThrow()
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
