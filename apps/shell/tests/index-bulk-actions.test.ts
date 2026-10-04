import { describe, expect, it } from 'vitest'
import { isOcrCandidate, selectedIndexFiles } from '../src/renderer/src/fork/index-bulk-actions'

describe('Index selection actions', () => {
  it('only offers cloud OCR for scanned PDFs that still need text', () => {
    expect(isOcrCandidate({ path: 'C:/files/scan.PDF', reason: 'no-text' })).toBe(true)
    expect(isOcrCandidate({ path: 'scan.pdf', reason: 'waiting' })).toBe(false)
    expect(isOcrCandidate({ path: 'ready.pdf' })).toBe(false)
    expect(isOcrCandidate({ path: 'blank.docx', reason: 'no-text' })).toBe(false)
  })

  it('does not repeat destructive actions when polling moves a file between groups', () => {
    const old = { id: 1, path: 'scan.pdf', reason: 'waiting' }
    const refreshed = { ...old, reason: 'no-text' }
    const other = { id: 2, path: 'letter.docx', reason: 'timeout' }
    expect(
      selectedIndexFiles(
        [{ items: [old, other] }, undefined, { items: [refreshed] }],
        new Set([1]),
      ),
    ).toEqual([refreshed])
  })

  it('never acts on selected IDs that are no longer loaded', () => {
    expect(selectedIndexFiles([{ items: [{ id: 3 }] }], new Set([1, 2]))).toEqual([])
  })
})
