import type { FolderScanManager } from '../document-memory/folder-scan'
import type { DocumentMemoryManager } from '../document-memory/manager'
import { foldFolderProgress } from '../document-memory/folder-progress'
import { ALL_FOLDERS, type IndexIssueReader, type IndexIssueSummary } from '../document-memory/issue-reader'
import { shortCause } from '../document-memory/issues'
import { currentIndexingPolicy } from './indexing-policy-bus'
import { getEventLoopMetrics, getSqliteTimingSummary } from '../document-memory/sqlite-timing'
import type { DocumentMemoryStatus, HomeIndexingActivity } from '../../shared/home-api'
import type {
  DocumentIndexSnapshot,
  DocumentIndexDiagnostics,
  DocumentIndexStorageDiagnostics,
  DocumentIndexMigrationDiagnostics,
  IndexingNow,
} from '../../shared/fork/document-index-api'
import type { FolderChunkProgress } from '../document-memory/store'

export interface SnapshotContext {
  getDocumentMemory: () => DocumentMemoryManager | null
  getFolderScan: () => FolderScanManager | null
  getIssueReader: () => IndexIssueReader
  getFolderCounts: () => { get: (root: string, fetcher: () => FolderChunkProgress) => FolderChunkProgress }
  dbPath: () => string
}

let snapshotCache: { data: DocumentIndexSnapshot; expiresAt: number } | null = null
const SNAPSHOT_CACHE_TTL_MS = 1500

let diagnosticsCache: { data: DocumentIndexDiagnostics; expiresAt: number } | null = null
const DIAGNOSTICS_CACHE_TTL_MS = 60_000

export function getDocumentIndexSnapshot(ctx: SnapshotContext, forceRefresh?: boolean): DocumentIndexSnapshot {
  const now = Date.now()
  if (!forceRefresh && snapshotCache && now < snapshotCache.expiresAt) {
    return snapshotCache.data
  }

  const documentMemory = ctx.getDocumentMemory()
  const folder = ctx.getFolderScan()?.status() ?? null
  const memoryStatus: DocumentMemoryStatus = documentMemory?.status() ?? {
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
  const actMem = documentMemory?.indexingActivityStatus()
  const extractingPath = actMem?.activity.extracting[0]?.path
  const modelError =
    extractingPath && documentMemory?.lastIndexError ? shortCause(documentMemory.lastIndexError) : ''
  const counts = documentMemory
    ? ctx.getFolderCounts().get(ALL_FOLDERS, () => documentMemory.getLibraryIndexCounts())
    : null
  const policy = currentIndexingPolicy()
  const cpuMode: 'gentle' | undefined =
    !policy || (!policy.paused && policy.cpuShare < 1) ? 'gentle' : undefined

  const activity: HomeIndexingActivity = {
    folder,
    progressScope: 'library',
    memory: {
      enabled: documentMemory?.isEnabled() ?? false,
      ...(cpuMode ? { cpuMode } : {}),
      modelState: 'ready',
      pending: actMem?.activity.queued ?? 0,
      errors: memoryStatus.errors,
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

  const nowState: IndexingNow = documentMemory?.nowStatus() ?? {
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

  // Lightweight snapshot for 2s polling: does NOT compute heavy storage dbstat or top offenders!
  const lightStorage: DocumentIndexStorageDiagnostics = {
    activeDbSizeBytes: 0,
    walSizeBytes: 0,
    pageSize: 4096,
    pageCount: 0,
    freelistCount: 0,
    estimatedReclaimableBytes: 0,
    v2BackupSizeBytes: null,
    schemaVersion: '3',
    migrationStatus: 'completed',
    topOffendersByChunks: [],
    topOffendersBySize: [],
  }

  const migration: DocumentIndexMigrationDiagnostics = documentMemory?.getMigrationDiagnostics() ?? {
    activeEmbeddingSpace: 'standard',
    state: 'idle',
    completedChunks: 0,
    totalChunks: 0,
  }

  const snapshot: DocumentIndexSnapshot = {
    memory: memoryStatus,
    activity,
    mode: null,
    issues,
    now: nowState,
    storage: lightStorage,
    performance,
    migration,
    timestamp: now,
  }

  snapshotCache = {
    data: snapshot,
    expiresAt: now + SNAPSHOT_CACHE_TTL_MS,
  }

  return snapshot
}

export function getDocumentIndexDiagnostics(ctx: SnapshotContext, forceRefresh?: boolean): DocumentIndexDiagnostics {
  const now = Date.now()
  if (!forceRefresh && diagnosticsCache && now < diagnosticsCache.expiresAt) {
    return diagnosticsCache.data
  }

  const memory = ctx.getDocumentMemory()
  const storage = memory?.getStorageDiagnostics() ?? {
    activeDbSizeBytes: 0,
    walSizeBytes: 0,
    pageSize: 4096,
    pageCount: 0,
    freelistCount: 0,
    estimatedReclaimableBytes: 0,
    v2BackupSizeBytes: null,
    schemaVersion: '3',
    migrationStatus: 'none',
    topOffendersByChunks: [],
    topOffendersBySize: [],
  }

  const migration: DocumentIndexMigrationDiagnostics = memory?.getMigrationDiagnostics() ?? {
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

  diagnosticsCache = {
    data: diagnostics,
    expiresAt: now + DIAGNOSTICS_CACHE_TTL_MS,
  }

  return diagnostics
}
