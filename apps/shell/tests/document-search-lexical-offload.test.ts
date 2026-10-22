import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { SearchService } from '../src/main/document-memory/runtime/search-service'

/**
 * The lexical (FTS5) candidate query is the slowest synchronous statement the main thread runs (0.3-1.5 s on a
 * large corpus; 905 calls, ~697 s in one day's stall log). It is answered by the document-memory worker when it can;
 * the main connection is only the fallback.
 */
describe('SearchService lexical candidates are answered off the main connection', () => {
  let dir: string
  let store: DocumentMemoryStore
  let filePath: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-lexical-offload-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    filePath = join(dir, 'security-policy.docx')
    writeFileSync(filePath, 'dummy', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'h1',
      mtimeMs: 1000,
      sizeBytes: 100,
      chunks: [
        {
          id: 1,
          ordinal: 0,
          text: 'strict cryptographic encryption at rest standards',
          location: 's1',
        },
      ],
      embeddingModel: null,
      status: 'ready',
    })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('LEX-OFF-01: uses the worker answer and never runs the query on the main connection', async () => {
    const candidates = store.searchLexical('cryptographic encryption', 200)
    expect(candidates.length).toBeGreaterThan(0)
    const mainQuery = vi.spyOn(store, 'searchLexical')
    const askLexical = vi.fn(async () => candidates)
    const service = new SearchService({ store, askLexical })

    const hits = await service.searchProgressive('cryptographic encryption', 5)

    expect(askLexical).toHaveBeenCalledWith('cryptographic encryption', 200)
    expect(mainQuery).not.toHaveBeenCalled()
    expect(hits.some((h) => h.path === filePath)).toBe(true)
  })

  it('LEX-OFF-02: falls back to the main connection when the worker cannot answer', async () => {
    const mainQuery = vi.spyOn(store, 'searchLexical')
    for (const askLexical of [
      async () => null,
      async () => Promise.reject(new Error('worker down')),
    ]) {
      mainQuery.mockClear()
      const service = new SearchService({ store, askLexical })
      const hits = await service.searchProgressive('cryptographic encryption', 5)
      expect(mainQuery).toHaveBeenCalledTimes(1)
      expect(hits.some((h) => h.path === filePath)).toBe(true)
    }
  })

  it('LEX-OFF-03: without a worker hook the behaviour is unchanged', async () => {
    const mainQuery = vi.spyOn(store, 'searchLexical')
    const hits = await new SearchService({ store }).searchProgressive('cryptographic encryption', 5)
    expect(mainQuery).toHaveBeenCalledTimes(1)
    expect(hits.some((h) => h.path === filePath)).toBe(true)
  })

  it('LEX-OFF-04: a query cancelled while the worker is busy returns nothing', async () => {
    let release: (v: ReturnType<DocumentMemoryStore['searchLexical']>) => void = () => {}
    const askLexical = vi.fn(
      () => new Promise<ReturnType<DocumentMemoryStore['searchLexical']>>((r) => (release = r)),
    )
    const service = new SearchService({ store, askLexical })
    const pending = service.searchProgressive('cryptographic encryption', 5)
    service.cancelActiveQuery()
    release(store.searchLexical('cryptographic encryption', 200))
    expect(await pending).toEqual([])
  })
})
