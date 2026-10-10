import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import {
  DEFAULT_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
} from '../src/main/document-memory/embedding-profiles'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { nextInOrder } from '../src/main/document-memory/queue-order'
import { QueueLanes } from '../src/main/document-memory/runtime/queue-lanes'
import { VectorGate } from '../src/main/document-memory/runtime/vector-gate'
import { resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import { compactionNoopReply, storageBudgetAckReply } from './helpers/storage-budget-ack'

/**
 * The index queue as the app runs it: a V3 database with a backlog of never-read files and files that only lack vectors,
 * a fake index process, and the manager started the way `attachDocumentMemory()` starts it (constructor only: it opens
 * the worker and polls by itself). Field report: 3076 pending files never moved while 943 half-embedded files sat ahead of
 * them in the line and the vectors of those took hours on a slow computer.
 */

let dir: string
let manager: DocumentMemoryManager | undefined
beforeEach(() => {
  resetIndexingPolicyBus()
  dir = mkdtempSync(join(tmpdir(), 'genoffice-lanes-'))
  mkdirSync(join(dir, 'files'))
})
afterEach(async () => {
  await manager?.closeAsync()
  manager = undefined
  rmSync(dir, { recursive: true, force: true })
})

interface Seen {
  type: string
  path?: string
  n?: number
}

/** An index process that reads real files, embeds on demand, and can hold every embed reply until released. */
class FakeIndexWorker extends EventEmitter {
  readonly seen: Seen[] = []
  /** every vector batch answers after this long: a slow computer */
  embedDelayMs = 0
  dims = EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE].dimensions
  neverExtract = false
  neverAck = false
  postMessage(message: { id: number; type: string; path?: string; texts?: string[] }): void {
    this.seen.push({
      type: message.type,
      ...(message.path ? { path: message.path } : {}),
      ...(message.texts ? { n: message.texts.length } : {}),
    })
    setTimeout(() => {
      if (message.type === 'set-storage-budget' && this.neverAck) return
      const ack = storageBudgetAckReply(message)
      if (ack) return void this.emit('message', ack)
      const noop = compactionNoopReply(message as never)
      if (noop) return void this.emit('message', noop)
      if (message.type === 'extract') {
        if (this.neverExtract) return
        try {
          const bytes = readFileSync(message.path!)
          const stat = statSync(message.path!)
          this.emit('message', {
            id: message.id,
            result: {
              hash: createHash('sha256').update(bytes).digest('hex'),
              mtimeMs: stat.mtimeMs,
              sizeBytes: stat.size,
              chunks: chunkDocumentText(bytes.toString('utf8')),
              status: 'text-only',
            },
          })
        } catch {
          // directory was cleaned up during teardown
        }
      } else if (message.type === 'embed') {
        const reply = () => {
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: message.id,
            result: (message.texts ?? []).map(() => new Array(this.dims).fill(0.1)),
          })
        }
        if (this.embedDelayMs > 0) setTimeout(reply, this.embedDelayMs)
        else reply()
      }
    }, 0)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  count(type: string): number {
    return this.seen.filter((m) => m.type === type).length
  }
}

const BODY = (i: number): string =>
  `Biên bản nghiệm thu hạng mục số ${i}. `.repeat(40) +
  '\n\n' +
  `Hồ sơ thiết kế công trình ${i}, dự toán và bản vẽ hoàn công. `.repeat(40)

/** Seeds the database before the manager opens it: `textOnly` files (priority first) then `pending` ones, each a real file. */
function seedLine(
  textOnly: number,
  pending: number,
): { textOnlyPaths: string[]; pendingPaths: string[] } {
  const seed = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
  const textOnlyPaths: string[] = []
  const pendingPaths: string[] = []
  try {
    for (let i = 0; i < textOnly; i++) {
      const path = join(dir, 'files', `text-only-${i}.txt`)
      writeFileSync(path, BODY(i))
      const st = statSync(path)
      // text already indexed (chunks stored), no vectors yet
      seed.replaceDocument(path, {
        hash: 'old',
        mtimeMs: st.mtimeMs - 1,
        sizeBytes: st.size,
        chunks: chunkDocumentText(BODY(i)),
        embeddingModel: null,
        status: 'text-only',
      })
      textOnlyPaths.push(path)
    }
    for (let i = 0; i < pending; i++) {
      const path = join(dir, 'files', `pending-${i}.txt`)
      writeFileSync(path, BODY(1000 + i))
      seed.rawDb
        .prepare(
          "INSERT INTO documents(path, name, status, mtime_ms, size_bytes) VALUES (?, ?, 'pending', 1, NULL)",
        )
        .run(path, `pending-${i}.txt`)
      pendingPaths.push(path)
    }
    // a person's recent files first: text-only files rank ahead of the never-read ones
    seed.rawDb
      .prepare("UPDATE documents SET priority_at = 3000000000000 - id WHERE status = 'text-only'")
      .run()
    seed.rawDb
      .prepare("UPDATE documents SET priority_at = 1000000000000 - id WHERE status = 'pending'")
      .run()
  } finally {
    seed.close()
  }
  return { textOnlyPaths, pendingPaths }
}

function open(worker: FakeIndexWorker, extra: Record<string, unknown> = {}): DocumentMemoryManager {
  return new DocumentMemoryManager(join(dir, 'user'), {
    dbDir: dir,
    workerFactory: () => worker as unknown as Worker,
    pollIntervalMs: 3_600_000,
    junkPurgeDelayMs: 3_600_000,
    workerTimeoutMs: 20_000,
    ...extra,
  })
}

function statusCounts(): Record<string, number> {
  const view = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'search' })
  try {
    const rows = view.rawDb
      .prepare('SELECT status, count(*) AS n FROM documents GROUP BY status')
      .all() as Array<{ status: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  } finally {
    view.close()
  }
}

async function until(check: () => boolean, ms = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} not reached in time`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('reading does not wait for vectors', () => {
  it('reads every never-read file within seconds while each vector batch of the files ahead of them takes 1.5 s', async () => {
    seedLine(24, 40)
    const worker = new FakeIndexWorker()
    worker.embedDelayMs = 1_500 // a slow computer: the 24 files ahead need ~36 s of vector batches
    manager = open(worker)
    // the constructor alone starts the worker and the poll (what attachDocumentMemory() does), nothing else is called
    await until(() => (statusCounts().pending ?? 0) === 0, 35_000, 'all never-read files read')
    expect(worker.count('extract')).toBeGreaterThanOrEqual(40)
    // their text is searchable already; their vectors are still queued, not lost
    expect(manager.status().pending).toBeGreaterThan(0)
  }, 40_000)

  it('catches the vectors up afterwards: every file ends up ready', async () => {
    seedLine(24, 40)
    const worker = new FakeIndexWorker()
    worker.embedDelayMs = 40
    manager = open(worker)
    await until(() => (statusCounts().ready ?? 0) === 64, 150_000, 'all files ready')
    expect(manager.status().pending).toBe(0)
  }, 160_000)

  it('gives the vector lane its turns while the reading lane still has a backlog', async () => {
    seedLine(0, 60)
    const worker = new FakeIndexWorker()
    manager = open(worker)
    await until(() => (statusCounts().ready ?? 0) === 60, 50_000, 'all files ready')
    const extractAt = worker.seen
      .map((m, i) => (m.type === 'extract' ? i : -1))
      .filter((i) => i >= 0)
    const firstEmbedAt = worker.seen.findIndex((m) => m.type === 'embed')
    // vectors started before the last file was read: the lanes alternate, one does not wait for the other to finish
    expect(firstEmbedAt).toBeGreaterThan(-1)
    expect(firstEmbedAt).toBeLessThan(extractAt[extractAt.length - 1]!)
  }, 60_000)
})

describe('a backlog above the poll threshold is still polled', () => {
  it('adds a newly incomplete file to the line while 2300 files are already waiting', async () => {
    const seed = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
    try {
      const ins = seed.rawDb.prepare(
        "INSERT INTO documents(path, name, status, mtime_ms, size_bytes, priority_at) VALUES (?, ?, 'pending', 1, NULL, ?)",
      )
      seed.rawDb.exec('BEGIN')
      for (let i = 0; i < 2300; i++)
        ins.run(join(dir, 'files', `waiting-${i}.txt`), `waiting-${i}.txt`, 1_000_000 - i)
      seed.rawDb.exec('COMMIT')
    } finally {
      seed.close()
    }
    const worker = new FakeIndexWorker()
    worker.neverExtract = true // the line stays long
    manager = open(worker)
    const m = manager as unknown as {
      queue: string[]
      queued: Set<string>
      polling: boolean
      poll(): Promise<void>
    }
    await until(() => m.queued.size >= 2299, 20_000, 'the backlog is queued')
    await until(() => !m.polling, 20_000, 'the first poll is done')
    // a file that fell out of the in-memory line (or a changed file) is incomplete again in the database
    const lost = join(dir, 'files', 'waiting-17.txt')
    m.queue.splice(m.queue.indexOf(lost), 1)
    m.queued.delete(lost)
    expect(m.queued.size).toBeGreaterThan(2000)
    await m.poll()
    expect(m.queued.has(lost)).toBe(true)
  }, 40_000)
})

describe('the order of the line', () => {
  it('reads recent (high priority) files first, then small ones before heavy ones', async () => {
    const seed = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
    const names = ['recent-small', 'old-small', 'recent-heavy', 'older-small']
    try {
      const ins = seed.rawDb.prepare(
        "INSERT INTO documents(path, name, status, mtime_ms, size_bytes, priority_at) VALUES (?, ?, 'pending', 1, ?, ?)",
      )
      const spec: Array<[string, number | null, number]> = [
        ['recent-small', 1000, 4e12],
        ['old-small', 2000, 2e12],
        ['recent-heavy', 40 * 1024 * 1024, 3e12],
        ['older-small', 3000, 1e12],
      ]
      for (const [name, size, priority] of spec) {
        const path = join(dir, 'files', `${name}.txt`)
        writeFileSync(path, BODY(1))
        ins.run(path, `${name}.txt`, size, priority)
      }
    } finally {
      seed.close()
    }
    const worker = new FakeIndexWorker()
    manager = open(worker)
    await until(() => worker.count('extract') >= 4, 15_000, 'four files read')
    const order = worker.seen
      .filter((m) => m.type === 'extract')
      .map((m) => names.find((n) => m.path!.endsWith(`${n}.txt`)))
    expect(order).toEqual(['recent-small', 'old-small', 'older-small', 'recent-heavy'])
  }, 30_000)

  it('leaves a file that only lacks vectors out of the pick while the vector line is full, without dropping it', () => {
    const info = {
      urgent: new Set<string>(),
      deferred: new Set<string>(),
      bytes: new Map<string, number>(),
    }
    const line = ['text-a', 'text-b', 'fresh-c', 'text-d']
    const textOnly = new Set(['text-a', 'text-b', 'text-d'])
    expect(nextInOrder(line, info)).toBe('text-a')
    expect(nextInOrder(line, info, (p) => textOnly.has(p))).toBe('fresh-c')
    expect(nextInOrder(['text-a'], info, (p) => textOnly.has(p))).toBeUndefined()
    expect(line).toEqual(['text-a', 'text-b', 'fresh-c', 'text-d'])
  })
})

describe('a waiting queue always says why', () => {
  it('reports the storage hand-shake while the index process has not confirmed its limits', async () => {
    seedLine(0, 3)
    const worker = new FakeIndexWorker()
    worker.neverAck = true
    manager = open(worker)
    await until(() => manager!.nowStatus().queued > 0, 10_000, 'files are waiting')
    expect(manager.nowStatus().blocked).toBe('storage-starting')
    expect(manager.nowStatus().paused).toBe(false)
  }, 20_000)

  it('has no reason while the queue is moving or empty', async () => {
    const worker = new FakeIndexWorker()
    manager = open(worker)
    expect(manager.nowStatus().blocked).toBeUndefined()
  })

  it('writes one line to document-memory.log when files wait and nothing has been read or embedded since the last poll', async () => {
    seedLine(0, 4)
    const worker = new FakeIndexWorker()
    worker.neverExtract = true // a parser stuck in a native call
    manager = open(worker)
    await until(() => worker.count('extract') > 0, 10_000, 'a file is being read')
    const m = manager as unknown as { poll(): Promise<void> }
    await m.poll() // progress counter unchanged since construction: a stall
    await m.poll() // the same reason again within the interval: not repeated
    const log = join(dir, 'user', 'document-memory.log')
    await until(() => existsSync(log), 5_000, 'the log is written')
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/queue not advancing: reason=working-slowly waiting=\d+/)
    expect(lines[0]).not.toContain(dir) // aggregate text only: no paths
  }, 30_000)
})

describe('the gate between reading and the vector line', () => {
  it('reads never-read files whatever the vector line holds, and files that only lack vectors only with room (or when asked for now)', () => {
    let vectorLine = 16
    const gate = new VectorGate(() => vectorLine, 16)
    gate.queued('a.txt', 'text-only')
    gate.queued('b.txt', 'text-only')
    expect(gate.extractable(2, new Set())).toBe(false)
    expect(gate.extractable(2, new Set(['b.txt']))).toBe(true) // somebody opened it
    gate.queued('c.txt', 'pending')
    expect(gate.extractable(3, new Set())).toBe(true)
    expect(gate.skip(new Set())?.('a.txt')).toBe(true)
    expect(gate.skip(new Set(['a.txt']))?.('a.txt')).toBe(false)
    vectorLine = 3
    expect(gate.extractable(2, new Set())).toBe(true)
    expect(gate.skip(new Set())).toBeUndefined()
  })

  it('parks what was read while the line was full and gives it back only as room opens, never more than the room', () => {
    let vectorLine = 16
    const gate = new VectorGate(() => vectorLine, 16)
    for (let i = 0; i < 10; i++) gate.park(`p${i}.txt`)
    expect(gate.parked).toBe(10)
    expect(gate.release()).toEqual([])
    vectorLine = 13
    expect(gate.release()).toEqual(['p0.txt', 'p1.txt', 'p2.txt'])
    expect(gate.parked).toBe(7)
    gate.queued('p5.txt', 'text-only') // back in the line by another way: no longer parked
    expect(gate.isParked('p5.txt')).toBe(false)
    gate.clear()
    expect(gate.parked).toBe(0)
  })

  it('shares the index process evenly between the two lanes and gives a lane that had no work no head start', () => {
    const lanes = new QueueLanes()
    expect(lanes.next(true, false)).toBe('extract')
    lanes.add('extract', 5_000) // a long read while nothing waited for vectors: not owed back to the vector lane
    expect(lanes.next(true, true)).toBe('embed') // vectors arrive: even share, and the other lane than last time goes first
    lanes.add('embed', 1_000)
    expect(lanes.next(true, true)).toBe('extract') // the lane that has had less goes next
    lanes.add('extract', 3_000)
    expect(lanes.next(true, true)).toBe('embed')
    lanes.add('embed', 4_000)
    expect(lanes.next(true, true)).toBe('extract')
    expect(lanes.next(false, false)).toBeNull()
    // reading had nothing to do during a long vector pass: it does not get that time back as a head start
    expect(lanes.next(false, true)).toBe('embed')
    lanes.add('embed', 60_000)
    expect(lanes.next(true, true)).toBe('extract')
    lanes.add('extract', 1_000)
    expect(lanes.next(true, true)).toBe('embed')
  })
})
