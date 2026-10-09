import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import {
  StorageAccountingRunner,
  type StorageAccountingWorkerLike,
} from '../src/main/document-memory/runtime/storage-accounting-runner'
import { BackupRetentionRunner } from '../src/main/document-memory/runtime/backup-retention-runner'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { createStorageBudget } from '../src/main/document-memory/storage-budget'
import type { WorkerReply, WorkerRequest } from '../src/main/document-memory/worker-types'
import { compactionNoopReply } from './helpers/storage-budget-ack'

/**
 * Eviction must follow the INDEX, not unrelated files. Field incident: a 4 GB quota, a 221 MB live index and a 5.2 GB
 * V2 rollback backup next to it; the backup was charged to the index, usage read ~127%, the hard cap was exceeded for
 * good and compaction kept evicting the live index every few seconds (urgent mode never reaches "under the quota").
 * Here the REAL accounting measures a real folder through the real scheduler; only the indexing worker is scripted.
 */
const SOFT = 500_000_000
const budget = createStorageBudget({ maxDatabaseBytes: SOFT, version: 3 })
const BACKUP = 'document-memory.db.v2.1791535907060.e37993d1.backup.db'

let dir: string
let store: DocumentMemoryStore
let scheduler: MaintenanceScheduler | undefined

/** Production measures in a worker thread (real I/O that fake timers cannot advance): same protocol, in-process. */
function realInlineAccountingRunner(): StorageAccountingRunner {
  return new StorageAccountingRunner({
    workerPath: 'inline-accounting-worker',
    workerFactory: (_p, data) => {
      const worker = new EventEmitter() as EventEmitter & StorageAccountingWorkerLike
      worker.terminate = () => Promise.resolve(0)
      queueMicrotask(() =>
        worker.emit('message', { ok: true, report: collectStorageAccounting(data) }),
      )
      return worker
    },
  })
}

function idleRetentionRunner(): BackupRetentionRunner {
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

function build() {
  const requests: WorkerRequest[] = []
  const s = new MaintenanceScheduler({
    store,
    budget,
    storageAccountingRunner: realInlineAccountingRunner(),
    backupRetentionRunner: idleRetentionRunner(),
    askWorker: async (req): Promise<WorkerReply | null> => {
      requests.push(req)
      return compactionNoopReply(req as any) as WorkerReply | null
    },
  })
  scheduler = s
  return { s, retentionRuns: () => requests.filter((r) => r.type === 'run-retention'), requests }
}

function sparse(name: string, size: number): void {
  const path = join(dir, name)
  writeFileSync(path, '')
  truncateSync(path, size)
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'backup-no-thrash-'))
  store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
})
afterEach(() => {
  scheduler?.dispose()
  scheduler = undefined
  store.close()
  vi.clearAllTimers()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('a large migration backup next to a small index', () => {
  it('leaves the index in the ok state and never asks the worker to evict anything (no thrash)', async () => {
    sparse(BACKUP, 5_461_098_496) // 10.9x the 500 MB quota, the field ratio was 1.27x of the hard cap
    const { s, retentionRuns } = build()

    const accounting = await s.refreshAccountingAsync()
    expect(accounting.limitState).toBe('ok')
    expect(accounting.overQuotaBytes).toBe(0)
    expect(accounting.graceActive).toBe(false)
    expect(accounting.totalManagedBytes).toBeLessThan(SOFT / 10)
    expect(accounting.backupBytes).toBe(5_461_098_496)

    expect(s.canAcceptExpensiveWork()).toBe(true) // embeddings / OCR / ANN builds are admitted
    await vi.advanceTimersByTimeAsync(4 * 60_000) // four minutes of urgent-mode repeat windows
    expect(retentionRuns()).toHaveLength(0)
    expect(s.checkStorageBudget().limitState).toBe('ok')
  })

  it('periodic maintenance keeps measuring the same way: still no eviction request while the backup exists', async () => {
    sparse(BACKUP, 5_461_098_496)
    sparse(`${BACKUP}-wal`, 400_000_000)
    const { s, retentionRuns } = build()
    await s.refreshAccountingAsync()
    await s.runPeriodicMaintenance()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(s.checkStorageBudget().limitState).toBe('ok')
    // a release-only periodic run (urgency none) is allowed; an eviction run is not
    expect(retentionRuns().filter((r: any) => r.urgency !== 'none')).toHaveLength(0)
  })

  it('still evicts when the INDEX itself is over its quota (the fix removed the false alarm, not the safeguard)', async () => {
    sparse(BACKUP, 5_461_098_496)
    sparse('ann-standard.usearch', Math.round(SOFT * 1.06)) // an index file the live index really owns
    const { s, retentionRuns } = build()

    const snapshot = await s.refreshAccountingAsync()
    expect(snapshot.overQuotaBytes).toBeGreaterThan(0)
    expect(snapshot.overQuotaBytes).toBeLessThan(SOFT * 0.1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(retentionRuns().some((r: any) => r.urgency === 'urgent')).toBe(true)
  })

  it('deleting the backup changes nothing for the quota: usage is identical before and after', async () => {
    sparse(BACKUP, 1_000_000_000)
    const before = collectStorageAccounting({ dbPath: join(dir, 'document-memory.db') })
    rmSync(join(dir, BACKUP))
    const after = collectStorageAccounting({ dbPath: join(dir, 'document-memory.db') })
    expect(before.totalManagedBytes).toBe(after.totalManagedBytes)
    expect(before.backupSizeBytes).toBe(1_000_000_000)
    expect(after.backupSizeBytes).toBe(0)
  })
})
