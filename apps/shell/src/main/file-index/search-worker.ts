/**
 * Worker-thread entry of the file-index search. A query ranks every file that matches any of its words (a common
 * word on a 100k-file index is 100k candidates, 1-2 s of synchronous SQLite and sorting), so it never runs on
 * Electron's main thread, where it would hold every window still for as long as it takes - once per keystroke.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { FileIndexStore, type SearchOptions } from './store'

export interface SearchWorkerRequest {
  id: number
  q: string
  options: SearchOptions
}

let store: FileIndexStore | null = null

parentPort?.on('message', (req: SearchWorkerRequest) => {
  try {
    store ??= new FileIndexStore((workerData as { dbPath: string }).dbPath, { readOnly: true })
    parentPort?.postMessage({ id: req.id, result: store.search(req.q, req.options) })
  } catch (error) {
    parentPort?.postMessage({
      id: req.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
