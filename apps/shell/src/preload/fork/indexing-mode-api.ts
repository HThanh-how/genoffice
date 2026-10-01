import type { IpcRenderer } from 'electron'
import {
  INDEXING_MODE_CHANNELS,
  isIndexingMode,
  type IndexingEffectiveState,
  type IndexingModeApi,
  type IndexingModeState,
} from '../../shared/fork/indexing-mode'

const TIERS = new Set(['paused', 'battery', 'light', 'active', 'idle'])
const REASONS = new Set([
  'battery',
  'low-battery',
  'battery-saver',
  'locked',
  'low-memory',
  'thermal',
  'user',
])

function effectiveFrom(value: unknown): IndexingEffectiveState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.tier !== 'string' || !TIERS.has(v.tier)) return null
  if (typeof v.threads !== 'number' || typeof v.cpuShare !== 'number') return null
  return {
    tier: v.tier as IndexingEffectiveState['tier'],
    paused: v.paused === true,
    ...(typeof v.pauseReason === 'string' && REASONS.has(v.pauseReason)
      ? { pauseReason: v.pauseReason as IndexingEffectiveState['pauseReason'] }
      : {}),
    threads: v.threads,
    cpuShare: v.cpuShare,
    onBattery: v.onBattery === true,
  }
}

/** Preload half of the indexing-mode setting (spread into the home API object). */
export function createIndexingModePreloadApi(ipcRenderer: IpcRenderer): IndexingModeApi {
  return {
    async getIndexingModeState(): Promise<IndexingModeState> {
      const raw: unknown = await ipcRenderer.invoke(INDEXING_MODE_CHANNELS.getState)
      const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      return {
        mode: isIndexingMode(v.mode) ? v.mode : 'balanced',
        pauseOnBattery: typeof v.pauseOnBattery === 'boolean' ? v.pauseOnBattery : true,
        effective: effectiveFrom(v.effective),
      }
    },
    async setIndexingMode(mode) {
      if (!isIndexingMode(mode)) throw new Error('Invalid indexing mode.')
      return (await ipcRenderer.invoke(INDEXING_MODE_CHANNELS.setMode, mode)) === true
    },
    async setPauseIndexingOnBattery(value) {
      if (typeof value !== 'boolean') throw new Error('Invalid indexing setting.')
      return (await ipcRenderer.invoke(INDEXING_MODE_CHANNELS.setPauseOnBattery, value)) === true
    },
  }
}
