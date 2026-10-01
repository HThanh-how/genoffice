import { BrowserWindow, app, clipboard } from 'electron'
import type { IpcMain } from 'electron'
import { readAppSettings, writeAppSettingThen } from '../app-settings'
import { electronClipboardSource } from '../clipboard-suggest'
import { CLIPBOARD_HISTORY_CHANNELS } from '../../shared/clipboard-history-api'
import {
  CLIPBOARD_HISTORY_ENABLED_KEY,
  ClipboardHistory,
  clipboardHistoryEnabledFrom,
} from './clipboard-history'

export interface ClipboardHistoryDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  settingsPath: () => string
  historyPath: () => string
}

let history: ClipboardHistory | null = null

export function registerClipboardHistory(deps: ClipboardHistoryDeps): void {
  let cachedEnabled: boolean | null = null
  const enabled = (): boolean => {
    cachedEnabled ??= clipboardHistoryEnabledFrom(readAppSettings(deps.settingsPath()))
    return cachedEnabled
  }
  const store = new ClipboardHistory(electronClipboardSource(clipboard), enabled, deps.historyPath)
  history = store
  deps.ipcMain.handle(CLIPBOARD_HISTORY_CHANNELS.getEnabled, () => enabled())
  deps.ipcMain.handle(CLIPBOARD_HISTORY_CHANNELS.setEnabled, (_event, value: unknown): boolean => {
    if (typeof value !== 'boolean') return false
    writeAppSettingThen(deps.settingsPath(), CLIPBOARD_HISTORY_ENABLED_KEY, value, (persisted) => {
      cachedEnabled = persisted
      store.settingsChanged()
    })
    return true
  })
  deps.ipcMain.handle(CLIPBOARD_HISTORY_CHANNELS.getEntries, () => store.list())
  deps.ipcMain.handle(CLIPBOARD_HISTORY_CHANNELS.clear, () => {
    if (!enabled()) return false
    store.clear()
    return true
  })
}

export function initClipboardHistory(): void {
  const store = history
  if (!store) return
  app.once('before-quit', () => store.dispose())
  app.on('browser-window-focus', () => store.setFocused(true))
  app.on('browser-window-blur', () => store.setFocused(false))
  store.settingsChanged()
  store.setFocused(BrowserWindow.getFocusedWindow() !== null)
}
