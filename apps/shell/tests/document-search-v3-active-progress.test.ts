import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import {
  getDocumentIndexSnapshot,
  snapshotCache,
  diagnosticsCache,
} from '../src/main/fork/document-index-snapshot-service'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import type { FolderChunkProgress } from '../src/main/document-memory/store'

const F2_SPACE_ID = EMBEDDING_PROFILES.standard.embeddingId
const QWEN_SPACE_ID = EMBEDDING_PROFILES.high.embeddingId

describe('Active-Space Progress Invariants Suite (QA-08)', () => {
  let tempDir: string
  let dbPath: string
  let store: DocumentMemoryStore
  let manager: DocumentMemoryManager | null = null
  let issueReader: IndexIssueReader | null = null

  // Fixture paths
  let docsDir: string
  let docPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-active-progress-'))
    dbPath = join(tempDir, 'document-memory.db')
    docsDir = join(tempDir, 'documents')
    docPath = join(docsDir, 'enterprise-plan.docx')

    store = new DocumentMemoryStore(dbPath)

    // Register embedding spaces in schema
    store.rawDb
      .prepare(`
        INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
        VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
      `)
      .run(
        F2_SPACE_ID,
        EMBEDDING_PROFILES.standard.repo,
        EMBEDDING_PROFILES.standard.revision,
        EMBEDDING_PROFILES.standard.pooling,
        EMBEDDING_PROFILES.standard.dimensions,
        'q8',
        QWEN_SPACE_ID,
        EMBEDDING_PROFILES.high.repo,
        EMBEDDING_PROFILES.high.revision,
        EMBEDDING_PROFILES.high.pooling,
        EMBEDDING_PROFILES.high.dimensions,
        'q8',
      )

    // Fixture: 100 chunks in enterprise-plan.docx
    const chunks = Array.from({ length: 100 }, (_, idx) => ({
      text: `Passage content ${idx + 1} for enterprise strategy and active progress metrics`,
      location: `Section ${(idx % 10) + 1}, Page ${Math.floor(idx / 5) + 1}`,
    }))

    store.replaceDocument(docPath, {
      hash: 'hash-enterprise-plan-100',
      mtimeMs: 1700000000,
      sizeBytes: 25000,
      status: 'text-only',
      embeddingModel: null,
      chunks,
    })

    const doc = store.documentByPath(docPath)
    expect(doc).not.toBeNull()
    const docId = doc!.id

    // Fixture progress state:
    // F2 completed = 100 chunks
    // Qwen completed = 40 chunks
    const insertCount = store.rawDb.prepare(`
      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (?, ?, ?)
    `)
    insertCount.run(docId, F2_SPACE_ID, 100)
    insertCount.run(docId, QWEN_SPACE_ID, 40)
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
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('PROG-01 document: scopes document chunk progress accurately (F2: 100/100, Qwen: 40/100)', () => {
    // 1. Direct store.chunkProgress scoped to F2 space
    const f2Progress = store.chunkProgress(docPath, F2_SPACE_ID)
    expect(f2Progress.totalChunks).toBe(100)
    expect(f2Progress.completedChunks).toBe(100)

    // 2. Direct store.chunkProgress scoped to Qwen space
    const qwenProgress = store.chunkProgress(docPath, QWEN_SPACE_ID)
    expect(qwenProgress.totalChunks).toBe(100)
    expect(qwenProgress.completedChunks).toBe(40)

    // 3. Document index progress through Manager
    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })

    const f2DocProgress = manager.getDocumentIndexProgress(docPath, F2_SPACE_ID)
    expect(f2DocProgress.totalChunks).toBe(100)
    expect(f2DocProgress.completedChunks).toBe(100)
    expect(f2DocProgress.percent).toBe(100)

    const qwenDocProgress = manager.getDocumentIndexProgress(docPath, QWEN_SPACE_ID)
    expect(qwenDocProgress.totalChunks).toBe(100)
    expect(qwenDocProgress.completedChunks).toBe(40)
    expect(qwenDocProgress.percent).toBe(40)
  })

  it('PROG-02 folder: scopes folder chunk progress and coverage to active space (F2: 100/100, Qwen: 40/100)', () => {
    // 1. Folder scoped to F2
    const f2Folder = store.folderChunkProgress(docsDir, F2_SPACE_ID)
    expect(f2Folder.totalFiles).toBe(1)
    expect(f2Folder.totalChunks).toBe(100)
    expect(f2Folder.completedChunks).toBe(100)
    expect(f2Folder.semanticCoverage).toBe(1.0)
    expect(f2Folder.activeEmbeddingSpace).toBe(F2_SPACE_ID)

    // 2. Folder scoped to Qwen
    const qwenFolder = store.folderChunkProgress(docsDir, QWEN_SPACE_ID)
    expect(qwenFolder.totalFiles).toBe(1)
    expect(qwenFolder.totalChunks).toBe(100)
    expect(qwenFolder.completedChunks).toBe(40)
    expect(qwenFolder.semanticCoverage).toBeCloseTo(0.4, 4)
    expect(qwenFolder.activeEmbeddingSpace).toBe(QWEN_SPACE_ID)

    // 3. Folder counts through Manager
    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })
    const managerF2Folder = manager.getFolderIndexCounts(docsDir, F2_SPACE_ID)
    expect(managerF2Folder.completedChunks).toBe(100)
    expect(managerF2Folder.totalChunks).toBe(100)

    const managerQwenFolder = manager.getFolderIndexCounts(docsDir, QWEN_SPACE_ID)
    expect(managerQwenFolder.completedChunks).toBe(40)
    expect(managerQwenFolder.totalChunks).toBe(100)
  })

  it('PROG-03 library: aggregates library-wide progress scoped to active space (F2: 100/100, Qwen: 40/100)', () => {
    // 1. Store library progress (root = undefined)
    const f2Library = store.folderChunkProgress(undefined, F2_SPACE_ID)
    expect(f2Library.totalFiles).toBe(1)
    expect(f2Library.totalChunks).toBe(100)
    expect(f2Library.completedChunks).toBe(100)
    expect(f2Library.semanticCoverage).toBe(1.0)

    const qwenLibrary = store.folderChunkProgress(undefined, QWEN_SPACE_ID)
    expect(qwenLibrary.totalFiles).toBe(1)
    expect(qwenLibrary.totalChunks).toBe(100)
    expect(qwenLibrary.completedChunks).toBe(40)
    expect(qwenLibrary.semanticCoverage).toBeCloseTo(0.4, 4)

    // 2. Manager library counts
    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })
    const managerF2Lib = manager.getLibraryIndexCounts(F2_SPACE_ID)
    expect(managerF2Lib.completedChunks).toBe(100)
    expect(managerF2Lib.totalChunks).toBe(100)
    expect(managerF2Lib.semanticCoverage).toBe(1.0)

    const managerQwenLib = manager.getLibraryIndexCounts(QWEN_SPACE_ID)
    expect(managerQwenLib.completedChunks).toBe(40)
    expect(managerQwenLib.totalChunks).toBe(100)
    expect(managerQwenLib.semanticCoverage).toBeCloseTo(0.4, 4)
  })

  it('PROG-04 switching profile updates result: dynamic profile change toggles between 100/100 and 40/100', () => {
    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })

    // Initially standard (F2LLM-v2-80M)
    expect(manager.embeddingSettings().profile).toBe('standard')
    const initialLib = manager.getLibraryIndexCounts()
    expect(initialLib.completedChunks).toBe(100)
    expect(initialLib.totalChunks).toBe(100)
    expect(initialLib.activeEmbeddingSpace).toBe(F2_SPACE_ID)

    const initialDoc = manager.getDocumentIndexProgress(docPath)
    expect(initialDoc.completedChunks).toBe(100)
    expect(initialDoc.totalChunks).toBe(100)
    expect(initialDoc.percent).toBe(100)

    // Switch profile to high (Qwen3-Embedding-0.6B)
    const switchResult = manager.setEmbeddingProfile('high')
    expect(switchResult.changed).toBe(true)
    expect(manager.embeddingSettings().profile).toBe('high')

    // After switch: defaults must automatically query Qwen
    const switchedLib = manager.getLibraryIndexCounts()
    expect(switchedLib.completedChunks).toBe(40)
    expect(switchedLib.totalChunks).toBe(100)
    expect(switchedLib.activeEmbeddingSpace).toBe(QWEN_SPACE_ID)
    expect(switchedLib.semanticCoverage).toBeCloseTo(0.4, 4)

    const switchedDoc = manager.getDocumentIndexProgress(docPath)
    expect(switchedDoc.completedChunks).toBe(40)
    expect(switchedDoc.totalChunks).toBe(100)
    expect(switchedDoc.percent).toBe(40)

    // Switch back to standard (F2LLM-v2-80M)
    manager.setEmbeddingProfile('standard')
    const restoredLib = manager.getLibraryIndexCounts()
    expect(restoredLib.completedChunks).toBe(100)
    expect(restoredLib.totalChunks).toBe(100)
    expect(restoredLib.activeEmbeddingSpace).toBe(F2_SPACE_ID)

    const restoredDoc = manager.getDocumentIndexProgress(docPath)
    expect(restoredDoc.completedChunks).toBe(100)
    expect(restoredDoc.totalChunks).toBe(100)
    expect(restoredDoc.percent).toBe(100)
  })

  it('PROG-05 snapshot uses active profile: telemetry snapshot truthfully reflects active embedding profile', () => {
    snapshotCache.clear()
    diagnosticsCache.clear()

    manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })
    issueReader = new IndexIssueReader(dbPath)

    let cachedCounts: FolderChunkProgress | null = null
    const folderCounts = {
      get: (_root: string, fetcher: () => FolderChunkProgress) => {
        if (!cachedCounts) cachedCounts = fetcher()
        return cachedCounts
      },
      invalidate: () => {
        cachedCounts = null
      },
    }

    const snapshotCtx = {
      getDocumentMemory: () => manager,
      getFolderScan: () => null,
      getIssueReader: () => issueReader!,
      getFolderCounts: () => folderCounts,
      dbPath: () => dbPath,
    }

    // 1. Snapshot with default F2 active profile
    snapshotCache.clear()
    folderCounts.invalidate()
    const snapF2 = getDocumentIndexSnapshot(snapshotCtx, true)
    expect(snapF2.activity.folderProgress).not.toBeNull()
    expect(snapF2.activity.folderProgress?.completedChunks).toBe(100)
    expect(snapF2.activity.folderProgress?.totalChunks).toBe(100)
    expect(snapF2.activity.folderProgress?.percent).toBe(99)

    // 2. Switch profile to high (Qwen)
    manager.setEmbeddingProfile('high')
    snapshotCache.clear()
    folderCounts.invalidate()

    const snapQwen = getDocumentIndexSnapshot(snapshotCtx, true)
    expect(snapQwen.activity.folderProgress).not.toBeNull()
    expect(snapQwen.activity.folderProgress?.completedChunks).toBe(40)
    expect(snapQwen.activity.folderProgress?.totalChunks).toBe(100)
    expect(snapQwen.activity.folderProgress?.percent).toBe(40)

    // 3. Manager activity telemetry
    const actStatus = manager.indexingActivityStatus()
    expect(actStatus.activeEmbeddingSpace).toBe(QWEN_SPACE_ID)
    expect(actStatus.semanticCoverage).toBeCloseTo(0.4, 4)
  })

  it('PROG-06 never >100%: active-space isolation prevents cumulative sum overflow across spaces', () => {
    // In our fixture: F2 = 100, Qwen = 40.
    // Sum across all spaces in document_embedding_counts table is 140!
    const totalStoredRows = store.rawDb
      .prepare('SELECT sum(completed_chunks) AS total FROM document_embedding_counts WHERE document_id = (SELECT id FROM documents WHERE path = ?)')
      .get(docPath) as { total: number }
    expect(totalStoredRows.total).toBe(140)

    // 1. Check F2: must NEVER exceed 100%
    const f2Prog = store.chunkProgress(docPath, F2_SPACE_ID)
    expect(f2Prog.completedChunks).toBeLessThanOrEqual(f2Prog.totalChunks)
    expect(f2Prog.completedChunks).toBe(100)
    expect(f2Prog.completedChunks).not.toBe(140)

    const f2Folder = store.folderChunkProgress(docsDir, F2_SPACE_ID)
    expect(f2Folder.completedChunks).toBeLessThanOrEqual(f2Folder.totalChunks)
    expect(f2Folder.completedChunks).toBe(100)
    expect(f2Folder.semanticCoverage).toBeLessThanOrEqual(1.0)
    expect(f2Folder.semanticCoverage).toBe(1.0)

    // 2. Check Qwen: must NEVER exceed 100%
    const qwenProg = store.chunkProgress(docPath, QWEN_SPACE_ID)
    expect(qwenProg.completedChunks).toBeLessThanOrEqual(qwenProg.totalChunks)
    expect(qwenProg.completedChunks).toBe(40)
    expect(qwenProg.completedChunks).not.toBe(140)

    const qwenFolder = store.folderChunkProgress(docsDir, QWEN_SPACE_ID)
    expect(qwenFolder.completedChunks).toBeLessThanOrEqual(qwenFolder.totalChunks)
    expect(qwenFolder.completedChunks).toBe(40)
    expect(qwenFolder.semanticCoverage).toBeLessThanOrEqual(1.0)

    // 3. Add a 3rd space with 80 completed chunks (Total = 100 + 40 + 80 = 220 vectors!)
    const thirdSpaceId = 'third-custom-space-320'
    store.rawDb
      .prepare(`
        INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
        VALUES (?, 'repo/custom', 'r1', 'mean', 320, 'q8')
      `)
      .run(thirdSpaceId)

    const docId = store.documentByPath(docPath)!.id
    store.rawDb
      .prepare('INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, ?)')
      .run(docId, thirdSpaceId, 80)

    const grandTotal = store.rawDb
      .prepare('SELECT sum(completed_chunks) AS total FROM document_embedding_counts WHERE document_id = ?')
      .get(docId) as { total: number }
    expect(grandTotal.total).toBe(220) // Total vectors in database is 220 for 100 chunks

    // Progress for each space must remain strictly <= 100% and bounded to [0, totalChunks]
    const checkF2 = store.folderChunkProgress(undefined, F2_SPACE_ID)
    expect(checkF2.completedChunks).toBe(100)
    expect(checkF2.semanticCoverage).toBe(1.0)
    expect(checkF2.semanticCoverage!).toBeLessThanOrEqual(1.0)

    const checkQwen = store.folderChunkProgress(undefined, QWEN_SPACE_ID)
    expect(checkQwen.completedChunks).toBe(40)
    expect(checkQwen.semanticCoverage).toBeCloseTo(0.4, 4)
    expect(checkQwen.semanticCoverage!).toBeLessThanOrEqual(1.0)

    const checkThird = store.folderChunkProgress(undefined, thirdSpaceId)
    expect(checkThird.completedChunks).toBe(80)
    expect(checkThird.semanticCoverage).toBeCloseTo(0.8, 4)
    expect(checkThird.semanticCoverage!).toBeLessThanOrEqual(1.0)

    // And unknown space returns 0, never NaN nor overflow
    const checkUnknown = store.folderChunkProgress(undefined, 'non-existent-space')
    expect(checkUnknown.completedChunks).toBe(0)
    expect(checkUnknown.semanticCoverage).toBe(0.0)
  })
})
