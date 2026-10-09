import {
  DOCUMENT_INDEX_CHANNELS,
  type FileImportanceOverride,
} from '../../shared/fork/document-index-api'
import type { DocumentIndexIpcDeps } from './document-index-ipc'

const VALID_IMPORTANCE: ReadonlySet<string> = new Set(['auto', 'important', 'low'])

export function registerDocumentIndexImportanceHandlers(deps: DocumentIndexIpcDeps): void {
  const { ipcMain, getDocumentMemory } = deps

  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.setIndexFileImportance,
    async (_event, documentId: unknown, importance: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (
        typeof documentId !== 'number' ||
        !Number.isSafeInteger(documentId) ||
        documentId < 1 ||
        typeof importance !== 'string' ||
        !VALID_IMPORTANCE.has(importance)
      ) {
        return { ok: false, error: 'invalid-argument' }
      }

      const memory = getDocumentMemory()
      if (!memory) return { ok: false, error: 'unavailable' }

      try {
        const success = memory.store.setImportanceOverride(
          documentId,
          importance as FileImportanceOverride,
        )
        if (!success) {
          return { ok: false, error: 'not-found' }
        }
        return { ok: true }
      } catch (err: any) {
        return { ok: false, error: err?.message ?? 'save-failed' }
      }
    },
  )
}
