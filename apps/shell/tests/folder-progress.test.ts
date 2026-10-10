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

describe('Folder & Library Index Progress Scoped to Active Space Suite (QA-10)', () => {
  let tempDir: string
  let dbPath: string
  let activeManagers: DocumentMemoryManager[] = []
  let activeStores: DocumentMemoryStore[] = []

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-folder-prog-'))
    dbPath = join(tempDir, 'document-memory.db')
    activeManagers = []
    activeStores = []
  })

  afterEach(async () => {
    for (const m of activeManagers) {
      try {
        await m.closeAsync()
      } catch {}
    }
    for (const s of activeStores) {
      try {
        s.close()
      } catch {}
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('FOLDPROG-01: Empty folder returns 0 files and 1.0 semantic coverage', () => {
    const store = new DocumentMemoryStore(dbPath)
    activeStores.push(store)

    const folderProgress = store.folderChunkProgress(join(tempDir, 'empty-folder'), 'space-a')
    expect(folderProgress.totalFiles).toBe(0)
    expect(folderProgress.completedChunks).toBe(0)
    expect(folderProgress.totalChunks).toBe(0)
    expect(folderProgress.semanticCoverage).toBe(1.0)
    expect(folderProgress.activeEmbeddingSpace).toBe('space-a')
  })

  it('FOLDPROG-02: Folder counts scope completed chunks exclusively to active space without cross-contamination', () => {
    const store = new DocumentMemoryStore(dbPath)
    activeStores.push(store)

    const docsFolder = join(tempDir, 'docs')
    const doc1Path = join(docsFolder, 'report.docx')
    const doc2Path = join(docsFolder, 'analysis.pdf')

    // Insert doc 1: 3 chunks, embedded in space-a
    store.replaceDocument(doc1Path, {
      hash: 'hash-1',
      mtimeMs: 1000,
      sizeBytes: 1000,
      status: 'ready',
      chunks: [
        { text: 'chunk 1', location: 'p1' },
        { text: 'chunk 2', location: 'p2' },
        { text: 'chunk 3', location: 'p3' },
      ],
    })
    const doc1 = store.documentByPath(doc1Path)!
    store.rawDb
      .prepare(
        "INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization) VALUES ('space-a', 'r', '1', 'mean', 384, 'fp32'), ('space-b', 'r', '1', 'mean', 384, 'fp32'), ('space-c', 'r', '1', 'mean', 384, 'fp32')",
      )
      .run()
    store.rawDb
      .prepare(
        'INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, ?)',
      )
      .run(doc1.id, 'space-a', 3)

    // Insert doc 2: 2 chunks, embedded in space-b
    store.replaceDocument(doc2Path, {
      hash: 'hash-2',
      mtimeMs: 2000,
      sizeBytes: 2000,
      status: 'ready',
      chunks: [
        { text: 'part 1', location: 'p1' },
        { text: 'part 2', location: 'p2' },
      ],
    })
    const doc2 = store.documentByPath(doc2Path)!
    store.rawDb
      .prepare(
        'INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, ?)',
      )
      .run(doc2.id, 'space-b', 2)

    // Scope to space-a: only doc 1 is completed (3/5 chunks)
    const progA = store.folderChunkProgress(docsFolder, 'space-a')
    expect(progA.totalFiles).toBe(2)
    expect(progA.totalChunks).toBe(5)
    expect(progA.completedChunks).toBe(3)
    expect(progA.semanticCoverage).toBeCloseTo(0.6, 2)
    expect(progA.activeEmbeddingSpace).toBe('space-a')

    // Scope to space-b: only doc 2 is completed (2/5 chunks)
    const progB = store.folderChunkProgress(docsFolder, 'space-b')
    expect(progB.totalFiles).toBe(2)
    expect(progB.totalChunks).toBe(5)
    expect(progB.completedChunks).toBe(2)
    expect(progB.semanticCoverage).toBeCloseTo(0.4, 2)
    expect(progB.activeEmbeddingSpace).toBe('space-b')

    // Scope to unknown space-c: 0/5 chunks completed
    const progC = store.folderChunkProgress(docsFolder, 'space-c')
    expect(progC.totalChunks).toBe(5)
    expect(progC.completedChunks).toBe(0)
    expect(progC.semanticCoverage).toBe(0.0)
  })

  it('FOLDPROG-03: Library index counts aggregate documents across folders scoped to active space', () => {
    const store = new DocumentMemoryStore(dbPath)
    activeStores.push(store)

    const folder1 = join(tempDir, 'folder1')
    const folder2 = join(tempDir, 'folder2')

    store.rawDb
      .prepare(
        "INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization) VALUES ('target-space', 'r', '1', 'mean', 384, 'fp32'), ('other-space', 'r', '1', 'mean', 384, 'fp32')",
      )
      .run()

    store.replaceDocument(join(folder1, 'f1.txt'), {
      hash: 'h1',
      mtimeMs: 100,
      sizeBytes: 100,
      status: 'ready',
      chunks: [{ text: 'f1 chunk', location: 'p1' }],
    })
    const d1 = store.documentByPath(join(folder1, 'f1.txt'))!
    store.rawDb
      .prepare(
        'INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, ?)',
      )
      .run(d1.id, 'target-space', 1)

    store.replaceDocument(join(folder2, 'f2.txt'), {
      hash: 'h2',
      mtimeMs: 200,
      sizeBytes: 200,
      status: 'ready',
      chunks: [{ text: 'f2 chunk', location: 'p1' }],
    })
    const d2 = store.documentByPath(join(folder2, 'f2.txt'))!
    store.rawDb
      .prepare(
        'INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, ?)',
      )
      .run(d2.id, 'other-space', 1)

    const libProg = store.folderChunkProgress(undefined, 'target-space')
    expect(libProg.totalFiles).toBe(2)
    expect(libProg.totalChunks).toBe(2)
    expect(libProg.completedChunks).toBe(1)
    expect(libProg.semanticCoverage).toBeCloseTo(0.5, 2)
  })

  it('FOLDPROG-04: Manager getFolderIndexCounts and getLibraryIndexCounts default to active embedding profile', () => {
    const docsFolder = join(tempDir, 'my-docs')
    const filePath = join(docsFolder, 'note.txt')

    // A disabled manager correctly refuses metadata writes through its guarded store,
    // so seed the shared database through a plain store before the manager opens it.
    const seedStore = new DocumentMemoryStore(dbPath)
    try {
      seedStore.replaceDocument(filePath, {
        hash: 'hn',
        mtimeMs: 500,
        sizeBytes: 500,
        status: 'ready',
        chunks: [{ text: 'chunk note', location: 'p1' }],
      })
    } finally {
      seedStore.close()
    }

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    const counts = manager.getFolderIndexCounts(docsFolder)
    expect(counts.totalFiles).toBe(1)
    expect(counts.totalChunks).toBe(1)
    expect(counts.activeEmbeddingSpace).toBeDefined()

    const libCounts = manager.getLibraryIndexCounts()
    expect(libCounts.totalFiles).toBe(1)
    expect(libCounts.totalChunks).toBe(1)
    expect(libCounts.activeEmbeddingSpace).toBeDefined()
  })

  it('FOLDPROG-05: Truncated files count is aggregated truthfully in progress', () => {
    const store = new DocumentMemoryStore(dbPath)
    activeStores.push(store)

    const folder = join(tempDir, 'trunc-folder')
    store.replaceDocument(join(folder, 'trunc.txt'), {
      hash: 'ht',
      mtimeMs: 100,
      sizeBytes: 1000,
      status: 'ready',
      truncated: true,
      truncatedReason: 'chunk-limit',
      chunks: [{ text: 'truncated chunk', location: 'p1' }],
    })

    const prog = store.folderChunkProgress(folder, 'space-x')
    expect(prog.truncatedFiles).toBe(1)
  })
})
