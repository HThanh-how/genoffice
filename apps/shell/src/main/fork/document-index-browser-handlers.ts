import { stat } from 'node:fs/promises'
import { DOCUMENT_INDEX_CHANNELS } from '../../shared/fork/document-index-api'
import type { DocumentIndexIpcDeps } from './document-index-ipc'
import type { IndexIssueReader } from '../document-memory/issue-reader'
import { isPathIgnored } from '../document-memory/ignore-policy'
import { validateBrowserQuery } from '../document-memory/index-browser-reader'
import { rootAvailability } from '../document-memory/root-availability'

/** User-initiated metadata reads; database work uses the existing reader thread. */
export function registerIndexBrowserHandlers(
  deps: DocumentIndexIpcDeps,
  reader: () => IndexIssueReader,
) {
  deps.ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getIndexFileDetail, async (_event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('id')
    const memory = deps.getDocumentMemory()
    if (!memory) return null
    const detail = memory.aggregates ? await memory.aggregates.detail(id) : reader().detail(id)
    if (!detail || isPathIgnored(detail.path)) return null
    if (!rootAvailability.selectable(detail.path))
      return { ...detail, exists: false, sourceOffline: true }
    const exists = await stat(detail.path).then(
      (s) => s.isFile(),
      () => false,
    )
    return { ...detail, exists }
  })
  deps.ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.getIndexBrowserPage,
    async (_event, value: unknown) => {
      const query = validateBrowserQuery(value)
      const aggregates = deps.getDocumentMemory()?.aggregates
      if (!aggregates) throw new Error('Index reader unavailable')
      return aggregates.browse(query)
    },
  )
}
