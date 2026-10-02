import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { HEAVY_BYTES, orderQueue, weightOf } from '../src/main/document-memory/queue-order'

describe('orderQueue', () => {
  const none = new Set<string>()
  const bytes = new Map([
    ['big', HEAVY_BYTES + 1],
    ['mid', 10 * 1024 * 1024],
    ['small-a', 1000],
    ['small-b', 2000],
    ['unknown-size', 0],
  ])

  it('reads light files before medium before heavy, keeping the line order inside a group', () => {
    const line = ['big', 'mid', 'small-a', 'unknown-size', 'small-b']
    expect(orderQueue(line, { urgent: none, deferred: none, bytes })).toEqual([
      'small-a',
      'unknown-size',
      'small-b',
      'mid',
      'big',
    ])
  })

  it('puts what was asked for first and what was pushed back last', () => {
    const line = ['small-a', 'big', 'mid', 'small-b']
    expect(
      orderQueue(line, { urgent: new Set(['big']), deferred: new Set(['small-a']), bytes }),
    ).toEqual(['big', 'small-b', 'mid', 'small-a'])
  })

  it('calls a file heavy from 25 MB', () => {
    expect([weightOf(1), weightOf(6 * 1024 * 1024), weightOf(HEAVY_BYTES)]).toEqual([1, 2, 3])
  })
})

/** A worker that takes an extract request and answers only when told to. */
class HandWorker extends EventEmitter {
  terminated = false
  paths: string[] = []
  private pending: { id: number; path: string } | undefined
  postMessage(message: { id: number; type: string; path: string }): void {
    this.paths.push(message.path)
    this.pending = message
  }
  finish(): void {
    const { id, path } = this.pending!
    const bytes = readFileSync(path)
    this.emit('message', {
      id,
      result: {
        hash: createHash('sha256').update(bytes).digest('hex'),
        mtimeMs: statSync(path).mtimeMs,
        sizeBytes: statSync(path).size,
        chunks: chunkDocumentText('Giấy ra viện. '.repeat(20)),
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

let dir: string
let manager: DocumentMemoryManager | undefined
let workers: HandWorker[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-order-'))
  workers = []
})
afterEach(() => {
  manager?.close()
  manager = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

function start(autoDeferAfterMs = 3_600_000): DocumentMemoryManager {
  manager = new DocumentMemoryManager(join(dir, 'user'), {
    workerFactory: () => {
      const worker = new HandWorker()
      workers.push(worker)
      return worker as unknown as Worker
    },
    pollIntervalMs: 3_600_000,
    workerTimeoutMs: 60_000,
    autoDeferAfterMs,
  })
  return manager
}

function make(name: string, size = 0): string {
  const path = join(dir, name)
  writeFileSync(path, `Hợp đồng ${name}. `.repeat(10))
  if (size) truncateSync(path, size)
  return path
}

/** every path asked of any worker so far, in order */
const asked = (): string[] => workers.flatMap((worker) => worker.paths)
/** enrolled the way the folder scan does it: with the size it saw */
function enrol(m: DocumentMemoryManager, path: string): void {
  const { mtimeMs, size } = statSync(path)
  m.indexDiscoveredFile(path, { mtimeMs, sizeBytes: size })
}
const idOf = (m: DocumentMemoryManager, path: string): number =>
  (m as unknown as { store: { documentByPath(p: string): { id: number } } }).store.documentByPath(
    path,
  ).id

describe('the reading line', () => {
  it('reads the small files first and leaves a very large one for last', async () => {
    const m = start()
    const first = make('first.txt')
    const heavy = make('heavy.txt', HEAVY_BYTES + 1024)
    const l1 = make('l1.txt')
    const l2 = make('l2.txt')
    enrol(m, first)
    await until(() => asked().length === 1)
    for (const path of [heavy, l1, l2]) enrol(m, path)
    await until(() => Object.keys(m.nowStatus().positions).length === 3)

    const { positions } = m.nowStatus()
    expect([positions[l1], positions[l2], positions[heavy]]).toEqual([1, 2, 3])

    for (let i = 1; i <= 3; i++) {
      workers.at(-1)!.finish()
      await until(() => asked().length === i + 1)
    }
    expect(asked().map((path) => path.split(/[\\/]/).pop())).toEqual([
      'first.txt',
      'l1.txt',
      'l2.txt',
      'heavy.txt',
    ])
  })

  it('pressing read on a heavy file still puts it first, ahead of the small ones', async () => {
    const m = start()
    const busy = make('busy.txt')
    const heavy = make('heavy.txt', HEAVY_BYTES + 1024)
    const light = make('light.txt')
    enrol(m, busy)
    await until(() => asked().length === 1)
    enrol(m, heavy)
    enrol(m, light)
    await until(() => Object.keys(m.nowStatus().positions).length === 2)

    m.retryDocument(idOf(m, heavy), { now: true })

    await until(() => asked().length === 2)
    expect(asked()[1]).toBe(heavy)
  })

  it('"read later" cuts a heavy read short and puts the file behind every other one', async () => {
    const m = start()
    const heavy = make('heavy.txt', HEAVY_BYTES + 1024)
    const light = make('light.txt')
    enrol(m, heavy)
    await until(() => asked().length === 1)
    enrol(m, light)
    await until(() => m.nowStatus().positions[light] === 1)

    expect(m.deferDocument(idOf(m, heavy))).toEqual({ ok: true })

    await until(() => asked().length === 2)
    expect(workers[0]!.terminated).toBe(true)
    expect(asked()[1]).toBe(light)
    expect(m.nowStatus().positions[heavy]).toBe(1)
  })

  it('a heavy read steps back by itself when small files have been waiting', async () => {
    const m = start(60)
    const heavy = make('heavy.txt', HEAVY_BYTES + 1024)
    const light = make('light.txt')
    enrol(m, heavy)
    await until(() => asked().length === 1)
    enrol(m, light)

    await until(() => asked().length === 2)
    expect(workers[0]!.terminated).toBe(true)
    expect(asked()[1]).toBe(light)
  })

  it('a heavy file that is alone is read through, never interrupted', async () => {
    const m = start(40)
    const heavy = make('heavy.txt', HEAVY_BYTES + 1024)
    enrol(m, heavy)
    await until(() => asked().length === 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(workers[0]!.terminated).toBe(false)
    expect(asked()).toHaveLength(1)
  })
})
