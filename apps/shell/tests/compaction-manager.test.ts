import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  MIN_STORAGE_BUDGET_BYTES,
  writeStorageSettings,
} from '../src/main/document-memory/storage/storage-settings'
import { createStorageBudget, hardCapBytes } from '../src/main/document-memory/storage-budget'
import {
  handleCompactionRequest,
  resetCompactionLaneForTests,
} from '../src/main/document-memory/runtime/worker-compaction'
import type {
  FreeSpaceWorkerResult,
  RetentionWorkerResult,
} from '../src/main/document-memory/runtime/worker-compaction-types'
import { orderQueue } from '../src/main/document-memory/queue-order'
import { waitForManagerWriteReady } from './helpers/storage-budget-ack'
import {
  ScriptedWorker,
  simulatedAccountingRunner,
  waitFor,
} from './helpers/compaction-worker-harness'
import {
  budgetForRatio,
  chunkCount,
  laneContext,
  seedDocuments,
  vectorCount,
} from './helpers/compaction-fixtures'

/**
 * Real manager + real SQLite + real indexing pipeline; only the accounting total is test-controlled (the usual way the
 * budget tests drive the zones) and the worker is scripted for the storage-compaction lane.
 */
const SOFT = MIN_STORAGE_BUDGET_BYTES // 500 MB
const HARD = hardCapBytes(SOFT)

let dir: string
let managers: DocumentMemoryManager[]
let usage = 0

beforeEach(() => {
  resetCompactionLaneForTests()
  dir = mkdtempSync(join(tmpdir(), 'compaction-manager-'))
  mkdirSync(join(dir, 'files'))
  managers = []
  usage = 0
  writeStorageSettings(dir, { maxDatabaseBytes: SOFT, preset: 'custom', version: 1 })
})
afterEach(async () => {
  for (const m of managers) {
    try {
      m.close()
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 50))
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    await new Promise((r) => setTimeout(r, 100))
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

async function start(
  handlers: ConstructorParameters<typeof ScriptedWorker>[1] = {},
  startUsage = 0,
) {
  usage = startUsage
  const worker = new ScriptedWorker(join(dir, 'document-memory.db'), handlers)
  const manager = new DocumentMemoryManager(dir, {
    workerFactory: () => worker as any,
    pollIntervalMs: 3_600_000,
  })
  managers.push(manager)
  const sched = (manager as any).maintScheduler
  sched.storageAccountingRunner = simulatedAccountingRunner(() => usage)
  await waitForManagerWriteReady(manager)
  await sched.refreshAccountingAsync()
  return { manager, worker, sched }
}

const freeResult = (req: any, freed: number): FreeSpaceWorkerResult => ({
  kind: 'free-space',
  runId: req.runId,
  epoch: req.epoch,
  status: 'completed',
  durationMs: 2,
  displacement: null,
  agedStage: null,
  neededBytes: req.neededBytes,
  freedBytes: freed,
  usedBefore: usage,
  usedAfter: usage - freed,
  fitsHardCap: freed >= req.neededBytes,
  affectedAnnSpaces: [],
  annRequests: [],
})

describe('admission by displacement (real manager)', () => {
  it('(c) at 108.5% a NEW important file whose content would be refused is admitted after the worker frees old content', async () => {
    let asked = 0
    const { manager, worker } = await start(
      {
        'free-space': (req) => {
          asked++
          usage -= req.neededBytes // the worker compacted old content
          return freeResult(req, req.neededBytes)
        },
      },
      Math.round(SOFT * 1.085),
    )
    const file = join(dir, 'files', 'cccd-nguyen-van-a.txt')
    writeFileSync(
      file,
      'Căn cước công dân Nguyễn Văn A zeppelinquartz sổ hộ khẩu giấy tờ quan trọng.',
      'utf8',
    )
    manager.remember(file)
    expect(
      await waitFor(
        () =>
          manager.store.documentByPath(file)?.status === 'ready' ||
          manager.store.documentByPath(file)?.status === 'text-only',
      ),
    ).toBe(true)
    // Identity/extraction, extraction lease, and content commit each retry admission once.
    // The protected name headroom makes all three real reservations hit the cap in this fixture.
    expect(asked).toBe(3)
    expect(worker.of('free-space').every((r) => r.neededBytes > 0)).toBe(true)
    const req = worker.of('free-space')[0]
    expect(req.incomingImportance).toBe('important')
    expect(req.neededBytes).toBeGreaterThan(0)
    expect(manager.store.chunkProgress(file).totalChunks).toBeGreaterThan(0)
    const found = await manager.search('zeppelinquartz')
    expect(found.hits[0]?.path).toBe(resolve(file))
    expect(usage).toBeLessThan(HARD) // never above the hard cap
  })

  it('(d) refused only when nothing can be freed: content refused at the cap, identity kept; at the hard stop no row, one displacement attempt then cooldown', async () => {
    const { manager, worker } = await start(
      { 'free-space': (req) => freeResult(req, 0) },
      Math.round(SOFT * 1.085),
    )
    const a = join(dir, 'files', 'a-note.txt')
    writeFileSync(a, 'plain note about gardening quokkaberry', 'utf8')
    manager.remember(a)
    expect(await waitFor(() => worker.of('free-space').length >= 1)).toBe(true)
    // the file name is searchable (identity row exists) but its content was refused: nothing evictable, quota is real
    expect(await waitFor(() => Boolean(manager.lastIndexError))).toBe(true)
    expect(manager.lastIndexError).toMatch(/quota|Storage/i)
    expect(manager.store.chunkProgress(a).totalChunks).toBe(0)

    // hard stop: the sync guard refuses the new file outright; the displacement is tried, frees nothing, cools down
    usage = Math.round(SOFT * 1.12)
    await (manager as any).maintScheduler.refreshAccountingAsync()
    const before = worker.of('free-space').length
    const b = join(dir, 'files', 'b-note.txt')
    writeFileSync(b, 'second note', 'utf8')
    manager.remember(b)
    await new Promise((r) => setTimeout(r, 400))
    expect(manager.store.documentByPath(b)).toBeFalsy()
    const after = worker.of('free-space').length
    manager.remember(join(dir, 'files', 'a-note.txt'))
    const c = join(dir, 'files', 'c-note.txt')
    writeFileSync(c, 'third note', 'utf8')
    manager.remember(c)
    await new Promise((r) => setTimeout(r, 300))
    expect(worker.of('free-space').length).toBe(after) // cooldown: no worker round trip per refused file
    expect(after - before).toBeLessThanOrEqual(1)
  })

  it('at the hard stop a displacement that frees enough lets the parked intent through (intake replay)', async () => {
    const { manager } = await start(
      {
        'free-space': (req) => {
          usage = Math.round(SOFT * 0.97)
          return freeResult(req, req.neededBytes)
        },
      },
      Math.round(SOFT * 1.12),
    )
    const file = join(dir, 'files', 'late-arrival.txt')
    writeFileSync(file, 'late arrival pomelogranite', 'utf8')
    manager.remember(file)
    expect(await waitFor(() => Boolean(manager.store.documentByPath(file)), 8000)).toBe(true)
  })
})

describe('no evict -> re-embed thrash, revive on touch (real manager)', () => {
  async function seededManager() {
    const dbPath = join(dir, 'document-memory.db')
    const seed = new DocumentMemoryStore(dbPath, { role: 'worker' })
    const docs = seedDocuments(seed, join(dir, 'files'), [
      ...Array.from({ length: 6 }, (_, i) => ({ name: `old-${i}.txt`, ageDays: 400 + i })),
      { name: 'keep.txt', kind: 'important' as const, ageDays: 400, chunks: 2 },
    ])
    for (const d of docs) writeFileSync(d.path, `real file ${d.name}`, 'utf8')
    const tight = budgetForRatio(seed, 0.91)
    const evicted = (await handleCompactionRequest(laneContext(seed, tight), {
      type: 'run-retention',
      runId: 'seed',
      configVersion: 1,
      urgency: 'normal',
    })) as RetentionWorkerResult
    expect(evicted.report?.age?.archiveVectorDocsPruned).toBeGreaterThan(0)
    expect(vectorCount(seed, docs[0]!.path)).toBe(0)
    seed.close()
    return docs
  }

  it('(f) evicted documents are not re-queued by poll() or by budget-state callbacks; a touch (remember/open) revives them', async () => {
    const docs = await seededManager()
    const { manager, worker, sched } = await start({}, Math.round(SOFT * 0.5))
    const poll = (): Promise<void> => (manager as any).poll()
    await poll()
    // budget state flips ok -> warning -> ok -> grace -> ok: every transition calls poll() + drain()
    for (const ratio of [0.95, 0.5, 1.03, 0.5, 0.85, 0.4]) {
      usage = Math.round(SOFT * ratio)
      await sched.refreshAccountingAsync()
      await poll()
    }
    await new Promise((r) => setTimeout(r, 300))
    const evictedPaths = docs.filter((d) => d.name.startsWith('old')).map((d) => d.path)
    expect(worker.extractPaths.filter((p) => evictedPaths.includes(p))).toEqual([])
    expect(worker.embedCalls).toBe(0)

    // touching one of them (the agent opens the file) revives it: re-read and re-embedded
    const touched = docs[0]!.path
    await new Promise((r) => setTimeout(r, 10))
    manager.remember(touched)
    expect(await waitFor(() => worker.extractPaths.includes(touched))).toBe(true)
    expect(worker.extractPaths.filter((p) => evictedPaths.includes(p) && p !== touched)).toEqual([])
  })

  it('a content-evicted (identity-only) archive document is re-extracted on read-now', async () => {
    const dbPath = join(dir, 'document-memory.db')
    const seed = new DocumentMemoryStore(dbPath, { role: 'worker' })
    const docs = seedDocuments(seed, join(dir, 'files'), [
      { name: 'ancient.txt', ageDays: 500 },
      { name: 'other.txt', ageDays: 500 },
    ])
    for (const d of docs) writeFileSync(d.path, `ancient report ${d.name} nectarinequartz`, 'utf8')
    // identity-only: what the archive content stage leaves behind
    seed.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const { CacheRetentionRepository } =
      await import('../src/main/document-memory/storage/repositories/cache-retention-repository')
    const ids = docs.map((d) => seed.documentByPath(d.path)!.id)
    new CacheRetentionRepository(seed.rawDb).evictCacheContentBatch(ids)
    expect(chunkCount(seed, docs[0]!.path)).toBe(0)
    seed.close()

    const { manager } = await start({}, Math.round(SOFT * 0.3))
    const id = manager.store.documentByPath(docs[0]!.path)!.id
    const res = await manager.readNowDocument(id)
    expect(res.ok).toBe(true)
    expect(chunkCount(manager.store, docs[0]!.path)).toBeGreaterThan(0)
    expect(
      (
        manager.store.rawDb
          .prepare('SELECT content_evicted AS e FROM documents WHERE id = ?')
          .get(id) as { e: number }
      ).e,
    ).toBe(0)
  })
})

describe('manager wiring', () => {
  it('the worker run, ANN requests, release and diagnostics are all wired through the manager (no main-thread retention)', async () => {
    const annCalls: string[] = []
    let ran = 0
    const { manager, worker, sched } = await start(
      {
        'run-retention': (req) => {
          ran++
          const before = usage
          usage = Math.round(SOFT * 0.78)
          return {
            kind: 'run-retention',
            runId: req.runId,
            epoch: req.epoch,
            status: 'completed',
            durationMs: 4,
            urgency: req.urgency,
            report: { triggered: true, targetReached: true, redundancy: { ran: true } },
            bytesBefore: before,
            bytesAfter: usage,
            belowSoftQuota: true,
            release: {
              vectorDocuments: 0,
              vectorChunks: 0,
              skeletonDocuments: 0,
              skeletonEstimatedBytes: 0,
            },
            affectedAnnSpaces: [],
            annRequests: [
              {
                spaceId: 'sp-1',
                dimensions: 4,
                vectorCount: 50,
                targetGeneration: 2,
                estimatedBytes: 500,
                clearsStaleIndex: false,
              },
            ],
          }
        },
      },
      Math.round(SOFT * 0.95),
    )
    ;(manager as any).triggerAnnSync = async (space: string) => void annCalls.push(space)
    await sched.refreshAccountingAsync()
    expect(await waitFor(() => ran >= 1, 8000)).toBe(true)
    expect(await waitFor(() => annCalls.length >= 1)).toBe(true)
    expect(annCalls).toEqual(['sp-1'])
    // the main thread did not run the retention policy: the only retention work is the worker request
    expect(worker.of('run-retention')[0].urgency).toBe('normal')
    expect(sched.getLastCompactionOutcome()?.report?.redundancy).toEqual({ ran: true })
    const diag = await manager.getStorageDiagnosticsAsync()
    void diag
  })

  it('closing the manager during a run leaves no timers and dispatches nothing afterwards', async () => {
    let started = false
    let finish!: (v: unknown) => void
    const annCalls: string[] = []
    const { manager, worker } = await start(
      {
        'run-retention': (req) => {
          started = true
          return new Promise(
            (r) =>
              (finish = () =>
                r({
                  kind: 'run-retention',
                  runId: req.runId,
                  epoch: req.epoch,
                  status: 'completed',
                  durationMs: 1,
                  urgency: 'normal',
                  report: null,
                  bytesBefore: 1,
                  bytesAfter: 1,
                  belowSoftQuota: false,
                  release: {
                    vectorDocuments: 1,
                    vectorChunks: 1,
                    skeletonDocuments: 0,
                    skeletonEstimatedBytes: 0,
                  },
                  affectedAnnSpaces: [],
                  annRequests: [
                    {
                      spaceId: 'late',
                      dimensions: 4,
                      vectorCount: 50,
                      targetGeneration: 2,
                      estimatedBytes: 500,
                      clearsStaleIndex: false,
                    },
                  ],
                })),
          )
        },
      },
      Math.round(SOFT * 0.95),
    )
    ;(manager as any).triggerAnnSync = async (space: string) => void annCalls.push(space)
    await (manager as any).maintScheduler.refreshAccountingAsync()
    expect(await waitFor(() => started, 8000)).toBe(true)
    manager.close()
    finish(undefined)
    await new Promise((r) => setTimeout(r, 200))
    expect(annCalls).toEqual([])
    expect(worker.received.some((m) => m.type === 'run-retention')).toBe(true)
  })
})

describe('extraction queue near the quota', () => {
  it('files modified recently go ahead of the old backlog (right after what was asked for)', () => {
    const none = new Set<string>()
    const line = ['old-a', 'old-b', 'new-c', 'new-d']
    const recent = new Set(['new-c', 'new-d'])
    const bytes = new Map<string, number>()
    expect(orderQueue(line, { urgent: none, deferred: none, bytes })).toEqual(line)
    expect(
      orderQueue(line, { urgent: none, deferred: none, bytes, prioritize: (p) => recent.has(p) }),
    ).toEqual(['new-c', 'new-d', 'old-a', 'old-b'])
    expect(
      orderQueue(line, {
        urgent: new Set(['old-b']),
        deferred: none,
        bytes,
        prioritize: (p) => recent.has(p),
      }),
    ).toEqual(['old-b', 'new-c', 'new-d', 'old-a'])
    expect(
      orderQueue(line, {
        urgent: none,
        deferred: new Set(['new-c']),
        bytes,
        prioritize: (p) => recent.has(p),
      }),
    ).toEqual(['new-d', 'old-a', 'old-b', 'new-c'])
  })

  it('MaintenanceScheduler.isRecentUnderQuotaPressure: only near the quota and only for fresh files', async () => {
    const { manager, sched } = await start({}, Math.round(SOFT * 0.5))
    const fresh = join(dir, 'files', 'fresh.txt')
    writeFileSync(fresh, 'fresh text')
    manager.store.remember(fresh)
    manager.store.rawDb
      .prepare('UPDATE documents SET mtime_ms = ? WHERE path = ?')
      .run(Date.now() - 2 * 86_400_000, resolve(fresh))
    const stale = join(dir, 'files', 'stale.txt')
    writeFileSync(stale, 'stale text')
    manager.store.remember(stale)
    manager.store.rawDb
      .prepare('UPDATE documents SET mtime_ms = ? WHERE path = ?')
      .run(Date.now() - 200 * 86_400_000, resolve(stale))
    expect(sched.isRecentUnderQuotaPressure(resolve(fresh))).toBe(false) // 50%: no pressure, no database access
    usage = Math.round(SOFT * 0.93)
    await sched.refreshAccountingAsync()
    expect(sched.isRecentUnderQuotaPressure(resolve(fresh))).toBe(true)
    expect(sched.isRecentUnderQuotaPressure(resolve(stale))).toBe(false)
  })
})

void createStorageBudget
