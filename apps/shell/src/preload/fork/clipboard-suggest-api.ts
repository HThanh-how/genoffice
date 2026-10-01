import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  CLIPBOARD_SUGGEST_CHANNELS,
  type ClipboardSuggestApi,
  type ClipboardSuggestion,
} from '../../shared/clipboard-suggest-api'
import { isClipboardSuggestion } from '../../shared/clipboard-suggest-guard'

/** Preload half of the opt-in clipboard suggestions (spread into the home API object). */
export function createClipboardSuggestPreloadApi(ipcRenderer: IpcRenderer): ClipboardSuggestApi {
  return {
    async getClipboardSuggestEnabled() {
      return (await ipcRenderer.invoke(CLIPBOARD_SUGGEST_CHANNELS.getEnabled)) === true
    },
    async setClipboardSuggestEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Invalid clipboard suggestion setting.')
      return (await ipcRenderer.invoke(CLIPBOARD_SUGGEST_CHANNELS.setEnabled, enabled)) === true
    },
    async getClipboardSuggestion() {
      const result: unknown = await ipcRenderer.invoke(CLIPBOARD_SUGGEST_CHANNELS.getCurrent)
      return isClipboardSuggestion(result) ? result : null
    },
    async dismissClipboardSuggestion(id) {
      if (typeof id !== 'string') return
      await ipcRenderer.invoke(CLIPBOARD_SUGGEST_CHANNELS.dismiss, id)
    },
    async getClipboardSuggestionText(id) {
      if (typeof id !== 'string') return null
      const result: unknown = await ipcRenderer.invoke(CLIPBOARD_SUGGEST_CHANNELS.getFullText, id)
      return typeof result === 'string' ? result : null
    },
    onClipboardSuggestion(handler) {
      const listener = (_event: IpcRendererEvent, payload: unknown) => {
        handler(isClipboardSuggestion(payload) ? (payload as ClipboardSuggestion) : null)
      }
      ipcRenderer.on(CLIPBOARD_SUGGEST_CHANNELS.changed, listener)
      return () => ipcRenderer.removeListener(CLIPBOARD_SUGGEST_CHANNELS.changed, listener)
    },
  }
}
