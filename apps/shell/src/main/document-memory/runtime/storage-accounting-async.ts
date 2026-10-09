import { getStorageFreelistStats } from '../storage-gc'
import type {
  StorageAccountingOptions,
  StorageAccountingReport,
} from './storage-accounting'
import { StorageAccountingRunner } from './storage-accounting-runner'

let defaultAccountingRunner: StorageAccountingRunner | null = null

export function getSharedStorageAccountingRunner(): StorageAccountingRunner {
  if (!defaultAccountingRunner) {
    defaultAccountingRunner = new StorageAccountingRunner()
  }
  return defaultAccountingRunner
}

/**
 * Asynchronous, non-blocking storage accounting measurement for Document Search V3.
 * Offloads filesystem traversals and backup SQLite verification to a dedicated worker thread,
 * snapshots SQLite metadata synchronously beforehand to eliminate race conditions with database close,
 * and prevents blocking the main event loop.
 *
 * Isolated from core collector to eliminate circular bundler dependencies
 * (storage-accounting -> runner -> worker -> storage-accounting).
 */
export async function collectStorageAccountingAsync(
  options: StorageAccountingOptions,
  runner?: StorageAccountingRunner,
): Promise<StorageAccountingReport> {
  const safeOptions: StorageAccountingOptions = {
    dbPath: options.dbPath,
    vectorsDir: options.vectorsDir,
    ocrDir: options.ocrDir,
    tempDir: options.tempDir,
    modelDir: options.modelDir,
    annIndexesMeta: options.annIndexesMeta,
    reusableFreelistBytes: options.reusableFreelistBytes,
    maxDepth: options.maxDepth,
    maxDirQueue: options.maxDirQueue,
    maxVisitedEntries: options.maxVisitedEntries,
    maxFileInventory: options.maxFileInventory,
  }

  // Snapshot lightweight metadata from db handle synchronously before any async await
  if (options.db) {
    try {
      safeOptions.annIndexesMeta = options.db
        .prepare('SELECT space_id, file_path FROM ann_indexes')
        .all() as Array<{ space_id: string; file_path: string | null }>
    } catch {
      // non-blocking
    }
    try {
      safeOptions.reusableFreelistBytes = getStorageFreelistStats(options.db).reclaimableBytes
    } catch {
      // non-blocking
    }
  }

  const activeRunner = runner ?? getSharedStorageAccountingRunner()
  return activeRunner.run(safeOptions)
}
