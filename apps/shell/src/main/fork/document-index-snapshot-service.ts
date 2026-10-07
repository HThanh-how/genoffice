import type { FolderScanManager } from '../document-memory/folder-scan'
import type { DocumentMemoryManager } from '../document-memory/manager'
import { foldFolderProgress } from '../document-memory/folder-progress'
import { ALL_FOLDERS, type IndexIssueReader, type IndexIssueSummary } from '../document-memory/issue-reader'
import { shortCause } from '../document-memory/issues'
import { currentIndexingPolicy, effectiveStateOf } from './indexing-policy-bus'
import { getEventLoopMetrics, getSqliteTimingSummary } from '../document-memory/sqlite-timing'
import { readAppSettings } from '../app-settings'
import {
  DEFAULT_INDEXING_MODE,
  DEFAULT_PAUSE_ON_BATTERY,
  indexingModeFrom,
  pauseOnBatteryFrom,
  type IndexingMode,
  type IndexingModeState,
} from '../../shared/fork/indexing-mode'
import type { DocumentMemoryStatus, HomeIndexingActivity } from '../../shared/home-api'
import type {
  DocumentIndexSnapshot,
  DocumentIndexDiagnostics,
  DocumentIndexStorageDiagnostics,
  DocumentIndexMigrationDiagnostics,
  IndexingNow,
} from '../../shared/fork/document-index-api'
import type { FolderChunkProgress } from '../document-memory/store'
import { createStorageBudgetSnapshot, safeGetFileSize } from '../document-memory/storage-budget'

export interface SnapshotContext {
  getDocumentMemory: () => DocumentMemoryManager | null
  getFolderScan: () => FolderScanManager | null
  getIssueReader: () => IndexIssueReader
  getFolderCounts: () => { get: (root: string, fetcher: () => FolderChunkProgress) => FolderChunkProgress }
  dbPath: () => string
  settingsPath?: string | (() => string)
}

/** In-memory TTL cache with support for forced refresh and invalidation. */
export class IndexStatusCache<T> {
  private entry: { data: T; expiresAt: number } | null = null

  constructor(public readonly ttlMs: number) {}

  get(forceRefresh = false): T | null {
    if (!forceRefresh && this.entry && Date.now() < this.entry.expiresAt) {
      return this.entry.data
    }
    return null
  }

  latest(): T | null {
    return this.entry?.data ?? null
  }

  peek(): T | null {
    return this.entry?.data ?? null
  }

  set(data: T): T {
    this.entry = {
      data,
      expiresAt: Date.now() + this.ttlMs,
    }
    return data
  }

  clear(): void {
    this.entry = null
  }
}

export const SNAPSHOT_CACHE_TTL_MS = 2000
export const DIAGNOSTICS_CACHE_TTL_MS = 60_000

export const snapshotCache = new IndexStatusCache<DocumentIndexSnapshot>(SNAPSHOT_CACHE_TTL_MS)
export const diagnosticsCache = new IndexStatusCache<DocumentIndexDiagnostics>(DIAGNOSTICS_CACHE_TTL_MS)

function emptyStorageDiagnostics(): DocumentIndexStorageDiagnostics {
  return {
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
  }
}

function fallbackStorageDiagnostics(hasMemory: boolean): DocumentIndexStorageDiagnostics {
  return {
    activeDbSizeBytes: 0,
    walSizeBytes: 0,
    pageSize: 4096,
    pageCount: 0,
    freelistCount: 0,
    estimatedReclaimableBytes: 0,
    v2BackupSizeBytes: null,
    schemaVersion: hasMemory ? 'unknown' : '',
    migrationStatus: 'none',
    topOffendersByChunks: [],
    topOffendersBySize: [],
  }
}

function fallbackMigrationDiagnostics(): DocumentIndexMigrationDiagnostics {
  return {
    activeEmbeddingSpace: 'unknown',
    state: 'unknown',
    completedChunks: 0,
    totalChunks: 0,
  }
}

function getSnapshotMode(ctx: SnapshotContext): IndexingModeState {
  let mode: IndexingMode = DEFAULT_INDEXING_MODE
  let pauseOnBattery = DEFAULT_PAUSE_ON_BATTERY
  if (ctx.settingsPath) {
    try {
      const sPath = typeof ctx.settingsPath === 'function' ? ctx.settingsPath() : ctx.settingsPath
      const stored = readAppSettings(sPath)
      mode = indexingModeFrom(stored)
      pauseOnBattery = pauseOnBatteryFrom(stored)
    } catch {
      // ignore
    }
  }
  return {
    mode,
    pauseOnBattery,
    effective: effectiveStateOf(currentIndexingPolicy()),
  }
}

export function getDocumentIndexSnapshot(ctx: SnapshotContext, forceRefresh?: boolean): DocumentIndexSnapshot {
  const cached = snapshotCache.get(forceRefresh)
  if (cached) {
    return cached
  }

  const now = Date.now()
  const documentMemory = ctx.getDocumentMemory()
  const folder = ctx.getFolderScan()?.status() ?? null
  const memoryStatus: DocumentMemoryStatus = typeof documentMemory?.status === 'function' ? documentMemory.status() : {
    enabled: false,
    modelState: 'not-loaded',
    documents: 0,
    chunks: 0,
    vectors: 0,
    pending: 0,
    errors: 0,
    dbPath: ctx.dbPath(),
    files: [],
  }
  const actMem = documentMemory?.indexingActivityStatus?.()
  const extractingPath = actMem?.activity?.extracting?.[0]?.path
  const modelError =
    extractingPath && documentMemory?.lastIndexError ? shortCause(documentMemory.lastIndexError) : ''
  const counts = documentMemory && typeof documentMemory.getLibraryIndexCounts === 'function'
    ? ctx.getFolderCounts().get(ALL_FOLDERS, () => documentMemory.getLibraryIndexCounts())
    : null
  const policy = currentIndexingPolicy()
  const cpuMode: 'gentle' | undefined =
    !policy || (!policy.paused && policy.cpuShare < 1) ? 'gentle' : undefined

  const activity: HomeIndexingActivity = {
    folder,
    progressScope: 'library',
    memory: {
      enabled: documentMemory?.isEnabled?.() ?? actMem?.enabled ?? memoryStatus.enabled ?? false,
      ...(cpuMode ? { cpuMode } : {}),
      modelState: (actMem as any)?.modelState ?? memoryStatus.modelState,
      pending: actMem?.activity?.queued ?? (actMem as any)?.pending ?? memoryStatus.pending ?? 0,
      errors: (actMem as any)?.errors ?? memoryStatus.errors,
      ...(modelError ? { lastError: modelError } : {}),
    },
    folderProgress: counts
      ? foldFolderProgress(counts, !folder?.running, folder?.running ? (folder.errors ?? 0) : 0)
      : null,
  }

  let issues: IndexIssueSummary = { total: 0, groups: [] }
  try {
    issues = ctx.getIssueReader().summary('*')
  } catch {
    // ignore
  }

  const nowState: IndexingNow = typeof documentMemory?.nowStatus === 'function' ? documentMemory.nowStatus() : {
    extracting: [],
    embedding: {},
    positions: {},
    pages: {},
    queued: 0,
    paused: true,
  }

  const timing = getSqliteTimingSummary()
  const eventLoop = getEventLoopMetrics()
  const performance = {
    eventLoop,
    sqliteLatency: {
      slowOperationCount: timing.slowOperations,
      criticalOperations: timing.recentSlow
        .filter((r) => r.severity === 'critical')
        .slice(-10)
        .map((r) => ({
          operation: r.operation,
          durationMs: r.durationMs,
          timestamp: r.timestamp,
        })),
    },
    paused: !policy || policy.paused,
    cpuShare: policy?.cpuShare ?? 1,
  }

  // Diagnostics are heavy (PRAGMA, dbstat, top offenders GROUP BY) and strictly banned inside snapshot.
  // We use the last cached diagnostics if available; otherwise provide a lightweight fallback with 'unknown'
  // without triggering any synchronous diagnostics fetch.
  const cachedDiagnostics = diagnosticsCache.latest()
  const storage = cachedDiagnostics?.storage ?? fallbackStorageDiagnostics(Boolean(documentMemory))
  const migration = cachedDiagnostics?.migration ?? fallbackMigrationDiagnostics()

  const liveDbPath = ctx.dbPath()
  const liveActiveBytes = safeGetFileSize(liveDbPath)
  const liveWalBytes = safeGetFileSize(`${liveDbPath}-wal`)

  const storageBudget = createStorageBudgetSnapshot({
    activeDbSizeBytes: liveActiveBytes > 0 ? liveActiveBytes : storage.activeDbSizeBytes,
    walSizeBytes: liveWalBytes > 0 ? liveWalBytes : storage.walSizeBytes,
    budgetBytes: storage.budgetBytes,
    chunksBytes: storage.breakdown?.chunksBytes ?? storage.chunksBytes,
    embeddingsBytes: storage.breakdown?.embeddingsBytes ?? storage.embeddingsBytes,
    ftsBytes: storage.breakdown?.ftsBytes ?? storage.ftsBytes,
    ocrBytes: storage.breakdown?.ocrBytes ?? storage.ocrBytes,
    backupBytes: storage.v2BackupSizeBytes ?? storage.backupBytes,
    reclaimableBytes: storage.estimatedReclaimableBytes ?? storage.reclaimableBytes,
  })

  const modeState = getSnapshotMode(ctx)

  const snapshot: DocumentIndexSnapshot = {
    memory: memoryStatus,
    activity,
    mode: modeState,
    issues,
    now: nowState,
    storage,
    storageBudget,
    performance,
    migration,
    timestamp: now,
  }

  return snapshotCache.set(snapshot)
}

export async function getDocumentIndexDiagnostics(ctx: SnapshotContext, forceRefresh?: boolean): Promise<DocumentIndexDiagnostics> {
  const cached = diagnosticsCache.get(forceRefresh)
  if (cached) {
    return cached
  }

  const now = Date.now()
  const memory = ctx.getDocumentMemory()
  const storage = (await memory?.getStorageDiagnosticsAsync?.()) ?? emptyStorageDiagnostics()

  const migration: DocumentIndexMigrationDiagnostics = typeof memory?.getMigrationDiagnostics === 'function' ? memory.getMigrationDiagnostics() : {
    activeEmbeddingSpace: 'standard',
    state: 'idle',
    totalChunks: 0,
    completedChunks: 0,
  }

  const diagnostics: DocumentIndexDiagnostics = {
    storage,
    migration,
    timestamp: now,
  }

  return diagnosticsCache.set(diagnostics)
}
