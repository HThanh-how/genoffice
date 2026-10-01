import { describe, expect, it } from 'vitest'
import { isRetryableReason, issueReason } from '../src/main/document-memory/issues'

// Windows reports a vanished network or removable drive as a generic UNKNOWN error from stat.
// It is the drive that is unavailable, not a defect in the file, so it must not land in "other".
describe('issueReason for a drive that went away', () => {
  it('classifies the libuv UNKNOWN stat error as unavailable', () => {
    const message = "UNKNOWN: unknown error, stat 'G:\\Mr Quốc\\TTKTQH\\Phòng Thí nghiệm\\a.doc'"
    expect(issueReason(message, 'error')).toBe('unavailable')
  })

  it('also covers the same error from open, read and scandir', () => {
    for (const call of ['open', 'read', 'scandir']) {
      expect(issueReason(`UNKNOWN: unknown error, ${call} 'G:\\x'`, 'error')).toBe('unavailable')
    }
  })

  it('stays retryable so it recovers when the drive returns', () => {
    expect(isRetryableReason('unavailable')).toBe(true)
  })

  it('does not change how scanned PDFs are classified', () => {
    expect(issueReason('No readable text; scanned documents need OCR', 'empty')).toBe('no-text')
  })
})
