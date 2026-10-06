import type { IpcMain } from 'electron'
import { stat } from 'node:fs/promises'
import type { FolderScanManager } from '../document-memory/folder-scan'
import { ALL_FOLDERS, IndexIssueReader } from '../document-memory/issue-reader'
import { ISSUE_REASON_ORDER, type IndexIssueReason } from '../document-memory/issues'
import type { DocumentMemoryManager } from '../document-memory/manager'
import type { FolderChunkProgress } from '../document-memory/store'
import { createSwrCache } from './activity-cache'
import { HOME_CHANNELS, type HomeIndexingActivity } from '../../shared/home-api'
import {
  DOCUMENT_INDEX_CHANNELS,
  type IndexedFileHit,
  type IndexingNow,
  type IndexFileDetail,
} from '../../shared/fork/document-index-api'
import type { KnownSourcesManager } from '../document-memory/known-sources'
import {
  getDocumentIndexSnapshot,
  getDocumentIndexDiagnostics,
} from './document-index-snapshot-service'
import { registerFolderAndModelHandlers } from './document-index-folder-handlers'

export interface DocumentIndexIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  getDocumentMemory: () => DocumentMemoryManager | null
  getFolderScan: () => FolderScanManager | null
  dbPath: () => string
  getKnownSources?: () => KnownSourcesManager | null
  settingsPath?: string | (() => string)
}

const samePath = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
const ISSUE_REASONS: ReadonlySet<IndexIssueReason> = new Set(ISSUE_REASON_ORDER)

/** Document-index popup IPC handler registration (< 250 LOC). */
export function registerDocumentIndexIpc(deps: DocumentIndexIpcDeps): () => void {
  const { ipcMain, getDocumentMemory, getFolderScan } = deps
  const folderCounts = createSwrCache<FolderChunkProgress>()
  let issueReader: IndexIssueReader | null = null
  const reader = (): IndexIssueReader => (issueReader ??= new IndexIssueReader(deps.dbPath()))

  const activeRoot = (root: unknown): string => {
    if (root === ALL_FOLDERS) return ALL_FOLDERS
    if (typeof root !== 'string' || root !== getFolderScan()?.status().root) throw new Error('Invalid index issue request')
    return root
  }
  const issueReason = (reason: unknown): IndexIssueReason | undefined => {
    if (reason === undefined || reason === null) return undefined
    if (typeof reason !== 'string' || !ISSUE_REASONS.has(reason as IndexIssueReason)) throw new Error('Invalid index issue reason')
    return reason as IndexIssueReason
  }

  const snapshotCtx = {
    getDocumentMemory, getFolderScan,
    getIssueReader: reader,
    getFolderCounts: () => folderCounts,
    dbPath: deps.dbPath,
  }

  registerFolderAndModelHandlers(deps, () => folderCounts.invalidate())

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.enqueueDocumentIndex, (_event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      return { queued: 0, skipped: Array.isArray(ids) ? ids.length : 0, error: 'invalid-request' }
    }
    const memory = getDocumentMemory()
    if (!memory) return { queued: 0, skipped: ids.length, error: 'unavailable' }
    let queued = 0, error: string | undefined
    for (const id of new Set(ids)) {
      const result = memory.retryDocument(id)
      if (result) queued++
      else error = 'Failed to enqueue'
    }
    return { queued, skipped: ids.length - queued, ...(error ? { error } : {}) }
  })

  ipcMain.handle(HOME_CHANNELS.getDocumentIndexIssues, (_event, root: unknown, offset: unknown = 0, reason?: unknown) => {
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid index issue page')
    if (!getDocumentMemory()) return { total: 0, items: [] }
    return reader().page(activeRoot(root), offset, issueReason(reason))
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getIndexingNow, (): IndexingNow => {
    const memory = getDocumentMemory()
    return (
      memory?.nowStatus() ?? {
        extracting: [],
        embedding: {},
        positions: {},
        pages: {},
        queued: 0,
        paused: true,
      }
    )
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.searchIndexedFiles, async (_event, query: unknown): Promise<IndexedFileHit[]> => {
    if (typeof query !== 'string' || query.length > 200) return []
    const memory = getDocumentMemory()
    if (!memory) return []
    const indexed = reader().search(query)
    const known = new Set(indexed.map((hit) => samePath(hit.path)))
    const elsewhere = (await memory.searchExternal(query, 8))
      .filter((file) => !known.has(samePath(file.path)))
      .map((file) => ({ id: 0, path: file.path, name: file.name, status: 'on-disk' as const, external: true }))
    return [...indexed, ...elsewhere]
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getIndexFileDetail, async (_event, id: unknown): Promise<IndexFileDetail | null> => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('Invalid document id')
    if (!getDocumentMemory()) return null
    const detail = reader().detail(id)
    if (!detail) return null
    const exists = await stat(detail.path).then((s) => s.isFile(), () => false)
    return { ...detail, exists }
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getDocumentIndexIssueSummary, (_event, root: unknown) => {
    if (!getDocumentMemory()) return { total: 0, groups: [] }
    return reader().summary(activeRoot(root))
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.retryDocumentIndexGroup, (_event, root: unknown, reason?: unknown) => {
    const scope = activeRoot(root)
    const only = issueReason(reason)
    const memory = getDocumentMemory()
    if (!memory) return { ok: false, retried: 0, error: 'unavailable' }
    if (only === 'model') {
      memory.recycleEmbeddingWorker()
      folderCounts.invalidate()
      return { ok: true, retried: 0 }
    }
    let retried = 0
    const ids = reader().ids(scope, only)
    for (const id of only === 'waiting' ? ids.slice(0, 100) : ids) {
      if (memory.retryDocument(id)) retried++
    }
    folderCounts.invalidate()
    return { ok: true, retried }
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.deferIndexFile, (_event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('Invalid document id')
    const memory = getDocumentMemory()
    const doc = memory?.store.documentById(id)
    if (doc) memory?.deferDocument(doc.path)
    return { ok: !!doc }
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.stopIndexFile, async (_event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('Invalid document id')
    folderCounts.invalidate()
    const memory = getDocumentMemory()
    const doc = memory?.store.documentById(id)
    return doc ? (await memory?.stopDocument(doc.path)) ?? false : false
  })

  ipcMain.handle(HOME_CHANNELS.retryDocumentIndex, async (_event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('Invalid document id')
    folderCounts.invalidate()
    const memory = getDocumentMemory()
    const doc = memory?.store.documentById(id)
    const res = doc ? await memory?.readNowDocument(doc.path) : { ok: false, error: 'unavailable' }
    folderCounts.invalidate()
    return res
  })

  ipcMain.handle(HOME_CHANNELS.getIndexingActivity, (): HomeIndexingActivity => {
    return getDocumentIndexSnapshot(snapshotCtx).activity
  })

  // Fast 2s polling snapshot endpoint
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getDocumentIndexSnapshot, (_event, forceRefresh?: boolean) => {
    return getDocumentIndexSnapshot(snapshotCtx, forceRefresh)
  })

  // Heavy diagnostics endpoint cached for 60s (INV-10)
  ipcMain.handle('get-document-index-diagnostics', (_event, forceRefresh?: boolean) => {
    return getDocumentIndexDiagnostics(snapshotCtx, forceRefresh)
  })

  return () => issueReader?.close()
}
