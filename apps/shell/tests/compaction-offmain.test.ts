import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  MIN_STORAGE_BUDGET_BYTES,
  writeStorageSettings,
} from '../src/main/document-memory/storage/storage-settings'
import { createStorageBudget } from '../src/main/document-memory/storage-budget'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import { seedDocuments, vectorCount, chunkCount } from './helpers/compaction-fixtures'
import { bundleIndexWorker, realIndexWorkerFactory } from './helpers/index-worker-process'
import { waitFor } from './helpers/compaction-worker-harness'
import { waitForManagerWriteReady } from './helpers/storage-budget-ack'

/**
 * The compaction lane across the REAL process boundary: the bundled worker.ts runs as a child process, the manager
 * (this process = the "main thread") only decides when and consumes the JSON report. An index at 93% of the 500 MB
 * product minimum is compacted to <= 80% while the main event loop keeps beating.
 */
const SOFT = MIN_STORAGE_BUDGET_BYTES

describe('worker bundle', () => {
  it('contains the compaction lane (not the main-thread driver) and the age policy', async () => {
    const { modules } = await bundleIndexWorker()
    const has = (needle: string): boolean => modules.some((m) => m.includes(needle))
    for (const needle of [
      'runtime/worker-compaction.ts',
      'runtime/cache-retention-policy.ts',
      'runtime/redundancy-compaction.ts',
      'runtime/storage-optimizer.ts',
      'runtime/value-density.ts',
      'runtime/skeleton-rehydration.ts',
      'runtime/vector-eviction-release.ts',
      'runtime/ann-rebuild-after-compaction.ts',
    ]) {
      expect(has(needle), needle).toBe(true)
    }
    expect(has('runtime/compaction-driver.ts')).toBe(false)
    expect(has('runtime/maintenance-scheduler.ts')).toBe(false)
  }, 120_000)
})

describe('off the main thread (real child-process worker)', () => {
  let dir: string
  let manager: DocumentMemoryManager | undefined
  beforeAll(async () => {
    await bundleIndexWorker()
  }, 120_000)
  afterEach(async () => {
    if (manager) {
      await manager.closeAsync()
      manager = undefined
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('(a) 93% of the quota is compacted to <= 80% by the worker process; the main event loop never stalls', async () => {
    dir = mkdtempSync(join(tmpdir(), 'compaction-offmain-'))
    mkdirSync(join(dir, 'files'))
    writeStorageSettings(dir, { maxDatabaseBytes: SOFT, preset: 'custom', version: 1 })
    const dbPath = join(dir, 'document-memory.db')

    // ~85 MB of evictable archive content + important documents + ballast up to 93% of the quota
    const seed = new DocumentMemoryStore(dbPath, { role: 'worker' })
    const docs = seedDocuments(seed, join(dir, 'files'), [
      ...Array.from({ length: 150 }, (_, i) => ({
        name: `archive-${i}.txt`,
        ageDays: 400 + (i % 50),
        chunks: 10,
        words: 3500,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `fresh-${i}.txt`,
        ageDays: 2,
        chunks: 10,
        words: 300,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        name: `important-${i}.txt`,
        kind: 'important' as const,
        ageDays: 700,
        chunks: 10,
        words: 300,
      })),
    ])
    seed.rawDb.exec('CREATE TABLE IF NOT EXISTS ballast (x BLOB)')
    const target = Math.round(SOFT * 0.93)
    seed.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    let total = collectStorageAccounting({ dbPath }).totalManagedBytes
    expect(total).toBeLessThan(target)
    const content = total
    while (target - total > 3_000_000) {
      seed.rawDb
        .prepare('INSERT INTO ballast VALUES (zeroblob(?))')
        .run(Math.min(40_000_000, target - total - 1_000_000))
      seed.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      total = collectStorageAccounting({ dbPath }).totalManagedBytes
    }
    expect(total / SOFT).toBeGreaterThan(0.91)
    expect(total / SOFT).toBeLessThan(0.97)
    expect(content).toBeGreaterThan(70_000_000) // enough evictable content to reach the 80% floor
    // the one-time main-thread name-projection backfill (not part of compaction) is completed up front so the
    // heartbeat below isolates the compaction work
    for (let i = 0; i < 100 && !seed.backfillNameProjectionBatch(100).done; i++);
    seed.close()

    manager = new DocumentMemoryManager(dir, {
      workerFactory: (await realIndexWorkerFactory()) as any,
      pollIntervalMs: 3_600_000,
      workerTimeoutMs: 120_000,
    })
    const sched = (manager as any).maintScheduler
    await waitForManagerWriteReady(manager, 20_000)
    // heartbeat on the main thread while the worker compacts
    const delay = monitorEventLoopDelay({ resolution: 5 })
    delay.enable()
    let maxGap = 0
    let last = performance.now()
    const t00 = performance.now()
    const gaps: Array<{ at: number; gap: number }> = []
    const beat = setInterval(() => {
      const now = performance.now()
      if (now - last > 40) gaps.push({ at: Math.round(now - t00), gap: Math.round(now - last) })
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)
    try {
      await sched.refreshAccountingAsync() // 93% -> arms the pressure run (2 s), the worker process does the rest
      const done = await waitFor(
        () => sched.getLastCompactionOutcome()?.status === 'completed',
        120_000,
      )
      expect(done).toBe(true)
    } finally {
      clearInterval(beat)
      delay.disable()
    }

    const outcome = sched.getLastCompactionOutcome()
    expect(outcome.report.targetReached).toBe(true)
    expect(outcome.report.bytesBefore / SOFT).toBeGreaterThan(0.9)
    expect(outcome.report.bytesAfter / SOFT).toBeLessThanOrEqual(0.8)
    expect(collectStorageAccounting({ dbPath }).totalManagedBytes / SOFT).toBeLessThanOrEqual(0.8)
    // no synchronous block of the main thread longer than ~100 ms (the old main-thread path blocked ~0.6 s per batch)
    // measured: ~20 ms max over a ~14 s run, with a CPU benchmark running next to it
    expect(maxGap, JSON.stringify(gaps)).toBeLessThan(100)
    expect(delay.max / 1e6).toBeLessThan(100)

    // identity + integrity: nothing lost but cache; originals untouched by construction
    const check = new DocumentMemoryStore(dbPath, { role: 'worker' })
    try {
      expect(
        (check.rawDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
          .integrity_check,
      ).toBe('ok')
      for (const d of docs) expect(check.documentByPath(d.path)).not.toBeNull()
      for (const d of docs.filter(
        (x) => x.name.startsWith('important') || x.name.startsWith('fresh'),
      )) {
        expect(vectorCount(check, d.path)).toBe(10)
        expect(chunkCount(check, d.path)).toBe(10)
      }
      expect(
        docs
          .filter((d) => d.name.startsWith('archive'))
          .some((d) => vectorCount(check, d.path) === 0),
      ).toBe(true)
    } finally {
      check.close()
    }
  }, 300_000)

  it('every lane request crosses the process boundary as plain JSON: free-space, optimize-fts, redundancy-analyze, stale-config, cancel', async () => {
    dir = mkdtempSync(join(tmpdir(), 'compaction-ipc-'))
    mkdirSync(join(dir, 'files'))
    const dbPath = join(dir, 'document-memory.db')
    const seed = new DocumentMemoryStore(dbPath, { role: 'worker' })
    const docs = seedDocuments(seed, join(dir, 'files'), [
      ...Array.from({ length: 12 }, (_, i) => ({
        name: `old-${i}.txt`,
        ageDays: 500 + i,
        chunks: 8,
        words: 400,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        name: `new-${i}.txt`,
        ageDays: 2,
        chunks: 8,
        words: 400,
      })),
    ])
    seed.close()
    const factory = await realIndexWorkerFactory()
    const worker = factory('unused', {
      cacheDir: join(dir, 'models'),
      dbPath,
      embeddingProfile: 'standard',
      storageBudget: createStorageBudget({ maxDatabaseBytes: SOFT, version: 1 }),
      configVersion: 1,
    } as any)
    let nextId = 1
    const pending = new Map<number, (m: any) => void>()
    worker.on('message', (m: any) => {
      if (m && typeof m.id === 'number') pending.get(m.id)?.(m)
    })
    const ask = (req: Record<string, unknown>): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        const t = setTimeout(() => reject(new Error(`no reply to ${String(req.type)}`)), 60_000)
        pending.set(id, (m) => {
          clearTimeout(t)
          resolve(m)
        })
        worker.postMessage({ ...req, id })
      })
    try {
      const fs1 = await ask({
        type: 'free-space',
        runId: 'ipc-1',
        epoch: 3,
        configVersion: 1,
        neededBytes: 150_000,
        incomingImportance: 'normal',
      })
      expect(fs1.error).toBeUndefined()
      expect(fs1.result).toMatchObject({
        kind: 'free-space',
        runId: 'ipc-1',
        epoch: 3,
        status: 'completed',
      })
      expect(fs1.result.freedBytes).toBeGreaterThanOrEqual(150_000)

      const fts = await ask({
        type: 'optimize-fts',
        runId: 'ipc-2',
        configVersion: 1,
        maxPages: 64,
        budgetMs: 2000,
      })
      expect(fts.result).toMatchObject({
        kind: 'optimize-fts',
        runId: 'ipc-2',
        status: 'completed',
      })

      const ana = await ask({
        type: 'redundancy-analyze',
        runId: 'ipc-3',
        configVersion: 1,
        maxRounds: 2,
      })
      expect(ana.result).toMatchObject({ kind: 'redundancy-analyze', runId: 'ipc-3' })

      const stale = await ask({
        type: 'run-retention',
        runId: 'ipc-4',
        configVersion: 99,
        urgency: 'normal',
      })
      expect(stale.result).toMatchObject({
        kind: 'run-retention',
        status: 'stale-config',
        report: null,
      })

      const none = await ask({
        type: 'run-retention',
        runId: 'ipc-5',
        configVersion: 1,
        urgency: 'none',
        usage: { usedBytes: 1000, limitState: 'ok', measurementStatus: 'fresh' },
      })
      // nothing to evict at urgency none; the release hook re-opens the vectors the free-space step evicted (usage 1000 B)
      expect(none.result).toMatchObject({
        kind: 'run-retention',
        status: 'completed',
        report: null,
      })
      expect(none.result.release.vectorDocuments).toBeGreaterThan(0)

      const cancel = await ask({ type: 'cancel-compaction', runId: 'nothing-running' })
      expect(cancel.result).toEqual({ cancelled: false })
    } finally {
      await worker.terminate()
    }
    const check = new DocumentMemoryStore(dbPath, { role: 'worker' })
    try {
      // the worker displaced old content only
      for (const d of docs.filter((x) => x.name.startsWith('new')))
        expect(vectorCount(check, d.path)).toBe(8)
      expect(
        docs.filter((d) => d.name.startsWith('old')).some((d) => vectorCount(check, d.path) === 0),
      ).toBe(true)
    } finally {
      check.close()
    }
  }, 180_000)
})
