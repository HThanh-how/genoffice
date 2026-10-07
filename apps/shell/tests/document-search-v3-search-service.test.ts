import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { SearchService } from '../src/main/document-memory/runtime/search-service'
import { FreshnessCoordinator } from '../src/main/document-memory/runtime/freshness-coordinator'
import type { EmbeddingProfile } from '../src/main/document-memory/embedding-profiles'

describe('Pair 14: Document Search V3 Search Service Parity Suite (QA-14)', () => {
  let dir: string
  let dbPath: string
  let store: DocumentMemoryStore

  const profile3D: EmbeddingProfile = {
    id: 'standard',
    repo: 'repo-test',
    revision: 'r1',
    pooling: 'mean',
    dimensions: 3,
    embeddingId: 'space-test',
    nativeDimensions: 3,
    files: [],
    modelFile: 'm',
    tokenizerFile: 't',
    tokenizerConfigFile: 'tc',
  }

  const profileF2: EmbeddingProfile = {
    id: 'standard',
    repo: 'repo-f2',
    revision: 'r1',
    pooling: 'mean',
    dimensions: 2,
    embeddingId: 'space-f2',
    nativeDimensions: 2,
    files: [],
    modelFile: 'm',
    tokenizerFile: 't',
    tokenizerConfigFile: 'tc',
  }

  const profileQwen: EmbeddingProfile = {
    id: 'high',
    repo: 'repo-qwen',
    revision: 'r1',
    pooling: 'last-token',
    dimensions: 2,
    embeddingId: 'space-qwen',
    nativeDimensions: 2,
    files: [],
    modelFile: 'm',
    tokenizerFile: 't',
    tokenizerConfigFile: 'tc',
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-qa14-search-'))
    dbPath = join(dir, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
    store.ensureEmbeddingSpace(profile3D)
    store.ensureEmbeddingSpace(profileF2)
    store.ensureEmbeddingSpace(profileQwen)
  })

  afterEach(() => {
    store.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('SEARCH-01 exact filename matches document name directly', async () => {
    const filePath = join(dir, 'financial-statement-2026.xlsx')
    writeFileSync(filePath, 'dummy content', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'hash-01',
      mtimeMs: 1000,
      sizeBytes: 100,
      chunks: [{ id: 1, ordinal: 0, text: 'dummy text', location: 'sheet 1' }],
      embeddingModel: null,
      status: 'ready',
    })

    const service = new SearchService({ store })
    const hits = await service.searchProgressive('financial-statement-2026.xlsx', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe('financial-statement-2026.xlsx')
    expect(hits[0]!.path).toBe(filePath)
  })

  it('SEARCH-02 filename partial matches query words', async () => {
    const filePath = join(dir, 'quarterly-audit-report.docx')
    writeFileSync(filePath, 'dummy content', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'hash-02',
      mtimeMs: 1000,
      sizeBytes: 100,
      chunks: [{ id: 2, ordinal: 0, text: 'table of contents', location: 'p.1' }],
      embeddingModel: null,
      status: 'ready',
    })

    const service = new SearchService({ store })
    const hits = await service.searchProgressive('quarterly audit', 5)
    expect(hits.some((h) => h.name.includes('quarterly-audit'))).toBe(true)
  })

  it('SEARCH-03 lexical phrase matches full text search in chunks', async () => {
    const filePath = join(dir, 'security-policy.docx')
    writeFileSync(filePath, 'dummy content', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'hash-03',
      mtimeMs: 1000,
      sizeBytes: 100,
      chunks: [
        { id: 3, ordinal: 0, text: 'strict cryptographic encryption at rest standards', location: 'section 4' },
      ],
      embeddingModel: null,
      status: 'ready',
    })

    const service = new SearchService({ store })
    const hits = await service.searchProgressive('cryptographic encryption', 5)
    expect(hits.some((h) => h.text.includes('cryptographic encryption'))).toBe(true)
  })

  it('SEARCH-04 semantic-only hit retrieves chunk without lexical match', async () => {
    const filePath = join(dir, 'concept.txt')
    writeFileSync(filePath, 'dummy content', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'hash-04',
      mtimeMs: 1000,
      sizeBytes: 100,
      chunks: [{ id: 4, ordinal: 0, text: 'automobile vehicle engine specs', location: 'p.1', vector: [1, 0, 0] }],
      embeddingModel: 'space-test',
      status: 'ready',
    })

    const service = new SearchService({
      store,
      askEmbed: async () => [1, 0, 0], // Query vector matches chunk vector exactly
    })

    const hits = await service.searchProgressive('car motor', 5, undefined, 'space-test')
    expect(hits.some((h) => h.text.includes('automobile'))).toBe(true)
  })

  it('SEARCH-05 lexical + semantic RRF combines both channels', async () => {
    const filePathA = join(dir, 'doc-a.txt')
    const filePathB = join(dir, 'doc-b.txt')
    writeFileSync(filePathA, 'alpha', 'utf8')
    writeFileSync(filePathB, 'beta', 'utf8')

    await store.replaceDocumentSliced(filePathA, {
      hash: 'h-a',
      mtimeMs: 1000,
      sizeBytes: 10,
      chunks: [{ id: 10, ordinal: 0, text: 'distributed consensus protocol blockchain', location: 'p.1', vector: [0.1, 0.9, 0] }],
      embeddingModel: 'space-test',
      status: 'ready',
    })
    await store.replaceDocumentSliced(filePathB, {
      hash: 'h-b',
      mtimeMs: 1000,
      sizeBytes: 10,
      chunks: [{ id: 20, ordinal: 0, text: 'distributed consensus protocol raft paxos', location: 'p.1', vector: [0.9, 0.1, 0] }],
      embeddingModel: 'space-test',
      status: 'ready',
    })

    const service = new SearchService({
      store,
      askEmbed: async () => [0.9, 0.1, 0], // High semantic match for chunk 20
    })

    const hits = await service.searchProgressive('consensus protocol', 5, undefined, 'space-test')
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it('SEARCH-06 changed file does not return stale text without stale flag', async () => {
    const filePath = join(dir, 'mutated.txt')
    writeFileSync(filePath, 'v1 text', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'h-mut',
      mtimeMs: 1000,
      sizeBytes: 7,
      chunks: [{ id: 30, ordinal: 0, text: 'database storage optimization', location: 'p.1' }],
      embeddingModel: null,
      status: 'ready',
    })

    // Modify file on disk to change mtime
    writeFileSync(filePath, 'v2 completely modified content', 'utf8')

    const freshnessCoord = new FreshnessCoordinator({ store })
    const service = new SearchService({
      store,
      annotateFreshness: (hits) => freshnessCoord.annotateFreshness(hits),
    })

    const hits = await service.searchProgressive('database storage', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.stale).toBe(true)
  })

  it('SEARCH-07 deleted file marked missing / removed', async () => {
    const filePath = join(dir, 'deleted.txt')
    writeFileSync(filePath, 'temporary notes', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'h-del',
      mtimeMs: 1000,
      sizeBytes: 15,
      chunks: [{ id: 40, ordinal: 0, text: 'temporary notes about architecture', location: 'p.1' }],
      embeddingModel: null,
      status: 'ready',
    })

    // Remove file from disk
    rmSync(filePath, { force: true })

    const freshnessCoord = new FreshnessCoordinator({ store })
    const service = new SearchService({
      store,
      annotateFreshness: (hits) => freshnessCoord.annotateFreshness(hits),
    })

    const hits = await service.searchProgressive('temporary notes', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.missing).toBe(true)
  })

  it('SEARCH-08 moved file resolves new path', async () => {
    const oldPath = join(dir, 'old-location.txt')
    const newPath = join(dir, 'new-location.txt')
    writeFileSync(newPath, 'relocated content', 'utf8')

    await store.replaceDocumentSliced(oldPath, {
      hash: 'h-mov',
      mtimeMs: 1000,
      sizeBytes: 17,
      chunks: [{ id: 50, ordinal: 0, text: 'relocated unique document phrase', location: 'p.1' }],
      embeddingModel: null,
      status: 'ready',
    })

    // Move in store
    store.move(oldPath, newPath)

    const service = new SearchService({ store })
    const hits = await service.searchProgressive('relocated unique', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.path).toBe(newPath)
  })

  it('SEARCH-09 old async query cannot overwrite newer query', async () => {
    const filePath = join(dir, 'race.txt')
    writeFileSync(filePath, 'content', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'h-race',
      mtimeMs: 1000,
      sizeBytes: 7,
      chunks: [{ id: 60, ordinal: 0, text: 'asynchronous query race condition test', location: 'p.1' }],
      embeddingModel: null,
      status: 'ready',
    })

    let slowResolve: ((val: number[]) => void) | null = null
    const slowPromise = new Promise<number[]>((res) => {
      slowResolve = res
    })

    const service = new SearchService({
      store,
      askEmbed: async (text) => {
        if (text === 'query-1') {
          return slowPromise
        }
        return [0.5, 0.5]
      },
    })

    const finalEvents: string[] = []

    // Launch slow query 1
    const p1 = service.searchProgressive('query-1', 5, {
      onFinal: () => finalEvents.push('query-1-finished'),
    })

    // Launch fast query 2 immediately after
    const p2 = service.searchProgressive('query-2', 5, {
      onFinal: () => finalEvents.push('query-2-finished'),
    })

    await p2

    // Now resolve slow query 1 later
    slowResolve!([0.1, 0.1])
    await p1

    // Query 1 must NOT deliver onFinal callback after Query 2
    expect(finalEvents).toEqual(['query-2-finished'])
  })

  it('SEARCH-10 active profile switch uses correct semantic space', async () => {
    const filePath = join(dir, 'multi-space.txt')
    writeFileSync(filePath, 'content', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'h-multi',
      mtimeMs: 1000,
      sizeBytes: 7,
      chunks: [{ id: 70, ordinal: 0, text: 'multilingual embedding representation', location: 'p.1', vector: [1, 0] }],
      embeddingModel: 'space-f2',
      status: 'ready',
    })

    let requestedSpace = ''
    const service = new SearchService({
      store,
      askEmbed: async () => [1, 0],
      askSemantic: async (vector, limit, spaceId) => {
        requestedSpace = spaceId
        return store.searchSemantic(vector, limit, spaceId)
      },
    })

    await service.searchProgressive('multilingual', 5, undefined, 'space-f2')
    expect(requestedSpace).toBe('space-f2')

    await service.searchProgressive('multilingual', 5, undefined, 'space-qwen')
    expect(requestedSpace).toBe('space-qwen')
  })

  it('SEARCH-11 OCR text searchable with page location', async () => {
    const filePath = join(dir, 'scanned.pdf')
    writeFileSync(filePath, 'pdf data', 'utf8')
    await store.replaceDocumentSliced(filePath, {
      hash: 'h-ocr',
      mtimeMs: 1000,
      sizeBytes: 8,
      chunks: [{ id: 80, ordinal: 0, text: 'optical character recognition extracted text from scan', location: 'page 4' }],
      embeddingModel: null,
      status: 'ready',
    })

    const service = new SearchService({ store })
    const hits = await service.searchProgressive('optical character recognition', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.location).toBe('page 4')
    expect(hits[0]!.text).toContain('optical character recognition')
  })

  it('SEARCH-12 external filename result merged once without duplicates', async () => {
    const service = new SearchService({
      store,
      externalNames: async () => [
        { path: 'D:/external/file1.docx', name: 'file1.docx' },
        { path: 'D:/external/file1.docx', name: 'file1.docx' }, // duplicate
        { path: 'D:/external/file2.docx', name: 'file2.docx' },
      ],
    })

    const results = await service.searchExternal('file', 10)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.path)).toEqual(['D:/external/file1.docx', 'D:/external/file2.docx'])
  })
})
