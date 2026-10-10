import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  getEventLoopMetrics,
  getSqliteTimingSummary,
} from '../src/main/document-memory/sqlite-timing'
import {
  getDocumentIndexSnapshot,
  IndexStatusCache,
  snapshotCache,
  diagnosticsCache,
} from '../src/main/fork/document-index-snapshot-service'
import { registerFolderAndModelHandlers } from '../src/main/fork/document-index-folder-handlers'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'

describe('Document Memory Snapshot & Consolidated Telemetry Suite (IT-4)', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-snapshot-'))
    dbPath = join(directory, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('computes storage diagnostics with page metrics and top offenders', () => {
    // Populate with 2 test documents
    store.replaceDocument(join(directory, 'file1.docx'), {
      hash: 'hash-f1',
      mtimeMs: 100,
      sizeBytes: 1000,
      chunks: [
        { text: 'Chunk 1 text', location: 'Chunk 1' },
        { text: 'Chunk 2 text', location: 'Chunk 2' },
      ],
      embeddingModel: null,
      status: 'text-only',
    })

    store.replaceDocument(join(directory, 'file2.docx'), {
      hash: 'hash-f2',
      mtimeMs: 200,
      sizeBytes: 2000,
      chunks: [
        { text: 'Another passage 1', location: 'Chunk 1' },
        { text: 'Another passage 2', location: 'Chunk 2' },
        { text: 'Another passage 3', location: 'Chunk 3' },
      ],
      embeddingModel: null,
      status: 'text-only',
      truncated: true,
      truncatedReason: 'chunk-limit',
    })

    const diagnostics = store.getStorageDiagnostics()

    expect(diagnostics.activeDbSizeBytes).toBeGreaterThan(0)
    expect(diagnostics.pageSize).toBeGreaterThanOrEqual(512)
    expect(diagnostics.pageCount).toBeGreaterThan(0)
    expect(diagnostics.freelistCount).toBeGreaterThanOrEqual(0)
    expect(diagnostics.schemaVersion).toBe('3')
    expect(diagnostics.migrationStatus).toBe('completed')

    // Top offenders
    expect(diagnostics.topOffendersByChunks.length).toBe(2)
    expect(diagnostics.topOffendersByChunks[0].chunks).toBe(3)
    expect(diagnostics.topOffendersByChunks[0].name).toBe('file2.docx')
    expect(diagnostics.topOffendersByChunks[0].truncated).toBe(true)

    expect(diagnostics.topOffendersBySize.length).toBe(2)
    expect(diagnostics.topOffendersBySize[0].name).toBe('file2.docx')
    expect(diagnostics.topOffendersBySize[0].sizeBytes).toBe(2000)

    // Fallback breakdown
    if (diagnostics.breakdown) {
      expect(diagnostics.breakdown.chunksBytes).toBeGreaterThan(0)
      expect(diagnostics.breakdown.documentsBytes).toBeGreaterThan(0)
      expect(diagnostics.breakdown.ftsBytes).toBeGreaterThan(0)
    }
  })

  it('provides event-loop and SQLite latency metrics in performance diagnostics', () => {
    const timing = getSqliteTimingSummary()
    expect(timing).toHaveProperty('totalOperations')
    expect(timing).toHaveProperty('slowOperations')
    expect(timing).toHaveProperty('criticalOperations')

    const eventLoop = getEventLoopMetrics()
    expect(eventLoop).toHaveProperty('p50')
    expect(eventLoop).toHaveProperty('p95')
    expect(eventLoop).toHaveProperty('p99')
    expect(eventLoop).toHaveProperty('max')
  })

  it('IndexStatusCache respects TTL and forceRefresh', () => {
    const cache = new IndexStatusCache<string>(100)
    expect(cache.get()).toBeNull()
    cache.set('initial')
    expect(cache.get()).toBe('initial')
    expect(cache.get(true)).toBeNull()
  })

  it('provides truthful snapshot without hardcoded mock values', () => {
    snapshotCache.clear()
    diagnosticsCache.clear()

    const issueReader = new IndexIssueReader(dbPath)
    const ctx = {
      getDocumentMemory: () => null,
      getFolderScan: () => null,
      getIssueReader: () => issueReader,
      getFolderCounts: () => ({
        get: () => ({
          completedChunks: 0,
          totalChunks: 0,
          totalFiles: 0,
          readyFiles: 0,
          pendingFiles: 0,
          errorFiles: 0,
          emptyFiles: 0,
        }),
      }),
      dbPath: () => dbPath,
    }

    const snap = getDocumentIndexSnapshot(ctx)
    // mode must not be null
    expect(snap.mode).not.toBeNull()
    expect(snap.mode?.mode).toBe('balanced')
    expect(snap.mode?.pauseOnBattery).toBe(true)

    // modelState must reflect memoryStatus ('not-loaded', not hardcoded 'ready')
    expect(snap.activity.memory.modelState).toBe('not-loaded')
    expect(snap.memory.modelState).toBe('not-loaded')

    // storage schemaVersion should not be hardcoded '3' when memory is null
    expect(snap.storage.schemaVersion).toBe('')

    issueReader.close()
  })

  it('loads, saves and returns truthful PDF pages state and contract', async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const fakeIpcMain = {
      handle: (ch: string, fn: (...args: any[]) => any) => handlers.set(ch, fn),
    }

    const pdfConfigFile = join(directory, 'document-memory-pdf.json')
    writeFileSync(pdfConfigFile, JSON.stringify({ maxPages: 55 }), 'utf8')

    registerFolderAndModelHandlers(
      {
        ipcMain: fakeIpcMain as any,
        getDocumentMemory: () => null,
        getFolderScan: () => null,
        dbPath: () => dbPath,
        settingsPath: () => join(directory, 'app-settings.json'),
      },
      () => {},
    )

    const getHandler = handlers.get(DOCUMENT_INDEX_CHANNELS.getPdfPages)!
    const setHandler = handlers.get(DOCUMENT_INDEX_CHANNELS.setPdfPages)!

    expect(getHandler).toBeDefined()
    expect(setHandler).toBeDefined()

    const initial = await getHandler()
    expect(initial.pages).toBe(55)
    expect(initial.default).toBe(30)
    expect(initial.max).toBe(400)

    const updated = await setHandler({}, 75)
    expect(updated).toEqual({
      pages: 75,
      default: 30,
      max: 400,
      requeued: 0,
    })

    const persisted = JSON.parse(readFileSync(pdfConfigFile, 'utf8'))
    expect(persisted.maxPages).toBe(75)
  })
})
