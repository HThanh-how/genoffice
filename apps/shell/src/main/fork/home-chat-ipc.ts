import type { IpcMain } from 'electron'
import { HOME_CHAT_CHANNELS } from '../../shared/fork/home-chat-types'
import { HomeChatStore } from './home-chat-store'

/** Registers the Home assistant history channels; every input is validated by the store. */
export function registerHomeChatIpc(ipcMain: IpcMain, dir: string): HomeChatStore {
  const store = new HomeChatStore(dir)
  ipcMain.handle(HOME_CHAT_CHANNELS.list, () => store.list())
  ipcMain.handle(HOME_CHAT_CHANNELS.get, (_event, id: unknown) => store.get(id))
  ipcMain.handle(HOME_CHAT_CHANNELS.save, (_event, input: unknown) => store.save(input))
  ipcMain.handle(HOME_CHAT_CHANNELS.rename, (_event, id: unknown, title: unknown) =>
    store.rename(id, title),
  )
  ipcMain.handle(HOME_CHAT_CHANNELS.delete, (_event, id: unknown) => store.delete(id))
  ipcMain.handle(HOME_CHAT_CHANNELS.clear, () => store.clear())
  return store
}
