import type { IpcRenderer } from 'electron'
import { LOCAL_MODEL_CHANNELS as C, type LocalModelApi } from '../../shared/fork/local-model-api'

/** Preload half of the local chat model API (spread into window.aiOffice). */
export function createLocalModelPreloadApi(ipcRenderer: IpcRenderer): LocalModelApi {
  return {
    getLocalModelState: () => ipcRenderer.invoke(C.getState),
    downloadLocalModel: () => ipcRenderer.invoke(C.download),
    cancelLocalModelDownload: () => ipcRenderer.invoke(C.cancel),
    deleteLocalModel: () => ipcRenderer.invoke(C.delete),
    selectExistingLocalModel: () => ipcRenderer.invoke(C.selectExisting),
  }
}
