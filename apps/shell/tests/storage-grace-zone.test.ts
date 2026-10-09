import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_RETENTION_HIGH_WATERMARK,
  OVERSHOOT_RATIO,
  canAcceptExpensiveWork,
  calculateStorageLimitState,
  compactionTarget,
  compactionUrgency,
  createStorageBudget,
  createStorageBudgetSnapshot,
  hardCapBytes,
  isHardStop,
  isInGrace,
  normalizeOvershootRatio,
  type StorageBudgetSnapshot,
} from '../src/main/document-memory/storage-budget'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import { SyncMetadataAdmissionCoordinator } from '../src/main/document-memory/runtime/sync-metadata-admission'
import { checkAnnWriteAdmission, estimateAnnIndexBytes } from '../src/main/document-memory/runtime/ann-write-budget'
import { StorageBudgetCoordinator } from '../src/main/document-memory/runtime/storage-budget-coordinator'
import { EmbeddingCoordinator, GRACE_DEFER_RESUME_RATIO } from '../src/main/document-memory/runtime/embedding-coordinator'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { extractDocument } from '../src/main/document-memory/worker'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { MIN_STORAGE_BUDGET_BYTES, writeStorageSettings } from '../src/main/document-memory/storage/storage-settings'
import {
  StorageAccountingRunner,
  type StorageAccountingWorkerLike,
} from '../src/main/document-memory/runtime/storage-accounting-runner'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import { storageBudgetAckReply, waitForManagerWriteReady } from './helpers/storage-budget-ack'

/**
 * GRACE ZONE contract (owner requirement: "embedding must always keep working; the index may bloat at most 10% over
 * the quota, then compact back gradually"):
 *   <80% ok | 80-100% warning | 100-110% GRACE (limitState 'warning' + graceActive) | >=110% HARD STOP ('full').
 * maxDatabaseBytes is the SOFT quota; every growth admission is reserved against hardCapBytes(budget).
 */
const SOFT = MIN_STORAGE_BUDGET_BYTES // 500 MB
const HARD = hardCapBytes(SOFT)
const PROFILE = EMBEDDING_PROFILES.standard

function snap(used: number, soft = SOFT, extra: Partial<StorageBudgetSnapshot> = {}): StorageBudgetSnapshot {
  return createStorageBudgetSnapshot({
    activeDbSizeBytes: used,
    totalManagedBytes: used,
    budgetBytes: soft,
    measurementStatus: 'fresh',
    isDegraded: false,
    measuredAt: Date.now(),
    ...extra,
  })
}

describe('grace zone: pure budget math', () => {
  it('hard cap = floor(max x 1.10); overshoot is clamped to [0, 0.10] and defaults to 0.10', () => {
    expect(OVERSHOOT_RATIO).toBe(0.1)
    expect(normalizeOvershootRatio(undefined)).toBe(0.1)
    expect(normalizeOvershootRatio(Number.NaN)).toBe(0.1)
    expect(normalizeOvershootRatio('x')).toBe(0.1)
    expect(normalizeOvershootRatio(5)).toBe(0.1)
    expect(normalizeOvershootRatio(-1)).toBe(0)
    expect(normalizeOvershootRatio(0.04)).toBe(0.04)
    expect(HARD).toBe(550_000_000)
    expect(hardCapBytes({ maxDatabaseBytes: 4 * 1024 ** 3 })).toBe(Math.floor(4 * 1024 ** 3 * 1.1)) // no field = 0.10
    expect(hardCapBytes({ maxDatabaseBytes: 1_000_000_000, overshootRatio: 0 })).toBe(1_000_000_000)
    expect(hardCapBytes({ maxDatabaseBytes: 1_000_000_000, overshootRatio: 0.5 })).toBe(1_100_000_000)
    expect(createStorageBudget(SOFT).overshootRatio).toBe(0.1)
    expect(createStorageBudget({ maxDatabaseBytes: SOFT, overshootRatio: 9 }).overshootRatio).toBe(0.1)
    expect(createStorageBudget({ maxDatabaseBytes: SOFT, overshootRatio: 0 }).overshootRatio).toBe(0)
  })

  it('zones by physical bytes: ok / warning / grace / hard stop, never a new StorageLimitState member', () => {
    const at = (r: number) => snap(Math.round(SOFT * r))
    expect(at(0.79).limitState).toBe('ok')
    expect(at(0.8).limitState).toBe('warning')
    expect(at(0.99).limitState).toBe('warning')
    expect(at(0.99).graceActive).toBe(false)
    for (const r of [1.0, 1.05, 1.0999]) {
      const s = at(r)
      expect(s.limitState).toBe('warning')
      expect(s.graceActive).toBe(true)
      expect(s.overQuotaBytes).toBeGreaterThanOrEqual(0)
      expect(s.hardCapBytes).toBe(HARD)
      expect(s.softBudgetBytes).toBe(SOFT)
      expect(canAcceptExpensiveWork(s.limitState)).toBe(true)
    }
    expect(at(1.05).overQuotaBytes).toBe(Math.round(SOFT * 1.05) - SOFT)
    const full = at(1.1)
    expect(full.limitState).toBe('full')
    expect(full.graceActive).toBe(false)
    expect(canAcceptExpensiveWork(full.limitState)).toBe(false)
    expect(isInGrace(SOFT, SOFT)).toBe(true)
    expect(isInGrace(HARD - 1, SOFT)).toBe(true)
    expect(isInGrace(HARD, SOFT)).toBe(false)
    expect(isHardStop(HARD, SOFT)).toBe(true)
    expect(isHardStop(HARD - 1, SOFT)).toBe(false)
    // overshoot 0 = legacy contract (full at 100%)
    expect(calculateStorageLimitState(SOFT, SOFT, 0)).toBe('full')
    expect(snap(SOFT, SOFT, { overshootRatio: 0 }).limitState).toBe('full')
  })

  it('compactionUrgency: none < 90% <= normal < 100% <= urgent, with bytes to reclaim to the 80% floor / the soft quota', () => {
    const t = (r: number) => compactionTarget(snap(Math.round(SOFT * r)))
    expect(compactionUrgency(snap(Math.round(SOFT * 0.85)))).toBe('none')
    expect(t(0.85).reclaimToFloorBytes).toBe(0)
    expect(compactionUrgency(snap(Math.round(SOFT * CACHE_RETENTION_HIGH_WATERMARK)))).toBe('normal')
    expect(t(0.95)).toEqual({
      urgency: 'normal',
      reclaimToFloorBytes: Math.ceil(SOFT * 0.95 - SOFT * 0.8),
      reclaimToSoftBytes: 0,
    })
    const urgent = t(1.05)
    expect(urgent.urgency).toBe('urgent')
    expect(urgent.reclaimToSoftBytes).toBe(Math.ceil(SOFT * 1.05 - SOFT))
    expect(urgent.reclaimToFloorBytes).toBe(Math.ceil(SOFT * 1.05 - SOFT * 0.8))
    expect(compactionUrgency(snap(Math.round(SOFT * 1.2)))).toBe('urgent') // hard stop is urgent too
    // unknown/degraded accounting: nothing trustworthy to act on
    expect(compactionUrgency(snap(Math.round(SOFT * 1.05), SOFT, { isDegraded: true }))).toBe('none')
  })
})

describe('grace zone: admission controller and metadata guard (real controller, no mocked decisions)', () => {
  it('(3) the hard cap is never exceeded by concurrent reservations: two that fit alone, only one fits together', () => {
    const admission = new StorageAdmissionController()
    const used = HARD - 30_000_000 // 30 MB below the hard cap, 20 MB above the soft quota
    const want = 15_000_000
    const a = admission.reserve('r-a', 'extract', want, used, HARD, 60_000, { headroomBytes: 5_000_000 })
    const b = admission.reserve('r-b', 'extract', want, used, HARD, 60_000, { headroomBytes: 5_000_000 })
    expect(a.admitted).toBe(true)
    expect(b.admitted).toBe(false)
    expect(b.reason).toBe('quota-exhausted')
    expect(admission.getReservedBytes()).toBe(want)
    expect(used + admission.getReservedBytes()).toBeLessThanOrEqual(HARD)
    // embeddings keep the same reason code as before
    const e = admission.reserve('r-e', 'passage-embed', 20_000_000, used, HARD, 60_000, { headroomBytes: 5_000_000 })
    expect(e.admitted).toBe(false)
    expect(e.reason).toBe('hard-limit-exceeded')
  })

  function coordinatorAt(used: number, overrides: Partial<StorageBudgetSnapshot> = {}) {
    const admission = new StorageAdmissionController()
    const budget = createStorageBudget(SOFT)
    const current = snap(used, SOFT, overrides)
    const guard = new SyncMetadataAdmissionCoordinator({
      admission,
      getStorageBudget: () => budget,
      isWriteReady: () => true,
      refreshAccountingAsync: async () => current,
      getStorageBudgetSnapshot: () => current,
      getFreeDiskBytes: async () => 50_000_000_000,
      freeDiskHeadroomBytes: 0,
    })
    return { admission, guard, current }
  }

  it('(1)(2) the name/identity row is admitted in the grace zone and refused at the hard stop with the old reason', async () => {
    const grace = coordinatorAt(Math.round(SOFT * 1.05))
    await Promise.resolve()
    await Promise.resolve()
    const ok = grace.guard.canAdmitNewDocument({ name: 'new.docx', path: '/d/new.docx' }, 4096)
    expect(ok.admitted, ok.error).toBe(true)
    // the reservation is charged against the hard cap, not the soft quota
    expect(grace.admission.listReservations()).toHaveLength(1)
    expect(
      grace.guard.canWriteProjection({ id: 1, name: 'x.docx', path: '/d/x.docx' }, 2048),
    ).toBe(true)
    grace.guard.close()

    const stop = coordinatorAt(HARD)
    await Promise.resolve()
    await Promise.resolve()
    const refused = stop.guard.canAdmitNewDocument({ name: 'new.docx', path: '/d/new.docx' }, 4096)
    expect(refused.admitted).toBe(false)
    expect(refused.reason).toBe('budget-full')
    expect(stop.guard.getLastRejectionReason()).toBe('Storage limit state is full')
    expect(stop.guard.canWriteProjection({ id: 1, name: 'x.docx', path: '/d/x.docx' }, 2048)).toBe(false)
    stop.guard.close()
  })

  it('(3) two simultaneous new-document admissions that fit alone but not together: exactly one is admitted', async () => {
    const used = HARD - 16 * 1024 // room for one 10 KB row (+ minimum metadata), not two
    const { admission, guard } = coordinatorAt(used)
    await Promise.resolve()
    await Promise.resolve()
    const d1 = guard.canAdmitNewDocument({ name: 'a.docx', path: '/d/a.docx' }, 10 * 1024)
    const d2 = guard.canAdmitNewDocument({ name: 'b.docx', path: '/d/b.docx' }, 10 * 1024)
    expect([d1.admitted, d2.admitted].filter(Boolean)).toHaveLength(1)
    expect(used + admission.getReservedBytes()).toBeLessThanOrEqual(HARD)
    const loser = d1.admitted ? d2 : d1
    expect(['budget-full', 'min-metadata-unfit']).toContain(loser.reason)
    guard.close()
  })

  it('(5) unknown or degraded accounting still blocks inside the grace zone', async () => {
    for (const overrides of [
      { isDegraded: true },
      { measurementStatus: 'unknown' as const },
      { measurementStatus: 'stale' as const },
    ]) {
      const { guard, admission } = coordinatorAt(Math.round(SOFT * 1.05), overrides)
      await Promise.resolve()
      await Promise.resolve()
      const d = guard.canAdmitNewDocument({ name: 'a.docx', path: '/d/a.docx' }, 4096)
      expect(d.admitted).toBe(false)
      expect(d.reason).toBe('accounting-unknown')
      expect(admission.listReservations()).toHaveLength(0)
      guard.close()
    }
  })

  it('free disk stays strict in the grace zone', async () => {
    const admission = new StorageAdmissionController()
    const budget = createStorageBudget(SOFT)
    const current = snap(Math.round(SOFT * 1.05))
    const guard = new SyncMetadataAdmissionCoordinator({
      admission,
      getStorageBudget: () => budget,
      isWriteReady: () => true,
      refreshAccountingAsync: async () => current,
      getStorageBudgetSnapshot: () => current,
      getFreeDiskBytes: async () => 1024, // the disk cannot hold the growth
      freeDiskHeadroomBytes: 0,
    })
    await Promise.resolve()
    await Promise.resolve()
    const d = guard.canAdmitNewDocument({ name: 'a.docx', path: '/d/a.docx' }, 4096)
    expect(d.admitted).toBe(false)
    expect(d.reason).toBe('disk-space-insufficient')
    guard.close()
  })

  it('ANN rebuild may use the overshoot room but is refused beyond the hard cap', () => {
    const vectors = 2_000
    const dims = 320
    const est = estimateAnnIndexBytes(vectors, dims)
    const base = { spaceId: 's', vectorCount: vectors, dimensions: dims, freeDiskBytes: 50_000_000_000 }
    const inGrace = checkAnnWriteAdmission({ ...base, currentUsageBytes: SOFT + 1_000_000, budgetBytes: HARD })
    expect(inGrace.admitted, inGrace.error).toBe(true)
    const beyond = checkAnnWriteAdmission({ ...base, currentUsageBytes: HARD - est / 2, budgetBytes: HARD })
    expect(beyond.admitted).toBe(false)
    expect(beyond.reason).toBe('quota-exhausted')
  })
})

describe('grace zone: worker <-> main budget handshake carries overshootRatio', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grace-handshake-'))
    writeStorageSettings(dir, { maxDatabaseBytes: SOFT, preset: 'custom', version: 3 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function make(reply: (req: any) => any) {
    const sent: any[] = []
    let budget = createStorageBudget(SOFT)
    const coord = new StorageBudgetCoordinator({
      settingsDir: dir,
      getMaintBudget: () => budget,
      setMaintBudget: (b) => {
        budget = b
      },
      askWorker: async (req) => {
        sent.push(req)
        return reply(req)
      },
      isStopped: () => false,
    })
    return { coord, sent, getBudget: () => budget }
  }

  it('sends the normalized overshootRatio and accepts the exact ack (version + overshoot)', async () => {
    const { coord, sent, getBudget } = make((req) => ({
      id: 1,
      result: { ...storageBudgetAckReply(req)!.result, appliedOvershootRatio: req.budget.overshootRatio },
    }))
    expect(await coord.onWorkerSpawned()).toBe(true)
    expect(sent[0].type).toBe('set-storage-budget')
    expect(sent[0].budget.overshootRatio).toBe(0.1)
    expect(coord.isWriteReady()).toBe(true)
    expect(hardCapBytes(getBudget())).toBe(HARD)
    coord.close()
  })

  it('an ack without the field means the default 0.10 (older worker) and is accepted', async () => {
    const { coord } = make((req) => storageBudgetAckReply(req))
    expect(await coord.onWorkerSpawned()).toBe(true)
    coord.close()
  })

  it('a worker that applied a different overshoot is NOT write-ready (main and worker must agree)', async () => {
    const { coord } = make((req) => ({
      id: 1,
      result: { ...storageBudgetAckReply(req)!.result, appliedOvershootRatio: 0 },
    }))
    expect(await coord.onWorkerSpawned()).toBe(false)
    expect(coord.isWriteReady()).toBe(false)
    coord.close()
  })

  it('a stale version ack is still rejected', async () => {
    const { coord } = make((req) => ({
      id: 1,
      result: { ...storageBudgetAckReply(req)!.result, appliedVersion: req.configVersion - 1 },
    }))
    expect(await coord.onWorkerSpawned()).toBe(false)
    expect(coord.isWriteReady()).toBe(false)
    coord.close()
  })
})

describe('grace zone: embeddings keep running, value rule parks low-value docs, hysteresis resumes them', () => {
  let dir: string
  let store: DocumentMemoryStore
  let usage = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grace-embed-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
    usage = 0
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeDoc(name: string, importance: 'low' | 'normal' | 'important') {
    const path = join(dir, name)
    writeFileSync(path, `content of ${name}`)
    const st = statSync(path)
    const chunks = [0, 1].map((i) => ({ text: `${name} body paragraph ${i} lorem ipsum`, location: `Chunk ${i + 1}` }))
    store.replaceDocument(path, {
      hash: `h-${name}`,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      chunks,
      embeddingModel: null,
      status: 'text-only',
    })
    if (importance !== 'normal') store.setImportanceOverride(path, importance)
    return {
      path,
      job: { path, generation: 1, epoch: 1, hash: `h-${name}`, mtimeMs: st.mtimeMs, sizeBytes: st.size, chunks, startOffset: 0 },
    }
  }

  function vectorCount(path: string): number {
    return (
      store.rawDb
        .prepare(
          'SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE d.path = ?',
        )
        .get(path) as { c: number }
    ).c
  }

  function build() {
    const admission = new StorageAdmissionController()
    const budget = createStorageBudget(SOFT)
    const errors: string[] = []
    const reserveSpy = vi.spyOn(admission, 'reserve')
    const current = () => snap(usage)
    const coord = new EmbeddingCoordinator({
      store,
      initialProfileId: 'standard',
      admission,
      getStorageBudget: () => budget,
      getCurrentUsage: () => usage,
      refreshUsage: async () => current(),
      canAcceptExpensiveWork: () => canAcceptExpensiveWork(current().limitState),
      isWriteReady: () => true,
      getFreeDiskBytes: async () => 50_000_000_000,
      headroomBytes: 1_000_000,
      onError: (e) => errors.push(e),
    })
    const ask = async (req: { texts: string[] }) => ({
      result: req.texts.map((_, i) => Array.from({ length: PROFILE.dimensions }, (_v, d) => ((d + i) % 7) / 7 + 0.01)),
    })
    return { coord, ask, errors, reserveSpy, admission }
  }

  it('(1) in the grace zone a normal document is fully embedded and its reservation is checked against the HARD cap', async () => {
    usage = Math.round(SOFT * 1.05)
    const { coord, ask, errors, reserveSpy } = build()
    const doc = makeDoc('normal-doc.txt', 'normal')
    coord.enqueueEmbed(doc.job)
    await coord.drainEmbeddings(ask as any)
    expect(errors).toEqual([])
    expect(vectorCount(doc.path)).toBe(2)
    const embedReserve = reserveSpy.mock.calls.find((c) => c[1] === 'passage-embed')!
    expect(embedReserve[4]).toBe(HARD) // budgetBytes handed to the controller = hard cap, never the soft quota
    expect(embedReserve[4]).not.toBe(SOFT)
  })

  it('(2) at the hard stop nothing is embedded', async () => {
    usage = HARD + 1_000_000
    const { coord, ask } = build()
    const doc = makeDoc('blocked-doc.txt', 'normal')
    coord.enqueueEmbed(doc.job)
    await coord.drainEmbeddings(ask as any)
    expect(vectorCount(doc.path)).toBe(0)
    expect(coord.getQueueLength()).toBe(1) // kept queued, resumes when compaction frees room
  })

  it('(3) an embedding that would cross the hard cap is refused with the same hard-limit reason', async () => {
    usage = HARD - 500_000 // below the cap, but the 1 MB headroom would cross it
    const { coord, ask, errors } = build()
    const doc = makeDoc('cap-doc.txt', 'normal')
    coord.enqueueEmbed(doc.job)
    await coord.drainEmbeddings(ask as any)
    expect(vectorCount(doc.path)).toBe(0)
    expect(errors.some((e) => e.includes('hard-limit-exceeded'))).toBe(true)
  })

  it('(4) low-value docs are parked in grace (name + text stay), normal/important embed; parked docs resume below 90%', async () => {
    usage = Math.round(SOFT * 1.05)
    const { coord, ask, errors } = build()
    const low = makeDoc('low-doc.txt', 'low')
    const normal = makeDoc('normal-doc.txt', 'normal')
    const important = makeDoc('important-doc.txt', 'important')
    coord.enqueueEmbed(low.job)
    coord.enqueueEmbed(normal.job)
    coord.enqueueEmbed(important.job)
    await coord.drainEmbeddings(ask as any)
    expect(errors).toEqual([])
    expect(vectorCount(normal.path)).toBe(2)
    expect(vectorCount(important.path)).toBe(2)
    expect(vectorCount(low.path)).toBe(0)
    expect(coord.getGraceDeferredCount()).toBe(1)
    // the parked doc still counts as pending work, so poll() will not re-extract it
    expect(coord.embedsQueue.some((j) => j.path === low.path)).toBe(true)
    expect(coord.getQueueLength()).toBe(0) // and it does not block extraction of newcomers
    // name row + lexical text remain
    expect(store.searchLexical('low-doc.txt body paragraph').length).toBeGreaterThan(0)

    // compaction brings the index back under the soft quota but not under 90%: still parked (no oscillation)
    usage = Math.round(SOFT * 0.96)
    expect(snap(usage).limitState).toBe('warning')
    expect(snap(usage).graceActive).toBe(false)
    expect(coord.releaseGraceDeferred()).toBe(0)
    expect(coord.getGraceDeferredCount()).toBe(1)

    // below the 90% retention high watermark: released and embedded
    usage = Math.round(SOFT * (GRACE_DEFER_RESUME_RATIO - 0.05))
    expect(coord.releaseGraceDeferred()).toBe(1)
    expect(coord.getGraceDeferredCount()).toBe(0)
    await coord.drainEmbeddings(ask as any)
    expect(vectorCount(low.path)).toBe(2)
  })

  it('(4) below the soft quota a low-value doc is embedded normally (the rule only applies in grace)', async () => {
    usage = Math.round(SOFT * 0.7)
    const { coord, ask } = build()
    const low = makeDoc('low-doc.txt', 'low')
    coord.enqueueEmbed(low.job)
    await coord.drainEmbeddings(ask as any)
    expect(vectorCount(low.path)).toBe(2)
    expect(coord.getGraceDeferredCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// End to end with the real manager, real SQLite and the real indexing pipeline. Only the accounting measurement is
// overridden (as in document-search-v3-budget-runtime): the managed total is a test-controlled number.
// ---------------------------------------------------------------------------------------------------------------
class GraceWorker extends EventEmitter {
  embedCalls = 0
  constructor(private readonly dbPath: string) {
    super()
  }
  postMessage(message: { id: number; type: string; path?: string; texts?: string[]; maxPdfPages?: number }): void {
    setTimeout(async () => {
      try {
        const ack = storageBudgetAckReply(message)
        if (ack) return void this.emit('message', ack)
        if (message.type === 'extract' && message.path) {
          const s = new DocumentMemoryStore(this.dbPath)
          try {
            const result = await extractDocument(message.path, (p, h) => s.ocr.pages(p, h), message.maxPdfPages)
            this.emit('message', { id: message.id, result })
          } finally {
            s.close()
          }
        } else if (message.type === 'embed') {
          this.embedCalls++
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: message.id,
            result: (message.texts ?? []).map(() => new Array(PROFILE.dimensions).fill(0.01)),
          })
        } else {
          this.emit('message', { id: message.id, result: [] })
        }
      } catch (err) {
        this.emit('message', { id: message.id, error: err instanceof Error ? err.message : String(err) })
      }
    }, 0)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('grace zone: real manager end to end', () => {
  let tempDir: string
  let managers: DocumentMemoryManager[]
  let simulatedUsage = 0

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grace-e2e-'))
    mkdirSync(join(tempDir, 'files'))
    managers = []
    writeStorageSettings(tempDir, { maxDatabaseBytes: SOFT, preset: 'custom', version: 1 })
  })
  afterEach(() => {
    for (const m of managers) {
      try {
        m.close()
      } catch {}
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function runner(): StorageAccountingRunner {
    return new StorageAccountingRunner({
      workerPath: 'inline-accounting-worker',
      workerFactory: (_p, data) => {
        const worker = new EventEmitter() as EventEmitter & StorageAccountingWorkerLike
        worker.terminate = () => Promise.resolve(0)
        queueMicrotask(() => {
          try {
            const report = collectStorageAccounting(data)
            report.totalManagedBytes = simulatedUsage
            report.totalTrackedBytes = simulatedUsage
            worker.emit('message', { ok: true, report })
          } catch (err) {
            worker.emit('message', { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })
        return worker
      },
    })
  }

  async function start(usage: number) {
    simulatedUsage = usage
    const worker = new GraceWorker(join(tempDir, 'document-memory.db'))
    const manager = new DocumentMemoryManager(tempDir, { workerFactory: () => worker as any, pollIntervalMs: 60_000 })
    managers.push(manager)
    ;(manager as any).maintScheduler.storageAccountingRunner = runner()
    await waitForManagerWriteReady(manager)
    await (manager as any).maintScheduler.refreshAccountingAsync()
    return { manager, worker }
  }

  async function waitFor(cond: () => boolean, ms = 6000): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (cond()) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return cond()
  }

  it('(1) at 105% a NEW file is admitted, chunked, embedded and found by name and by content', async () => {
    const { manager, worker } = await start(Math.round(SOFT * 1.05))
    const s = manager.getStorageBudgetSnapshot()
    expect(s.limitState).toBe('warning')
    expect(s.graceActive).toBe(true)

    const file = join(tempDir, 'files', 'gracenewcomer-ledger.txt')
    writeFileSync(file, 'Quarterly xylophonic zeppelin reconciliation notes for the harbour project.', 'utf8')
    manager.remember(file)

    expect(await waitFor(() => manager.store.documentByPath(file)?.status === 'ready')).toBe(true)
    const progress = manager.store.chunkProgress(file)
    expect(progress.totalChunks).toBeGreaterThan(0)
    expect(progress.completedChunks).toBe(progress.totalChunks)
    expect(worker.embedCalls).toBeGreaterThan(0)

    const byContent = await manager.search('xylophonic zeppelin reconciliation')
    expect(byContent.hits[0]?.path).toBe(resolve(file))
    const byName = await manager.search('gracenewcomer ledger')
    expect(byName.hits.map((h) => h.path)).toContain(resolve(file))
    // usage stays inside the grace zone: nothing here pushed the state to 'full'
    expect(manager.getStorageBudgetSnapshot().limitState).toBe('warning')
  })

  it('(2) at >=110% a new file is refused (no row, no embedding), exactly as the old full state', async () => {
    const { manager, worker } = await start(Math.round(SOFT * 1.12))
    expect(manager.getStorageBudgetSnapshot().limitState).toBe('full')
    expect(manager.getStorageBudgetSnapshot().graceActive).toBe(false)

    const file = join(tempDir, 'files', 'hardstop-file.txt')
    writeFileSync(file, 'Content that must not be indexed at the hard stop.', 'utf8')
    manager.remember(file)
    await new Promise((r) => setTimeout(r, 500))
    expect(manager.store.documentByPath(file)).toBeFalsy()
    expect(worker.embedCalls).toBe(0)
  })

  it('(4) after compaction the file indexed in grace is still searchable and the state returns to warning/ok', async () => {
    const { manager } = await start(Math.round(SOFT * 1.05))
    const file = join(tempDir, 'files', 'compacted-note.txt')
    writeFileSync(file, 'Hysteresis kumquat sentinel record.', 'utf8')
    manager.remember(file)
    expect(await waitFor(() => manager.store.documentByPath(file)?.status === 'ready')).toBe(true)

    simulatedUsage = Math.round(SOFT * 0.97) // compaction reclaimed ~8%
    await (manager as any).maintScheduler.refreshAccountingAsync()
    let s = manager.getStorageBudgetSnapshot()
    expect(s.limitState).toBe('warning')
    expect(s.graceActive).toBe(false)
    simulatedUsage = Math.round(SOFT * 0.7)
    await (manager as any).maintScheduler.refreshAccountingAsync()
    s = manager.getStorageBudgetSnapshot()
    expect(s.limitState).toBe('ok')
    const found = await manager.search('hysteresis kumquat sentinel')
    expect(found.hits[0]?.path).toBe(resolve(file))
  })
})
