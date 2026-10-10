import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  junkPurgeDone,
  runJunkPurgeStep,
  startJunkPurge,
} from '../src/main/document-memory/runtime/junk-purge'
import { storageBudgetAckReply } from './helpers/storage-budget-ack'
import { seedDocuments } from './helpers/seed-documents'

let dir: string
let store: DocumentMemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-junk-step-'))
  store = new DocumentMemoryStore(join(dir, 'm.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const count = (sql: string): number => (store.rawDb.prepare(sql).get() as { n: number }).n

describe('junk purge runs in bounded slices', () => {
  it('deletes only never-opened junk, resumes from its cursor and sets the one-time flag at the end', () => {
    const seeded = seedDocuments(store.rawDb, {
      docs: 300,
      junkEvery: 5,
      openedEvery: 10,
      chunksPerDoc: 3,
    })
    const before = count('SELECT count(*) n FROM documents')
    let removed = 0
    let steps = 0
    for (;;) {
      // a 1 ms budget forces many slices; the cursor makes each one continue where the last stopped
      const step = store.purgeDiscoveredByNameStep((name) => name.startsWith('~$'), {
        maxMs: 1,
        pageSize: 20,
        flagKey: 'junk_test',
      })
      removed += step.removed
      steps++
      if (step.done) break
      expect(junkPurgeDone(store)).toBe(false)
    }
    expect(steps).toBeGreaterThan(3)
    expect(removed).toBe(seeded.junk)
    expect(count('SELECT count(*) n FROM documents')).toBe(before - seeded.junk)
    // opened junk survives; ordinary documents survive
    expect(
      count("SELECT count(*) n FROM documents WHERE name LIKE '~$%' AND last_opened_at = 0"),
    ).toBe(0)
    expect(
      count("SELECT count(*) n FROM documents WHERE name LIKE '~$%' AND last_opened_at > 0"),
    ).toBeGreaterThan(0)
    // nothing of a deleted document is left behind: chunks, sets, full-text rows, vectors, counters
    expect(
      count('SELECT count(*) n FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)'),
    ).toBe(0)
    expect(
      count(
        'SELECT count(*) n FROM chunk_sets WHERE document_id NOT IN (SELECT id FROM documents)',
      ),
    ).toBe(0)
    expect(
      count(
        'SELECT count(*) n FROM chunk_embeddings WHERE chunk_id NOT IN (SELECT id FROM chunks)',
      ),
    ).toBe(0)
    expect(count('SELECT count(*) n FROM chunk_fts')).toBe(count('SELECT count(*) n FROM chunks'))
    expect(
      count(
        'SELECT count(*) n FROM document_embedding_counts WHERE document_id NOT IN (SELECT id FROM documents)',
      ),
    ).toBe(0)
    expect(store.rawDb.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      store.rawDb.prepare("SELECT 1 FROM document_memory_meta WHERE key = 'junk_test'").get(),
    ).toBeTruthy()
    expect(
      store.rawDb
        .prepare("SELECT 1 FROM document_memory_meta WHERE key = 'junk_test_cursor'")
        .get(),
    ).toBeUndefined()
  })

  it('a slice returns within its budget even when thousands of documents are junk', () => {
    seedDocuments(store.rawDb, { docs: 3000, junkEvery: 1, chunksPerDoc: 2 })
    const started = performance.now()
    const step = runJunkPurgeStep(store)
    const took = performance.now() - started
    expect(step.done).toBe(false)
    expect(step.removed).toBeGreaterThan(0)
    expect(step.removed).toBeLessThan(3000)
    // budget 25 ms plus the one document in flight; far from the seconds the single-transaction purge needed
    expect(took).toBeLessThan(250)
  })

  it('deleting a document never scans its child tables (foreign keys are indexed)', () => {
    const plan = (sql: string): string =>
      (store.rawDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join('\n')
    expect(plan('SELECT 1 FROM chunk_sets WHERE document_id = 1')).toContain(
      'chunk_sets_document_id',
    )
    expect(plan('SELECT 1 FROM chunks WHERE chunk_set_id = 1')).toContain('chunks_chunk_set_id')
    expect(
      plan("SELECT 1 FROM documents WHERE size_bytes = 1 AND path != 'x' AND excluded = 0"),
    ).toContain('documents_size_bytes')
  })
})

describe('the purge never blocks the event loop', () => {
  it('a long purge driven through the worker protocol keeps a 5 ms timer within 150 ms', async () => {
    seedDocuments(store.rawDb, { docs: 6000, junkEvery: 2, chunksPerDoc: 3 })
    const gaps: number[] = []
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
    }, 5)
    const sync = vi.spyOn(store, 'purgeDiscoveredByName')
    await new Promise<void>((resolve) => {
      const stop = startJunkPurge({
        store,
        // the worker, in this thread: one slice per request, like the real protocol
        ask: async () => ({ id: 1, result: runJunkPurgeStep(store) }),
        isActive: () => true,
        stepGapMs: 1,
        setTimer: (fn, ms) => setTimeout(fn, ms),
      })
      const wait = setInterval(() => {
        if (junkPurgeDone(store)) {
          clearInterval(wait)
          stop()
          resolve()
        }
      }, 20)
    })
    clearInterval(timer)
    expect(sync).not.toHaveBeenCalled()
    expect(count("SELECT count(*) n FROM documents WHERE name LIKE '~$%'")).toBe(0)
    // the single-transaction purge held the loop for the whole run (seconds on this data)
    expect(Math.max(...gaps)).toBeLessThan(150)
  }, 60_000)

  it('the driver stops when the worker keeps failing, and when the manager is stopped', async () => {
    const ask = vi.fn(async () => null)
    const timers: number[] = []
    startJunkPurge({
      store,
      ask,
      isActive: () => true,
      retryMs: 7,
      setTimer: (fn, ms) => {
        timers.push(ms)
        return setTimeout(fn, 0)
      },
    })
    await vi.waitFor(() => expect(ask.mock.calls.length).toBe(5))
    await new Promise((r) => setTimeout(r, 30))
    expect(ask.mock.calls.length).toBe(5) // gives up; the next start retries
    expect(timers).toContain(7)
  })
})

class FakeWorker extends EventEmitter {
  requests: string[] = []
  postMessage(message: { id: number; type: string }) {
    this.requests.push(message.type)
    setTimeout(() => {
      const ack = storageBudgetAckReply(message)
      if (ack) this.emit('message', ack)
      else if (message.type === 'junk-purge-step')
        this.emit('message', { id: message.id, result: { removed: 0, scanned: 0, done: true } })
      else this.emit('message', { id: message.id, result: {} })
    }, 0)
  }
  terminate() {
    return Promise.resolve(0)
  }
}

describe('DocumentMemoryManager does not purge on the main thread', () => {
  it('asks the worker for the junk purge and leaves the rows to it', async () => {
    const managerDir = mkdtempSync(join(tmpdir(), 'genoffice-junk-manager-'))
    const worker = new FakeWorker()
    let manager: DocumentMemoryManager | null = null
    try {
      // a library with junk, created before the manager opens it
      const seedStore = new DocumentMemoryStore(join(managerDir, 'document-memory.db'))
      seedDocuments(seedStore.rawDb, { docs: 60, junkEvery: 3 })
      seedStore.close()
      manager = new DocumentMemoryManager(managerDir, {
        dbDir: managerDir,
        junkPurgeDelayMs: 10,
        pollIntervalMs: 3_600_000,
        workerFactory: () => worker as never,
      })
      const mainSide = vi.spyOn(manager.store, 'purgeDiscoveredByName')
      const mainStep = vi.spyOn(manager.store, 'purgeDiscoveredByNameStep')
      await vi.waitFor(() => expect(worker.requests).toContain('junk-purge-step'), {
        timeout: 5_000,
      })
      expect(mainSide).not.toHaveBeenCalled()
      expect(mainStep).not.toHaveBeenCalled()
      // the fake worker deleted nothing: every junk row is still there, proof the main thread did not do it
      expect(
        (
          manager.store.rawDb
            .prepare("SELECT count(*) n FROM documents WHERE name LIKE '~$%'")
            .get() as { n: number }
        ).n,
      ).toBe(20)
    } finally {
      await manager?.closeAsync()
      rmSync(managerDir, { recursive: true, force: true })
    }
  })
})
