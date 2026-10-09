import { dirname } from 'node:path'
import {
  DOCUMENT_INDEX_CHANNELS,
  type DocumentIndexBackupDeleteResult,
  type DocumentIndexBackupInfo,
} from '../../shared/fork/document-index-api'
import { readBackupRetentionDays } from '../document-memory/storage/migration/backup-retention-settings'
import {
  deleteV2Backups,
  inventoryV2Backups,
  isLiveV3Database,
  isMigrationInFlight,
} from '../document-memory/storage/migration/v2-backup-files'
import { diagnosticsCache, snapshotCache } from './document-index-snapshot-service'
import type { DocumentIndexIpcDeps } from './document-index-ipc'

/**
 * "Old index backup" in Settings > search index storage. The backup is the previous derived index kept after the V2->V3
 * upgrade; it is not counted in the index size. Deleting it frees disk only: the user's documents and the live index
 * are never touched (v2-backup-files.ts owns the file-name pattern and the safety checks).
 */
export function registerDocumentIndexBackupHandlers(deps: DocumentIndexIpcDeps): void {
  const { ipcMain, dbPath } = deps
  let deleting: Promise<DocumentIndexBackupDeleteResult> | null = null

  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.getDocumentIndexBackup,
    async (): Promise<DocumentIndexBackupInfo> => {
      const db = dbPath()
      const inventory = inventoryV2Backups(db)
      return {
        exists: inventory.backups.length > 0,
        totalBytes: inventory.totalBytes,
        files: inventory.backups.length,
        createdAt: inventory.backups[0]?.createdAt ?? 0,
        retentionDays: readBackupRetentionDays(dirname(db)),
        deletable: inventory.backups.length > 0 && !isMigrationInFlight(db) && isLiveV3Database(db),
      }
    },
  )

  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.deleteDocumentIndexBackup,
    (): Promise<DocumentIndexBackupDeleteResult> => {
      deleting ??= deleteV2Backups(dbPath())
        .then((result): DocumentIndexBackupDeleteResult => {
          snapshotCache.clear()
          diagnosticsCache.clear()
          return {
            ok: result.ok,
            freedBytes: result.freedBytes,
            deleted: result.deleted.length,
            ...(result.error || result.refused ? { error: result.error ?? result.refused } : {}),
          }
        })
        .catch((err: unknown): DocumentIndexBackupDeleteResult => ({
          ok: false,
          freedBytes: 0,
          deleted: 0,
          error: err instanceof Error ? err.message : 'delete-failed',
        }))
        .finally(() => {
          deleting = null
        })
      return deleting
    },
  )
}
