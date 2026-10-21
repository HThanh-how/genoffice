import { parentPort } from 'node:worker_threads'

let mode = 'incomplete'

parentPort?.on('message', (req) => {
  if (req.type === 'set-mode') {
    mode = req.mode
    parentPort?.postMessage({ id: req.id, type: 'mode-set' })
    return
  }
  if (req.type === 'scan') {
    if (mode === 'incomplete') {
      parentPort?.postMessage({ id: req.id, type: 'scan', files: [], complete: false, truncated: true })
    } else if (mode === 'empty-complete') {
      parentPort?.postMessage({ id: req.id, type: 'scan', files: [], complete: true, truncated: false })
    } else {
      parentPort?.postMessage({ id: req.id, type: 'scan', files: req.files || [], complete: true })
    }
    return
  }
  parentPort?.postMessage({ id: req.id, type: 'extract', result: { kind: 'name-only' } })
})
