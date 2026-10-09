import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import type { StorageBudgetWorkerResult, WorkerReply } from '../src/main/document-memory/worker-types'

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
  handshakeRequests = 0
  paths: string[] = []
  acks: StorageBudgetWorkerResult[] = []
  private last: { id: number; path: string } | undefined
  postMessage(message: {
    id: number
    type?: string
    path?: string
    configVersion?: number
    budget?: { maxDatabaseBytes: number }
  }): void {
    if (message.type === 'set-storage-budget') {
      this.handshakeRequests++
      const replyResult: StorageBudgetWorkerResult = {
        ok: true,
        appliedVersion: message.configVersion ?? 0,
        desiredVersion: message.configVersion ?? 0,
        appliedBudgetBytes: message.budget?.maxDatabaseBytes,
      }
      this.acks.push(replyResult)
      const reply: WorkerReply = {
        id: message.id,
        result: replyResult,
      }
      this.emit('message', reply)
      return
    }
    if (message.type === 'extract' || message.path) {
      this.requests++
      if (message.path) {
        this.paths.push(message.path)
      }
      this.last = { id: message.id, path: message.path! }
    }
  }
  hasValidAck(): boolean {
    return (
      this.acks.length > 0 &&
      this.acks.every((a) => a.ok && a.appliedVersion === a.desiredVersion)
    )
  }
  /** the long read finally finishes */
  finish(): void {
    const { id, path } = this.last!
    const bytes = readFileSync(path)
    const reply: WorkerReply = {
      id,
      result: {
        hash: createHash('sha256').update(bytes).digest('hex'),
        mtimeMs: statSync(path).mtimeMs,
        sizeBytes: statSync(path).size,
        chunks: chunkDocumentText(bytes.toString('utf8')),
        status: 'text-only',
        skipEmbeddings: true,
      },
    }
    this.emit('message', reply)
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

async function setup(): Promise<{ worker: SlowWorker; file: string; id: () => number }> {
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
  await until(() => store.documentByPath(file) !== undefined)
  return { worker, file, id: () => store.documentByPath(file)!.id }
}

describe('retry and stop on a file that is being read', () => {
  it('retry leaves the running read alone instead of restarting it', async () => {
    const { worker, file, id } = await setup()
    await until(() =>
      manager!.nowStatus().extracting.some((entry) => entry.path.endsWith('scan.txt')),
    )
    const since = manager!.nowStatus().extracting[0]!.since

    expect(manager!.retryDocument(id())).toEqual({ ok: true })

    expect(worker.requests).toBe(1)
    expect(worker.terminated).toBe(false)
    expect(worker.handshakeRequests).toBeGreaterThanOrEqual(1)
    expect(worker.hasValidAck()).toBe(true)
    expect(manager!.nowStatus().extracting[0]!.since).toBe(since)

    // the read that was already running is the one that counts: it is kept, not read again
    worker.finish()
    await until(() => manager!.getDocumentIndexProgress(file).state === 'ready')
    expect(worker.requests).toBe(1)
  })

  it('stop cancels the read and leaves the file as a problem to retry', async () => {
    const { worker, file, id } = await setup()
    await until(() => manager!.nowStatus().extracting.length > 0)

    expect(await manager!.stopDocument(id())).toEqual({ ok: true })

    expect(worker.terminated).toBe(true)
    expect(worker.handshakeRequests).toBeGreaterThanOrEqual(1)
    expect(worker.hasValidAck()).toBe(true)
    await until(() => manager!.nowStatus().extracting.length === 0)
    expect(manager!.getDocumentIndexProgress(file).state).toBe('error')
    expect(manager!.nowStatus().positions[file]).toBeUndefined()
  })

  it('stop refuses a file that is already indexed', async () => {
    const { worker, id } = await setup()
    await until(() => manager!.nowStatus().extracting.length > 0)
    expect(worker.handshakeRequests).toBeGreaterThanOrEqual(1)
    expect(worker.hasValidAck()).toBe(true)
    await manager!.stopDocument(id())
    // an errored file is not waiting any more, so a second stop has nothing to do
    expect(await manager!.stopDocument(id())).toEqual({ ok: false, error: 'unavailable' })
  })

  it('pressing read on one file takes the reader over from the file it was busy with', async () => {
    const workers: SlowWorker[] = []
    manager = new DocumentMemoryManager(join(dir, 'user'), {
      workerFactory: () => {
        const worker = new SlowWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
      pollIntervalMs: 3_600_000,
      workerTimeoutMs: 60_000,
    })
    const busy = join(dir, 'busy.txt')
    const chosen = join(dir, 'chosen.txt')
    writeFileSync(busy, 'Hợp đồng thi công. '.repeat(30))
    writeFileSync(chosen, 'Giấy ra viện. '.repeat(30))
    manager.indexDiscoveredFile(busy)
    await until(() => manager!.nowStatus().extracting.length > 0)
    manager.indexDiscoveredFile(chosen)
    const store = (
      manager as unknown as { store: { documentByPath(p: string): { id: number } | undefined } }
    ).store
    await until(() => store.documentByPath(chosen) !== undefined)

    expect(manager.retryDocument(store.documentByPath(chosen)!.id, { now: true })).toEqual({
      ok: true,
    })

    // the busy file's worker is replaced and the chosen file is the next one read
    await until(() => workers.length === 2 && workers[1]!.paths.length > 0)
    expect(workers[0]!.terminated).toBe(true)
    expect(workers[1]!.paths[0]).toMatch(/chosen\.txt$/)
    expect(workers[0]!.handshakeRequests).toBeGreaterThanOrEqual(1)
    expect(workers[1]!.handshakeRequests).toBeGreaterThanOrEqual(1)
    expect(workers[0]!.hasValidAck()).toBe(true)
    expect(workers[1]!.hasValidAck()).toBe(true)
    // the interrupted file is not lost: it is back in the line right behind
    expect(manager.nowStatus().positions[busy]).toBe(1)
  })
})
