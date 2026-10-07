import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'

vi.mock('../src/main/document-memory/worker?modulePath', () => ({
  default: 'mock-worker-path',
}))
vi.mock('@genoffice/file-parse', () => ({
  parseFileToText: vi.fn(),
  pdfPageTextsSlice: vi.fn(),
}))
vi.mock('onnxruntime-node', () => ({
  InferenceSession: { create: vi.fn() },
}))
vi.mock('@huggingface/tokenizers', () => ({
  Tokenizer: { fromFile: vi.fn() },
}))

import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { SearchService } from '../src/main/document-memory/runtime/search-service'
import { EMBEDDING_PROFILES, type EmbeddingProfile } from '../src/main/document-memory/embedding-profiles'
import {
  isIndexingPaused,
  publishIndexingPolicy,
  resetIndexingPolicyBus,
  type PublishedPolicy,
} from '../src/main/fork/indexing-policy-bus'
import {
  getDocumentIndexSnapshot,
  snapshotCache,
  diagnosticsCache,
} from '../src/main/fork/document-index-snapshot-service'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import { blobVector, floatBlob } from '../src/main/document-memory/storage/repositories/embedding-repository'

const F2_SPACE_ID = EMBEDDING_PROFILES.standard.embeddingId
const QWEN_SPACE_ID = EMBEDDING_PROFILES.high.embeddingId

const testProfileF2: EmbeddingProfile = {
  id: 'standard',
  repo: EMBEDDING_PROFILES.standard.repo,
  revision: EMBEDDING_PROFILES.standard.revision,
  pooling: EMBEDDING_PROFILES.standard.pooling,
  dimensions: 4,
  embeddingId: F2_SPACE_ID,
  nativeDimensions: 4,
  files: [],
  modelFile: 'm',
  tokenizerFile: 't',
  tokenizerConfigFile: 'tc',
}

const testProfileQwen: EmbeddingProfile = {
  id: 'high',
  repo: EMBEDDING_PROFILES.high.repo,
  revision: EMBEDDING_PROFILES.high.revision,
  pooling: EMBEDDING_PROFILES.high.pooling,
  dimensions: 4,
  embeddingId: QWEN_SPACE_ID,
  nativeDimensions: 4,
  files: [],
  modelFile: 'm',
  tokenizerFile: 't',
  tokenizerConfigFile: 'tc',
}

const runningPolicy: PublishedPolicy = {
  paused: false,
  threads: 2,
  cpuShare: 0.5,
  priority: 'below-normal',
  tier: 'active',
  reason: 'test',
  onBattery: false,
}

const pausedPolicy: PublishedPolicy = {
  ...runningPolicy,
  paused: true,
  pauseReason: 'battery-saver',
  cpuShare: 0,
  tier: 'paused',
  onBattery: true,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('until condition timed out')
    await sleep(15)
  }
}

describe('Semantic Soak Independent Auditor Suite (PAIR 20)', () => {
  let tempDir: string
  let dbPath: string
  let store: DocumentMemoryStore
  let manager: DocumentMemoryManager | null = null
  let issueReader: IndexIssueReader | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-qa20-soak-'))
    dbPath = join(tempDir, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
    store.ensureEmbeddingSpace(testProfileF2)
    store.ensureEmbeddingSpace(testProfileQwen)
    resetIndexingPolicyBus()
    snapshotCache.clear()
    diagnosticsCache.clear()
  })

  afterEach(() => {
    if (manager) {
      try {
        manager.close()
      } catch {}
      manager = null
    }
    if (issueReader) {
      try {
        issueReader.close()
      } catch {}
      issueReader = null
    }
    try {
      store.close()
    } catch {}
    resetIndexingPolicyBus()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  // =========================================================================
  // SOAK-01: Kiểm chứng lexical query hoạt động ngay khi vector = 0
  // =========================================================================
  it('SOAK-01: lexical query returns instant accurate hits when vectors = 0 (text-only)', async () => {
    const docPath = join(tempDir, 'quarterly-audit-2026.docx')
    writeFileSync(docPath, 'Audit report text content on disk', 'utf8')

    // Document contains 5 chunks, but 0 vector embeddings generated
    const chunks = [
      { id: 1, ordinal: 0, text: 'Executive Summary: enterprise financial outlook and strategic initiatives', location: 'Page 1' },
      { id: 2, ordinal: 1, text: 'Operating expenses reduction across cloud infrastructure clusters', location: 'Page 2' },
      { id: 3, ordinal: 2, text: 'Strict cryptographic encryption at rest protocol implementation', location: 'Page 3' },
      { id: 4, ordinal: 3, text: 'Risk assessment regarding foreign exchange volatility and inflation', location: 'Page 4' },
      { id: 5, ordinal: 4, text: 'Appendix A: consolidated balance sheet and audited ledger entries', location: 'Page 5' },
    ]

    await store.replaceDocumentSliced(docPath, {
      hash: 'hash-audit-2026',
      mtimeMs: 1710000000,
      sizeBytes: 15420,
      status: 'text-only',
      embeddingModel: null,
      chunks,
    })

    // Confirm vector count is strictly 0
    const rawVectorCount = store.rawDb
      .prepare('SELECT count(*) AS total FROM chunk_embeddings WHERE space_id = ?')
      .get(F2_SPACE_ID) as { total: number }
    expect(rawVectorCount.total).toBe(0)

    const stats = store.stats(F2_SPACE_ID)
    expect(stats.chunks).toBe(5)
    expect(stats.vectors).toBe(0)
    expect(stats.semanticCoverage).toBe(0)

    const searchService = new SearchService({ store })

    // 1. Filename Exact & Partial Lexical Query
    const filenameHits = await searchService.searchProgressive('quarterly audit', 5, undefined, F2_SPACE_ID)
    expect(filenameHits.length).toBeGreaterThan(0)
    expect(filenameHits[0]!.name).toBe('quarterly-audit-2026.docx')
    expect(filenameHits[0]!.path).toBe(docPath)
    expect(filenameHits[0]!.stale).toBe(false)
    expect(filenameHits[0]!.missing).toBe(false)

    // 2. Full-Text Lexical Phrase Query matching chunk 3
    const phraseHits = await searchService.searchProgressive('cryptographic encryption', 5, undefined, F2_SPACE_ID)
    expect(phraseHits.length).toBeGreaterThan(0)
    const matchedChunk = phraseHits.find((h) => h.text.includes('cryptographic encryption'))
    expect(matchedChunk).toBeDefined()
    expect(matchedChunk!.location).toBe('Page 3')
    expect(typeof matchedChunk!.score).toBe('number')
    expect(Number.isFinite(matchedChunk!.score)).toBe(true)
    expect(matchedChunk!.score).not.toBe(0)

    // 3. Lexical query matching chunk 1
    const summaryHits = await searchService.searchProgressive('financial outlook', 5, undefined, F2_SPACE_ID)
    expect(summaryHits.length).toBeGreaterThan(0)
    expect(summaryHits.some((h) => h.text.includes('financial outlook'))).toBe(true)

    // 4. Verify searchProgressive does not throw or fail when askEmbed is undefined or returns null
    const noVectorHits = await searchService.searchProgressive('balance sheet ledger', 5, undefined, F2_SPACE_ID)
    expect(noVectorHits.length).toBeGreaterThan(0)
    expect(noVectorHits.some((h) => h.text.includes('balance sheet'))).toBe(true)
  })

  // =========================================================================
  // SOAK-02: Kiểm tra tính đơn điệu (monotonic) của completedChunks
  // =========================================================================
  it('SOAK-02: completedChunks is strictly monotonic non-decreasing throughout active space embedding', async () => {
    const docPath = join(tempDir, 'enterprise-knowledge-base.docx')
    writeFileSync(docPath, 'Enterprise knowledge base content', 'utf8')

    const TOTAL_CHUNKS = 60
    const chunks = Array.from({ length: TOTAL_CHUNKS }, (_, i) => ({
      id: i + 1,
      ordinal: i,
      text: `Knowledge base paragraph ${i + 1} detailing enterprise architecture and operational standards.`,
      location: `Section ${Math.floor(i / 10) + 1}, Paragraph ${(i % 10) + 1}`,
    }))

    await store.replaceDocumentSliced(docPath, {
      hash: 'hash-kb-60',
      mtimeMs: 1710000000,
      sizeBytes: 45000,
      status: 'text-only',
      embeddingModel: null,
      chunks,
    })

    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })

    // Define incremental batches of vectors
    const batches = [
      { offset: 0, count: 15 },
      { offset: 15, count: 15 },
      { offset: 30, count: 15 },
      { offset: 45, count: 15 }, // Completes all 60
    ]

    const observedDocCompleted: number[] = []
    const observedFolderCompleted: number[] = []
    const observedLibraryCompleted: number[] = []
    const observedCoverages: number[] = []

    // Baseline (0 completed)
    const initialProg = manager.getDocumentIndexProgress(docPath, F2_SPACE_ID)
    observedDocCompleted.push(initialProg.completedChunks)
    observedFolderCompleted.push(manager.getFolderIndexCounts(tempDir, F2_SPACE_ID).completedChunks)
    observedLibraryCompleted.push(manager.getLibraryIndexCounts(F2_SPACE_ID).completedChunks)
    observedCoverages.push(initialProg.percent)

    expect(initialProg.completedChunks).toBe(0)

    for (let b = 0; b < batches.length; b++) {
      const { offset, count } = batches[b]!
      const isComplete = offset + count >= TOTAL_CHUNKS
      const vectors = Array.from({ length: count }, (_, idx) => [
        (offset + idx) * 0.01,
        0.5,
        0.2,
        0.1,
      ])

      store.setChunkEmbeddings(docPath, 'hash-kb-60', offset, vectors, F2_SPACE_ID, isComplete)

      // Sample progress metrics
      const docProg = manager.getDocumentIndexProgress(docPath, F2_SPACE_ID)
      const folderCounts = manager.getFolderIndexCounts(tempDir, F2_SPACE_ID)
      const libCounts = manager.getLibraryIndexCounts(F2_SPACE_ID)

      observedDocCompleted.push(docProg.completedChunks)
      observedFolderCompleted.push(folderCounts.completedChunks)
      observedLibraryCompleted.push(libCounts.completedChunks)
      observedCoverages.push(docProg.percent)
    }

    // MONOTONIC AUDIT: Every step must be >= previous step
    for (let i = 1; i < observedDocCompleted.length; i++) {
      expect(observedDocCompleted[i]!).toBeGreaterThanOrEqual(observedDocCompleted[i - 1]!)
      expect(observedFolderCompleted[i]!).toBeGreaterThanOrEqual(observedFolderCompleted[i - 1]!)
      expect(observedLibraryCompleted[i]!).toBeGreaterThanOrEqual(observedLibraryCompleted[i - 1]!)
      expect(observedCoverages[i]!).toBeGreaterThanOrEqual(observedCoverages[i - 1]!)
    }

    // Final state checks
    expect(observedDocCompleted[observedDocCompleted.length - 1]).toBe(TOTAL_CHUNKS)
    expect(observedFolderCompleted[observedFolderCompleted.length - 1]).toBe(TOTAL_CHUNKS)
    expect(observedLibraryCompleted[observedLibraryCompleted.length - 1]).toBe(TOTAL_CHUNKS)
    expect(observedCoverages[observedCoverages.length - 1]).toBe(100)

    const finalFolder = store.folderChunkProgress(tempDir, F2_SPACE_ID)
    expect(finalFolder.semanticCoverage).toBe(1.0)
    expect(finalFolder.completedChunks).toBe(TOTAL_CHUNKS)
    expect(finalFolder.totalChunks).toBe(TOTAL_CHUNKS)
  })

  // =========================================================================
  // SOAK-03: Kiểm tra tỷ lệ phần trăm tiến trình không vượt quá 100%
  // =========================================================================
  it('SOAK-03: progress percentage and coverage never exceed 100% across multi-space & edge-cases', async () => {
    const docPath = join(tempDir, 'critical-spec.docx')
    writeFileSync(docPath, 'Critical specification document', 'utf8')

    const TOTAL_CHUNKS = 50
    const chunks = Array.from({ length: TOTAL_CHUNKS }, (_, i) => ({
      id: i + 1,
      ordinal: i,
      text: `Specification point ${i + 1} for high-reliability telemetry and active bounds validation.`,
      location: `Sec ${i + 1}`,
    }))

    await store.replaceDocumentSliced(docPath, {
      hash: 'hash-spec-50',
      mtimeMs: 1710000000,
      sizeBytes: 30000,
      status: 'text-only',
      embeddingModel: null,
      chunks,
    })

    const docId = store.documentByPath(docPath)!.id

    // Populate multiple spaces:
    // Space 1: F2 = 50 (100%)
    // Space 2: Qwen = 30 (60%)
    // Space 3: Custom = 45 (90%)
    // TOTAL VECTORS in table = 125 (for a 50 chunk document!)
    const customSpaceId = 'custom-space-dim4'
    store.rawDb
      .prepare(`
        INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
        VALUES (?, 'repo/custom', 'r1', 'mean', 4, 'q8')
      `)
      .run(customSpaceId)

    const insertCounts = store.rawDb.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (?, ?, ?)
    `)
    insertCounts.run(docId, F2_SPACE_ID, 50)
    insertCounts.run(docId, QWEN_SPACE_ID, 30)
    insertCounts.run(docId, customSpaceId, 45)

    const sumCheck = store.rawDb
      .prepare('SELECT sum(completed_chunks) AS total FROM document_embedding_counts WHERE document_id = ?')
      .get(docId) as { total: number }
    expect(sumCheck.total).toBe(125)

    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })

    // 1. Audit F2 Space Progress
    const f2Doc = manager.getDocumentIndexProgress(docPath, F2_SPACE_ID)
    expect(f2Doc.completedChunks).toBe(50)
    expect(f2Doc.totalChunks).toBe(50)
    expect(f2Doc.percent).toBeLessThanOrEqual(100)
    expect(f2Doc.percent).toBe(100)

    const f2Folder = manager.getFolderIndexCounts(tempDir, F2_SPACE_ID)
    expect(f2Folder.completedChunks).toBe(50)
    expect(f2Folder.semanticCoverage).toBeLessThanOrEqual(1.0)
    expect(f2Folder.semanticCoverage).toBe(1.0)

    // 2. Audit Qwen Space Progress
    const qwenDoc = manager.getDocumentIndexProgress(docPath, QWEN_SPACE_ID)
    expect(qwenDoc.completedChunks).toBe(30)
    expect(qwenDoc.totalChunks).toBe(50)
    expect(qwenDoc.percent).toBeLessThanOrEqual(100)
    expect(qwenDoc.percent).toBe(60)

    const qwenFolder = manager.getFolderIndexCounts(tempDir, QWEN_SPACE_ID)
    expect(qwenFolder.completedChunks).toBe(30)
    expect(qwenFolder.semanticCoverage).toBeLessThanOrEqual(1.0)
    expect(qwenFolder.semanticCoverage).toBeCloseTo(0.6, 4)

    // 3. Audit Custom Space Progress
    const customDoc = manager.getDocumentIndexProgress(docPath, customSpaceId)
    expect(customDoc.completedChunks).toBe(45)
    expect(customDoc.totalChunks).toBe(50)
    expect(customDoc.percent).toBeLessThanOrEqual(100)
    expect(customDoc.percent).toBe(90)

    const customFolder = manager.getFolderIndexCounts(tempDir, customSpaceId)
    expect(customFolder.completedChunks).toBe(45)
    expect(customFolder.semanticCoverage).toBeLessThanOrEqual(1.0)
    expect(customFolder.semanticCoverage).toBeCloseTo(0.9, 4)

    // 4. Edge case: Malicious / corrupted count overflow (raw DB = 9999)
    insertCounts.run(docId, F2_SPACE_ID, 9999)
    const clampedProg = store.chunkProgress(docPath, F2_SPACE_ID)
    expect(clampedProg.completedChunks).toBe(50) // Clamped to totalChunks
    expect(clampedProg.completedChunks).toBeLessThanOrEqual(clampedProg.totalChunks)

    const clampedFolder = store.folderChunkProgress(tempDir, F2_SPACE_ID)
    expect(clampedFolder.completedChunks).toBe(50)
    expect(clampedFolder.semanticCoverage).toBe(1.0)
    expect(clampedFolder.semanticCoverage!).toBeLessThanOrEqual(1.0)

    // 5. Edge case: Zero chunks empty document
    const emptyDocPath = join(tempDir, 'empty.txt')
    writeFileSync(emptyDocPath, '', 'utf8')
    await store.replaceDocumentSliced(emptyDocPath, {
      hash: 'hash-empty',
      mtimeMs: 1710000000,
      sizeBytes: 0,
      status: 'empty',
      embeddingModel: null,
      chunks: [],
    })
    const emptyProg = store.chunkProgress(emptyDocPath, F2_SPACE_ID)
    expect(emptyProg.totalChunks).toBe(0)
    expect(emptyProg.completedChunks).toBe(0)
  })

  // =========================================================================
  // SOAK-04: Đóng băng counters khi pause và tiếp tục khi resume
  // =========================================================================
  it('SOAK-04: counters freeze strictly when indexing is paused and resume on unpause', async () => {
    const file1 = join(tempDir, 'soak-doc-1.txt')
    const file2 = join(tempDir, 'soak-doc-2.txt')
    writeFileSync(file1, 'Alpha content '.repeat(40), 'utf8')
    writeFileSync(file2, 'Beta content '.repeat(40), 'utf8')

    let pauseTriggered = false
    class ControlledWorker extends EventEmitter {
      extractions: string[] = []
      embeddings: string[][] = []

      postMessage(message: { id: number; type: string; path?: string; texts?: string[] }) {
        setTimeout(() => {
          if (message.type === 'extract') {
            this.extractions.push(message.path!)
            // Trigger pause right after first extraction completes
            if (this.extractions.length === 1 && !pauseTriggered) {
              pauseTriggered = true
              publishIndexingPolicy(pausedPolicy)
            }
            const bytes = readFileSync(message.path!)
            const st = statSync(message.path!)
            this.emit('message', {
              id: message.id,
              result: {
                hash: createHash('sha256').update(bytes).digest('hex'),
                mtimeMs: st.mtimeMs,
                sizeBytes: st.size,
                chunks: chunkDocumentText(bytes.toString('utf8')),
                status: 'text-only',
              },
            })
          } else if (message.type === 'embed') {
            this.embeddings.push(message.texts ?? [])
            this.emit('message', { type: 'model', state: 'ready' })
            this.emit('message', {
              id: message.id,
              result: (message.texts ?? []).map(() => [0.1, 0.2, 0.3, 0.4]),
            })
          }
        }, 30)
      }

      terminate() {
        return Promise.resolve(0)
      }
    }

    const fakeWorker = new ControlledWorker()
    manager = new DocumentMemoryManager(tempDir, {
      pollIntervalMs: 60_000,
      workerFactory: () => fakeWorker as unknown as Worker,
    })

    publishIndexingPolicy(runningPolicy)
    manager.indexDiscoveredFile(file1)
    manager.indexDiscoveredFile(file2)

    // Wait until pause has taken effect
    await until(() => isIndexingPaused() && fakeWorker.extractions.length === 1, 4000)

    // Allow any in-flight ticks to settle
    await sleep(250)

    // AUDIT 1: Verify Freeze State
    expect(isIndexingPaused()).toBe(true)
    const frozenStatus = manager.status()
    const frozenNow = manager.nowStatus()
    expect(frozenNow.paused).toBe(true)

    // Sample counters multiple times during pause to prove they are FROZEN
    const frozenVectors = frozenStatus.vectors
    const frozenExtractionsCount = fakeWorker.extractions.length
    const frozenEmbeddingsCount = fakeWorker.embeddings.length

    await sleep(200)

    const sampledStatus = manager.status()
    expect(sampledStatus.vectors).toBe(frozenVectors)
    expect(fakeWorker.extractions.length).toBe(frozenExtractionsCount)
    expect(fakeWorker.embeddings.length).toBe(frozenEmbeddingsCount)

    // AUDIT 2: Resume Indexing
    publishIndexingPolicy(runningPolicy)
    expect(isIndexingPaused()).toBe(false)

    // Wait until both files are fully extracted and embedded
    await until(() => manager!.status().vectors >= 2 && manager!.status().pending === 0, 8000)

    expect(fakeWorker.extractions).toEqual([file1, file2])
    expect(fakeWorker.embeddings.length).toBeGreaterThanOrEqual(1)
    expect(manager.status().vectors).toBe(2)
    expect(manager.status().errors).toBe(0)
  })

  // =========================================================================
  // SOAK-05: Khả năng chịu lỗi (fault injection / process kill mid-embedding)
  // =========================================================================
  it('SOAK-05: fault injection / process crash recovery produces zero duplicates and zero corruption', async () => {
    const docPath = join(tempDir, 'mission-critical-archive.docx')
    writeFileSync(docPath, 'Mission critical archive payload', 'utf8')

    const TOTAL_CHUNKS = 80
    const chunks = Array.from({ length: TOTAL_CHUNKS }, (_, i) => ({
      id: 200 + i,
      ordinal: i,
      text: `Critical passage ${i + 1} testing atomic transaction rollback and resumption safety.`,
      location: `Chapter ${Math.floor(i / 10) + 1}`,
    }))

    await store.replaceDocumentSliced(docPath, {
      hash: 'hash-archive-80',
      mtimeMs: 1710000000,
      sizeBytes: 85000,
      status: 'text-only',
      embeddingModel: null,
      chunks,
    })

    // Batch 1: Write first 30 chunks successfully
    const batch1Vectors = Array.from({ length: 30 }, (_, idx) => [0.1 * idx, 0.2, 0.3, 0.4])
    store.setChunkEmbeddings(docPath, 'hash-archive-80', 0, batch1Vectors, F2_SPACE_ID, false)

    // Verify initial state: 30 completed
    expect(store.chunkProgress(docPath, F2_SPACE_ID).completedChunks).toBe(30)
    expect(store.resumeVectorOffset(docPath, 'hash-archive-80', F2_SPACE_ID)).toBe(30)

    // SIMULATE FAULT INJECTION / SUDDEN WORKER CRASH MID-BATCH:
    // Attempt an invalid batch with NaN values or interrupted transaction
    expect(() => {
      const corruptVectors = Array.from({ length: 20 }, () => [0.1, Number.NaN, 0.3, 0.4])
      store.setChunkEmbeddings(docPath, 'hash-archive-80', 30, corruptVectors, F2_SPACE_ID, false)
    }).toThrow()

    // SIMULATE SUDDEN PROCESS KILL / UNCOMMITTED TRANSACTION INTERRUPT:
    // Start an explicit transaction, insert partial rows, then ROLLBACK to simulate crash recovery
    const actualChunkIds = store.rawDb
      .prepare('SELECT id FROM chunks WHERE document_id = (SELECT id FROM documents WHERE path = ?) ORDER BY ordinal ASC')
      .all(docPath) as Array<{ id: number }>

    store.rawDb.exec('BEGIN IMMEDIATE')
    const partialInsert = store.rawDb.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (?, ?, ?, 4)
    `)
    // Write fake uncommitted chunks 30..35 using actual foreign keys
    for (let c = 30; c < 35; c++) {
      partialInsert.run(actualChunkIds[c]!.id, F2_SPACE_ID, floatBlob([0.9, 0.9, 0.9, 0.9]))
    }
    // KILL: Rollback transaction (as happens when SQLite recovers from aborted process)
    store.rawDb.exec('ROLLBACK')

    // Close and simulate process reboot: reopen store from disk
    store.close()
    const recoveredStore = new DocumentMemoryStore(dbPath)
    recoveredStore.ensureEmbeddingSpace(testProfileF2)

    // 1. AUDIT: SQLite Database Integrity Check
    const pragmaIntegrity = recoveredStore.rawDb
      .prepare('PRAGMA integrity_check')
      .get() as { integrity_check: string }
    expect(pragmaIntegrity.integrity_check).toBe('ok')

    // 2. AUDIT: Zero duplicate vectors in chunk_embeddings
    const duplicateRows = recoveredStore.rawDb
      .prepare(`
        SELECT chunk_id, space_id, count(*) AS count
        FROM chunk_embeddings
        GROUP BY chunk_id, space_id
        HAVING count > 1
      `)
      .all()
    expect(duplicateRows).toHaveLength(0)

    // 3. AUDIT: Zero corrupted embeddings (dimension, byteLength, float32 finite validity)
    const allEmbeddings = recoveredStore.rawDb
      .prepare('SELECT chunk_id, vector, vector_dim FROM chunk_embeddings WHERE space_id = ?')
      .all(F2_SPACE_ID) as Array<{ chunk_id: number; vector: Uint8Array; vector_dim: number }>

    expect(allEmbeddings).toHaveLength(30)
    for (const row of allEmbeddings) {
      expect(row.vector_dim).toBe(4)
      expect(row.vector.byteLength).toBe(4 * 4) // 4 dimensions * 4 bytes
      const floats = blobVector(row.vector, row.vector_dim)
      expect(floats.length).toBe(4)
      for (let i = 0; i < floats.length; i++) {
        expect(Number.isFinite(floats[i])).toBe(true)
      }
    }

    // 4. AUDIT: Document counts table consistency
    const countRow = recoveredStore.rawDb
      .prepare(`
        SELECT completed_chunks FROM document_embedding_counts
        WHERE space_id = ? AND document_id = (SELECT id FROM documents WHERE path = ?)
      `)
      .get(F2_SPACE_ID, docPath) as { completed_chunks: number }
    expect(countRow.completed_chunks).toBe(30)

    // 5. AUDIT: Resumption offset starts at exact recovery point (30)
    const resumeOffset = recoveredStore.resumeVectorOffset(docPath, 'hash-archive-80', F2_SPACE_ID)
    expect(resumeOffset).toBe(30)

    // 6. RESUME EMBEDDING: Complete remaining 50 chunks (offset 30..79)
    const remainingVectors = Array.from({ length: 50 }, (_, idx) => [
      0.05 * (idx + 30),
      0.3,
      0.2,
      0.1,
    ])
    recoveredStore.setChunkEmbeddings(docPath, 'hash-archive-80', 30, remainingVectors, F2_SPACE_ID, true)

    // Final Post-Resume Audit
    const finalProg = recoveredStore.chunkProgress(docPath, F2_SPACE_ID)
    expect(finalProg.completedChunks).toBe(TOTAL_CHUNKS)
    expect(finalProg.totalChunks).toBe(TOTAL_CHUNKS)

    const finalDuplicates = recoveredStore.rawDb
      .prepare(`
        SELECT chunk_id, space_id, count(*) AS count
        FROM chunk_embeddings
        GROUP BY chunk_id, space_id
        HAVING count > 1
      `)
      .all()
    expect(finalDuplicates).toHaveLength(0)

    recoveredStore.close()
    // Reassign store so afterEach closes without error
    store = new DocumentMemoryStore(dbPath)
  })

  // =========================================================================
  // SOAK-06: Thẩm định tải tổng thể và chuyển đổi profile động dưới áp lực
  // =========================================================================
  it('SOAK-06: concurrent search and profile toggle maintain semantic invariants under load', async () => {
    const docPath = join(tempDir, 'stress-concurrent-doc.docx')
    writeFileSync(docPath, 'Stress concurrent payload', 'utf8')

    const CHUNK_COUNT = 40
    const chunks = Array.from({ length: CHUNK_COUNT }, (_, i) => ({
      id: 300 + i,
      ordinal: i,
      text: `Stress test chunk content ${i + 1} with distinct semantic token markers.`,
      location: `Sec ${i + 1}`,
    }))

    await store.replaceDocumentSliced(docPath, {
      hash: 'hash-stress-40',
      mtimeMs: 1710000000,
      sizeBytes: 24000,
      status: 'text-only',
      embeddingModel: null,
      chunks,
    })

    // Write all 40 chunks for F2
    const f2Vectors = Array.from({ length: CHUNK_COUNT }, () => [0.2, 0.4, 0.6, 0.8])
    store.setChunkEmbeddings(docPath, 'hash-stress-40', 0, f2Vectors, F2_SPACE_ID, true)

    // Write 20 chunks for Qwen
    const qwenVectors = Array.from({ length: 20 }, () => [0.1, 0.3, 0.5, 0.7])
    store.setChunkEmbeddings(docPath, 'hash-stress-40', 0, qwenVectors, QWEN_SPACE_ID, false)

    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })

    // Search while in F2 profile
    const hitsF2 = await manager.searchProgressive('semantic token markers', 5)
    expect(hitsF2.length).toBeGreaterThan(0)

    const libF2 = manager.getLibraryIndexCounts()
    expect(libF2.completedChunks).toBe(40)
    expect(libF2.semanticCoverage).toBe(1.0)

    // Dynamically toggle profile to High (Qwen)
    manager.setEmbeddingProfile('high')
    expect(manager.embeddingSettings().profile).toBe('high')

    // Library counts must immediately and truthfully reflect Qwen without re-indexing
    const libQwen = manager.getLibraryIndexCounts()
    expect(libQwen.completedChunks).toBe(20)
    expect(libQwen.totalChunks).toBe(40)
    expect(libQwen.semanticCoverage).toBeCloseTo(0.5, 4)

    // Search under Qwen profile succeeds without error
    const hitsQwen = await manager.searchProgressive('Stress test', 5)
    expect(hitsQwen.length).toBeGreaterThan(0)
  })
})
