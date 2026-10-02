import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { issueReason } from '../src/main/document-memory/issues'

const OLD = 'No readable text; scanned documents need OCR'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-blank-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function emptyDocument(store: DocumentMemoryStore, path: string): Promise<void> {
  await store.replaceDocumentSliced(path, {
    hash: 'h',
    mtimeMs: 1,
    sizeBytes: 3000,
    chunks: [],
    embeddingModel: null,
    status: 'empty',
    error: OLD,
  })
}

describe('blank documents are not "scanned, needs OCR"', () => {
  it('re-files a blank Word file that an older version called a scan, and leaves PDFs alone', async () => {
    const dbPath = join(dir, 'memory.db')
    const first = new DocumentMemoryStore(dbPath)
    await emptyDocument(first, join(dir, 'blank.docx'))
    await emptyDocument(first, join(dir, 'scan.pdf'))
    first.close()

    const reopened = new DocumentMemoryStore(dbPath)
    try {
      const docx = reopened.documentByPath(join(dir, 'blank.docx'))
      const pdf = reopened.documentByPath(join(dir, 'scan.pdf'))
      expect(issueReason(docx!.error ?? null, docx!.status)).toBe('empty')
      expect(issueReason(pdf!.error ?? null, pdf!.status)).toBe('no-text')
    } finally {
      reopened.close()
    }
  })
})
