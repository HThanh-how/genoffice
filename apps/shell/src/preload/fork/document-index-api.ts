import type { IpcRenderer } from 'electron'
import {
  DOCUMENT_INDEX_CHANNELS,
  type DocumentIndexApi,
} from '../../shared/fork/document-index-api'
import type { AgyOcrApi } from '../../shared/fork/agy-ocr'
import type { IndexingModeApi } from '../../shared/fork/indexing-mode'
import { createAgyOcrPreloadApi } from './agy-ocr-api'
import { createIndexingModePreloadApi } from './indexing-mode-api'

/** Preload half of the document-index popup additions (spread into the home API object). */
export function createDocumentIndexPreloadApi(
  ipcRenderer: IpcRenderer,
): DocumentIndexApi & IndexingModeApi & AgyOcrApi {
  return {
    // Indexing effort setting (Light / Balanced / Fast), shown in the same Settings section.
    ...createIndexingModePreloadApi(ipcRenderer),
    // Scanned-PDF reader (Antigravity): settings, live status, manual "read now".
    ...createAgyOcrPreloadApi(ipcRenderer),
    async getDocumentIndexIssueSummary(root) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getDocumentIndexIssueSummary, root)
    },
    async retryDocumentIndexGroup(root, reason) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.retryDocumentIndexGroup, root, reason)
    },
  }
}
