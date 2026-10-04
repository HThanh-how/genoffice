/**
 * Worker-thread entry: text extraction and directory walks run here so a slow
 * PDF or a stalled network folder never blocks the main process.
 */
import { parentPort } from 'node:worker_threads'
import { extractText } from './extract'
import { scanFiles } from './scan'
import { applyPolicyMessage, isPolicyMessage } from '../fork/indexing-worker-policy'
import { withBackgroundBudget } from '../document-memory/cpu-budget'

export type WorkerRequest =
  { id: number; type: 'extract'; path: string } | { id: number; type: 'scan'; root: string }

export type WorkerResponse =
  | { id: number; type: 'extract'; result: Awaited<ReturnType<typeof extractText>> }
  | { id: number; type: 'scan'; files: ReturnType<typeof scanFiles> }

parentPort?.on('message', async (req: WorkerRequest) => {
  if (isPolicyMessage(req)) {
    applyPolicyMessage(req)
    return
  }
  if (req.type === 'extract') {
    const result = await withBackgroundBudget(() => extractText(req.path))
    parentPort?.postMessage({ id: req.id, type: 'extract', result } satisfies WorkerResponse)
  } else {
    parentPort?.postMessage({
      id: req.id,
      type: 'scan',
      files: scanFiles(req.root),
    } satisfies WorkerResponse)
  }
})
