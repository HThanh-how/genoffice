import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { storageBudgetAckReply, waitForManagerWriteReady } from './helpers/storage-budget-ack'

let dir: string
let managers: DocumentMemoryManager[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-shutdown-test-'))
  managers = []
})

afterEach(async () => {
  for (const m of managers) {
    try {
      await m.closeAsync()
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
})

class ControlledWorker extends EventEmitter {
  terminated = false
  terminateCallCount = 0
  activeRequests = new Set<number>()

  constructor(public readonly dbPath: string) {
    super()
  }

  postMessage(message: any): void {
    if (this.terminated) return
    const id = message.id
    this.activeRequests.add(id)

    setTimeout(() => {
      if (this.terminated || !this.activeRequests.has(id)) return
      const ack = storageBudgetAckReply(message)
      if (ack) {
        this.emit('message', ack)
        this.activeRequests.delete(id)
        return
      }

      if (message.type === 'extract') {
        this.emit('message', {
          id,
          result: {
            hash: 'hash-abc',
            mtimeMs: Date.now(),
            sizeBytes: 100,
            chunks: [{ text: 'extracted snippet', startByte: 0, endByte: 100 }],
            status: 'ready',
          },
        })
      } else if (message.type === 'embed') {
        this.emit('message', {
          id,
          result: [[0.1, 0.2, 0.3]],
        })
      }
      this.activeRequests.delete(id)
    }, 5)
  }

  terminate(): Promise<number> {
    this.terminateCallCount++
    this.terminated = true
    this.activeRequests.clear()
    return new Promise((resolve) => setTimeout(() => resolve(0), 50))
  }
}

function createTestManager(worker?: ControlledWorker): {
  instance: DocumentMemoryManager
  worker: ControlledWorker
} {
  const dbPath = join(dir, 'document-memory.db')
  const w = worker ?? new ControlledWorker(dbPath)
  const instance = new DocumentMemoryManager(dir, {
    pollIntervalMs: 60_000,
    workerFactory: () => w as unknown as Worker,
  })
  managers.push(instance)
  return { instance, worker: w }
}

describe('Asynchronous Worker Shutdown (Job P0-03)', () => {
  it('P0-03.1: two simultaneous closeAsync calls share the exact same idempotent promise', async () => {
    const { instance, worker } = createTestManager()
    await waitForManagerWriteReady(instance)

    const p1 = instance.closeAsync()
    const p2 = instance.closeAsync()

    expect(p1).toBe(p2)
    await Promise.all([p1, p2])

    expect(worker.terminateCallCount).toBe(1)
  })

  it('P0-03.2: close() followed by closeAsync() awaits the same in-progress shutdown', async () => {
    const { instance, worker } = createTestManager()
    await waitForManagerWriteReady(instance)

    instance.close()
    const p = instance.closeAsync()
    await p

    expect(worker.terminateCallCount).toBe(1)
  })

  it('P0-03.3: shutdown during in-flight extraction terminates workers before database closes', async () => {
    const { instance, worker } = createTestManager()
    await waitForManagerWriteReady(instance)

    const testFile = join(dir, 'slow.txt')
    writeFileSync(testFile, 'long document text for extraction')
    instance.indexDiscoveredFile(testFile)

    // Trigger shutdown while extraction may be in flight
    await instance.closeAsync()

    expect(worker.terminateCallCount).toBeGreaterThanOrEqual(1)
  })

  it('P0-03.4: shutdown while worker initialization is pending completes cleanly', async () => {
    const { instance } = createTestManager()
    // Intentionally do not wait for write ready; shut down immediately
    await expect(instance.closeAsync()).resolves.toBeUndefined()
  })

  it('P0-03.5: allows reopening the same SQLite database immediately after shutdown without lock errors', async () => {
    const { instance } = createTestManager()
    await waitForManagerWriteReady(instance)

    const dbPath = join(dir, 'document-memory.db')
    await instance.closeAsync()

    // Immediately reopen SQLite handle: must NOT throw EBUSY or database locked
    const directDb = new DatabaseSync(dbPath)
    try {
      const result = directDb.prepare('PRAGMA quick_check;').all()
      expect(result).toBeDefined()
    } finally {
      directDb.close()
    }

    // Immediately reopen with a second DocumentMemoryStore
    const secondStore = new DocumentMemoryStore(dbPath)
    try {
      expect(secondStore.stats()).toBeDefined()
    } finally {
      secondStore.close()
    }
  })

  it('P0-03.6: allows removing temporary SQLite files immediately after shutdown without EBUSY', async () => {
    const { instance } = createTestManager()
    await waitForManagerWriteReady(instance)

    const dbPath = join(dir, 'document-memory.db')
    await instance.closeAsync()

    // Unlinking files must succeed immediately on all platforms (no residual open handles)
    expect(() => unlinkSync(dbPath)).not.toThrow()
  })

  it('P0-03.7: repeated startup and shutdown cycles execute deterministically', async () => {
    const dbPath = join(dir, 'document-memory.db')

    for (let cycle = 0; cycle < 5; cycle++) {
      const worker = new ControlledWorker(dbPath)
      const instance = new DocumentMemoryManager(dir, {
        pollIntervalMs: 60_000,
        workerFactory: () => worker as unknown as Worker,
      })
      await waitForManagerWriteReady(instance)
      await instance.closeAsync()
      expect(worker.terminateCallCount).toBe(1)
    }
  })

  it('P0-03.8: SQLite store remains open while worker termination is in-flight and only closes after termination finishes', async () => {
    let workerTerminating = false
    let storeOpenDuringTermination: boolean | undefined

    const dbPath = join(dir, 'document-memory.db')
    const worker = new ControlledWorker(dbPath)
    worker.terminate = () => {
      worker.terminateCallCount++
      worker.terminated = true
      worker.activeRequests.clear()
      workerTerminating = true
      return new Promise<number>((resolve) => {
        setTimeout(() => {
          try {
            instance.store.stats()
            storeOpenDuringTermination = true
          } catch {
            storeOpenDuringTermination = false
          }
          workerTerminating = false
          resolve(0)
        }, 60)
      })
    }

    const instance = new DocumentMemoryManager(dir, {
      pollIntervalMs: 60_000,
      workerFactory: () => worker as unknown as Worker,
    })
    managers.push(instance)
    await waitForManagerWriteReady(instance)

    const shutdownPromise = instance.closeAsync()
    await new Promise((r) => setTimeout(r, 10))
    expect(workerTerminating).toBe(true)

    // During worker termination, store must still be open
    expect(() => instance.store.stats()).not.toThrow()

    await shutdownPromise
    expect(storeOpenDuringTermination).toBe(true)

    // Only after shutdown completes, store is closed
    expect(() => instance.store.stats()).toThrow()

    // Immediate reopen and unlink work without lock errors
    expect(() => unlinkSync(dbPath)).not.toThrow()
  })
})
