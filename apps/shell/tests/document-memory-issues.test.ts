import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import {
  groupIssueCounts,
  isInformationalReason,
  isRetryableReason,
  issueReason,
  shortCause,
  type IndexIssueReason,
} from '../src/main/document-memory/issues'

it('pages readable issue reasons within the selected folder and safely retries a known file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-issues-'))
  const store = new DocumentMemoryStore(join(dir, 'memory.db'))
  try {
    const root = join(dir, 'selected')
    for (let i = 0; i < 12; i++)
      store.markError(
        join(root, `file-${i}.docx`),
        i === 0 ? 'Password protected' : 'Document is unavailable.',
        null,
      )
    store.markError(join(dir, 'selected-sibling', 'outside.docx'), 'Document is unavailable.', null)
    const excluded = join(root, 'excluded.docx')
    store.markError(excluded, 'timeout', null)
    store.exclude(excluded)
    const scan = join(root, 'scan.pdf')
    store.replaceDocument(scan, {
      hash: 'scan',
      mtimeMs: 1,
      sizeBytes: 1,
      chunks: [],
      embeddingModel: null,
      status: 'empty',
      error: 'No readable text; scanned documents need OCR',
    })
    const first = store.indexIssues(root)
    expect(first.total).toBe(13)
    expect(first.items).toHaveLength(10)
    const second = store.indexIssues(root, 10)
    expect(second.items).toHaveLength(3)
    const all = [...first.items, ...second.items]
    expect(all.some((item) => item.reason === 'password')).toBe(true)
    expect(all.some((item) => item.reason === 'no-text')).toBe(true)
    expect(
      all.every((item) => !item.path.includes('sibling') && !item.path.includes('excluded')),
    ).toBe(true)
    expect(store.retryDocument(first.items[0]!.id)).toBe(first.items[0]!.path)
    expect(store.documentById(first.items[0]!.id)?.status).toBe('pending')
    expect(store.indexIssues(root).total).toBe(12)
    expect(store.retryDocument(999999)).toBeNull()
    expect(store.retryDocument(store.documentByPath(excluded)!.id)).toBeNull()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('issueReason classification', () => {
  const cases: Array<[string | null, string, IndexIssueReason]> = [
    ['Password protected', 'error', 'password'],
    ['File is encrypted', 'error', 'password'],
    ['Document is unavailable.', 'error', 'unavailable'],
    ["ENOENT: no such file or directory, open 'C:\\a.docx'", 'error', 'unavailable'],
    ['Document moved to an already remembered path.', 'error', 'unavailable'],
    ["EACCES: permission denied, open 'C:\\a.docx'", 'error', 'permission'],
    ['EBUSY: resource busy or locked', 'error', 'permission'],
    [
      'The process cannot access the file because it is being used by another process',
      'error',
      'permission',
    ],
    ['Document extraction timed out.', 'error', 'timeout'],
    ['Document exceeds the 128 MB indexing limit', 'error', 'too-large'],
    ['File changed while indexing', 'error', 'changed'],
    ['Could not find end of central directory (bad zip)', 'error', 'corrupt'],
    ['Invalid PDF structure', 'error', 'corrupt'],
    ['Invalid input', 'error', 'unsupported'],
    ['Invalid PDF header', 'error', 'corrupt'],
    ['No readable text; scanned documents need OCR', 'empty', 'no-text'],
    [null, 'empty', 'no-text'],
    ['No readable text in this file; there is nothing to search', 'empty', 'empty'],
    ['Unsupported document type', 'error', 'unsupported'],
    ['Local embedding model unavailable; text search remains available', 'error', 'model'],
    ['TypeError: fetch failed', 'error', 'model'],
    ['Something odd', 'error', 'other'],
    [null, 'error', 'other'],
  ]
  it.each(cases)('classifies %j (%s) as %s', (error, status, expected) => {
    expect(issueReason(error, status)).toBe(expected)
  })

  it('never reports a model failure as a missing file', () => {
    expect(issueReason('Embedding model unavailable', 'error')).not.toBe('unavailable')
  })

  it('separates informational reasons from ones worth retrying', () => {
    expect(isInformationalReason('no-text')).toBe(true)
    expect(isInformationalReason('password')).toBe(true)
    expect(isInformationalReason('timeout')).toBe(false)
    expect(isRetryableReason('timeout')).toBe(true)
    expect(isRetryableReason('too-large')).toBe(false)
  })

  it('folds per-message counts into ordered groups', () => {
    const groups = groupIssueCounts([
      { status: 'empty', error: 'No readable text; scanned documents need OCR', count: 40 },
      { status: 'error', error: 'Password protected', count: 7 },
      { status: 'error', error: 'file is encrypted', count: 5 },
      { status: 'error', error: 'Document is unavailable.', count: 9 },
      { status: 'error', error: null, count: 2 },
    ])
    expect(groups).toEqual([
      { reason: 'unavailable', count: 9 },
      { reason: 'other', count: 2 },
      { reason: 'password', count: 12 },
      { reason: 'no-text', count: 40 },
    ])
  })

  it('shortens a raw exception to one readable line', () => {
    expect(shortCause('Error: Error: fetch failed\n    at foo (bar.js:1:1)')).toBe('fetch failed')
    expect(shortCause(undefined)).toBe('')
    expect(shortCause('x'.repeat(300), 20)).toHaveLength(20)
  })
})

it('IndexIssueReader summarizes, pages by reason and lists ids without touching the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-issue-reader-'))
  const dbPath = join(dir, 'memory.db')
  const store = new DocumentMemoryStore(dbPath)
  const reader = new IndexIssueReader(dbPath)
  try {
    const root = join(dir, 'selected')
    for (let i = 0; i < 14; i++)
      store.markError(join(root, `locked-${i}.docx`), 'EBUSY: resource busy or locked', null)
    store.markError(join(root, 'pw.docx'), 'Password protected', null)
    store.markError(join(dir, 'selected-sibling', 'x.docx'), 'Password protected', null)
    const summary = reader.summary(root)
    expect(summary.total).toBe(15)
    expect(summary.groups).toEqual([
      { reason: 'permission', count: 14 },
      { reason: 'password', count: 1 },
    ])
    const first = reader.page(root, 0, 'permission')
    expect(first.total).toBe(14)
    expect(first.items).toHaveLength(10)
    expect(first.items.every((item) => item.reason === 'permission' && item.error)).toBe(true)
    expect(reader.page(root, 10, 'permission').items).toHaveLength(4)
    expect(reader.page(root, 0).total).toBe(15)
    expect(reader.ids(root, 'password')).toHaveLength(1)
    expect(reader.ids(root)).toHaveLength(15)
    // excluded rows disappear from every view
    store.exclude(join(root, 'pw.docx'))
    expect(reader.summary(root).total).toBe(14)
  } finally {
    reader.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
