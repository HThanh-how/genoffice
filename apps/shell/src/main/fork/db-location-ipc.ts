import type { IpcMain } from 'electron'
import {
  cancelDbMove,
  dbLocationState,
  planDbMove,
  type DbLocationState,
} from '../document-memory/db-location'
import { DOCUMENT_INDEX_CHANNELS, type DbMoveResult } from '../../shared/fork/document-index-api'

export interface DbLocationIpcDeps {
  ipcMain: IpcMain
  /** the app's data folder: where the index starts out */
  userData: string
  /** ask the person for a folder; null when they cancel */
  pickFolder: () => Promise<string | null>
  /** quit and start again so a scheduled move is carried out */
  restart: () => void
}

/** Where the index is kept, and moving it (the move itself happens at the next start). */
export function registerDbLocationIpc(deps: DbLocationIpcDeps): void {
  const { ipcMain, userData } = deps
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getDbLocation, (): DbLocationState =>
    dbLocationState(userData),
  )
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.chooseDbLocation, async (): Promise<DbMoveResult> => {
    const folder = await deps.pickFolder()
    if (!folder) return { ok: false, canceled: true }
    return planDbMove(userData, folder)
  })
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.resetDbLocation, (): DbMoveResult =>
    planDbMove(userData, userData),
  )
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.cancelDbMove, () => cancelDbMove(userData))
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.restartForDbMove, () => deps.restart())
}
