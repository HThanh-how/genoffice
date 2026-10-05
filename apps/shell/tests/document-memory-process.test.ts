import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createIndexProcess } from '../src/main/document-memory/process-worker'
import { withBackgroundBudget } from '../src/main/document-memory/cpu-budget'
import { resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'

it('runs index IPC in a separate process and terminates it on close', async () => {
  resetIndexingPolicyBus()
  const dir = mkdtempSync(join(tmpdir(), 'index-process-'))
  const file = join(dir, 'worker.cjs')
  writeFileSync(
    file,
    `process.on('message', m => process.send({id:m.id,pid:process.pid,data:JSON.parse(process.env.GENOFFICE_INDEX_WORKER_DATA)}));`,
  )
  const worker = createIndexProcess(file, { cacheDir: dir, dbPath: join(dir, 'index.db') })
  try {
    const result = new Promise<{ id: number; pid: number; data: { cacheDir: string } }>(
      (resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      },
    )
    worker.postMessage({ id: 1 })
    const reply = await result
    expect(reply.id).toBe(1)
    expect(reply.pid).not.toBe(process.pid)
    expect(reply.data.cacheDir).toBe(dir)
  } finally {
    await worker.terminate()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('leaves idle time for interactive work between CPU-heavy background tasks', async () => {
  let heartbeat = false
  const timer = setTimeout(() => {
    heartbeat = true
  }, 5)
  const started = performance.now()
  const value = await withBackgroundBudget(async () => {
    const stop = performance.now() + 30
    while (performance.now() < stop) {
      /* simulate CPU work */
    }
    return 42
  })
  clearTimeout(timer)
  expect(value).toBe(42)
  expect(heartbeat).toBe(true)
  expect(performance.now() - started).toBeGreaterThanOrEqual(65)
})
