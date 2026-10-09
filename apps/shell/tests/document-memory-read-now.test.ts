import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { publishIndexingPolicy, resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import type { StorageBudgetWorkerResult, WorkerReply } from '../src/main/document-memory/worker-types'

class HandWorker extends EventEmitter {
  terminated = false
  requests: Array<{ path: string; interactive?: boolean }> = []
  handshakeRequests = 0
  acks: StorageBudgetWorkerResult[] = []
  private pending: { id: number; path: string } | undefined
  postMessage(message: {
    id: number
    type?: string
    path?: string
    interactive?: boolean
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
      this.requests.push({ path: message.path!, interactive: message.interactive })
      this.pending = { id: message.id, path: message.path! }
    }
  }
  hasValidAck(): boolean {
    return (
      this.acks.length > 0 &&
      this.acks.every((a) => a.ok && a.appliedVersion === a.desiredVersion)
    )
  }
  finish(skipEmbeddings = true): void {
    const { id, path } = this.pending!
    const bytes = readFileSync(path)
    const reply: WorkerReply = {
      id,
      result: {
        hash: createHash('sha256').update(bytes).digest('hex'),
        mtimeMs: statSync(path).mtimeMs,
        sizeBytes: statSync(path).size,
        chunks: chunkDocumentText('Giấy ra viện. '.repeat(20)),
        status: 'text-only',
        ...(skipEmbeddings ? { skipEmbeddings: true } : {}),
      },
    }
    this.emit('message', reply)
  }
  fail(message: string): void {
    const reply: WorkerReply = { id: this.pending!.id, error: message }
    this.emit('message', reply)
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}

const PAUSED = {
  paused: true,
  pauseReason: 'low-memory' as const,
  threads: 1,
  cpuShare: 0,
  priority: 'idle' as const,
  tier: 'paused' as const,
  reason: 'test pause',
  onBattery: false,
}

let dir: string
let manager: DocumentMemoryManager
let workers: HandWorker[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-readnow-'))
  workers = []
  manager = new DocumentMemoryManager(join(dir, 'user'), {
    workerFactory: () => {
      const worker = new HandWorker()
      workers.push(worker)
      return worker as unknown as Worker
    },
    pollIntervalMs: 3_600_000,
    workerTimeoutMs: 60_000,
    autoDeferAfterMs: 3_600_000,
  })
})
afterEach(() => {
  manager.close()
  resetIndexingPolicyBus()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

function make(name: string, size = 0): string {
  const path = join(dir, name)
  writeFileSync(path, `Hợp đồng ${name}. `.repeat(10))
  if (size) truncateSync(path, size)
  return path
}
const enrol = (path: string): void => {
  const { mtimeMs, size } = statSync(path)
  manager.indexDiscoveredFile(path, { mtimeMs, sizeBytes: size })
}
const asked = (): Array<{ path: string; interactive?: boolean }> =>
  workers.flatMap((worker) => worker.requests)
const idOf = async (path: string): Promise<number> => {
  await until(() => {
    const doc = (
      manager as unknown as { store: { documentByPath(p: string): { id: number } | undefined } }
    ).store.documentByPath(path)
    return doc !== undefined && doc !== null
  })
  return (
    manager as unknown as { store: { documentByPath(p: string): { id: number } } }
  ).store.documentByPath(path).id
}
const statusOf = (path: string): string | undefined =>
  (
    manager as unknown as { store: { documentByPath(p: string): { status: string } | undefined } }
  ).store.documentByPath(path)?.status
const validAckExists = (): boolean =>
  workers.length > 0 && workers.every((worker) => worker.hasValidAck())

describe('"read this one" reads at once', () => {
  it('even when the indexing policy has paused the background work', async () => {
    const path = make('Ra viện BV Chợ Rẫy.pdf')
    publishIndexingPolicy(PAUSED)
    enrol(path)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(asked()).toHaveLength(0) // the line really is held

    const docId = await idOf(path)
    const reading = manager.readNowDocument(docId)
    await until(() => asked().length === 1)
    expect(asked()[0]).toMatchObject({ path, interactive: true })
    expect(manager.nowStatus().extracting.map((entry) => entry.path)).toEqual([path])
    expect(validAckExists()).toBe(true)
    workers.at(-1)!.finish()

    expect(await reading).toEqual({ ok: true })
    // the reader says not to build vectors for this one: it is searchable by its words at once
    expect(statusOf(path)).toBe('ready')
    expect(manager.nowStatus().extracting).toEqual([])
  })

  it('reads a file whose row already carries the same hash (text stored again, not skipped)', async () => {
    const path = make('3032-cv_0001_signed_signed.pdf')
    enrol(path)
    const docId = await idOf(path)
    const first = manager.readNowDocument(docId)
    await until(() => asked().length === 1)
    expect(validAckExists()).toBe(true)
    const worker = workers.at(-1)!
    worker.finish(false) // a normal result: its vectors are still to be made
    await first
    // a row can wait again while still carrying the hash of the bytes (a rescan, a retry)
    const store = (
      manager as unknown as {
        store: { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }
      }
    ).store
    store.db.prepare(`UPDATE documents SET status = 'pending' WHERE id = ?`).run(docId)
    expect(statusOf(path)).toBe('pending')

    const again = manager.readNowDocument(docId)
    await until(() => asked().filter((request) => request.path === path).length === 2)
    workers.at(-1)!.finish(false)
    expect(await again).toEqual({ ok: true })
    expect(statusOf(path)).toBe('text-only')
  })

  it('says why a file cannot be read instead of leaving it waiting', async () => {
    const path = make('on-the-missing-drive.pdf')
    enrol(path)
    const docId = await idOf(path)
    const reading = manager.readNowDocument(docId)
    await until(() => asked().length === 1)
    expect(validAckExists()).toBe(true)
    workers.at(-1)!.fail('ENOENT: no such file or directory, open G:\\Mr Quốc\\x.pdf')

    expect(await reading).toEqual({
      ok: false,
      error: 'ENOENT: no such file or directory, open G:\\Mr Quốc\\x.pdf',
    })
    expect(statusOf(path)).toBe('error')
  })

  it('a file already being read in the background is waited for, not reported as done', async () => {
    const path = make('already.pdf')
    enrol(path)
    await until(() => asked().length === 1)
    expect(asked()[0]!.interactive).toBeUndefined()
    expect(validAckExists()).toBe(true)

    const docId = await idOf(path)
    const pressed = manager.readNowDocument(docId)
    await new Promise((resolve) => setTimeout(resolve, 150))
    let settled = false
    void pressed.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false) // the read has not finished, so neither has the press

    workers.at(-1)!.finish()
    expect(await pressed).toEqual({ ok: true })
  })

  it('a folder refresh that touches a file being read does not throw the read away', async () => {
    const path = make('touched.pdf')
    enrol(path)
    await until(() => asked().length === 1)
    expect(validAckExists()).toBe(true)

    // the scanner finds the same (still unread) file again while it is being read
    enrol(path)
    enrol(path)

    workers.at(-1)!.finish()
    await until(() => statusOf(path) === 'ready')
    // read once: the file was neither read twice nor left waiting
    expect(asked()).toHaveLength(1)
    expect(manager.nowStatus().positions[path]).toBeUndefined()
  })

  it('"read this one" survives the same, and reads the file again if it still was dropped', async () => {
    const path = make('pressed.pdf')
    publishIndexingPolicy(PAUSED)
    enrol(path)
    const docId = await idOf(path)
    const reading = manager.readNowDocument(docId)
    await until(() => asked().length === 1)
    expect(validAckExists()).toBe(true)
    enrol(path) // a refresh in the middle of the read
    workers.at(-1)!.finish()
    expect(await reading).toEqual({ ok: true })
    expect(statusOf(path)).toBe('ready')
    expect(asked()).toHaveLength(1)
  })

  it('a background read that was overtaken is not the answer: the file is read again at once', async () => {
    const path = make('overtaken.pdf')
    enrol(path)
    await until(() => asked().length === 1)
    expect(validAckExists()).toBe(true)
    const docId = await idOf(path)
    const pressed = manager.readNowDocument(docId)
    // the background read comes back as an error-free, but outdated, answer: the file changed
    ;(manager as unknown as { invalidatePath(p: string): void }).invalidatePath(path)
    workers.at(-1)!.finish()
    await until(() => asked().length === 2)
    expect(asked()[1]).toMatchObject({ path, interactive: true })
    workers.at(-1)!.finish()
    expect(await pressed).toEqual({ ok: true })
    expect(statusOf(path)).toBe('ready')
  })

  it('refuses only when indexing has been switched off by the person', async () => {
    const path = make('a.pdf')
    enrol(path)
    const docId = await idOf(path)
    manager.setEnabled(false)
    expect(await manager.readNowDocument(docId)).toEqual({ ok: false, error: 'paused' })
  })

  it('steps a very large file that cannot be read in turns aside for it', async () => {
    const heavy = make('heavy.txt', 30 * 1024 * 1024)
    const wanted = make('wanted.txt')
    enrol(heavy)
    await until(() => asked().length === 1)
    expect(validAckExists()).toBe(true)
    enrol(wanted)
    const wantedId = await idOf(wanted)

    const reading = manager.readNowDocument(wantedId)
    await until(() => asked().some((request) => request.path === wanted && request.interactive))
    expect(workers[0]!.terminated).toBe(true)
    workers.at(-1)!.finish()
    expect(await reading).toEqual({ ok: true })
    // the file it stepped aside is not lost: waiting again, or already being read again
    const now = manager.nowStatus()
    expect(
      now.positions[heavy] !== undefined || now.extracting.some((entry) => entry.path === heavy),
    ).toBe(true)
  })
})
