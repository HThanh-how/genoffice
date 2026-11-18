/**
 * The local chat model (LFM3-VL-2B-Q4_K_M) as the renderer sees it: its state on this computer and
 * the actions on it. Implemented by main/local-model/local-model-manager.ts, carried over IPC by
 * main/fork/local-model-ipc.ts and preload/fork/local-model-api.ts.
 */

export type LocalModelStatus = 'not-installed' | 'downloading' | 'ready' | 'error'

export type LocalModelErrorCode =
  /** host unreachable or too slow after retries (a partial file may remain: download resumes it) */
  | 'network'
  /** the downloaded bytes did not match the pinned SHA-256 or size; the file was deleted */
  | 'checksum'
  /** a chosen file is not this model (size or SHA-256 differ) */
  | 'wrong-model'
  /** not enough free disk space (checked before starting, or the disk filled while writing) */
  | 'disk-space'
  /** the repository answered 401/403/404 */
  | 'unavailable'
  /** another GenOffice process holds the download lock */
  | 'busy'
  /** a chosen path does not exist (any more) */
  | 'not-found'

export interface LocalModelError {
  code: LocalModelErrorCode
  message: string
}

export interface LocalModelState {
  status: LocalModelStatus
  modelId: string
  /** size of the model file */
  totalBytes: number
  /** bytes on disk so far (status 'downloading') */
  doneBytes?: number
  /** bytes of an interrupted download that a new download resumes */
  partialBytes?: number
  /** status 'ready': where the model came from and the file to load */
  source?: 'downloaded' | 'selected'
  path?: string
  error?: LocalModelError
}

export type SelectResult =
  | { ok: true; state: LocalModelState }
  | { ok: false; error: LocalModelError; state: LocalModelState }

/** Outcome of the "choose a model file" action: the dialog may also simply be closed. */
export type LocalModelSelectOutcome = SelectResult | { ok: false; cancelled: true; state: LocalModelState }

export const LOCAL_MODEL_CHANNELS = {
  getState: 'local-model:get-state',
  download: 'local-model:download',
  cancel: 'local-model:cancel',
  delete: 'local-model:delete',
  selectExisting: 'local-model:select-existing',
} as const

/** Renderer-facing methods, merged into HomeApi through ForkHomeApi. */
export interface LocalModelApi {
  /** current state (poll it while a download runs) */
  getLocalModelState(): Promise<LocalModelState>
  /** start or resume the download; answers at once with the state, progress arrives by polling */
  downloadLocalModel(): Promise<LocalModelState>
  /** stop a download and delete its partial file */
  cancelLocalModelDownload(): Promise<LocalModelState>
  /** remove the downloaded model and forget a chosen file (which itself is never deleted) */
  deleteLocalModel(): Promise<LocalModelState>
  /** open a file dialog and use the chosen file if its size and SHA-256 match the model */
  selectExistingLocalModel(): Promise<LocalModelSelectOutcome>
}
