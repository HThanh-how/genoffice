/**
 * Worker-thread entry: text extraction, directory walks and the index writes that follow them run here so a slow
 * PDF, a stalled network folder or a million-character document never blocks the main process.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { extractText } from './extract'
import { scanFileSnapshot, type ScannedFile } from './scan'
import { FileIndexStore } from './store'
import { handleWriterRequest, isWriterRequest, type WriterResponse } from './worker-ops'
import { applyPolicyMessage, isPolicyMessage } from '../fork/indexing-worker-policy'
import { withBackgroundBudget } from '../document-memory/cpu-budget'

export type WorkerRequest =
  { id: number; type: 'extract'; path: string } | { id: number; type: 'scan'; root: string }

export type WorkerResponse =
  | { id: number; type: 'extract'; result: Awaited<ReturnType<typeof extractText>> }
  /** a slice of the walk, so no single message carries (and the main thread deserializes) a whole drive */
  | { id: number; type: 'scan-part'; files: ScannedFile[] }
  | { id: number; type: 'scan'; files: ScannedFile[]; complete?: boolean; truncated?: boolean }
  | WriterResponse

/** Files per `scan-part` message: ~1 ms to deserialize on the receiving thread. */
export const SCAN_PART_SIZE = 4_000

let store: FileIndexStore | null = null
function writerStore(): FileIndexStore {
  const dbPath = (workerData as { dbPath?: string } | null)?.dbPath
  if (!dbPath) throw new Error('file index worker started without a database path')
  return (store ??= new FileIndexStore(dbPath))
}

parentPort?.on('message', async (req: WorkerRequest | Parameters<typeof isWriterRequest>[0]) => {
  if (isPolicyMessage(req)) {
    applyPolicyMessage(req)
    return
  }
  if (isWriterRequest(req)) {
    const run = () => handleWriterRequest(writerStore(), req, extractText)
    const res = req.type === 'index' ? await withBackgroundBudget(run) : await run()
    parentPort?.postMessage(res satisfies WorkerResponse)
    return
  }
  const request = req as WorkerRequest
  if (request.type === 'extract') {
    const result = await withBackgroundBudget(() => extractText(request.path))
    parentPort?.postMessage({ id: request.id, type: 'extract', result } satisfies WorkerResponse)
  } else {
    const snapshot = scanFileSnapshot(request.root)
    for (let i = 0; i < snapshot.files.length; i += SCAN_PART_SIZE)
      parentPort?.postMessage({
        id: request.id,
        type: 'scan-part',
        files: snapshot.files.slice(i, i + SCAN_PART_SIZE),
      } satisfies WorkerResponse)
    parentPort?.postMessage({
      id: request.id,
      type: 'scan',
      files: [],
      complete: snapshot.complete,
    } satisfies WorkerResponse)
  }
})
