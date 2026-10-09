import type { IpcMain } from 'electron'
import {
  STORAGE_STARTUP_CHANNELS,
  type StorageStartupPhase,
  type StorageStartupState,
} from '../../shared/fork/storage-startup'

export interface StorageStartupDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** every window that should hear about progress (the shell window; tabs ignore the channel) */
  send: (channel: string, state: StorageStartupState) => void
}

export interface StorageStartupTracker {
  get(): StorageStartupState
  set(phase: StorageStartupPhase, percent?: number | null): void
}

/**
 * Holds the document-memory storage start-up state and answers the renderer. It is registered before the window
 * exists and starts at "checking", so the first read of a window that opens mid-migration already says so.
 */
export function registerStorageStartup(deps: StorageStartupDeps): StorageStartupTracker {
  let state: StorageStartupState = { phase: 'checking', percent: null }
  deps.ipcMain.handle(STORAGE_STARTUP_CHANNELS.getState, () => state)
  return {
    get: () => state,
    set(phase, percent = null) {
      const next: StorageStartupState = { phase, percent }
      if (next.phase === state.phase && next.percent === state.percent) return
      state = next
      deps.send(STORAGE_STARTUP_CHANNELS.changed, state)
    },
  }
}
