import { dialog, type BrowserWindow, type IpcMain, type OpenDialogOptions } from 'electron'
import { isAbsolute } from 'node:path'
import {
  LOCAL_MODEL_CHANNELS as C,
  type LocalModelSelectOutcome,
  type LocalModelState,
} from '../../shared/fork/local-model-api'
import {
  createLocalModelManager,
  type LocalModelManager,
} from '../local-model/local-model-manager'

/**
 * IPC for the local chat model. Electron stays here: the manager (local-model-manager.ts) is plain
 * Node and only ever receives a file path. The renderer never sends a path either; choosing a file
 * goes through the system dialog opened by the main process.
 */

type DialogProvider = {
  showOpenDialog(
    ...args: [OpenDialogOptions] | [BrowserWindow, OpenDialogOptions]
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}

export interface LocalModelIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** the app's userData folder (models live in its local-models/ subfolder) */
  userDataPath: () => string
  /** the window a file dialog belongs to, when there is one */
  parentWindow?: () => BrowserWindow | null
  dialogProvider?: DialogProvider
  /** injected by tests; otherwise built from userDataPath */
  manager?: LocalModelManager
  /**
   * Runs before the model is deleted. The shell stops the local llama-server here: a running
   * server keeps the model file open, and Windows refuses to delete an open file.
   */
  beforeDelete?: () => void | Promise<void>
}

const OPEN_OPTIONS: OpenDialogOptions = {
  title: 'Choose the LFM3-VL-2B-Q4_K_M model file',
  properties: ['openFile'],
  filters: [
    { name: 'GGUF model', extensions: ['gguf'] },
    { name: 'All files', extensions: ['*'] },
  ],
}

/** Registers the handlers and returns the manager (the provider layer will read readyPath() from it). */
export function registerLocalModel(deps: LocalModelIpcDeps): LocalModelManager {
  const manager = deps.manager ?? createLocalModelManager({ userDataPath: deps.userDataPath() })
  const dialogProvider = deps.dialogProvider ?? (dialog as unknown as DialogProvider)
  // the first answer must reflect the disk (a model downloaded in an earlier session)
  const initial: Promise<unknown> = manager.refresh().catch(() => undefined)
  const current = async (): Promise<LocalModelState> => {
    await initial
    return manager.state()
  }

  deps.ipcMain.handle(C.getState, () => current())

  deps.ipcMain.handle(C.download, async () => {
    await initial
    // minutes long: the outcome lands in the state the renderer polls, never as a rejection here
    void manager.download().catch(() => undefined)
    return manager.state()
  })

  deps.ipcMain.handle(C.cancel, async () => {
    await initial
    return manager.cancel()
  })

  deps.ipcMain.handle(C.delete, async () => {
    await initial
    // release the file first; a failing hook must not keep the person from deleting the model
    await Promise.resolve()
      .then(() => deps.beforeDelete?.())
      .catch(() => undefined)
    return manager.delete()
  })

  deps.ipcMain.handle(C.selectExisting, async (): Promise<LocalModelSelectOutcome> => {
    await initial
    const parent = deps.parentWindow?.()
    const outcome =
      parent && !parent.isDestroyed()
        ? await dialogProvider.showOpenDialog(parent, OPEN_OPTIONS)
        : await dialogProvider.showOpenDialog(OPEN_OPTIONS)
    const picked = outcome.canceled ? undefined : outcome.filePaths[0]?.trim()
    if (!picked) return { ok: false, cancelled: true, state: manager.state() }
    if (/[\r\n\0]/.test(picked) || !isAbsolute(picked)) {
      return {
        ok: false,
        error: { code: 'not-found', message: 'The chosen path is not a valid file path.' },
        state: manager.state(),
      }
    }
    return manager.selectExisting(picked)
  })

  return manager
}
