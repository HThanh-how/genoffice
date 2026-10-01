import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

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
