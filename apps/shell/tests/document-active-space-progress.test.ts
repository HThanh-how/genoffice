import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'

describe('Document Active-Space Progress QA Suite (DOCPROG-01..04)', () => {
  let tempDir: string
  let dbPath: string
  let store: DocumentMemoryStore
  let scheduler: MaintenanceScheduler
  let docPath: string
  const SPACE_F2 = 'f2llm-v2-80m:ad88d7a126:q8:last-token:320:v1'
  const SPACE_QWEN = 'qwen3-embedding-0.6b:bd58e9fd4b:q8:last-token:512:v1'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-docprog-'))
    dbPath = join(tempDir, 'memory.sqlite')
    docPath = join(tempDir, 'spec-document.docx')
    store = new DocumentMemoryStore(dbPath)
    scheduler = new MaintenanceScheduler({ store })

    // Setup 100 chunks for the document
    const chunks = Array.from({ length: 100 }, (_, i) => ({
      text: `Chunk content number ${i}`,
      location: `Paragraph ${i}`,
    }))

    store.replaceDocument(docPath, {
      hash: 'doc-hash-1',
      mtimeMs: 1_700_000_000_000,
      sizeBytes: 10_000,
      status: 'ready',
      chunks,
      embeddingModel: SPACE_F2,
    })

    // Seed 100 completed embeddings for Space F2
    const f2Vectors = Array.from({ length: 100 }, () => new Array(320).fill(0.1))
    store.setChunkEmbeddings(docPath, 'doc-hash-1', 0, f2Vectors, SPACE_F2, true)

    // Seed 40 completed embeddings for Space Qwen
    const qwenVectors = Array.from({ length: 40 }, () => new Array(512).fill(0.2))
    store.setChunkEmbeddings(docPath, 'doc-hash-1', 0, qwenVectors, SPACE_QWEN, false)
  })

  afterEach(() => {
    scheduler.dispose()
    try {
      store.close()
    } catch {
      // ignore
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('DOCPROG-01: active F2 returns 100/100 completed chunks (100%)', () => {
    const progress = scheduler.getDocumentIndexProgress(docPath, SPACE_F2)
    expect(progress).toBeDefined()
    expect(progress.percent).toBe(100)
    expect(progress.completedChunks).toBe(100)
    expect(progress.totalChunks).toBe(100)
  })

  it('DOCPROG-02: active Qwen returns 40/100 completed chunks (40%)', () => {
    const progress = scheduler.getDocumentIndexProgress(docPath, SPACE_QWEN)
    expect(progress).toBeDefined()
    expect(progress.percent).toBe(40)
    expect(progress.completedChunks).toBe(40)
    expect(progress.totalChunks).toBe(100)
  })

  it('DOCPROG-03: never sums cross-profile embeddings (140/100 is impossible)', () => {
    const f2Progress = scheduler.getDocumentIndexProgress(docPath, SPACE_F2)
    const qwenProgress = scheduler.getDocumentIndexProgress(docPath, SPACE_QWEN)

    expect(f2Progress.completedChunks).toBe(100)
    expect(qwenProgress.completedChunks).toBe(40)
    expect(f2Progress.completedChunks + qwenProgress.completedChunks).toBe(140)

    // Neither progress returns 140
    expect(f2Progress.completedChunks).not.toBe(140)
    expect(qwenProgress.completedChunks).not.toBe(140)
    expect(f2Progress.percent).not.toBeGreaterThan(100)
    expect(qwenProgress.percent).not.toBeGreaterThan(100)
  })

  it('DOCPROG-04: getDocumentIndexProgress strictly requires explicit activeSpaceId and queries chunkProgress accordingly', () => {
    const directProgressF2 = store.chunkProgress(docPath, SPACE_F2)
    const directProgressQwen = store.chunkProgress(docPath, SPACE_QWEN)

    expect(directProgressF2.completedChunks).toBe(100)
    expect(directProgressQwen.completedChunks).toBe(40)

    const schedProgressF2 = scheduler.getDocumentIndexProgress(docPath, SPACE_F2)
    const schedProgressQwen = scheduler.getDocumentIndexProgress(docPath, SPACE_QWEN)

    expect(schedProgressF2.completedChunks).toBe(directProgressF2.completedChunks)
    expect(schedProgressQwen.completedChunks).toBe(directProgressQwen.completedChunks)
  })
})
