import { parentPort, workerData } from 'node:worker_threads'

export const indexingWorkerData: { cacheDir?: string; dbPath?: string } =
  workerData ?? JSON.parse(process.env.GENOFFICE_INDEX_WORKER_DATA ?? '{}')

export function postIndexMessage(message: unknown): void {
  if (parentPort) parentPort.postMessage(message)
  else if (process.env.GENOFFICE_INDEX_WORKER_DATA && process.connected)
    process.send?.(message as object)
}

export function onIndexRequest<T>(handler: (request: T) => void): void {
  if (parentPort) parentPort.on('message', handler)
  else if (process.env.GENOFFICE_INDEX_WORKER_DATA && process.send)
    process.on('message', (request) => handler(request as T))
}

if (!parentPort && process.env.GENOFFICE_INDEX_WORKER_DATA && process.send)
  process.once('disconnect', () => process.exit(0))
