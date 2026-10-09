import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import {
  NORMAL_NO_PROGRESS_BACKOFF_MS,
  URGENT_NO_PROGRESS_BACKOFF_MS,
  URGENT_REPEAT_MS,
} from '../src/main/document-memory/runtime/compaction-driver'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { createStorageBudget, hardCapBytes } from '../src/main/document-memory/storage-budget'
import { BackupRetentionRunner } from '../src/main/document-memory/runtime/backup-retention-runner'
import type { WorkerReply, WorkerRequest } from '../src/main/document-memory/worker-types'
import type {
  FreeSpaceWorkerResult,
  RetentionWorkerResult,
} from '../src/main/document-memory/runtime/worker-compaction-types'
import { simulatedAccountingRunner } from './helpers/compaction-worker-harness'
import { compactionNoopReply } from './helpers/storage-budget-ack'

/**
 * WHEN the main thread asks the worker to compact (CompactionDriver via MaintenanceScheduler), against a scripted
 * worker. The worker-side behaviour is covered in worker-compaction.test.ts; the real process boundary in
 * compaction-offmain.test.ts.
 */
const SOFT = 500_000_000
const HARD = hardCapBytes(SOFT)
const budget = createStorageBudget({ maxDatabaseBytes: SOFT, version: 7 })

let dir: string
let store: DocumentMemoryStore
let usage = 0
let scheduler: MaintenanceScheduler | undefined

function inlineBackupRunner(): BackupRetentionRunner {
  return new BackupRetentionRunner({
    workerPath: 'inline-retention-worker',
    workerFactory: () => {
      const w: any = new EventEmitter()
      w.terminate = () => Promise.resolve(0)
      queueMicrotask(() => w.emit('message', { purgedCount: 0 }))
      return w
    },
  })
}

function retentionResult(req: any, over: Partial<RetentionWorkerResult> = {}): RetentionWorkerResult {
  return {
    kind: 'run-retention', runId: req.runId, epoch: req.epoch, status: 'completed', durationMs: 5, urgency: req.urgency,
    report: null, bytesBefore: usage, bytesAfter: usage, belowSoftQuota: usage < SOFT,
    release: { vectorDocuments: 0, vectorChunks: 0, skeletonDocuments: 0, skeletonEstimatedBytes: 0 },
    affectedAnnSpaces: [], annRequests: [], ...over,
  }
}

function build(handlers: { retention?: (req: any) => unknown | Promise<unknown>; free?: (req: any) => unknown | Promise<unknown>; extra?: Partial<ConstructorParameters<typeof MaintenanceScheduler>[0]> } = {}) {
  const requests: WorkerRequest[] = []
  const s = new MaintenanceScheduler({
    store,
    budget,
    storageAccountingRunner: simulatedAccountingRunner(() => usage),
    backupRetentionRunner: inlineBackupRunner(),
    askWorker: async (req): Promise<WorkerReply | null> => {
      requests.push(req)
      const id = requests.length
      if (req.type === 'run-retention') return { id, result: handlers.retention ? await handlers.retention(req) : retentionResult(req) } as WorkerReply
      if (req.type === 'free-space') return { id, result: handlers.free ? await handlers.free(req) : null } as WorkerReply
      return { id, result: null } as WorkerReply
    },
    ...handlers.extra,
  })
  scheduler = s
  return { s, requests, of: (t: string) => requests.filter((r) => r.type === t) as any[] }
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'compaction-sched-'))
  store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
  usage = 0
})
afterEach(() => {
  scheduler?.dispose()
  scheduler = undefined
  store.close()
  vi.clearAllTimers()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('compaction scheduling (WHEN)', () => {
  it('normal pressure (>= 90%) asks the worker for one run towards the 80% floor, then stays idle', async () => {
    usage = Math.round(SOFT * 0.93)
    const { s, of } = build({
      retention: (req) => {
        usage = Math.round(SOFT * 0.79) // the worker reclaimed down to the floor
        return retentionResult(req, { bytesBefore: Math.round(SOFT * 0.93), bytesAfter: usage })
      },
    })
    await s.refreshAccountingAsync()
    await settle(2_500)
    const runs = of('run-retention')
    expect(runs).toHaveLength(1)
    expect(runs[0].urgency).toBe('normal')
    expect(runs[0].configVersion).toBe(7)
    expect(runs[0].reclaimToFloorBytes).toBe(Math.ceil(SOFT * 0.93 - SOFT * 0.8))
    expect(runs[0].reclaimToSoftBytes).toBe(0)
    await settle(10 * 60_000)
    expect(of('run-retention')).toHaveLength(1) // 79%: nothing more to do
    expect(s.getLastCompactionOutcome()?.status).toBe('completed')
    expect(s.getLastCompactionOutcome()?.reclaimedBytes).toBeGreaterThan(0)
  })

  it('urgent (grace zone) runs immediately and repeats at a short interval until usage is back under the soft quota', async () => {
    usage = Math.round(SOFT * 1.06)
    const { s, of } = build({
      retention: (req) => {
        const before = usage
        usage = Math.round(usage - SOFT * 0.02) // slow progress: 2% per run
        return retentionResult(req, { bytesBefore: before, bytesAfter: usage })
      },
    })
    await s.refreshAccountingAsync()
    await settle(300) // 250 ms arm delay, no waiting for the 60 s periodic cycle
    expect(of('run-retention')).toHaveLength(1)
    expect(of('run-retention')[0].urgency).toBe('urgent')
    expect(of('run-retention')[0].reclaimToSoftBytes).toBe(Math.ceil(SOFT * 0.06))
    await settle(URGENT_REPEAT_MS + 50)
    expect(of('run-retention').length).toBeGreaterThanOrEqual(2)
    await settle(URGENT_REPEAT_MS * 3)
    // 106% -> 104 -> 102 -> 100 -> 98%: urgent runs stop once usage is under the quota
    const urgencies = of('run-retention').map((r) => r.urgency)
    expect(urgencies.slice(0, 3)).toEqual(['urgent', 'urgent', 'urgent'])
    expect(usage).toBeLessThan(SOFT)
    const runs = of('run-retention').length
    await settle(5 * 60_000)
    expect(of('run-retention').length).toBe(runs) // 98% < 100% and the worker made progress: no hot loop
  })

  it('urgent without progress backs off instead of looping (nothing evictable)', async () => {
    usage = Math.round(SOFT * 1.04)
    const { s, of } = build({ retention: (req) => retentionResult(req) }) // reclaims nothing
    await s.refreshAccountingAsync()
    await settle(300)
    expect(of('run-retention')).toHaveLength(1)
    await settle(URGENT_REPEAT_MS * 4)
    expect(of('run-retention')).toHaveLength(1) // not the short interval
    await settle(URGENT_NO_PROGRESS_BACKOFF_MS)
    expect(of('run-retention')).toHaveLength(2)
  })

  it('normal pressure with nothing left to reclaim waits the idle back-off', async () => {
    usage = Math.round(SOFT * 0.95)
    const { s, of } = build({ retention: (req) => retentionResult(req) })
    await s.refreshAccountingAsync()
    await settle(2_500)
    expect(of('run-retention')).toHaveLength(1)
    await settle(NORMAL_NO_PROGRESS_BACKOFF_MS - 5_000)
    expect(of('run-retention')).toHaveLength(1)
  })

  it('below 90% nothing is requested between periodic cycles; the periodic cycle sends a release-only run', async () => {
    usage = Math.round(SOFT * 0.5)
    const { s, of } = build()
    await s.refreshAccountingAsync()
    await settle(30_000)
    expect(of('run-retention')).toHaveLength(0)
    const outcome = await s.runCompactionCycle('manual')
    expect(outcome.urgency).toBe('none')
    expect(of('run-retention')).toHaveLength(1)
    expect(of('run-retention')[0].urgency).toBe('none')
    expect(of('run-retention')[0].usage.usedBytes).toBe(usage)
  })

  it('single flight: a second cycle skips while a run is in flight, and GC / vacuum steps never overlap it', async () => {
    usage = Math.round(SOFT * 0.95)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { s, of, requests } = build({ retention: async (req) => { await gate; return retentionResult(req) } })
    const first = s.runCompactionCycle()
    await settle(0)
    expect(s.isCompactionRunning()).toBe(true)
    const second = await s.runCompactionCycle()
    expect(second.status).toBe('skipped')
    expect(second.skippedReason).toBe('already-running')
    await s.runGcStep()
    await s.runVacuumStep()
    expect(requests.filter((r) => r.type === 'gc-step' || r.type === 'vacuum-step')).toHaveLength(0)
    release()
    await first
    expect(of('run-retention')).toHaveLength(1)
    await s.runGcStep()
    expect(requests.filter((r) => r.type === 'gc-step')).toHaveLength(1)
  })

  it('respects pause and the budget handshake gate (write-ready) before sending anything', async () => {
    usage = Math.round(SOFT * 0.95)
    let ready = false
    let paused = true
    const { s, of } = build({ extra: { isWriteReady: () => ready, isPaused: () => paused } })
    await s.refreshAccountingAsync()
    await settle(5_000)
    expect(of('run-retention')).toHaveLength(0)
    expect((await s.runCompactionCycle()).skippedReason).toBe('paused')
    paused = false
    expect((await s.runCompactionCycle()).skippedReason).toBe('write-gate-closed')
    ready = true
    expect((await s.runCompactionCycle()).status).toBe('completed')
    expect(of('run-retention')).toHaveLength(1)
  })
})

describe('compaction replies', () => {
  it('(g) a reply that arrives after dispose/close (stale epoch) or for another run is ignored', async () => {
    usage = Math.round(SOFT * 0.95)
    let resolveReply!: (v: unknown) => void
    const onAnn = vi.fn()
    const onReleased = vi.fn()
    const outcomes = vi.fn()
    const { s, of } = build({
      retention: (req) => new Promise((r) => (resolveReply = () => r(retentionResult(req, {
        annRequests: [{ spaceId: 'x', dimensions: 4, vectorCount: 10, targetGeneration: 2, estimatedBytes: 1000, clearsStaleIndex: false }],
        affectedAnnSpaces: [{ spaceId: 'x', desiredGeneration: 2 }],
        release: { vectorDocuments: 3, vectorChunks: 30, skeletonDocuments: 0, skeletonEstimatedBytes: 0 },
      })))),
      extra: { onAnnRebuildRequests: onAnn, onCompactionReleased: onReleased, onCompactionOutcome: outcomes },
    })
    const inv = vi.spyOn(store, 'invalidateAnnInMemory')
    const run = s.runCompactionCycle()
    await settle(0)
    expect(of('run-retention')).toHaveLength(1)
    s.dispose() // epoch bump + cancel
    resolveReply(undefined)
    const out = await run
    expect(out.status).toBe('skipped')
    expect(out.skippedReason).toBe('stale-reply')
    expect(onAnn).not.toHaveBeenCalled()
    expect(onReleased).not.toHaveBeenCalled()
    expect(outcomes).not.toHaveBeenCalled()
    expect(inv).not.toHaveBeenCalled()
    expect(s.getLastCompactionOutcome()).toBeNull()
  })

  it('a reply for a different runId is dropped', async () => {
    usage = Math.round(SOFT * 0.95)
    const onAnn = vi.fn()
    const { s } = build({
      retention: (req) => retentionResult({ ...req, runId: 'someone-else' }, { annRequests: [{ spaceId: 'x', dimensions: 4, vectorCount: 10, targetGeneration: 2, estimatedBytes: 1000, clearsStaleIndex: false }] }),
      extra: { onAnnRebuildRequests: onAnn },
    })
    const out = await s.runCompactionCycle()
    expect(out.skippedReason).toBe('stale-reply')
    expect(onAnn).not.toHaveBeenCalled()
  })

  it('(h) closing the scheduler cancels the in-flight worker run (out-of-band cancel-compaction with its runId)', async () => {
    usage = Math.round(SOFT * 0.95)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { s, of, requests } = build({ retention: async (req) => { await gate; return retentionResult(req) } })
    const run = s.runCompactionCycle()
    await settle(0)
    const runId = of('run-retention')[0].runId
    s.dispose()
    const cancel = requests.find((r) => r.type === 'cancel-compaction') as any
    expect(cancel?.runId).toBe(runId)
    release()
    expect((await run).status).toBe('skipped')
    // no timers are left behind that could start another run
    await settle(10 * 60_000)
    expect(of('run-retention')).toHaveLength(1)
  })

  it('consumes the report: invalidates the main ANN cache, hands ANN rebuilds / released documents to the owner, keeps redundancy + age in the outcome', async () => {
    usage = Math.round(SOFT * 0.95)
    const onAnn = vi.fn()
    const onReleased = vi.fn()
    const annReq = { spaceId: 'space-a', dimensions: 4, vectorCount: 100, targetGeneration: 3, estimatedBytes: 1000, clearsStaleIndex: false }
    const { s } = build({
      retention: (req) => {
        usage = Math.round(SOFT * 0.7)
        return retentionResult(req, {
          bytesBefore: Math.round(SOFT * 0.95), bytesAfter: usage,
          report: { triggered: true, redundancy: { ran: true } as any, age: { archiveVectorDocsPruned: 2 } as any } as any,
          affectedAnnSpaces: [{ spaceId: 'space-a', desiredGeneration: 3 }],
          annRequests: [annReq],
          release: { vectorDocuments: 2, vectorChunks: 20, skeletonDocuments: 1, skeletonEstimatedBytes: 10 },
        })
      },
      extra: { onAnnRebuildRequests: onAnn, onCompactionReleased: onReleased },
    })
    const inv = vi.spyOn(store, 'invalidateAnnInMemory')
    const out = await s.runCompactionCycle()
    expect(out.status).toBe('completed')
    expect(inv).toHaveBeenCalledWith('space-a')
    expect(onAnn).toHaveBeenCalledWith([annReq])
    expect(onReleased).toHaveBeenCalledTimes(1)
    expect(out.report?.redundancy).toEqual({ ran: true })
    expect(out.report?.age?.archiveVectorDocsPruned).toBe(2)
    expect(JSON.parse(JSON.stringify(s.getLastCompactionOutcome()))).toEqual(JSON.parse(JSON.stringify(out)))
  })

  it('an idle worker answering "not-needed" (shared helper) is accepted without follow-up work', async () => {
    usage = Math.round(SOFT * 0.96)
    const { s, of } = build({ retention: (req) => compactionNoopReply(req)!.result })
    const out = await s.runCompactionCycle()
    expect(out.status).toBe('not-needed')
    await settle(60_000)
    expect(of('run-retention')).toHaveLength(1) // no progress at 96%: idle back-off, not a loop
  })

  it('a worker that does not know the request (null / empty result) just backs off; null also sends a cancel', async () => {
    usage = Math.round(SOFT * 0.95)
    const { s, requests } = build({ retention: () => null })
    const out = await s.runCompactionCycle()
    expect(out.status).toBe('skipped')
    expect(requests.some((r) => r.type === 'cancel-compaction')).toBe(false) // a reply was received
  })
})

describe('admission by displacement (driver.makeRoom)', () => {
  const freeResult = (req: any, over: Partial<FreeSpaceWorkerResult> = {}): FreeSpaceWorkerResult => ({
    kind: 'free-space', runId: req.runId, epoch: req.epoch, status: 'completed', durationMs: 3, displacement: null, agedStage: null,
    neededBytes: req.neededBytes, freedBytes: req.neededBytes, usedBefore: usage, usedAfter: usage - req.neededBytes, fitsHardCap: true,
    affectedAnnSpaces: [], annRequests: [], ...over,
  })

  it('runs when the protected content cap is reached; frees shortfall + margin in the worker; asks the caller to retry once', async () => {
    usage = Math.round(SOFT * 0.85)
    const { s, of } = build({ free: (req) => freeResult(req) })
    await s.refreshAccountingAsync()
    expect(await s.makeRoom({ neededBytes: 1000, reason: 'content' })).toMatchObject({ attempted: false, reason: 'below-content-cap' })
    expect(of('free-space')).toHaveLength(0)

    usage = Math.round(SOFT * 1.09)
    await s.refreshAccountingAsync()
    const need = 3_000_000
    const out = await s.makeRoom({ neededBytes: need, importance: 'important', reason: 'content' })
    expect(out).toMatchObject({ attempted: true, retry: true })
    const req = of('free-space')[0]
    expect(req.incomingImportance).toBe('important')
    expect(req.configVersion).toBe(7)
    expect(req.neededBytes).toBeGreaterThan(need) // + margin
    expect(req.neededBytes).toBeLessThanOrEqual(need + 64 * 1024 * 1024)
  })

  it('concurrent refusals share one displacement; an insufficient one starts a cooldown (no thrash per file)', async () => {
    usage = Math.round(SOFT * 1.09)
    let calls = 0
    const { s, of } = build({ free: (req) => { calls++; return freeResult(req, { freedBytes: 0, fitsHardCap: false }) } })
    await s.refreshAccountingAsync()
    const [a, b, c] = await Promise.all([
      s.makeRoom({ neededBytes: 1000, reason: 'content' }),
      s.makeRoom({ neededBytes: 2000, reason: 'metadata' }),
      s.makeRoom({ neededBytes: 3000, reason: 'embedding' }),
    ])
    expect(calls).toBe(1)
    expect([a.retry, b.retry, c.retry]).toEqual([false, false, false])
    // cooldown: the next refusal does not ask the worker again
    expect(await s.makeRoom({ neededBytes: 1000, reason: 'content' })).toMatchObject({ attempted: false, reason: 'cooldown' })
    expect(of('free-space')).toHaveLength(1)
    await settle(31_000)
    await s.makeRoom({ neededBytes: 1000, reason: 'content' })
    expect(of('free-space')).toHaveLength(2)
  })

  it('does nothing at the budget gate / without a worker', async () => {
    usage = Math.round(SOFT * 1.09)
    const { s, of } = build({ extra: { isWriteReady: () => false } })
    await s.refreshAccountingAsync()
    expect(await s.makeRoom({ neededBytes: 10, reason: 'content' })).toMatchObject({ attempted: false, reason: 'write-gate-closed' })
    expect(of('free-space')).toHaveLength(0)
  })

  it('waits for an in-flight retention run instead of starting a competing one', async () => {
    usage = Math.round(SOFT * 1.09)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { s, of } = build({
      retention: async (req) => { await gate; const before = usage; usage = Math.round(SOFT * 0.9); return retentionResult(req, { bytesBefore: before, bytesAfter: usage }) },
      free: (req) => freeResult(req),
    })
    await s.refreshAccountingAsync()
    const run = s.runCompactionCycle()
    await settle(0)
    const room = s.makeRoom({ neededBytes: 5_000_000, reason: 'content' })
    await settle(0)
    expect(of('free-space')).toHaveLength(0)
    release()
    await run
    const out = await room
    expect(out.retry).toBe(true) // the run itself freed far more than needed
    expect(of('free-space')).toHaveLength(0)
  })
})

void HARD
