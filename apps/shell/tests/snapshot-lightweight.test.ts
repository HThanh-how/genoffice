import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import {
  getDocumentIndexSnapshot,
  getDocumentIndexDiagnostics,
  snapshotCache,
  diagnosticsCache,
  SNAPSHOT_CACHE_TTL_MS,
  DIAGNOSTICS_CACHE_TTL_MS,
  type SnapshotContext,
} from '../src/main/fork/document-index-snapshot-service'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'

describe('Document Index Snapshot Lightweight Verification Suite', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore
  let issueReader: IndexIssueReader

  let storageDiagMock: ReturnType<typeof vi.fn>
  let migrationDiagMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-snap-light-'))
    dbPath = join(directory, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
    issueReader = new IndexIssueReader(dbPath)

    snapshotCache.clear()
    diagnosticsCache.clear()

    storageDiagMock = vi.fn().mockImplementation(() => {
      throw new Error('CRITICAL VIOLATION: storage diagnostics invoked during lightweight snapshot!')
    })
    migrationDiagMock = vi.fn().mockImplementation(() => {
      throw new Error('CRITICAL VIOLATION: migration diagnostics invoked during lightweight snapshot!')
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    issueReader.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
    snapshotCache.clear()
    diagnosticsCache.clear()
  })

  function createMockMemory() {
    return {
      status: vi.fn(() => ({
        enabled: true,
        modelState: 'ready' as const,
        documents: 10,
        chunks: 50,
        vectors: 50,
        pending: 0,
        errors: 0,
        dbPath,
        files: [],
      })),
      isEnabled: vi.fn(() => true),
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
        completedChunks: 50,
        totalChunks: 50,
        totalFiles: 10,
        readyFiles: 10,
        pendingFiles: 0,
        errorFiles: 0,
        emptyFiles: 0,
      })),
      getStorageDiagnostics: storageDiagMock,
      getMigrationDiagnostics: migrationDiagMock,
    }
  }

  function createContext(memory: any = createMockMemory()): SnapshotContext {
    return {
      getDocumentMemory: () => memory,
      getFolderScan: () => null,
      getIssueReader: () => issueReader,
      getFolderCounts: () => ({
        get: (_root: string, fetcher: () => any) => fetcher(),
      }),
      dbPath: () => dbPath,
    }
  }

  // =========================================================================
  // SNAP-01: Critical test - mock diagnostics = THROW, 100 calls -> 100 successes
  // =========================================================================
  it('SNAP-01: critical test: diagnostics function throws, 100 calls succeed with 0 diagnostics calls', () => {
    const memory = createMockMemory()
    const ctx = createContext(memory)

    // Call 100 times with forceRefresh: true to force full snapshot execution every time
    for (let i = 0; i < 100; i++) {
      let snapshot: any
      expect(() => {
        snapshot = getDocumentIndexSnapshot(ctx, true)
      }).not.toThrow()

      expect(snapshot).toBeDefined()
      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.memory.enabled).toBe(true)
      expect(snapshot.storage).toBeDefined()
      expect(snapshot.migration).toBeDefined()
    }

    // Diagnostics must never have been called across all 100 full snapshot executions
    expect(storageDiagMock).toHaveBeenCalledTimes(0)
    expect(migrationDiagMock).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // SNAP-02: Cache diagnostics does not auto-trigger synchronous diagnostics
  // =========================================================================
  it('SNAP-02: diagnostics cache does not auto-trigger synchronous diagnostics', () => {
    const memory = createMockMemory()
    const ctx = createContext(memory)

    // 1. Initial cold state: diagnostics cache is empty
    expect(diagnosticsCache.latest()).toBeNull()

    const coldSnap = getDocumentIndexSnapshot(ctx)
    expect(coldSnap).toBeDefined()
    // diagnosticsCache must remain null - snapshot does NOT trigger diagnostics run
    expect(diagnosticsCache.latest()).toBeNull()
    expect(storageDiagMock).toHaveBeenCalledTimes(0)
    expect(migrationDiagMock).toHaveBeenCalledTimes(0)

    // 2. Diagnostics cache has existing populated data
    const mockStorage = {
      activeDbSizeBytes: 1048576,
      walSizeBytes: 32768,
      pageSize: 4096,
      pageCount: 256,
      freelistCount: 2,
      estimatedReclaimableBytes: 8192,
      v2BackupSizeBytes: null,
      schemaVersion: '3',
      migrationStatus: 'completed' as const,
      topOffendersByChunks: [],
      topOffendersBySize: [],
    }
    const mockMigration = {
      activeEmbeddingSpace: 'text-embedding-3-small',
      state: 'ready',
      completedChunks: 100,
      totalChunks: 100,
    }

    diagnosticsCache.set({
      storage: mockStorage,
      migration: mockMigration,
      timestamp: Date.now(),
    })

    // Calling snapshot with forceRefresh should use cached diagnostics without re-running diagnostics
    const snapWithCache = getDocumentIndexSnapshot(ctx, true)
    expect(snapWithCache.storage).toEqual(mockStorage)
    expect(snapWithCache.migration).toEqual(mockMigration)
    expect(storageDiagMock).toHaveBeenCalledTimes(0)
    expect(migrationDiagMock).toHaveBeenCalledTimes(0)

    // 3. Diagnostics cache entry expires past TTL
    vi.useFakeTimers()
    vi.advanceTimersByTime(DIAGNOSTICS_CACHE_TTL_MS + 5_000)

    // diagnosticsCache.get() now returns null because it expired
    expect(diagnosticsCache.get()).toBeNull()
    // But diagnosticsCache.latest() retains stale data
    expect(diagnosticsCache.latest()).not.toBeNull()

    // Calling snapshot must still use stale diagnostics via .latest() without triggering diagnostics sync
    const snapStaleCache = getDocumentIndexSnapshot(ctx, true)
    expect(snapStaleCache.storage).toEqual(mockStorage)
    expect(snapStaleCache.migration).toEqual(mockMigration)
    expect(storageDiagMock).toHaveBeenCalledTimes(0)
    expect(migrationDiagMock).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // SNAP-03: Unknown fallback remains truthful when no diagnostics available
  // =========================================================================
  it('SNAP-03: unknown fallback remains truthful when no diagnostics exist', () => {
    diagnosticsCache.clear()
    snapshotCache.clear()

    // Case A: Memory manager is present
    const memory = createMockMemory()
    const ctxWithMemory = createContext(memory)

    const snapWithMem = getDocumentIndexSnapshot(ctxWithMemory, true)
    expect(snapWithMem.storage).toEqual({
      activeDbSizeBytes: 0,
      walSizeBytes: 0,
      pageSize: 4096,
      pageCount: 0,
      freelistCount: 0,
      estimatedReclaimableBytes: 0,
      v2BackupSizeBytes: null,
      schemaVersion: 'unknown', // truthful: manager exists, but schema version is unprobed
      migrationStatus: 'none',
      topOffendersByChunks: [],
      topOffendersBySize: [],
    })
    expect(snapWithMem.migration).toEqual({
      activeEmbeddingSpace: 'unknown',
      state: 'unknown',
      completedChunks: 0,
      totalChunks: 0,
    })

    // Case B: Memory manager is absent (null)
    snapshotCache.clear()
    const ctxNoMemory: SnapshotContext = {
      getDocumentMemory: () => null,
      getFolderScan: () => null,
      getIssueReader: () => issueReader,
      getFolderCounts: () => ({
        get: (_root: string, fetcher: () => any) => fetcher(),
      }),
      dbPath: () => dbPath,
    }

    const snapNoMem = getDocumentIndexSnapshot(ctxNoMemory, true)
    expect(snapNoMem.storage.schemaVersion).toBe('') // truthful: no memory manager, empty schema
    expect(snapNoMem.storage.migrationStatus).toBe('none')
    expect(snapNoMem.storage.topOffendersByChunks).toEqual([])
    expect(snapNoMem.storage.topOffendersBySize).toEqual([])
    expect(snapNoMem.migration.activeEmbeddingSpace).toBe('unknown')
    expect(snapNoMem.migration.state).toBe('unknown')
  })

  // =========================================================================
  // SNAP-04: Snapshot cache TTL operates accurately
  // =========================================================================
  it('SNAP-04: snapshot cache TTL operates accurately with forceRefresh and expiry', () => {
    vi.useFakeTimers()
    const memory = createMockMemory()
    const ctx = createContext(memory)

    expect(SNAPSHOT_CACHE_TTL_MS).toBe(2000)

    // Call 1: cold fetch
    const snap1 = getDocumentIndexSnapshot(ctx)
    expect(snap1).toBeDefined()

    // Call 2: immediate subsequent call within TTL returns cached reference
    const snap2 = getDocumentIndexSnapshot(ctx)
    expect(snap2).toBe(snap1)

    // Call 3: advance time by 1000ms (still within 2000ms TTL)
    vi.advanceTimersByTime(1000)
    const snap3 = getDocumentIndexSnapshot(ctx)
    expect(snap3).toBe(snap1)

    // Call 4: advance time by 999ms (total 1999ms, still within TTL)
    vi.advanceTimersByTime(999)
    const snap4 = getDocumentIndexSnapshot(ctx)
    expect(snap4).toBe(snap1)

    // Call 5: forceRefresh bypasses cache even within TTL
    const snapForced = getDocumentIndexSnapshot(ctx, true)
    expect(snapForced).not.toBe(snap1)

    // Subsequent normal call returns the newly forced cached reference
    const snapAfterForce = getDocumentIndexSnapshot(ctx)
    expect(snapAfterForce).toBe(snapForced)

    // Call 6: advance time past 2000ms TTL from snapForced
    vi.advanceTimersByTime(SNAPSHOT_CACHE_TTL_MS + 1)
    const snapExpired = getDocumentIndexSnapshot(ctx)
    expect(snapExpired).not.toBe(snapForced)

    // Call 7: immediately after recomputing, cached again
    const snapReCached = getDocumentIndexSnapshot(ctx)
    expect(snapReCached).toBe(snapExpired)
  })

  // =========================================================================
  // BONUS / IPC PRODUCTION PATH: IPC handler delegates to lightweight snapshot
  // =========================================================================
  it('production IPC handler passes through to lightweight snapshot without diagnostics', async () => {
    const memory = createMockMemory()
    const handlers = new Map<string, Function>()
    const fakeIpcMain = {
      handle: (channel: string, handler: Function) => {
        handlers.set(channel, handler)
      },
    }

    const unregister = registerDocumentIndexIpc({
      ipcMain: fakeIpcMain as any,
      getDocumentMemory: () => memory as any,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    const snapshotHandler = handlers.get(DOCUMENT_INDEX_CHANNELS.getDocumentIndexSnapshot)
    expect(snapshotHandler).toBeDefined()

    // Invoke through IPC handler
    const result = await snapshotHandler!({}, true)
    expect(result).toBeDefined()
    expect(result.storage.schemaVersion).toBe('unknown')

    // Diagnostics mocks were never called through IPC handler
    expect(storageDiagMock).toHaveBeenCalledTimes(0)
    expect(migrationDiagMock).toHaveBeenCalledTimes(0)

    unregister()
  })
})
