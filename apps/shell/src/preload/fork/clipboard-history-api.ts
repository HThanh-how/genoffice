import type { IpcRenderer } from 'electron'
import { CLIPBOARD_HISTORY_CHANNELS } from '../../shared/clipboard-history-api'
import type { ClipboardHistoryApi, ClipboardHistoryEntry } from '../../shared/clipboard-history-api'

export function createClipboardHistoryPreloadApi(ipcRenderer: IpcRenderer): ClipboardHistoryApi {
  return {
    async getClipboardHistoryEnabled() {
      return (await ipcRenderer.invoke(CLIPBOARD_HISTORY_CHANNELS.getEnabled)) === true
    },
    async setClipboardHistoryEnabled(enabled) {
      if (typeof enabled !== 'boolean') return false
      return (await ipcRenderer.invoke(CLIPBOARD_HISTORY_CHANNELS.setEnabled, enabled)) === true
    },
    async getClipboardHistory() {
      const value: unknown = await ipcRenderer.invoke(CLIPBOARD_HISTORY_CHANNELS.getEntries)
      if (!Array.isArray(value)) return []
      return value.filter(
        (entry): entry is ClipboardHistoryEntry =>
          !!entry &&
          typeof entry.id === 'string' &&
          typeof entry.text === 'string' &&
          typeof entry.copiedAt === 'number' &&
          (entry.kind === undefined || entry.kind === 'text' || entry.kind === 'image'),
      )
    },
    async restoreClipboardHistoryImage(id) {
      if (typeof id !== 'string') return false
      return (await ipcRenderer.invoke(CLIPBOARD_HISTORY_CHANNELS.restoreImage, id)) === true
    },
    async clearClipboardHistory() {
      return (await ipcRenderer.invoke(CLIPBOARD_HISTORY_CHANNELS.clear)) === true
    },
  }
}
