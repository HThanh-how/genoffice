import type { IpcMain } from 'electron'
import type { FolderScanManager } from '../document-memory/folder-scan'
import { IndexIssueReader } from '../document-memory/issue-reader'
import { shortCause, type IndexIssueReason } from '../document-memory/issues'
import type { DocumentMemoryManager } from '../document-memory/manager'
import { createActivityCache } from '../indexing-activity-cache'
import { HOME_CHANNELS, type HomeIndexingActivity } from '../../shared/home-api'
import { DOCUMENT_INDEX_CHANNELS } from '../../shared/fork/document-index-api'

export interface DocumentIndexIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  getDocumentMemory: () => DocumentMemoryManager | null
  getFolderScan: () => FolderScanManager | null
  /** absolute path of the document-memory SQLite file */
  dbPath: () => string
}

const ISSUE_REASONS: ReadonlySet<IndexIssueReason> = new Set([
  'unavailable',
  'permission',
  'password',
  'corrupt',
  'unsupported',
  'timeout',
  'no-text',
  'too-large',
  'changed',
  'model',
  'other',
])

/**
 * Document-index popup IPC: grouped problem files, per-group retry and the cached
 * indexing-activity payload. Replaces the upstream getDocumentIndexIssues,
 * retryDocumentIndex and getIndexingActivity handlers (do not register those twice).
 */
export function registerDocumentIndexIpc(deps: DocumentIndexIpcDeps): void {
  const { ipcMain, getDocumentMemory, getFolderScan } = deps
  const activityCache =
    createActivityCache<Pick<HomeIndexingActivity, 'memory' | 'folderProgress'>>()
  let issueReader: IndexIssueReader | null = null
  const reader = (): IndexIssueReader => (issueReader ??= new IndexIssueReader(deps.dbPath()))
  const activeRoot = (root: unknown): string => {
    if (typeof root !== 'string' || root !== getFolderScan()?.status().root)
      throw new Error('Invalid index issue request')
    return root
  }
  const issueReason = (reason: unknown): IndexIssueReason | undefined => {
    if (reason === undefined || reason === null) return undefined
    if (typeof reason !== 'string' || !ISSUE_REASONS.has(reason as IndexIssueReason))
      throw new Error('Invalid index issue reason')
    return reason as IndexIssueReason
  }

  ipcMain.handle(
    HOME_CHANNELS.getDocumentIndexIssues,
    (_event, root: unknown, offset: unknown = 0, reason?: unknown) => {
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Invalid index issue page')
      if (!getDocumentMemory()) return { total: 0, items: [] }
      return reader().page(activeRoot(root), offset, issueReason(reason))
    },
  )
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getDocumentIndexIssueSummary, (_event, root: unknown) => {
    if (!getDocumentMemory()) return { total: 0, groups: [] }
    return reader().summary(activeRoot(root))
  })
  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.retryDocumentIndexGroup,
    (_event, root: unknown, reason?: unknown) => {
      const scope = activeRoot(root)
      const only = issueReason(reason)
      const documentMemory = getDocumentMemory()
      if (!documentMemory) return { ok: false, retried: 0, error: 'unavailable' }
      if (only === 'model') {
        // The model has no retry of its own: pausing and resuming restarts the worker and
        // re-queues files that were waiting on embeddings.
        const wasEnabled = documentMemory.indexingActivityStatus().enabled
        if (!wasEnabled) return { ok: false, retried: 0, error: 'paused' }
        documentMemory.setEnabled(false)
        documentMemory.setEnabled(true)
        activityCache.invalidate()
        return { ok: true, retried: 0 }
      }
      let retried = 0
      for (const id of reader().ids(scope, only)) {
        const result = documentMemory.retryDocument(id)
        if (!result.ok) {
          if (result.error === 'paused') return { ok: false, retried, error: 'paused' }
          continue
        }
        retried++
      }
      activityCache.invalidate()
      return { ok: true, retried }
    },
  )
  ipcMain.handle(HOME_CHANNELS.retryDocumentIndex, (_event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
      throw new Error('Invalid document id')
    activityCache.invalidate()
    return getDocumentMemory()?.retryDocument(id) ?? { ok: false, error: 'unavailable' }
  })
  ipcMain.handle(HOME_CHANNELS.getIndexingActivity, (): HomeIndexingActivity => {
    // Cheap, in-memory state is read live; the aggregate SQL (chunk counts over the whole
    // store) is cached with a TTL scaled to its cost. See indexing-activity-cache.ts.
    const folder = getFolderScan()?.status() ?? null
    const key = `${folder?.root ?? ''}|${folder?.state ?? ''}|${folder?.errors ?? 0}`
    const heavy = activityCache.get(key, () => {
      const documentMemory = getDocumentMemory()
      const memory = documentMemory?.indexingActivityStatus()
      const modelError =
        memory?.modelState === 'error' ? shortCause(documentMemory?.status().lastError) : ''
      return {
        memory: {
          enabled: memory?.enabled ?? false,
          cpuMode: 'gentle' as const,
          modelState: memory?.modelState ?? 'not-loaded',
          ...(memory?.modelProgress === undefined ? {} : { modelProgress: memory.modelProgress }),
          pending: memory?.pending ?? 0,
          errors: memory?.errors ?? 0,
          ...(modelError ? { lastError: modelError } : {}),
        },
        folderProgress:
          folder?.root && documentMemory
            ? documentMemory.getFolderIndexProgress(
                folder.root,
                folder.state === 'complete',
                folder.errors,
              )
            : null,
      }
    })
    return { folder, ...heavy }
  })
}
