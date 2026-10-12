import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { AdmissionRetry } from '../src/main/document-memory/runtime/admission-retry'
import { EmbeddingCoordinator } from '../src/main/document-memory/runtime/embedding-coordinator'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import {
  createStorageBudget,
  createStorageBudgetSnapshot,
  type StorageBudgetSnapshot,
} from '../src/main/document-memory/storage-budget'
import { resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import {
  storageBudgetAckReply,
  compactionNoopReply,
  waitForManagerWriteReady,
} from './helpers/storage-budget-ack'

describe('AdmissionRetry (bounded backoff, never a busy loop)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make(freshSeq: boolean[]) {
    const calls: string[] = []
    let active = true
    const retry = new AdmissionRetry({
      refresh: async () => {
        calls.push('refresh')
        return freshSeq.shift() ?? false
      },
      resume: () => {
        calls.push('resume')
      },
      isActive: () => active,
      baseMs: 1000,
      maxMs: 8000,
    })
    return {
      retry,
      calls,
      setActive: (v: boolean) => {
        active = v
      },
    }
  }

  it('collapses any number of requests into one timer and re-measures BEFORE resuming', async () => {
    const { retry, calls } = make([true])
    retry.request()
    retry.request(false)
    retry.request()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(['refresh', 'resume'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('doubles the delay while refusals persist, caps it, and resets after success', async () => {
    const { retry } = make([])
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      delays.push(retry.nextDelayMs())
      retry.request(false) // a refusal that is not about accounting (quota): keeps backing off
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
    retry.succeeded()
    expect(retry.nextDelayMs()).toBe(1000)
  })

  it('an accounting refusal answered by a fresh measurement restarts from the short delay', async () => {
    const { retry } = make([false, false, true])
    for (let i = 0; i < 3; i++) {
      retry.request(true)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(retry.nextDelayMs()).toBe(1000)
  })

  it('stops for good when disposed or inactive', async () => {
    const a = make([true])
    a.retry.request()
    a.retry.dispose()
    expect(vi.getTimerCount()).toBe(0)
    a.retry.request()
    expect(vi.getTimerCount()).toBe(0)
    const b = make([true])
    b.retry.request()
    b.setActive(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(b.calls).toEqual([])
  })
})

describe('EmbeddingCoordinator reports transient admission refusals to its owner', () => {
  let dir: string
  let store: DocumentMemoryStore
  const PROFILE = EMBEDDING_PROFILES.standard
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'embed-admission-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const fresh = (): StorageBudgetSnapshot =>
    createStorageBudgetSnapshot({
      activeDbSizeBytes: 1_000_000,
      nameMetadataBytes: 0,
      totalManagedBytes: 1_000_000,
      budgetBytes: 500 * 1024 * 1024,
      measurementStatus: 'fresh',
      isDegraded: false,
      measuredAt: Date.now(),
    })

  function job() {
    const path = join(dir, 'doc.txt')
    writeFileSync(path, 'content')
    const st = statSync(path)
    const chunks = [0, 1, 2].map((i) => ({
      text: `doc body paragraph ${i} lorem ipsum`,
      location: `Chunk ${i + 1}`,
    }))
    store.replaceDocument(path, {
      hash: 'h-doc',
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      chunks,
      embeddingModel: null,
      status: 'text-only',
    })
    return {
      path,
      generation: 1,
      epoch: 1,
      hash: 'h-doc',
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      chunks,
      startOffset: 0,
    }
  }
  const ask = async (req: { texts: string[] }) => ({
    result: req.texts.map(() => new Array(PROFILE.dimensions).fill(0.05)),
  })

  it('a stale/degraded accounting gate frees the queue for the owner backoff instead of the fixed 15 s delay, then resumes', async () => {
    let accountingOk = false
    const signals: Array<[boolean, boolean | undefined]> = []
    const drained = vi.fn()
    const refresh = vi.fn(async () => fresh())
    const coord = new EmbeddingCoordinator({
      store,
      initialProfileId: 'standard',
      admission: new StorageAdmissionController(),
      getStorageBudget: () => createStorageBudget(500 * 1024 * 1024),
      getCurrentUsage: () => 1_000_000,
      refreshUsage: refresh,
      canAcceptExpensiveWork: () => accountingOk,
      isWriteReady: () => true,
      getFreeDiskBytes: async () => 50_000_000_000,
      headroomBytes: 1_000_000,
      onDrainNeeded: drained,
      onAdmission: (blocked, accounting) => signals.push([blocked, accounting]),
    })
    const j = job()
    coord.enqueueEmbed(j)
    drained.mockClear()

    await coord.drainEmbeddings(ask as any)
    expect(signals).toEqual([[true, true]])
    expect(coord.getQueueLength()).toBe(1) // the document stays queued
    expect(coord.isRetryPending()).toBe(false) // the owner's backoff drives the retry, not a 15 s lock-out
    expect(drained).not.toHaveBeenCalled() // and nothing re-enters in a loop

    accountingOk = true
    await coord.drainEmbeddings(ask as any)
    expect(signals.at(-1)).toEqual([false, undefined])
    expect(coord.getQueueLength()).toBe(0)
    const n = (
      store.rawDb.prepare('SELECT count(*) AS c FROM chunk_embeddings').get() as { c: number }
    ).c
    expect(n).toBe(3)
  })

  it('measures accounting three times per committed batch (before admission, before commit, terminal), not four', async () => {
    const refresh = vi.fn(async () => fresh())
    const coord = new EmbeddingCoordinator({
      store,
      initialProfileId: 'standard',
      admission: new StorageAdmissionController(),
      getStorageBudget: () => createStorageBudget(500 * 1024 * 1024),
      getCurrentUsage: () => 1_000_000,
      refreshUsage: refresh,
      canAcceptExpensiveWork: () => true,
      isWriteReady: () => true,
      getFreeDiskBytes: async () => 50_000_000_000,
      headroomBytes: 1_000_000,
    })
    coord.enqueueEmbed(job())
    await coord.drainEmbeddings(ask as any)
    expect(refresh).toHaveBeenCalledTimes(3)
  })
})

describe('DocumentMemoryManager does not wait for the next poll after a transient admission refusal', () => {
  let dir: string
  let managers: DocumentMemoryManager[]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-drain-retry-'))
    managers = []
  })
  afterEach(async () => {
    for (const m of managers) await m.closeAsync()
    resetIndexingPolicyBus()
    rmSync(dir, { recursive: true, force: true })
  })

  class Fake extends EventEmitter {
    extracts: string[] = []
    embeds = 0
    postMessage(m: any) {
      setTimeout(() => {
        const ack = storageBudgetAckReply(m)
        if (ack) return void this.emit('message', ack)
        const noop = compactionNoopReply(m)
        if (noop) return void this.emit('message', noop)
        if (m.type === 'extract') {
          this.extracts.push(m.path)
          const bytes = readFileSync(m.path)
          const st = statSync(m.path)
          this.emit('message', {
            id: m.id,
            result: {
              hash: createHash('sha256').update(bytes).digest('hex'),
              mtimeMs: st.mtimeMs,
              sizeBytes: st.size,
              chunks: chunkDocumentText(bytes.toString('utf8')),
              status: 'text-only',
            },
          })
        } else if (m.type === 'embed') {
          this.embeds++
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: m.id,
            result: m.texts.map(() => new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1)),
          })
        } else this.emit('message', { id: m.id, result: [] })
      }, 1)
    }
    terminate() {
      return Promise.resolve(0)
    }
  }

  it('resumes a queue whose first drain was refused (accounting unknown at start-up) within seconds, with a 60 s poll', async () => {
    const N = 12
    const seed = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    for (let i = 0; i < N; i++) {
      const p = join(dir, `f${i}.txt`)
      writeFileSync(
        p,
        Array.from(
          { length: 30 },
          (_, k) => `Paragraph ${i}-${k} lorem ipsum dolor sit amet consectetur adipiscing elit`,
        ).join('\n\n'),
      )
      expect(seed.remember(p)).toBe(true)
    }
    seed.close()
    const fake = new Fake()
    const manager = new DocumentMemoryManager(dir, {
      pollIntervalMs: 60_000,
      workerFactory: () => fake as unknown as Worker,
    })
    managers.push(manager)
    const reasons: string[] = []
    const reserve = manager.admission.reserve.bind(manager.admission)
    ;(manager.admission as any).reserve = (...a: any[]) => {
      const d = reserve(...a)
      if (a[1] === 'extract') reasons.push(d.admitted ? 'ok' : d.reason)
      return d
    }
    await waitForManagerWriteReady(manager)

    const started = Date.now()
    while (!(
      manager.status().pending === 0 &&
      manager.status().vectors > 0 &&
      manager.status().vectors >= manager.status().chunks
    )) {
      if (Date.now() - started > 15_000)
        throw new Error(`stalled: ${JSON.stringify(manager.status())}`)
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(Date.now() - started).toBeLessThan(15_000) // before the fix: one 60 s poll
    expect(new Set(fake.extracts).size).toBe(N)
    // the startup refusal happened once for the head of the queue and did not discard the rest of the queue
    expect(reasons.filter((r) => r === 'accounting-unknown').length).toBeLessThanOrEqual(2)
    expect(reasons.filter((r) => r === 'ok').length).toBe(N)
  }, 30_000)
})
