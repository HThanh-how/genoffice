import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import {
  getDocumentIndexSnapshot,
  snapshotCache,
  diagnosticsCache,
  SNAPSHOT_CACHE_TTL_MS,
  DIAGNOSTICS_CACHE_TTL_MS,
  type SnapshotContext,
} from '../src/main/fork/document-index-snapshot-service'

describe('Document Search V3 Snapshot - Lightweight Invariants Suite', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore
  let issueReader: IndexIssueReader
  let heavyDiagnostics: ReturnType<typeof vi.fn>

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-snap-v3-'))
    dbPath = join(directory, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
    issueReader = new IndexIssueReader(dbPath)

    snapshotCache.clear()
    diagnosticsCache.clear()

    // Test trọng tâm: heavyDiagnostics ném exception nếu bị gọi từ lightweight path
    heavyDiagnostics = vi.fn(() => {
      throw new Error('HEAVY PATH CALLED')
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
        documents: 42,
        chunks: 150,
        vectors: 150,
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
        completedChunks: 150,
        totalChunks: 150,
        totalFiles: 42,
        readyFiles: 42,
        pendingFiles: 0,
        errorFiles: 0,
        emptyFiles: 0,
      })),
      // Bất kỳ truy vấn chẩn đoán nặng (PRAGMA, dbstat, migration deep inspection) đều ném lỗi
      getStorageDiagnostics: heavyDiagnostics,
      getStorageDiagnosticsAsync: heavyDiagnostics,
      getMigrationDiagnostics: heavyDiagnostics,
      computeDiagnostics: heavyDiagnostics,
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
  // SNAP-01: 100 snapshots no heavy diagnostics
  // =========================================================================
  it('SNAP-01 100 snapshots no heavy diagnostics', () => {
    const memory = createMockMemory()
    const ctx = createContext(memory)

    for (let i = 0; i < 100; i++) {
      let snapshot: any
      expect(() => {
        snapshot = getDocumentIndexSnapshot(ctx)
      }).not.toThrow()

      expect(snapshot).toBeDefined()
      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.memory.enabled).toBe(true)
      expect(snapshot.storage).toBeDefined()
      expect(snapshot.migration).toBeDefined()
    }

    // Khẳng định trọng tâm: heavy call count = 0 sau 100 lần gọi
    expect(heavyDiagnostics).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // SNAP-02: forceRefresh still no heavy diagnostics
  // =========================================================================
  it('SNAP-02 forceRefresh still no heavy diagnostics', () => {
    const memory = createMockMemory()
    const ctx = createContext(memory)

    // 1. Gọi 100 lần với forceRefresh = true (bỏ qua snapshot cache ở mỗi lần gọi)
    for (let i = 0; i < 100; i++) {
      let snapshot: any
      expect(() => {
        snapshot = getDocumentIndexSnapshot(ctx, true)
      }).not.toThrow()

      expect(snapshot).toBeDefined()
      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.memory.documents).toBe(42)
    }

    expect(heavyDiagnostics).toHaveBeenCalledTimes(0)

    // 2. Khi diagnosticsCache có sẵn dữ liệu trước đó, forceRefresh snapshot tái sử dụng dữ liệu này
    const populatedStorage = {
      activeDbSizeBytes: 2097152,
      walSizeBytes: 65536,
      pageSize: 4096,
      pageCount: 512,
      freelistCount: 0,
      estimatedReclaimableBytes: 0,
      v2BackupSizeBytes: null,
      schemaVersion: '3',
      migrationStatus: 'completed' as const,
      topOffendersByChunks: [],
      topOffendersBySize: [],
    }
    const populatedMigration = {
      activeEmbeddingSpace: 'text-embedding-3-small',
      state: 'ready',
      completedChunks: 150,
      totalChunks: 150,
    }

    diagnosticsCache.set({
      storage: populatedStorage,
      migration: populatedMigration,
      timestamp: Date.now(),
    })

    const snapWithPopulatedCache = getDocumentIndexSnapshot(ctx, true)
    expect(snapWithPopulatedCache.storage).toEqual(populatedStorage)
    expect(snapWithPopulatedCache.migration).toEqual(populatedMigration)
    expect(heavyDiagnostics).toHaveBeenCalledTimes(0)

    // 3. Khi diagnosticsCache hết hạn TTL (stale), snapshot vẫn chỉ dùng cache.latest() và không gọi heavy diagnostics
    vi.useFakeTimers()
    vi.advanceTimersByTime(DIAGNOSTICS_CACHE_TTL_MS + 10_000)

    expect(diagnosticsCache.get()).toBeNull() // Cache entry đã hết hạn
    expect(diagnosticsCache.latest()).not.toBeNull() // Stale entry vẫn được giữ

    const snapWithStaleCache = getDocumentIndexSnapshot(ctx, true)
    expect(snapWithStaleCache.storage).toEqual(populatedStorage)
    expect(snapWithStaleCache.migration).toEqual(populatedMigration)
    expect(heavyDiagnostics).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // SNAP-03: cache TTL 2s
  // =========================================================================
  it('SNAP-03 cache TTL 2s', () => {
    vi.useFakeTimers()
    const memory = createMockMemory()
    const ctx = createContext(memory)

    // TTL cấu hình chuẩn cho snapshot là 2000ms
    expect(SNAPSHOT_CACHE_TTL_MS).toBe(2000)

    // Gọi lần 1: fetch ban đầu
    const snap1 = getDocumentIndexSnapshot(ctx)
    expect(snap1).toBeDefined()

    // Gọi lần 2: ngay sau đó (t = 0), phải trả về chính xác cached reference
    const snap2 = getDocumentIndexSnapshot(ctx)
    expect(snap2).toBe(snap1)

    // Gọi lần 3: sau 1000ms (vẫn trong khoảng TTL 2000ms)
    vi.advanceTimersByTime(1000)
    const snap3 = getDocumentIndexSnapshot(ctx)
    expect(snap3).toBe(snap1)

    // Gọi lần 4: sau 999ms nữa (tổng 1999ms, vẫn nằm trong TTL 2000ms)
    vi.advanceTimersByTime(999)
    const snap4 = getDocumentIndexSnapshot(ctx)
    expect(snap4).toBe(snap1)

    // Gọi lần 5: forceRefresh = true vượt qua cache ngay lập tức dù chưa hết TTL
    const snapForced = getDocumentIndexSnapshot(ctx, true)
    expect(snapForced).not.toBe(snap1)

    // Lần gọi tiếp theo tái sử dụng reference của snapForced
    const snapAfterForced = getDocumentIndexSnapshot(ctx)
    expect(snapAfterForced).toBe(snapForced)

    // Gọi lần 6: sau 2001ms kể từ snapForced (vượt quá 2000ms)
    vi.advanceTimersByTime(SNAPSHOT_CACHE_TTL_MS + 1)
    const snapExpired = getDocumentIndexSnapshot(ctx)
    expect(snapExpired).not.toBe(snapForced)

    // Lần gọi ngay sau đó tái sử dụng snapExpired
    const snapReCached = getDocumentIndexSnapshot(ctx)
    expect(snapReCached).toBe(snapExpired)

    // Tuyệt đối không gọi heavy diagnostics trong toàn bộ vòng đời cache
    expect(heavyDiagnostics).toHaveBeenCalledTimes(0)
  })

  // =========================================================================
  // SNAP-04: truthful unavailable/default state
  // =========================================================================
  it('SNAP-04 truthful unavailable/default state', () => {
    diagnosticsCache.clear()
    snapshotCache.clear()

    // Trường hợp A: DocumentMemoryManager = null (chưa khởi tạo hoặc unavailable)
    const ctxNullMemory: SnapshotContext = {
      getDocumentMemory: () => null,
      getFolderScan: () => null,
      getIssueReader: () => issueReader,
      getFolderCounts: () => ({
        get: (_root: string, fetcher: () => any) => fetcher(),
      }),
      dbPath: () => dbPath,
    }

    const snapNull = getDocumentIndexSnapshot(ctxNullMemory, true)
    expect(snapNull.memory.enabled).toBe(false)
    expect(snapNull.memory.modelState).toBe('not-loaded')
    expect(snapNull.now.paused).toBe(true)
    expect(snapNull.storage).toEqual({
      activeDbSizeBytes: 0,
      walSizeBytes: 0,
      pageSize: 4096,
      pageCount: 0,
      freelistCount: 0,
      estimatedReclaimableBytes: 0,
      v2BackupSizeBytes: null,
      schemaVersion: '', // Trung thực: không có manager thì schema version rỗng
      migrationStatus: 'none',
      topOffendersByChunks: [],
      topOffendersBySize: [],
    })
    expect(snapNull.migration).toEqual({
      activeEmbeddingSpace: 'unknown',
      state: 'unknown',
      completedChunks: 0,
      totalChunks: 0,
    })

    // Trường hợp B: DocumentMemoryManager có mặt nhưng chưa từng chạy diagnostics
    snapshotCache.clear()
    const memory = createMockMemory()
    const ctxWithMemory = createContext(memory)

    const snapCold = getDocumentIndexSnapshot(ctxWithMemory, true)
    expect(snapCold.memory.enabled).toBe(true)
    expect(snapCold.storage.schemaVersion).toBe('unknown') // Trung thực: có manager nhưng chưa probe heavy diagnostics
    expect(snapCold.storage.migrationStatus).toBe('none')
    expect(snapCold.storage.topOffendersByChunks).toEqual([])
    expect(snapCold.storage.topOffendersBySize).toEqual([])
    expect(snapCold.migration.activeEmbeddingSpace).toBe('unknown')
    expect(snapCold.migration.state).toBe('unknown')

    // Cả hai trường hợp fallback đều không được phép gọi heavy diagnostics
    expect(heavyDiagnostics).toHaveBeenCalledTimes(0)
  })
})
