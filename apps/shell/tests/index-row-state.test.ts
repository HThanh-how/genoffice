import { describe, expect, it } from 'vitest'
import { fileProgress, indexRowActions } from '../src/renderer/src/fork/index-row-state'

describe('State-specific Index actions', () => {
  it('keeps cancellation possible but disables disk/OCR reads while a source is offline', () => {
    expect(
      indexRowActions({ path: 'Z:/scan.pdf', reason: 'no-text', offline: true }, undefined, true),
    ).toMatchObject({ open: false, retry: false, ocr: false, defer: false, stop: true })
  })
  it('offers retry for stopped/error files, without pretending they are still stoppable', () => {
    expect(indexRowActions({ path: 'a.docx', reason: 'timeout' })).toMatchObject({
      retry: true,
      stop: false,
      defer: false,
      ocr: false,
    })
  })
  it('does not offer a second local read during active processing', () => {
    expect(indexRowActions({ path: 'a.docx', reason: 'waiting' }, 'embedding')).toMatchObject({
      retry: false,
      stop: true,
      defer: true,
    })
  })
  it('offers OCR only to scans and does not defer cloud work through the local queue', () => {
    const scan = { path: 'scan.pdf', reason: 'no-text' as const }
    expect(indexRowActions(scan)).toMatchObject({ ocr: true, retry: false, stop: false })
    expect(indexRowActions(scan, undefined, true)).toMatchObject({
      ocr: false,
      retry: false,
      stop: true,
      defer: false,
    })
  })
  it('does not offer open for files known to have disappeared', () => {
    expect(
      indexRowActions({ path: 'missing.docx', deleted: true, reason: 'unavailable' }).open,
    ).toBe(false)
  })
  it('clamps real progress and rejects an unknown or malformed total', () => {
    expect(fileProgress(15, 10)).toEqual({ done: 10, total: 10 })
    expect(fileProgress(-1, 10)).toEqual({ done: 0, total: 10 })
    expect(fileProgress(0, 0)).toBeNull()
    expect(fileProgress(0, 0.5)).toBeNull()
    expect(fileProgress(NaN, 10)).toBeNull()
  })
})
