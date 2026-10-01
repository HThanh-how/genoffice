import { BrowserWindow, app, clipboard, webContents } from 'electron'
import type { IpcMain } from 'electron'
import { readAppSettings, writeAppSettingThen } from '../app-settings'
import {
  CLIPBOARD_SUGGEST_ENABLED_KEY,
  ClipboardWatcher,
  clipboardSuggestEnabledFrom,
  electronClipboardSource,
} from '../clipboard-suggest'
import { CLIPBOARD_SUGGEST_CHANNELS } from '../../shared/clipboard-suggest-api'
import type { ClipboardSuggestion } from '../../shared/clipboard-suggest-api'

// ---- opt-in clipboard suggestions (see src/main/clipboard-suggest.ts) ----
// OFF unless the user enabled it in Settings. Reads the clipboard only while
// a GenOffice window is focused; nothing is stored or sent anywhere.

export interface ClipboardSuggestDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** absolute path of app-settings.json */
  settingsPath: () => string
}

let watcher: ClipboardWatcher | null = null

/** Registers the clipboard suggestion channels and builds the watcher. Call once. */
export function registerClipboardSuggest(deps: ClipboardSuggestDeps): void {
  let cachedEnabled: boolean | null = null
  const enabled = (): boolean => {
    cachedEnabled ??= clipboardSuggestEnabledFrom(readAppSettings(deps.settingsPath()))
    return cachedEnabled
  }
  const w = new ClipboardWatcher({
    source: electronClipboardSource(clipboard),
    isEnabled: enabled,
    onChange: (suggestion: ClipboardSuggestion | null) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send(CLIPBOARD_SUGGEST_CHANNELS.changed, suggestion)
      }
    },
  })
  watcher = w
  const { ipcMain } = deps
  ipcMain.handle(CLIPBOARD_SUGGEST_CHANNELS.getEnabled, (): boolean => enabled())
  ipcMain.handle(CLIPBOARD_SUGGEST_CHANNELS.setEnabled, (_event, value: unknown): boolean => {
    if (typeof value !== 'boolean') return false
    writeAppSettingThen(deps.settingsPath(), CLIPBOARD_SUGGEST_ENABLED_KEY, value, (persisted) => {
      cachedEnabled = persisted
      w.settingsChanged()
    })
    return true
  })
  ipcMain.handle(CLIPBOARD_SUGGEST_CHANNELS.getCurrent, (): ClipboardSuggestion | null =>
    enabled() ? w.getCurrent() : null,
  )
  ipcMain.handle(CLIPBOARD_SUGGEST_CHANNELS.dismiss, (_event, id: unknown): void => {
    if (typeof id === 'string') w.dismiss(id)
  })
  ipcMain.handle(CLIPBOARD_SUGGEST_CHANNELS.getFullText, (_event, id: unknown): string | null =>
    typeof id === 'string' && enabled() ? w.getFullText(id) : null,
  )
}

/** Starts watching once the first window exists (after registerClipboardSuggest). */
export function initClipboardSuggest(): void {
  const w = watcher
  if (!w) return
  app.on('browser-window-focus', () => w.setFocused(true))
  app.on('browser-window-blur', () => w.setFocused(false))
  w.settingsChanged()
  w.setFocused(BrowserWindow.getFocusedWindow() !== null)
}
