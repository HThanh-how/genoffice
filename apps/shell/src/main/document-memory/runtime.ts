import { parentPort, workerData } from 'node:worker_threads'
import { applyPolicyMessage, isPolicyMessage } from '../fork/indexing-worker-policy'

export const indexingWorkerData: {
  cacheDir?: string
  dbPath?: string
  /** `standard` or `high` (see embedding-profiles.ts) */
  embeddingProfile?: string
} = workerData ?? JSON.parse(process.env.GENOFFICE_INDEX_WORKER_DATA ?? '{}')

export function postIndexMessage(message: unknown): void {
  if (parentPort) parentPort.postMessage(message)
  else if (process.env.GENOFFICE_INDEX_WORKER_DATA && process.connected)
    process.send?.(message as object)
}

export function onIndexRequest<T>(handler: (request: T) => void): void {
  // Policy messages (threads / duty cycle) are consumed here and never reach the queue.
  const route = (request: unknown) =>
    isPolicyMessage(request) ? applyPolicyMessage(request) : handler(request as T)
  if (parentPort) parentPort.on('message', route)
  else if (process.env.GENOFFICE_INDEX_WORKER_DATA && process.send) process.on('message', route)
}

if (!parentPort && process.env.GENOFFICE_INDEX_WORKER_DATA && process.send)
  process.once('disconnect', () => process.exit(0))
