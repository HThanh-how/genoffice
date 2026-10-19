import { describe, expect, it, vi } from 'vitest'
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
})
