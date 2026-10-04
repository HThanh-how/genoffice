import { describe, expect, it } from 'vitest'
import type { IndexFileDetail } from '../src/shared/fork/document-index-api'
import { buildFileLog, deriveFileSteps, formatBytes } from '../src/renderer/src/fork/index-file-log'

const base: IndexFileDetail = {
  id: 7,
  path: 'G:\\Mr Quoc\\Ba\\BENH VIEN 30-4.pdf',
  name: 'BENH VIEN 30-4.pdf',
  status: 'empty',
  error: 'No readable text; scanned documents need OCR',
  sizeBytes: 2_411_000,
  mtimeMs: Date.UTC(2026, 3, 30),
  updatedAt: Date.UTC(2026, 9, 2),
  exists: true,
  truncated: false,
  chunkTotal: 0,
  chunkDone: 0,
  pdf: {
    totalPages: 3,
    scannedPages: 3,
    ocrPages: 1,
    ocrChars: 480,
    ocrModel: 'gemini-3.8-flash-low',
  },
}

describe('deriveFileSteps', () => {
  it('reports a blank Office file as information, without promising an OCR or retry step', () => {
    const steps = deriveFileSteps({ ...base, pdf: undefined, error: undefined }, 'en')
    expect(steps.map((step) => [step.key, step.state])).toEqual([
      ['found', 'ok'],
      ['read', 'info'],
      ['search', 'info'],
    ])
    expect(steps.at(-1)?.text).toBe('The file has no content to search')
  })
  it('shows a scanned PDF as waiting on OCR, partly done', () => {
    const steps = deriveFileSteps(base, 'en')
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ['found', 'ok'],
      ['read', 'warn'],
      ['ocr', 'run'],
      ['search', 'wait'],
    ])
    expect(steps[2]!.text).toContain('1/3 pages read')
    expect(steps[2]!.text).toContain('gemini-3.8-flash-low')
  })

  it('shows a finished file as searchable', () => {
    const steps = deriveFileSteps(
      { ...base, status: 'ready', error: undefined, chunkTotal: 4, chunkDone: 4, pdf: undefined },
      'en',
    )
    expect(steps.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('flags a read error and a file that vanished', () => {
    const steps = deriveFileSteps(
      { ...base, status: 'error', error: 'password', exists: false, pdf: undefined },
      'vi',
    )
    expect(steps[0]).toMatchObject({ key: 'found', state: 'fail' })
    expect(steps[1]).toMatchObject({ key: 'read', state: 'fail' })
    expect(steps[1]!.text).toContain('password')
  })
})

describe('buildFileLog', () => {
  it('is plain text with the path, steps and the raw error', () => {
    const log = buildFileLog(base, 'en', 'en-US', 'Scanned page')
    expect(log).toContain('BENH VIEN 30-4.pdf')
    expect(log).toContain('empty (Scanned page)')
    expect(log).toContain('[...]')
    expect(log).toContain('error: No readable text')
    expect(log).not.toMatch(/\n{3,}/)
  })
})

describe('formatBytes', () => {
  it('uses the nearest unit', () => {
    expect(formatBytes(512, 'en-US')).toBe('512\u00a0B')
    expect(formatBytes(2_411_000, 'en-US')).toBe('2.3\u00a0MB')
  })
})
