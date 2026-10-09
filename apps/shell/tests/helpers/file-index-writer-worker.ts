// Test double of the file-index worker thread that owns the index writes: the real request handler
// (worker-ops.ts) over a real store, a plain-text extractor, a walk that answers in small `scan-part` slices, and one
// file ("poison") whose request is never answered, like a wedged parse.
import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FileIndexStore } from '../../src/main/file-index/store'
import { handleWriterRequest, isWriterRequest } from '../../src/main/file-index/worker-ops'

let store: FileIndexStore | null = null

parentPort?.on('message', async (req: any) => {
  if (req.type === 'policy') return
  if (isWriterRequest(req)) {
    if (req.type === 'index' && String(req.file.path).includes('poison')) return
    store ??= new FileIndexStore((workerData as { dbPath: string }).dbPath)
    parentPort!.postMessage(
      await handleWriterRequest(store, req, async (path) => ({
        kind: 'text',
        text: readFileSync(path, 'utf8'),
      })),
    )
    return
  }
  if (req.type === 'scan') {
    const files: Array<{ path: string; mtimeMs: number; sizeBytes: number }> = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (ent.isFile()) {
          const st = statSync(p)
          files.push({ path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size })
        }
      }
    }
    walk(req.root)
    for (let i = 0; i < files.length; i += 3)
      parentPort!.postMessage({ id: req.id, type: 'scan-part', files: files.slice(i, i + 3) })
    parentPort!.postMessage({ id: req.id, type: 'scan', files: [], complete: true })
  }
})
