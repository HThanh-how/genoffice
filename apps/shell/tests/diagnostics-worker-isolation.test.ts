import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import { snapshotCache, diagnosticsCache } from '../src/main/fork/document-index-snapshot-service'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import {
  DOCUMENT_INDEX_CHANNELS,
  type DocumentIndexStorageDiagnostics,
  type DocumentIndexMigrationDiagnostics,
} from '../src/shared/fork/document-index-api'

describe('Document Index Diagnostics Worker Isolation & IPC Suite', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore
  let issueReader: IndexIssueReader

  let syncStorageMock: ReturnType<typeof vi.fn>
  let asyncStorageMock: ReturnType<typeof vi.fn>
  let migrationMock: ReturnType<typeof vi.fn>

  let ipcHandlers: Map<string, (...args: any[]) => any>
  let unregisterIpc: (() => void) | null = null

  const validDiagnostics: DocumentIndexStorageDiagnostics = {
    activeDbSizeBytes: 2 * 1024 * 1024,
    walSizeBytes: 64 * 1024,
    pageSize: 4096,
    pageCount: 512,
    freelistCount: 4,
    estimatedReclaimableBytes: 16384,
    v2BackupSizeBytes: 1024 * 1024,
    schemaVersion: '3',
    migrationStatus: 'completed',
    topOffendersByChunks: [{ documentId: 'doc-1', path: '/docs/report.pdf', chunkCount: 120 }],
    topOffendersBySize: [{ documentId: 'doc-1', path: '/docs/report.pdf', totalBytes: 256000 }],
  }

  const validMigration: DocumentIndexMigrationDiagnostics = {
    activeEmbeddingSpace: 'text-embedding-3-small',
    state: 'idle',
    completedChunks: 120,
    totalChunks: 120,
  }

  function createMockManager() {
    return {
      status: vi.fn(() => ({
        enabled: true,
        modelState: 'ready' as const,
        documents: 5,
        chunks: 120,
        vectors: 120,
        pending: 0,
        errors: 0,
        dbPath,
        files: [],
      })),
      indexingActivityStatus: vi.fn(() => ({
        enabled: true,
        modelState: 'ready' as const,
        pending: 0,
        errors: 0,
        activity: { queued: 0, extracting: [] },
      })),
      nowStatus: vi.fn(() => ({
        extracting: [],
        embedding: {},
        positions: {},
        pages: {},
        queued: 0,
        paused: false,
      })),
      getLibraryIndexCounts: vi.fn(() => ({
        completedChunks: 120,
        totalChunks: 120,
        totalFiles: 5,
        readyFiles: 5,
        pendingFiles: 0,
        errorFiles: 0,
        emptyFiles: 0,
      })),
      getStorageDiagnostics: syncStorageMock,
      getStorageDiagnosticsAsync: asyncStorageMock,
      getMigrationDiagnostics: migrationMock,
    }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-diag-worker-'))
    dbPath = join(directory, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
    issueReader = new IndexIssueReader(dbPath)

    snapshotCache.clear()
    diagnosticsCache.clear()

    syncStorageMock = vi.fn().mockImplementation(() => {
      throw new Error('MAIN THREAD VIOLATION')
    })

    asyncStorageMock = vi.fn().mockImplementation(async () => {
      return validDiagnostics
    })

    migrationMock = vi.fn().mockImplementation(() => {
      return validMigration
    })

    ipcHandlers = new Map<string, (...args: any[]) => any>()
    const fakeIpcMain = {
      handle: (channel: string, handler: (...args: any[]) => any) => {
        ipcHandlers.set(channel, handler)
      },
    }

    const mockManager = createMockManager()

    unregisterIpc = registerDocumentIndexIpc({
      ipcMain: fakeIpcMain as any,
      getDocumentMemory: () => mockManager as any,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (unregisterIpc) {
      unregisterIpc()
      unregisterIpc = null
    }
    issueReader.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
    snapshotCache.clear()
    diagnosticsCache.clear()
  })

  // =========================================================================
  // DIAG-01: Cold IPC diagnostics uses worker path
  // =========================================================================
  it('DIAG-01 cold IPC diagnostics uses worker path', async () => {
    const handler = ipcHandlers.get('get-document-index-diagnostics')
    expect(handler).toBeDefined()

    // Cold invocation through real IPC handler
    const result = await handler!({}, false)

    expect(result).toBeDefined()
    expect(result.storage).toEqual(validDiagnostics)
    expect(result.migration).toEqual(validMigration)
    expect(result.timestamp).toBeGreaterThan(0)

    // Invariant: Main-thread synchronous query MUST NEVER be invoked
    expect(syncStorageMock).toHaveBeenCalledTimes(0)
    // Worker asynchronous query MUST be invoked exactly once
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)
  })

  // =========================================================================
  // DIAG-02: Concurrent requests dedup/cache
  // =========================================================================
  it('DIAG-02 concurrent requests dedup/cache', async () => {
    const handler = ipcHandlers.get('get-document-index-diagnostics')
    expect(handler).toBeDefined()

    // Dispatch concurrent requests simultaneously
    const [result1, result2] = await Promise.all([handler!({}, false), handler!({}, false)])

    expect(result1).toBeDefined()
    expect(result2).toBeDefined()
    expect(result1.storage).toEqual(validDiagnostics)
    expect(result2.storage).toEqual(validDiagnostics)

    // Neither concurrent invocation may touch main thread SQLite
    expect(syncStorageMock).toHaveBeenCalledTimes(0)

    const callsAfterConcurrent = asyncStorageMock.mock.calls.length
    expect(callsAfterConcurrent).toBeGreaterThanOrEqual(1)

    // Immediately trigger follow-up request to verify cache absorption
    const result3 = await handler!({}, false)
    expect(result3).toEqual(result1)

    // Follow-up request within cache window MUST be cached (0 additional worker calls)
    expect(asyncStorageMock).toHaveBeenCalledTimes(callsAfterConcurrent)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // DIAG-03: <60s cached
  // =========================================================================
  it('DIAG-03 <60s cached', async () => {
    vi.useFakeTimers()
    const handler = ipcHandlers.get('get-document-index-diagnostics')
    expect(handler).toBeDefined()

    // Initial call (T = 0s)
    const initialResult = await handler!({}, false)
    expect(initialResult.storage).toEqual(validDiagnostics)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)

    // Advance 10s: still within 60s TTL
    vi.advanceTimersByTime(10_000)
    const cached10s = await handler!({}, false)
    expect(cached10s).toBe(initialResult)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)

    // Advance to 59s: still within 60s TTL
    vi.advanceTimersByTime(49_000)
    const cached59s = await handler!({}, false)
    expect(cached59s).toBe(initialResult)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)

    // Advance past 60s TTL (total 61s elapsed)
    vi.advanceTimersByTime(2_000)
    const refreshed = await handler!({}, false)
    expect(refreshed.storage).toEqual(validDiagnostics)

    // After TTL expiry, worker path is queried again
    expect(asyncStorageMock).toHaveBeenCalledTimes(2)
    // Synchronous main path remains untouched
    expect(syncStorageMock).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // DIAG-04: forceRefresh invokes worker
  // =========================================================================
  it('DIAG-04 forceRefresh invokes worker', async () => {
    const handler = ipcHandlers.get('get-document-index-diagnostics')
    expect(handler).toBeDefined()

    // Initial request populates the cache
    const initial = await handler!({}, false)
    expect(initial.storage).toEqual(validDiagnostics)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)

    // forceRefresh: true immediately bypasses cache and queries worker
    const refreshed = await handler!({}, true)
    expect(refreshed.storage).toEqual(validDiagnostics)
    expect(asyncStorageMock).toHaveBeenCalledTimes(2)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)

    // Subsequent normal request re-uses the newly refreshed cache
    const cached = await handler!({}, false)
    expect(cached).toBe(refreshed)
    expect(asyncStorageMock).toHaveBeenCalledTimes(2)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // DIAG-05: Worker timeout returns truthful fallback
  // =========================================================================
  it('DIAG-05 worker timeout returns truthful fallback', async () => {
    const handler = ipcHandlers.get('get-document-index-diagnostics')
    expect(handler).toBeDefined()

    // Simulate worker process timeout / unresponsive child process (returns null)
    asyncStorageMock.mockImplementationOnce(async () => null)

    diagnosticsCache.clear()
    const result = await handler!({}, true)

    expect(result).toBeDefined()
    expect(result.storage).toEqual({
      activeDbSizeBytes: 0,
      walSizeBytes: 0,
      pageSize: 4096,
      pageCount: 0,
      freelistCount: 0,
      estimatedReclaimableBytes: 0,
      v2BackupSizeBytes: null,
      schemaVersion: '',
      migrationStatus: 'none',
      topOffendersByChunks: [],
      topOffendersBySize: [],
    })
    expect(result.migration).toEqual(validMigration)

    // Worker was queried, returned null (timeout), main thread was NOT breached
    expect(syncStorageMock).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // DIAG-06: Snapshot polling causes 0 diagnostic worker calls
  // =========================================================================
  it('DIAG-06 snapshot polling causes 0 diagnostic worker calls', async () => {
    const snapshotHandler = ipcHandlers.get(DOCUMENT_INDEX_CHANNELS.getDocumentIndexSnapshot)
    expect(snapshotHandler).toBeDefined()

    // Simulate rapid snapshot polling (100 times)
    for (let i = 0; i < 100; i++) {
      const snap = await snapshotHandler!({}, true)
      expect(snap).toBeDefined()
      expect(snap.memory).toBeDefined()
      expect(snap.storage).toBeDefined()
    }

    // Critical invariant: snapshot polling MUST NEVER invoke diagnostics worker or main thread
    expect(asyncStorageMock).toHaveBeenCalledTimes(0)
    expect(syncStorageMock).toHaveBeenCalledTimes(0)
  })
})
