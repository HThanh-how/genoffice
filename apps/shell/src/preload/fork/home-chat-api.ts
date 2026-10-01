import type { IpcRenderer } from 'electron'
import {
  HOME_CHAT_CHANNELS,
  type HomeChatApi,
  type HomeChatSession,
  type HomeChatSessionSummary,
} from '../../shared/fork/home-chat-types'

/** Preload half of the Home assistant history API (spread into the home API object). */
export function createHomeChatPreloadApi(ipcRenderer: IpcRenderer): HomeChatApi {
  return {
    async homeChatList() {
      const rows = (await ipcRenderer.invoke(HOME_CHAT_CHANNELS.list)) as unknown
      return Array.isArray(rows) ? (rows as HomeChatSessionSummary[]) : []
    },
    async homeChatGet(id) {
      if (typeof id !== 'string') return null
      return (await ipcRenderer.invoke(HOME_CHAT_CHANNELS.get, id)) as HomeChatSession | null
    },
    async homeChatSave(input) {
      return (await ipcRenderer.invoke(
        HOME_CHAT_CHANNELS.save,
        input,
      )) as HomeChatSessionSummary | null
    },
    async homeChatRename(id, title) {
      if (typeof id !== 'string' || typeof title !== 'string') return null
      return (await ipcRenderer.invoke(
        HOME_CHAT_CHANNELS.rename,
        id,
        title,
      )) as HomeChatSessionSummary | null
    },
    async homeChatDelete(id) {
      if (typeof id !== 'string') return false
      return (await ipcRenderer.invoke(HOME_CHAT_CHANNELS.delete, id)) === true
    },
    async homeChatClear() {
      const count = (await ipcRenderer.invoke(HOME_CHAT_CHANNELS.clear)) as unknown
      return typeof count === 'number' ? count : 0
    },
  }
}
