import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { DOCUMENT_INDEX_CHANNELS, type EverythingState } from '../../shared/fork/document-index-api'
import { EverythingSearch } from '../everything/es-client'
import {
  readEverythingSettings,
  writeEverythingSettings,
  type EverythingSettings,
} from '../everything/settings'

export interface EverythingController {
  search: EverythingSearch
  state(): EverythingState
  set(change: EverythingSettings): void
}

/** The Everything file-name search, with its on/off and es.exe path kept in the user data folder. */
export function createEverything(userData: string): EverythingController {
  const file = join(userData, 'everything.json')
  let settings = readEverythingSettings(file)
  const search = new EverythingSearch({
    enabled: () => settings.enabled,
    configuredPath: () => settings.path,
  })
  return {
    search,
    state: () => ({
      supported: process.platform === 'win32',
      enabled: settings.enabled,
      found: search.locate() !== null,
      ...(settings.path ? { path: settings.path } : {}),
    }),
    set(change) {
      settings = {
        enabled: change.enabled,
        ...(change.path?.trim() ? { path: change.path.trim().slice(0, 1024) } : {}),
      }
      writeEverythingSettings(file, settings)
    },
  }
}

/**
 * The handlers exist from the moment the app loads, but the controller is only built later in
 * start-up, so it is looked up at each call. Until it exists the answer is "not found yet".
 */
export function registerEverythingIpc(
  ipcMain: IpcMain,
  controller: () => EverythingController | null,
): void {
  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.getEverything,
    (): EverythingState =>
      controller()?.state() ?? {
        supported: process.platform === 'win32',
        enabled: true,
        found: false,
      },
  )
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.setEverything, (_event, change: unknown) => {
    const { enabled, path } = (change ?? {}) as { enabled?: unknown; path?: unknown }
    if (typeof enabled !== 'boolean') throw new Error('Invalid Everything setting')
    if (path !== undefined && typeof path !== 'string') throw new Error('Invalid Everything path')
    const current = controller()
    if (!current) throw new Error('Everything is not ready yet')
    current.set({ enabled, ...(path === undefined ? {} : { path }) })
    return current.state()
  })
}
