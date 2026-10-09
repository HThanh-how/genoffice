import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { enforceBackupRetentionPolicy } from '../storage/migration/backup-retention'

export function runRetentionWorkerTask(dbPath: string): { purgedCount: number; error?: string } {
  try {
    const purgedCount = enforceBackupRetentionPolicy(dbPath)
    return { purgedCount }
  } catch (error) {
    return {
      purgedCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// Dedicated worker thread entry for backup retention maintenance (JOB-05-RET1).
// Receives dbPath once via workerData, executes retention policy once, posts result, and exits.
if (!isMainThread && parentPort) {
  const dbPath = (workerData as { dbPath?: string } | undefined)?.dbPath
  if (typeof dbPath === 'string' && dbPath.length > 0) {
    const result = runRetentionWorkerTask(dbPath)
    parentPort.postMessage(result)
  }
}

export default typeof import.meta !== 'undefined' ? (import.meta as any).filename : undefined
