import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  collectStorageAccounting,
  type StorageAccountingOptions,
  type StorageAccountingReport,
} from './storage-accounting'

export function runAccountingWorkerTask(options: StorageAccountingOptions): StorageAccountingReport {
  return collectStorageAccounting(options)
}

function sanitizeWorkerPayload(raw: unknown): StorageAccountingOptions | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (typeof data.dbPath !== 'string' || !data.dbPath.trim()) return null
  return {
    dbPath: data.dbPath,
    vectorsDir: typeof data.vectorsDir === 'string' ? data.vectorsDir : undefined,
    ocrDir: typeof data.ocrDir === 'string' ? data.ocrDir : undefined,
    tempDir: typeof data.tempDir === 'string' ? data.tempDir : undefined,
    modelDir: typeof data.modelDir === 'string' ? data.modelDir : undefined,
    annIndexesMeta: Array.isArray(data.annIndexesMeta)
      ? (data.annIndexesMeta as Array<{ space_id: string; file_path: string | null }>)
      : undefined,
    reusableFreelistBytes: typeof data.reusableFreelistBytes === 'number' ? data.reusableFreelistBytes : undefined,
    maxDepth: typeof data.maxDepth === 'number' ? data.maxDepth : undefined,
    maxDirQueue: typeof data.maxDirQueue === 'number' ? data.maxDirQueue : undefined,
    maxVisitedEntries: typeof data.maxVisitedEntries === 'number' ? data.maxVisitedEntries : undefined,
    maxFileInventory: typeof data.maxFileInventory === 'number' ? data.maxFileInventory : undefined,
  }
}

function handleWorkerExecution(payload: unknown): void {
  if (!parentPort) return
  const safeOptions = sanitizeWorkerPayload(payload)
  if (!safeOptions) {
    parentPort.postMessage({
      ok: false,
      error: 'Invalid storage accounting worker payload: dbPath missing or invalid',
    })
    return
  }
  try {
    const report = runAccountingWorkerTask(safeOptions)
    parentPort.postMessage({ ok: true, report })
  } catch (err: any) {
    parentPort.postMessage({
      ok: false,
      error: err?.message || String(err),
    })
  }
}

// Dedicated worker thread entry for storage accounting (PAIR 18 / JOB-05 off-main isolation).
// Receives options via workerData or postMessage, runs non-blocking filesystem and backup SQLite verification off-main,
// posts the accounting report back to parent, and exits cleanly.
if (!isMainThread && parentPort) {
  // Support payload passed at spawn time via workerData
  if (workerData) {
    handleWorkerExecution(workerData)
  }

  // Also support message-driven invocation if worker is messaged or reused
  parentPort.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'options' in (message as Record<string, unknown>)) {
      handleWorkerExecution((message as Record<string, unknown>).options)
    } else {
      handleWorkerExecution(message)
    }
  })
}

export default typeof import.meta !== 'undefined' ? (import.meta as any).filename : undefined
