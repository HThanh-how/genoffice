import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { CachedOcrRecovery } from '../src/main/document-memory/runtime/ocr-recovery'
import { readOcrRecoveryPage } from '../src/main/document-memory/storage/repositories/ocr-recovery-repository'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { extractDocument } from '../src/main/document-memory/worker'
import { buildScannedPdf, testPattern } from './helpers/scanned-pdf'

let dir: string
let store: DocumentMemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocr-recovery-'))
  store = new DocumentMemoryStore(join(dir, 'test.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function scan(name = 'scan.pdf') {
  const jpeg = encodeGrayJpeg(testPattern(120, 160, 0), 120, 160, 70)
  const bytes = buildScannedPdf(
    Array.from({ length: 2 }, () => ({ jpeg, width: 120, height: 160 })),
  )
  const path = join(dir, name)
  writeFileSync(path, bytes)
  const stat = statSync(path)
  const meta = {
    hash: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    totalPages: 2,
  }
  const empty = {
    ...meta,
    chunks: [],
    embeddingModel: null,
    status: 'empty' as const,
    error: 'No readable text; scanned documents need OCR',
  }
  store.replaceDocument(path, empty)
  return { path, meta, empty }
}

const pages = [
  { page: 1, text: 'Synthetic quarterly invoice total 12345' },
  { page: 2, text: 'Synthetic receipt balance 67890' },
]

describe('durable cached OCR write-back', () => {
  it('page save commits a pending request even if the queue callback never happens', async () => {
    const { path, meta } = scan()
    store.ocr.savePages(path, meta, pages)
    expect(store.documentByPath(path)).toMatchObject({ status: 'pending', error: null })
    expect(store.incompletePaths()).toContain(path)
    store.close()
    store = new DocumentMemoryStore(join(dir, 'test.db'))
    expect(store.incompletePaths()).toContain(path)
    const result = await extractDocument(path, (p, hash) => store.ocr.pages(p, hash))
    store.replaceDocument(path, { ...result, status: 'text-only', embeddingModel: null })
    expect(store.documentByPath(path)).toMatchObject({ status: 'text-only', error: null })
    expect(store.chunkProgress(path).totalChunks).toBeGreaterThan(0)
  })

  it('OCR arriving while an empty replacement awaits its commit cannot be overwritten as empty', async () => {
    const { path, meta, empty } = scan()
    await store.replaceDocumentSliced(path, empty, {
      beforeBatch: async () => {
        store.ocr.savePages(path, meta, pages)
        return { proceed: true }
      },
    })
    expect(store.documentByPath(path)).toMatchObject({ status: 'pending', error: null })
    expect(store.incompletePaths()).toContain(path)
    const result = await extractDocument(path, (p, hash) => store.ocr.pages(p, hash))
    await store.replaceDocumentSliced(path, {
      ...result,
      status: 'text-only',
      embeddingModel: null,
    })
    expect(store.chunkProgress(path).totalChunks).toBeGreaterThan(0)
  })

  it('does not retry genuinely blank cached OCR or text belonging to another hash', () => {
    const blank = scan('blank.pdf')
    store.ocr.savePages(blank.path, blank.meta, [
      { page: 1, text: ' \n\t\r' },
      { page: 2, text: '' },
    ])
    expect(store.documentByPath(blank.path)?.status).toBe('empty')
    const changed = scan('changed.pdf')
    store.ocr.savePages(changed.path, { ...changed.meta, hash: 'old-file' }, pages)
    expect(store.documentByPath(changed.path)?.status).toBe('empty')
    expect(readOcrRecoveryPage(store.rawDb, 0).paths).toEqual([])
  })
})

describe('one startup traversal of stuck empty documents', () => {
  it('heals a legacy stuck row using cached text and the normal chunk writer without any OCR request', async () => {
    const { path, meta } = scan()
    store.ocr.savePages(path, meta, pages)
    store.rawDb
      .prepare(
        "UPDATE documents SET status = 'empty', error = 'No readable text; scanned documents need OCR' WHERE path = ?",
      )
      .run(path)
    const incomplete = scan('partial.pdf')
    store.ocr.savePages(incomplete.path, incomplete.meta, [pages[0]])
    store.rawDb.prepare("UPDATE documents SET status = 'empty' WHERE path = ?").run(incomplete.path)
    const jobs: Promise<unknown>[] = []
    const ask = vi.fn(async (request) => {
      expect(request.type).toBe('ocr-reconcile-page')
      return { id: 1, result: readOcrRecoveryPage(store.rawDb, request.afterId) }
    })
    const recovery = new CachedOcrRecovery({
      ask,
      isActive: () => true,
      enqueue: (p) =>
        jobs.push(
          extractDocument(p, (p, h) => store.ocr.pages(p, h)).then((result) =>
            store.replaceDocumentSliced(p, {
              ...result,
              status: 'text-only',
              embeddingModel: null,
            }),
          ),
        ),
    })
    await recovery.run()
    await Promise.all(jobs)
    await recovery.run()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(store.documentByPath(path)).toMatchObject({ status: 'text-only', error: null })
    expect(store.chunkProgress(path).totalChunks).toBeGreaterThan(0)
    expect(store.documentByPath(incomplete.path)?.status).toBe('empty')
  })

  it('bounds pages, resumes after pause, and stops scanning once done', async () => {
    for (let i = 0; i < 130; i++) {
      store.replaceDocument(join(dir, `${i}.pdf`), {
        hash: `hash${i}`,
        mtimeMs: 1,
        sizeBytes: 1,
        chunks: [],
        embeddingModel: null,
        status: 'empty',
      })
    }
    const first = readOcrRecoveryPage(store.rawDb, 0)
    expect(first).toMatchObject({ afterId: 128, done: false, paths: [] })
    expect(readOcrRecoveryPage(store.rawDb, first.afterId)).toMatchObject({
      afterId: 130,
      done: true,
    })
    let active = true
    const ask = vi.fn(async (request) => {
      const result = readOcrRecoveryPage(store.rawDb, request.afterId)
      if (ask.mock.calls.length === 1) active = false
      return { id: 1, result }
    })
    const recovery = new CachedOcrRecovery({ ask, isActive: () => active, enqueue: vi.fn() })
    await recovery.run()
    active = true
    await recovery.run()
    await recovery.run()
    expect(ask.mock.calls.map(([request]) => request.afterId)).toEqual([0, 0, 128]) // an interrupted reply is not consumed
  })

  it('failed local renders remain cloud candidates and escalated pages remain durable cloud work', () => {
    const failed = scan('unreadable.pdf')
    store.ocr.recordLocalFailure(failed.path, failed.meta, 'corrupt', true)
    expect(store.ocr.localFailure(failed.path)?.attempts).toBe(3)
    expect(store.ocr.candidates(5, { mode: 'local' }).map((r) => r.path)).not.toContain(failed.path)
    expect(
      store.ocr.candidates(5, { mode: 'cloud', leaveToLocal: true }).map((r) => r.path),
    ).toContain(failed.path)
    const escalated = scan('escalated.pdf')
    store.ocr.savePages(escalated.path, { ...escalated.meta, tier: 'local', escalate: true }, pages)
    // The automatic cloud branch also accepts pending rows while cached text is being indexed.
    expect(
      store.ocr.candidates(5, { mode: 'cloud', leaveToLocal: true }).map((r) => r.path),
    ).toContain(escalated.path)
    expect(
      store.ocr.pagesDone(escalated.path, escalated.meta.mtimeMs, escalated.meta.sizeBytes),
    ).toEqual([])
  })
})
