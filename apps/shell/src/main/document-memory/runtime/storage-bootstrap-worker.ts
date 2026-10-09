import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  ensureDocumentMemoryStorageReady,
  type BootstrapResult,
  type StorageBootstrapOptions,
  type StorageBootstrapProgress,
} from '../storage-bootstrap'

/** What the main thread hands the worker (structured-cloneable: no callbacks). */
export interface StorageBootstrapWorkerInput {
  dbDir: string
  options: Omit<StorageBootstrapOptions, 'onProgress'>
}

export type StorageBootstrapWorkerMessage =
  | { type: 'progress'; progress: StorageBootstrapProgress }
  | { type: 'result'; result: BootstrapResult }

/**
 * Dedicated worker-thread entry for the document-memory storage bootstrap: the database health check and the
 * (possibly multi-minute, multi-gigabyte) V2->V3 migration run here so the Electron main thread keeps painting
 * and answering the window. Runs once, posts progress and exactly one result, and exits.
 */
async function runBootstrapWorkerTask(input: StorageBootstrapWorkerInput): Promise<void> {
  const post = (message: StorageBootstrapWorkerMessage): void => parentPort?.postMessage(message)
  try {
    const result = await ensureDocumentMemoryStorageReady(input.dbDir, {
      ...input.options,
      onProgress: (progress) => post({ type: 'progress', progress }),
    })
    post({ type: 'result', result })
  } catch (error) {
    // fail closed: a throw is reported as "not ready", never as an open index
    post({
      type: 'result',
      result: {
        ready: false,
        migrated: false,
        error: `Storage bootstrap threw: ${error instanceof Error ? error.message : String(error)}`,
      },
    })
  }
}

if (!isMainThread && parentPort) {
  const input = workerData as StorageBootstrapWorkerInput | undefined
  if (input && typeof input.dbDir === 'string' && input.dbDir.length > 0) {
    void runBootstrapWorkerTask(input)
  }
}

export default typeof import.meta !== 'undefined' ? (import.meta as any).filename : undefined
