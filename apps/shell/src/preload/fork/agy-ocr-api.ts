import type { IpcRenderer } from 'electron'
import {
  AGY_OCR_CHANNELS,
  type AgyOcrApi,
  type AgyOcrModelList,
  type AgyOcrReadNowResult,
  type AgyOcrSettings,
  type AgyOcrStatus,
} from '../../shared/fork/agy-ocr'

/** Preload half of the scanned-PDF reader (Antigravity) settings (spread into the home API object). */
export function createAgyOcrPreloadApi(ipcRenderer: IpcRenderer): AgyOcrApi {
  return {
    async enqueueScannedPdfsWithAgy(ids, confirmed) {
      return ipcRenderer.invoke(AGY_OCR_CHANNELS.enqueue, ids, confirmed)
    },
    async cancelAgyOcr() {
      return (await ipcRenderer.invoke(AGY_OCR_CHANNELS.cancel)) === true
    },
    async refreshAgyOcrQuota() {
      return ipcRenderer.invoke(AGY_OCR_CHANNELS.refreshQuota)
    },
    async cancelScannedPdfsWithAgy(ids) {
      return ipcRenderer.invoke(AGY_OCR_CHANNELS.cancelDocuments, ids)
    },
    async getAgyOcrStatus(): Promise<AgyOcrStatus | null> {
      return ((await ipcRenderer.invoke(AGY_OCR_CHANNELS.getState)) as AgyOcrStatus | null) ?? null
    },
    async setAgyOcrSettings(patch: Partial<AgyOcrSettings>): Promise<AgyOcrSettings | null> {
      if (!patch || typeof patch !== 'object') throw new Error('Invalid settings.')
      return (
        ((await ipcRenderer.invoke(
          AGY_OCR_CHANNELS.setSettings,
          patch,
        )) as AgyOcrSettings | null) ?? null
      )
    },
    async listAgyOcrModels(): Promise<AgyOcrModelList> {
      const raw = (await ipcRenderer.invoke(AGY_OCR_CHANNELS.listModels)) as AgyOcrModelList | null
      return {
        models: Array.isArray(raw?.models) ? raw.models : [],
        ...(raw?.error ? { error: raw.error } : {}),
      }
    },
    async readScannedPdfWithAgy(documentId, confirmed): Promise<AgyOcrReadNowResult> {
      if (typeof documentId !== 'number' || typeof confirmed !== 'boolean')
        throw new Error('Invalid request.')
      return (await ipcRenderer.invoke(
        AGY_OCR_CHANNELS.readNow,
        documentId,
        confirmed,
      )) as AgyOcrReadNowResult
    },
  }
}
