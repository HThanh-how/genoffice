import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  LIVE_BACKGROUND_CHANNELS,
  normalizeLiveBackgroundState,
  type LiveBackgroundApi,
} from '../../shared/fork/live-background'

/** Preload half of the optional live background (spread into the home API object). */
export function createLiveBackgroundPreloadApi(ipcRenderer: IpcRenderer): LiveBackgroundApi {
  return {
    async scanLiveBackgroundWorkshop() {
      return ipcRenderer.invoke(LIVE_BACKGROUND_CHANNELS.scan)
    },
    async selectLiveBackgroundWorkshop(index) {
      return normalizeLiveBackgroundState(
        await ipcRenderer.invoke(LIVE_BACKGROUND_CHANNELS.selectWorkshop, index),
      )
    },
    async getLiveBackground() {
      return normalizeLiveBackgroundState(
        await ipcRenderer.invoke(LIVE_BACKGROUND_CHANNELS.getState),
      )
    },
    async setLiveBackgroundPrefs(patch) {
      return normalizeLiveBackgroundState(
        await ipcRenderer.invoke(LIVE_BACKGROUND_CHANNELS.setPrefs, patch),
      )
    },
    async pickLiveBackgroundSource(mode) {
      return normalizeLiveBackgroundState(
        await ipcRenderer.invoke(LIVE_BACKGROUND_CHANNELS.pickSource, mode),
      )
    },
    onLiveBackgroundChanged(handler) {
      const listener = (_event: IpcRendererEvent, state: unknown): void =>
        handler(normalizeLiveBackgroundState(state))
      ipcRenderer.on(LIVE_BACKGROUND_CHANNELS.changed, listener)
      return () => ipcRenderer.removeListener(LIVE_BACKGROUND_CHANNELS.changed, listener)
    },
  }
}
