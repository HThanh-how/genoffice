import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { extractDocument, extractDocumentSliced } from '../src/main/document-memory/worker'
import { storageBudgetAckReply } from './helpers/storage-budget-ack'

const FIXTURE = join(__dirname, 'fixtures', 'mixed-scan.pdf')

describe('reading a PDF in turns (worker)', () => {
  it('stops after a turn, keeps the pages it read, and finishes with the same result', async () => {
    const whole = await extractDocument(FIXTURE)

    // a turn that is already over: one page is still read, then it reports where it got to
    const first = await extractDocumentSliced(FIXTURE, undefined, -1)
    expect(first).toEqual({ partial: true, pagesDone: 1, totalPages: 3 })
    const second = await extractDocumentSliced(FIXTURE, undefined, -1)
    expect(second).toEqual({ partial: true, pagesDone: 2, totalPages: 3 })
    const last = await extractDocumentSliced(FIXTURE, undefined, -1)

    expect('partial' in last).toBe(false)
    expect(last).toEqual(whole)
  })

  it('reads only the first pages of a book-sized PDF and says the rest was left out', async () => {
    const whole = await extractDocumentSliced(FIXTURE, undefined, undefined, 3)
    expect('partial' in whole).toBe(false)
    expect(whole).not.toHaveProperty('truncated')

    const capped = await extractDocumentSliced(FIXTURE, undefined, undefined, 2)
    if ('partial' in capped) throw new Error('not expected')
    expect(capped.truncated).toBe(true)
    expect(capped.chunks.map((c) => c.text).join(' ')).not.toContain('Third page')
    // only the pages that were read can need OCR
    expect(capped.scan).toEqual({ totalPages: 2, scannedPages: [2] })
  })

  it('starts over when the file changed between turns', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'genoffice-turns-')), 'a.pdf')
    const bytes = readFileSync(FIXTURE)
    writeFileSync(path, bytes)
    try {
      const first = await extractDocumentSliced(path, undefined, -1)
      expect(first).toMatchObject({ partial: true, pagesDone: 1 })
      // same pages, but a different file now (size changes): nothing from before is reused
      writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n%% touched')]))
      const again = await extractDocumentSliced(path, undefined, -1)
      expect(again).toMatchObject({ partial: true, pagesDone: 1 })
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })
})

/** A worker that takes an extract request and answers when told: a turn, or the whole file. */
class TurnWorker extends EventEmitter {
  terminated = false
  requests: Array<{ path: string; sliceMs?: number }> = []
  private pending: { id: number; path: string } | undefined
  postMessage(message: { id: number; type: string; path: string; sliceMs?: number }): void {
    const ack = storageBudgetAckReply(message)
    if (ack) {
      this.emit('message', ack)
      return
    }
    this.requests.push({ path: message.path, sliceMs: message.sliceMs })
    this.pending = message
  }
  turn(pagesDone: number, totalPages: number): void {
    this.emit('message', { id: this.pending!.id, result: { partial: true, pagesDone, totalPages } })
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
let workers: TurnWorker[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-turns-'))
  workers = []
})
afterEach(async () => {
  await manager?.closeAsync()
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

function start(): DocumentMemoryManager {
  manager = new DocumentMemoryManager(join(dir, 'user'), {
    workerFactory: () => {
      const worker = new TurnWorker()
      workers.push(worker)
      return worker as unknown as Worker
    },
    pollIntervalMs: 3_600_000,
    workerTimeoutMs: 60_000,
    autoDeferAfterMs: 3_600_000,
  })
  return manager
}

function make(name: string, size = 0): string {
  const path = join(dir, name)
  writeFileSync(path, `Hợp đồng ${name}. `.repeat(10))
  if (size) truncateSync(path, size)
  return path
}
const enrol = (m: DocumentMemoryManager, path: string): void => {
  const { mtimeMs, size } = statSync(path)
  m.indexDiscoveredFile(path, { mtimeMs, sizeBytes: size })
}
const requests = (): Array<{ name: string; turn: boolean }> =>
  workers.flatMap((worker) =>
    worker.requests.map((request) => ({
      name: request.path.split(/[\\/]/).pop()!,
      turn: request.sliceMs !== undefined,
    })),
  )
const idOf = (m: DocumentMemoryManager, path: string): number =>
  (m as unknown as { store: { documentByPath(p: string): { id: number } } }).store.documentByPath(
    path,
  ).id
const BIG = 6 * 1024 * 1024

describe('reading a PDF in turns (queue)', () => {
  it('asks for a large PDF in turns, but reads a small one in one go', async () => {
    const m = start()
    enrol(m, make('big.pdf', BIG))
    await until(() => requests().length === 1)
    expect(requests()[0]).toEqual({ name: 'big.pdf', turn: true })
    workers.at(-1)!.finish()
    await until(() => m.getDocumentIndexProgress(join(dir, 'big.pdf')).state !== 'pending')

    enrol(m, make('small.pdf'))
    await until(() => requests().length === 2)
    expect(requests()[1]).toEqual({ name: 'small.pdf', turn: false })
  })

  it('lets a small file go between two turns, and carries on afterwards with the page count shown', async () => {
    const m = start()
    const big = make('big.pdf', BIG)
    const small = make('small.txt')
    enrol(m, big)
    await until(() => requests().length === 1)
    enrol(m, small)
    await until(() => m.nowStatus().positions[small] === 1)

    workers.at(-1)!.turn(120, 400)

    await until(() => requests().length === 2)
    expect(requests()[1]!.name).toBe('small.txt')
    expect(m.nowStatus().pages[big]).toEqual({ done: 120, total: 400 })
    expect(m.nowStatus().positions[big]).toBe(1)

    workers.at(-1)!.finish()
    await until(() => requests().length === 3)
    expect(requests()[2]).toEqual({ name: 'big.pdf', turn: true })
    workers.at(-1)!.finish()
    await until(() => m.nowStatus().pages[big] === undefined)
    expect(m.getDocumentIndexProgress(big).state).not.toBe('error')
  })

  it('"read later" does not cut a turn-by-turn read short: it steps back at the end of the turn', async () => {
    const m = start()
    const big = make('big.pdf', BIG)
    const small = make('small.txt')
    enrol(m, big)
    await until(() => requests().length === 1)
    enrol(m, small)
    await until(() => m.nowStatus().positions[small] === 1)

    expect(m.deferDocument(idOf(m, big))).toEqual({ ok: true })
    expect(workers[0]!.terminated).toBe(false)

    workers.at(-1)!.turn(10, 400)
    await until(() => requests().length === 2)
    expect(requests()[1]!.name).toBe('small.txt')
    expect(workers[0]!.terminated).toBe(false)
  })

  it('reading another file first waits for the end of the turn instead of throwing the pages away', async () => {
    const m = start()
    const big = make('big.pdf', BIG)
    const other = make('other.pdf', BIG)
    enrol(m, big)
    await until(() => requests().length === 1)
    enrol(m, other)
    await until(() => m.nowStatus().positions[other] === 1)

    m.retryDocument(idOf(m, other), { now: true })
    expect(workers[0]!.terminated).toBe(false)

    workers.at(-1)!.turn(30, 400)
    await until(() => requests().length === 2)
    expect(requests()[1]!.name).toBe('other.pdf')
  })
})
