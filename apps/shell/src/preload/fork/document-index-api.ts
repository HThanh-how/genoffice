import type { IpcRenderer } from 'electron'
import {
  DOCUMENT_INDEX_CHANNELS,
  type DocumentIndexApi,
} from '../../shared/fork/document-index-api'

/** Preload half of the document-index popup additions (spread into the home API object). */
export function createDocumentIndexPreloadApi(ipcRenderer: IpcRenderer): DocumentIndexApi {
  return {
    async getDocumentIndexIssueSummary(root) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getDocumentIndexIssueSummary, root)
    },
    async retryDocumentIndexGroup(root, reason) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.retryDocumentIndexGroup, root, reason)
    },
  }
}
