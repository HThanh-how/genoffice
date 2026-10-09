/**
 * Start-up state of the document-memory storage (fork-only): the window opens first, while the
 * database check / V2 -> V3 migration runs off the main thread, and the renderer follows it here.
 */

export type StorageStartupPhase =
  /** inspecting / verifying the database */
  | 'checking'
  /** copying a legacy database into the current layout */
  | 'migrating'
  /** post-migration repair and bookkeeping */
  | 'finalizing'
  /** the index is open */
  | 'ready'
  /** the index stays closed this run (fail-closed); the documents themselves are untouched */
  | 'unavailable'

export interface StorageStartupState {
  phase: StorageStartupPhase
  /** 0..100 while migrating, null when the step has no meaningful fraction */
  percent: number | null
}

export const STORAGE_STARTUP_CHANNELS = {
  getState: 'storage-startup:get-state',
  changed: 'storage-startup:changed',
} as const

const PHASES: readonly StorageStartupPhase[] = [
  'checking',
  'migrating',
  'finalizing',
  'ready',
  'unavailable',
]

/** True while the index is still being prepared (the banner is shown). */
export function isStorageStartupBusy(state: StorageStartupState): boolean {
  return state.phase === 'checking' || state.phase === 'migrating' || state.phase === 'finalizing'
}

/** Defensive parse of an IPC payload: anything unrecognised reads as "nothing to show". */
export function normalizeStorageStartupState(value: unknown): StorageStartupState {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const phase = PHASES.find((p) => p === raw.phase) ?? 'ready'
  const percent =
    typeof raw.percent === 'number' && Number.isFinite(raw.percent)
      ? Math.min(100, Math.max(0, Math.round(raw.percent)))
      : null
  return { phase, percent }
}

/** Renderer-facing methods, merged into HomeApi via ForkHomeApi. */
export interface StorageStartupApi {
  getStorageStartupState(): Promise<StorageStartupState>
  /** Subscribe to start-up progress; returns the unsubscribe function. */
  onStorageStartupChanged(handler: (state: StorageStartupState) => void): () => void
}
