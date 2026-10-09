import { dirname } from 'node:path'
import {
  DOCUMENT_INDEX_CHANNELS,
  type StorageBudgetConfig,
  type StorageBudgetPreset,
} from '../../shared/fork/document-index-api'
import {
  ensureStorageSettings,
  writeStorageSettings,
  validateStorageBudgetBytes,
  validateStorageBudgetVersion,
  isValidStoragePreset,
} from '../document-memory/storage/storage-settings'
import { snapshotCache, diagnosticsCache } from './document-index-snapshot-service'
import type { DocumentIndexIpcDeps } from './document-index-ipc'

export function registerDocumentIndexStorageHandlers(deps: DocumentIndexIpcDeps): void {
  const { ipcMain, getDocumentMemory, dbPath, settingsPath } = deps

  const getSettingsDir = (): string => {
    if (settingsPath) {
      const sPath = typeof settingsPath === 'function' ? settingsPath() : settingsPath
      if (sPath) return dirname(sPath)
    }
    return dirname(dbPath())
  }

  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.getStorageBudgetSettings,
    async (): Promise<StorageBudgetConfig> => {
      const memory = getDocumentMemory()
      if (memory && typeof (memory as any).getStorageBudgetConfig === 'function') {
        return (memory as any).getStorageBudgetConfig()
      }
      return ensureStorageSettings(getSettingsDir())
    },
  )

  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.setStorageBudgetSettings,
    async (
      _event,
      input: unknown,
    ): Promise<{ ok: boolean; settings?: StorageBudgetConfig; error?: string }> => {
      let targetBytes: number | undefined
      let targetPreset: StorageBudgetPreset | undefined
      let targetVersion: number | undefined

      if (typeof input === 'number') {
        targetBytes = input
      } else if (input && typeof input === 'object') {
        const obj = input as { maxDatabaseBytes?: unknown; preset?: unknown; version?: unknown }
        if (typeof obj.maxDatabaseBytes === 'number') {
          targetBytes = obj.maxDatabaseBytes
        }
        if (typeof obj.preset === 'string' && isValidStoragePreset(obj.preset)) {
          targetPreset = obj.preset
        }
        if (obj.version !== undefined) {
          if (!validateStorageBudgetVersion(obj.version)) {
            return { ok: false, error: 'invalid-version' }
          }
          targetVersion = obj.version
        }
      } else {
        return { ok: false, error: 'invalid-argument' }
      }

      if (targetBytes !== undefined && !validateStorageBudgetBytes(targetBytes)) {
        return { ok: false, error: 'invalid-budget-range' }
      }

      const memory = getDocumentMemory()
      try {
        let updated: StorageBudgetConfig
        if (memory && typeof (memory as any).setStorageBudget === 'function') {
          updated = await (memory as any).setStorageBudget({
            maxDatabaseBytes: targetBytes,
            preset: targetPreset,
            version: targetVersion,
          })
        } else {
          updated = writeStorageSettings(getSettingsDir(), {
            maxDatabaseBytes: targetBytes,
            preset: targetPreset,
            version: targetVersion,
          })
        }

        snapshotCache.clear()
        diagnosticsCache.clear()

        const isApplied =
          updated.status === 'applied' &&
          typeof updated.appliedVersion === 'number' &&
          typeof updated.version === 'number' &&
          updated.appliedVersion === updated.version
        if (!isApplied) {
          return {
            ok: false,
            settings: updated,
            error: updated.error ?? (updated.status === 'pending' ? 'budget-pending-worker-ack' : 'apply-failed'),
          }
        }

        return { ok: true, settings: updated }
      } catch (err: any) {
        return { ok: false, error: err?.message ?? 'save-failed' }
      }
    },
  )
}
