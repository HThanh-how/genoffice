// test double: answers a scan with several large `scan-part` slices of fake files, then an empty final answer
import { parentPort } from 'node:worker_threads'
import { join } from 'node:path'

parentPort?.on('message', (req) => {
  if (req.type === 'policy' || req.type === 'ignore-policy') return
  if (req.type === 'scan') {
    if (req.root.includes('offline')) return // would hang forever
    for (let part = 0; part < 3; part++) {
      const files = []
      for (let i = 0; i < 4000; i++) {
        files.push({ path: join(req.root, `p${part}`, `f${i}.txt`), mtimeMs: 1, sizeBytes: 1 })
      }
      parentPort.postMessage({ id: req.id, type: 'scan-part', files })
    }
    parentPort.postMessage({ id: req.id, type: 'scan', files: [], complete: true })
    return
  }
  parentPort.postMessage({ id: req.id, type: 'extract', result: { kind: 'text', text: '' } })
})
