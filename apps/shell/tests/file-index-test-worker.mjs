// test double for the file-index worker: walks the root like the real scan, and
// answers every extraction except the one for the poison file, which never
// answers — a wedged parse
import { parentPort } from 'node:worker_threads'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

parentPort?.on('message', (req) => {
  if (req.type === 'policy') return
  if (req.type === 'scan') {
    const files = []
    let complete = true
    const walk = (dir) => {
      let ents
      try {
        ents = readdirSync(dir, { withFileTypes: true })
      } catch {
        complete = false
        return
      }
      for (const ent of ents) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (ent.isFile()) {
          try {
            const st = statSync(p)
            files.push({ path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size })
          } catch {
            complete = false
          }
        }
      }
    }
    walk(req.root)
    if (req.root.includes('incomplete')) complete = false // a walk that could not read part of the tree
    parentPort.postMessage({ id: req.id, type: 'scan', files, complete })
    return
  }
  if (req.path.includes('poison')) return
  parentPort.postMessage({
    id: req.id,
    type: 'extract',
    result: { kind: 'text', text: readFileSync(req.path, 'utf8') },
  })
})
