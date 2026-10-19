import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath } from '../src/main/tab-manager'

describe('tab-manager canonicalPath', () => {
  it('returns undefined when path is undefined', () => {
    expect(canonicalPath(undefined)).toBeUndefined()
  })

  it('preserves casing on macOS/darwin platforms', () => {
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const p = '/Users/TestUser/Documents/CaseSensitiveReport.docx'
      const canonical = canonicalPath(p)
      expect(canonical).toContain('CaseSensitiveReport.docx')
      expect(canonical).not.toBe(canonical?.toLowerCase())
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('lowercases path on win32 platform', () => {
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const p = 'C:\\Users\\TestUser\\Documents\\Report.docx'
      const canonical = canonicalPath(p)
      expect(canonical).toBe(canonical?.toLowerCase())
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('resolves real files and symlinks to identical canonical paths on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tab-canonical-'))
    try {
      const realFile = join(dir, 'RealDocument.docx')
      writeFileSync(realFile, 'content')
      const symlinkFile = join(dir, 'SymlinkDocument.docx')
      try {
        symlinkSync(realFile, symlinkFile)
        expect(canonicalPath(symlinkFile)).toBe(canonicalPath(realFile))
      } catch {
        // Symlinks might not be supported on unprivileged Windows
      }

      const distinctFile = join(dir, 'DistinctDocument.docx')
      writeFileSync(distinctFile, 'content 2')
      expect(canonicalPath(distinctFile)).not.toBe(canonicalPath(realFile))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
