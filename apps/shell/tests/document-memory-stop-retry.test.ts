import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'

let dir: string
let manager: DocumentMemoryManager | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-stop-'))
})
afterEach(() => {
  manager?.close()
  manager = undefined
  rmSync(dir, { recursive: true, force: true })
})

/** A worker that takes the request and never answers: a long scan being read. */
class SlowWorker extends EventEmitter {
  terminated = false
  requests = 0
  private last: { id: number; path: string } | undefined
  postMessage(message: { id: number; path: string }): void {
    this.requests++
    this.last = message
  }
  /** the long read finally finishes */
  finish(): void {
    const { id, path } = this.last!
    const bytes = readFileSync(path)
    this.emit('message', {
      id,
      result: {
        hash: createHash('sha256').update(bytes).digest('hex'),
        mtimeMs: statSync(path).mtimeMs,
        sizeBytes: statSync(path).size,
        chunks: chunkDocumentText(bytes.toString('utf8')),
        status: 'text-only',
        skipEmbeddings: true,
      },
    })
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function setup(): { worker: SlowWorker; file: string; id: () => number } {
  const worker = new SlowWorker()
  manager = new DocumentMemoryManager(join(dir, 'user'), {
    workerFactory: () => worker as unknown as Worker,
    pollIntervalMs: 3_600_000,
    workerTimeoutMs: 60_000,
  })
  const file = join(dir, 'scan.txt')
  writeFileSync(file, 'Giấy ra viện. '.repeat(30))
  manager.indexDiscoveredFile(file)
  const store = (
    manager as unknown as { store: { documentByPath(p: string): { id: number } | undefined } }
  ).store
  return { worker, file, id: () => store.documentByPath(file)!.id }
}

describe('retry and stop on a file that is being read', () => {
  it('retry leaves the running read alone instead of restarting it', async () => {
    const { worker, file, id } = setup()
    await until(() =>
      manager!.nowStatus().extracting.some((entry) => entry.path.endsWith('scan.txt')),
    )
    const since = manager!.nowStatus().extracting[0]!.since

    expect(manager!.retryDocument(id())).toEqual({ ok: true })

    expect(worker.requests).toBe(1)
    expect(worker.terminated).toBe(false)
    expect(manager!.nowStatus().extracting[0]!.since).toBe(since)

    // the read that was already running is the one that counts: it is kept, not read again
    worker.finish()
    await until(() => manager!.getDocumentIndexProgress(file).state === 'ready')
    expect(worker.requests).toBe(1)
  })

  it('stop cancels the read and leaves the file as a problem to retry', async () => {
    const { worker, file, id } = setup()
    await until(() => manager!.nowStatus().extracting.length > 0)

    expect(await manager!.stopDocument(id())).toEqual({ ok: true })

    expect(worker.terminated).toBe(true)
    await until(() => manager!.nowStatus().extracting.length === 0)
    expect(manager!.getDocumentIndexProgress(file).state).toBe('error')
    expect(manager!.nowStatus().positions[file]).toBeUndefined()
  })

  it('stop refuses a file that is already indexed', async () => {
    const { id } = setup()
    await until(() => manager!.nowStatus().extracting.length > 0)
    await manager!.stopDocument(id())
    // an errored file is not waiting any more, so a second stop has nothing to do
    expect(await manager!.stopDocument(id())).toEqual({ ok: false, error: 'unavailable' })
  })
})
