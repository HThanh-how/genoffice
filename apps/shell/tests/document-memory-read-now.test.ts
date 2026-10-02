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

class HandWorker extends EventEmitter {
  terminated = false
  requests: Array<{ path: string; interactive?: boolean }> = []
  private pending: { id: number; path: string } | undefined
  postMessage(message: { id: number; path: string; interactive?: boolean }): void {
    this.requests.push({ path: message.path, interactive: message.interactive })
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
  fail(message: string): void {
    this.emit('message', { id: this.pending!.id, error: message })
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
const idOf = (path: string): number =>
  (
    manager as unknown as { store: { documentByPath(p: string): { id: number } } }
  ).store.documentByPath(path).id
const statusOf = (path: string): string | undefined =>
  (
    manager as unknown as { store: { documentByPath(p: string): { status: string } | undefined } }
  ).store.documentByPath(path)?.status

describe('"read this one" reads at once', () => {
  it('even when the indexing policy has paused the background work', async () => {
    const path = make('Ra viện BV Chợ Rẫy.pdf')
    publishIndexingPolicy(PAUSED)
    enrol(path)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(asked()).toHaveLength(0) // the line really is held

    const reading = manager.readNowDocument(idOf(path))
    await until(() => asked().length === 1)
    expect(asked()[0]).toMatchObject({ path, interactive: true })
    expect(manager.nowStatus().extracting.map((entry) => entry.path)).toEqual([path])
    workers.at(-1)!.finish()

    expect(await reading).toEqual({ ok: true })
    // the reader says not to build vectors for this one: it is searchable by its words at once
    expect(statusOf(path)).toBe('ready')
    expect(manager.nowStatus().extracting).toEqual([])
  })

  it('says why a file cannot be read instead of leaving it waiting', async () => {
    const path = make('on-the-missing-drive.pdf')
    enrol(path)
    const reading = manager.readNowDocument(idOf(path))
    await until(() => asked().length === 1)
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

    const pressed = manager.readNowDocument(idOf(path))
    await new Promise((resolve) => setTimeout(resolve, 150))
    let settled = false
    void pressed.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false) // the read has not finished, so neither has the press

    workers.at(-1)!.finish()
    expect(await pressed).toEqual({ ok: true })
  })

  it('refuses only when indexing has been switched off by the person', async () => {
    const path = make('a.pdf')
    enrol(path)
    manager.setEnabled(false)
    expect(await manager.readNowDocument(idOf(path))).toEqual({ ok: false, error: 'paused' })
  })

  it('steps a very large file that cannot be read in turns aside for it', async () => {
    const heavy = make('heavy.txt', 30 * 1024 * 1024)
    const wanted = make('wanted.txt')
    enrol(heavy)
    await until(() => asked().length === 1)
    enrol(wanted)

    const reading = manager.readNowDocument(idOf(wanted))
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
