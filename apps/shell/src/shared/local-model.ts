import type { LocalProgress } from '@genoffice/local-llm/protocol'

export interface LocalModelState {
  status: 'missing' | 'checking' | 'downloading' | 'verifying' | 'paused' | 'ready' | 'error'
  percent: number
  error?: string
}
export type LocalModelOfferAnswer = 'use' | 'later'

/** Pushed by the main process to the shell window. */
export const LOCAL_MODEL_EVENTS = {
  /** a download just finished (never sent for a model that was already on disk) */
  downloaded: 'local-model:downloaded',
  /** the answer of localModelOffer() may have changed */
  offerChanged: 'local-model:offer-changed',
  /** a step of the load that "Use now" started; carries a LocalModelStartup */
  startup: 'local-model:startup',
} as const

/** The background load after "Use now": its steps, then how it ended. */
export type LocalModelStartup =
  | LocalProgress
  | { phase: 'ready' }
  /** nothing was loaded and nothing went wrong (the model is set not to stay in memory) */
  | { phase: 'skipped' }
  | { phase: 'failed'; error: string }

export interface LocalModelApi {
  localModelLicense(): Promise<void>
  localModelStatus(): Promise<LocalModelState>
  localModelAction(action: 'download' | 'cancel' | 'delete'): Promise<LocalModelState>
  onLocalModelDownloaded(handler: () => void): () => void
  /** whether "Use Local AI now?" is open */
  localModelOffer(): Promise<boolean>
  onLocalModelOfferChanged(handler: () => void): () => void
  /** 'use' is sent after the provider was saved; it also starts loading the model in the background */
  localModelAnswerOffer(answer: LocalModelOfferAnswer): Promise<void>
  onLocalModelStartup(handler: (startup: LocalModelStartup) => void): () => void
}
