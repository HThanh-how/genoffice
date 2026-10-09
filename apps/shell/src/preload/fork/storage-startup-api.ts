import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  STORAGE_STARTUP_CHANNELS,
  normalizeStorageStartupState,
  type StorageStartupApi,
  type StorageStartupState,
} from '../../shared/fork/storage-startup'

/** Preload half of the storage start-up progress (spread into the home API object). */
export function createStorageStartupPreloadApi(ipcRenderer: IpcRenderer): StorageStartupApi {
  return {
    async getStorageStartupState(): Promise<StorageStartupState> {
      return normalizeStorageStartupState(
        await ipcRenderer.invoke(STORAGE_STARTUP_CHANNELS.getState),
      )
    },
    onStorageStartupChanged(handler) {
      const listener = (_event: IpcRendererEvent, state: unknown): void =>
        handler(normalizeStorageStartupState(state))
      ipcRenderer.on(STORAGE_STARTUP_CHANNELS.changed, listener)
      return () => ipcRenderer.removeListener(STORAGE_STARTUP_CHANNELS.changed, listener)
    },
  }
}
