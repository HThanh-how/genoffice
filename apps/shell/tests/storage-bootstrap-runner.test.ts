import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runStorageBootstrapOffThread,
  type StorageBootstrapWorkerLike,
} from '../src/main/document-memory/runtime/storage-bootstrap-runner'
import type { StorageBootstrapProgress } from '../src/main/document-memory/storage-bootstrap'

class FakeWorker extends EventEmitter implements StorageBootstrapWorkerLike {
  terminated = 0
  terminate(): Promise<number> {
    this.terminated++
    // a terminated worker reports exit(1), exactly like a real one
    queueMicrotask(() => this.emit('exit', 1))
    return Promise.resolve(1)
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-bootstrap-runner-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const logText = (): string =>
  existsSync(join(dir, 'logs', 'document-memory.log'))
    ? readFileSync(join(dir, 'logs', 'document-memory.log'), 'utf8')
    : ''

describe('runStorageBootstrapOffThread', () => {
  it('resolves with the worker result, forwards progress and releases the worker', async () => {
    const worker = new FakeWorker()
    const seen: StorageBootstrapProgress[] = []
    const run = runStorageBootstrapOffThread(
      dir,
      { settingsDir: dir },
      { workerFactory: () => worker, onProgress: (p) => seen.push(p), progressIntervalMs: 0 },
    )
    worker.emit('message', { type: 'progress', progress: { phase: 'checking', percent: null } })
    worker.emit('message', { type: 'progress', progress: { phase: 'migrating', percent: 40 } })
    worker.emit('message', { type: 'progress', progress: { phase: 'migrating', percent: 41 } })
    worker.emit('message', { type: 'result', result: { ready: true, migrated: true } })
    await expect(run).resolves.toEqual({ ready: true, migrated: true })
    expect(seen.map((p) => p.percent)).toEqual([null, 40, 41])
    expect(worker.terminated).toBe(1)
    // the deliberate terminate must not be logged as a crash
    expect(logText()).toBe('')
  })

  it('throttles progress inside one phase but never swallows a phase change', async () => {
    const worker = new FakeWorker()
    const seen: StorageBootstrapProgress[] = []
    const run = runStorageBootstrapOffThread(
      dir,
      {},
      { workerFactory: () => worker, onProgress: (p) => seen.push(p), progressIntervalMs: 60_000 },
    )
    for (let i = 0; i < 50; i++)
      worker.emit('message', { type: 'progress', progress: { phase: 'migrating', percent: i } })
    worker.emit('message', { type: 'progress', progress: { phase: 'finalizing', percent: null } })
    worker.emit('message', { type: 'result', result: { ready: true, migrated: true } })
    await run
    expect(seen).toEqual([
      { phase: 'migrating', percent: 0 },
      { phase: 'finalizing', percent: null },
    ])
  })

  it('fails closed when the worker errors', async () => {
    const worker = new FakeWorker()
    const run = runStorageBootstrapOffThread(
      dir,
      { settingsDir: dir },
      { workerFactory: () => worker },
    )
    worker.emit('error', new Error('out of memory'))
    const result = await run
    expect(result.ready).toBe(false)
    expect(result.migrated).toBe(false)
    expect(result.error).toContain('out of memory')
    expect(logText()).toContain('out of memory')
  })

  it('fails closed when the worker exits without a result', async () => {
    const worker = new FakeWorker()
    const run = runStorageBootstrapOffThread(
      dir,
      { settingsDir: dir },
      { workerFactory: () => worker },
    )
    worker.emit('exit', 3)
    const result = await run
    expect(result).toMatchObject({ ready: false, migrated: false })
    expect(result.error).toContain('code 3')
    expect(logText()).toContain('without a result')
  })

  it('ignores messages that are not the worker protocol (shared bundles post their own)', async () => {
    const worker = new FakeWorker()
    const run = runStorageBootstrapOffThread(dir, {}, { workerFactory: () => worker })
    worker.emit('message', { ok: false, error: 'Invalid storage accounting worker payload' })
    worker.emit('message', 'noise')
    worker.emit('message', null)
    worker.emit('message', { type: 'result', result: { ready: true, migrated: false } })
    await expect(run).resolves.toEqual({ ready: true, migrated: false })
  })

  it('never hands the worker a dbPath (bundled accounting / retention workers would take it as a job)', async () => {
    let received: unknown
    const worker = new FakeWorker()
    const run = runStorageBootstrapOffThread(
      dir,
      { settingsDir: dir },
      {
        workerFactory: (_path, data) => {
          received = data
          return worker
        },
      },
    )
    worker.emit('message', { type: 'result', result: { ready: true, migrated: false } })
    await run
    expect(received).toEqual({ dbDir: dir, options: { settingsDir: dir } })
    expect(received).not.toHaveProperty('dbPath')
  })

  it('runs in-process only when no worker can be created, and reports the same result shape', async () => {
    const runInline = vi.fn(
      async (_dir: string, options: { onProgress?: (p: StorageBootstrapProgress) => void }) => {
        options.onProgress?.({ phase: 'checking', percent: null })
        return { ready: true, migrated: false } as const
      },
    )
    const seen: StorageBootstrapProgress[] = []
    const result = await runStorageBootstrapOffThread(
      dir,
      { settingsDir: dir },
      {
        workerFactory: () => {
          throw new Error('no worker script')
        },
        runInline,
        onProgress: (p) => seen.push(p),
      },
    )
    expect(result).toEqual({ ready: true, migrated: false })
    expect(runInline).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([{ phase: 'checking', percent: null }])
    expect(logText()).toContain('could not start')
  })

  it('stays fail-closed if the in-process fallback throws', async () => {
    const result = await runStorageBootstrapOffThread(
      dir,
      { settingsDir: dir },
      {
        workerFactory: () => {
          throw new Error('no worker script')
        },
        runInline: async () => {
          throw new Error('disk gone')
        },
      },
    )
    expect(result).toMatchObject({ ready: false, migrated: false })
    expect(result.error).toContain('disk gone')
  })
})
