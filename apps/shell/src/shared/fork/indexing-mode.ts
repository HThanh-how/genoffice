/** Background-indexing effort setting (fork-only): types, channels and persisted defaults. */

export type IndexingMode = 'light' | 'balanced' | 'fast'
export const INDEXING_MODES: readonly IndexingMode[] = ['light', 'balanced', 'fast']
export const DEFAULT_INDEXING_MODE: IndexingMode = 'balanced'
export const DEFAULT_PAUSE_ON_BATTERY = true

/** app-settings.json keys. */
export const INDEXING_MODE_KEY = 'indexingMode'
export const PAUSE_INDEXING_ON_BATTERY_KEY = 'pauseIndexingOnBattery'
export type IndexingPauseReason =
  | 'battery'
  | 'low-battery'
  | 'battery-saver'
  | 'locked'
  | 'low-memory'
  | 'thermal'
  | 'user'
  | 'suspended'

export type PauseReason = IndexingPauseReason

/** Coarse state the UI describes in one sentence. */
export type IndexingTier = 'paused' | 'battery' | 'light' | 'active' | 'idle'

export interface IndexingEffectiveState {
  tier: IndexingTier
  paused: boolean
  pauseReason?: IndexingPauseReason
  threads: number
  /** 0..1 duty cycle; 1 means uncapped */
  cpuShare: number
  onBattery: boolean
  memoryTier?: 'low' | 'normal' | 'high'
}

export interface IndexingModeState {
  mode: IndexingMode
  pauseOnBattery: boolean
  /** null until the monitor has produced its first reading */
  effective: IndexingEffectiveState | null
}

export const INDEXING_MODE_CHANNELS = {
  getState: 'indexing-mode:get-state',
  setMode: 'indexing-mode:set-mode',
  setPauseOnBattery: 'indexing-mode:set-pause-on-battery',
} as const

/** Renderer-facing methods, merged into HomeApi via DocumentIndexApi. */
export interface IndexingModeApi {
  getIndexingModeState(): Promise<IndexingModeState>
  setIndexingMode(mode: IndexingMode): Promise<boolean>
  setPauseIndexingOnBattery(value: boolean): Promise<boolean>
}

export function isIndexingMode(value: unknown): value is IndexingMode {
  return value === 'light' || value === 'balanced' || value === 'fast'
}

export function indexingModeFrom(settings: Record<string, unknown>): IndexingMode {
  const value = settings[INDEXING_MODE_KEY]
  return isIndexingMode(value) ? value : DEFAULT_INDEXING_MODE
}

export function pauseOnBatteryFrom(settings: Record<string, unknown>): boolean {
  const value = settings[PAUSE_INDEXING_ON_BATTERY_KEY]
  return typeof value === 'boolean' ? value : DEFAULT_PAUSE_ON_BATTERY
}
