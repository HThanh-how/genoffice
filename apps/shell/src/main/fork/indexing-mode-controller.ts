import type { IpcMain } from 'electron'
import { readAppSettings, writeAppSettingThen } from '../app-settings'
import {
  INDEXING_MODE_CHANNELS,
  INDEXING_MODE_KEY,
  PAUSE_INDEXING_ON_BATTERY_KEY,
  indexingModeFrom,
  isIndexingMode,
  pauseOnBatteryFrom,
  type IndexingMode,
  type IndexingModeState,
} from '../../shared/fork/indexing-mode'
import { currentIndexingPolicy, effectiveStateOf } from './indexing-policy-bus'

export interface IndexingModeIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** absolute path of app-settings.json */
  settingsPath: () => string
  /** called after a setting was persisted (re-resolves the policy immediately) */
  onSettingsChanged?: () => void
}

export interface IndexingSettings {
  mode: IndexingMode
  pauseOnBattery: boolean
}

/**
 * Persists the indexing mode and the pause-on-battery switch in app-settings.json and serves
 * them (with the live effective state) to the renderer. Mirrors clipboard-suggest-ipc.ts.
 */
export function registerIndexingModeIpc(deps: IndexingModeIpcDeps): {
  settings: () => IndexingSettings
} {
  let cached: IndexingSettings | null = null
  const settings = (): IndexingSettings => {
    if (!cached) {
      const stored = readAppSettings(deps.settingsPath())
      cached = { mode: indexingModeFrom(stored), pauseOnBattery: pauseOnBatteryFrom(stored) }
    }
    return cached
  }
  const apply = (next: IndexingSettings): void => {
    cached = next
    deps.onSettingsChanged?.()
  }
  const { ipcMain } = deps
  ipcMain.handle(INDEXING_MODE_CHANNELS.getState, (): IndexingModeState => ({
    ...settings(),
    effective: effectiveStateOf(currentIndexingPolicy()),
  }))
  ipcMain.handle(INDEXING_MODE_CHANNELS.setMode, (_event, value: unknown): boolean => {
    if (!isIndexingMode(value)) return false
    try {
      writeAppSettingThen(deps.settingsPath(), INDEXING_MODE_KEY, value, (mode) =>
        apply({ ...settings(), mode }),
      )
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle(INDEXING_MODE_CHANNELS.setPauseOnBattery, (_event, value: unknown): boolean => {
    if (typeof value !== 'boolean') return false
    try {
      writeAppSettingThen(deps.settingsPath(), PAUSE_INDEXING_ON_BATTERY_KEY, value, (pause) =>
        apply({ ...settings(), pauseOnBattery: pause }),
      )
      return true
    } catch {
      return false
    }
  })
  return { settings }
}
