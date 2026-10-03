import type { IpcRenderer } from 'electron'
import {
  DOCUMENT_INDEX_CHANNELS,
  type DocumentIndexApi,
} from '../../shared/fork/document-index-api'
import type { AgyOcrApi } from '../../shared/fork/agy-ocr'
import type { IndexingModeApi } from '../../shared/fork/indexing-mode'
import { createAgyOcrPreloadApi } from './agy-ocr-api'
import { createIndexingModePreloadApi } from './indexing-mode-api'
import type { AiInstructionsApi } from '../../shared/fork/ai-instructions-meta'
import { createAiInstructionsPreloadApi } from './ai-instructions-api'

/** Preload half of the document-index popup additions (spread into the home API object). */
export function createDocumentIndexPreloadApi(
  ipcRenderer: IpcRenderer,
): DocumentIndexApi & IndexingModeApi & AgyOcrApi & AiInstructionsApi {
  return {
    ...createAiInstructionsPreloadApi(ipcRenderer),
    // Indexing effort setting (Light / Balanced / Fast), shown in the same Settings section.
    ...createIndexingModePreloadApi(ipcRenderer),
    // Scanned-PDF reader (Antigravity): settings, live status, manual "read now".
    ...createAgyOcrPreloadApi(ipcRenderer),
    async getDocumentIndexIssueSummary(root) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getDocumentIndexIssueSummary, root)
    },
    async getIndexingNow() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getIndexingNow)
    },
    async getDbLocation() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getDbLocation)
    },
    async chooseDbLocation() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.chooseDbLocation)
    },
    async resetDbLocation() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.resetDbLocation)
    },
    async cancelDbMove() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.cancelDbMove)
    },
    async restartForDbMove() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.restartForDbMove)
    },
    async getPdfPages() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getPdfPages)
    },
    async setPdfPages(pages) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.setPdfPages, pages)
    },
    async openFolderInFileManager(dir) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.openFolderInFileManager, dir)
    },
    async copyFilesToClipboard(paths) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.copyFilesToClipboard, paths)
    },
    async pasteFilesFromClipboard(dir) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.pasteFilesFromClipboard, dir)
    },
    async getShowDefaultFolder() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getShowDefaultFolder)
    },
    async setShowDefaultFolder(show) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.setShowDefaultFolder, show)
    },
    async getEverything() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getEverything)
    },
    async setEverything(change) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.setEverything, change)
    },
    async deferIndexFile(documentId) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.deferIndexFile, documentId)
    },
    async stopIndexFile(documentId) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.stopIndexFile, documentId)
    },
    async searchIndexedFiles(query) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.searchIndexedFiles, query)
    },
    async getIndexFileDetail(documentId) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getIndexFileDetail, documentId)
    },
    async retryDocumentIndexGroup(root, reason) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.retryDocumentIndexGroup, root, reason)
    },
    async listIndexedFolders() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.listIndexedFolders)
    },
    async setIndexedFolderPriority(root, priority) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.setIndexedFolderPriority, root, priority)
    },
    async rescanIndexedFolder(root) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.rescanIndexedFolder, root)
    },
    async getEmbeddingModel() {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.getEmbeddingModel)
    },
    async setEmbeddingModel(profile) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.setEmbeddingModel, profile)
    },
    async forgetIndexedFolder(root) {
      return ipcRenderer.invoke(DOCUMENT_INDEX_CHANNELS.forgetIndexedFolder, root)
    },
  }
}
