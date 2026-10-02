import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'

describe('IndexIssueReader search and detail', () => {
  it('finds files by name without accents, problems first, and describes one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'index-search-'))
    const dbPath = join(dir, 'memory.db')
    const store = new DocumentMemoryStore(dbPath)
    const reader = new IndexIssueReader(dbPath)
    try {
      const scan = join(dir, 'Ba', 'BỆNH VIỆN 30-4.pdf')
      store.replaceDocument(scan, {
        hash: 'a',
        mtimeMs: 1,
        sizeBytes: 2048,
        chunks: [],
        embeddingModel: null,
        status: 'empty',
        error: 'No readable text; scanned documents need OCR',
      })
      const ok = join(dir, 'Ba', 'bệnh viện ghi chú.docx')
      store.replaceDocument(ok, {
        hash: 'b',
        mtimeMs: 1,
        sizeBytes: 10,
        chunks: [],
        embeddingModel: null,
        status: 'ready',
      })
      store.replaceDocument(join(dir, 'other.docx'), {
        hash: 'c',
        mtimeMs: 1,
        sizeBytes: 10,
        chunks: [],
        embeddingModel: null,
        status: 'ready',
      })

      const hits = reader.search('benh vien')
      expect(hits.map((h) => h.name)).toEqual(['BỆNH VIỆN 30-4.pdf', 'bệnh viện ghi chú.docx'])
      expect(hits[0]).toMatchObject({ status: 'empty', reason: 'no-text' })
      expect(hits[1]?.reason).toBeUndefined()
      expect(reader.search('benh 30-4')).toHaveLength(1)
      expect(reader.search('   ')).toEqual([])
      expect(reader.search('khong co')).toEqual([])

      const detail = reader.detail(hits[0]!.id)
      expect(detail).toMatchObject({
        name: 'BỆNH VIỆN 30-4.pdf',
        status: 'empty',
        sizeBytes: 2048,
        truncated: false,
      })
      expect(reader.detail(999_999)).toBeNull()
    } finally {
      reader.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('DocumentMemoryStore.searchNames', () => {
  it('finds a scanned PDF by its name although it has no passages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'index-names-'))
    const store = new DocumentMemoryStore(join(dir, 'memory.db'))
    try {
      const empty = (path: string) =>
        store.replaceDocument(path, {
          hash: path,
          mtimeMs: 1,
          sizeBytes: 1,
          chunks: [],
          embeddingModel: null,
          status: 'empty',
          error: 'No readable text; scanned documents need OCR',
        })
      empty(join(dir, 'Ba', 'Ra viện BV Chợ Rẫy.pdf'))
      empty(join(dir, 'Ba', 'Biên nhận.pdf'))
      const hits = store.searchNames('có cái nào là giấy ra viện không?')
      expect(hits.map((h) => h.name)).toEqual(['Ra viện BV Chợ Rẫy.pdf'])
      expect(hits[0]).toMatchObject({ contentUnread: true, location: 'file name', chunkId: 0 })
      expect(store.searchNames('ra vien')).toHaveLength(1)
      expect(store.searchNames('tìm file')).toEqual([])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
