import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import {
  MaintenanceScheduler,
  INITIAL_MAINTENANCE_DELAY_MS,
  PERIODIC_MAINTENANCE_INTERVAL_MS,
} from '../src/main/document-memory/runtime/maintenance-scheduler'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  StorageAccountingRunner,
  type StorageAccountingWorkerLike,
} from '../src/main/document-memory/runtime/storage-accounting-runner'
import { BackupRetentionRunner } from '../src/main/document-memory/runtime/backup-retention-runner'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import type { WorkerRequest } from '../src/main/document-memory/worker-types'
import { storageBudgetAckReply } from './helpers/storage-budget-ack'

class MockMaintenanceWorker extends EventEmitter {
  public receivedRequests: WorkerRequest[] = []

  constructor() {
    super()
  }

  postMessage(message: { id: number; type: string }): void {
    this.receivedRequests.push(message as WorkerRequest)
    queueMicrotask(() => {
      const ack = storageBudgetAckReply(message)
      if (ack) {
        this.emit('message', ack)
        return
      }
      if (message.type === 'fts-maintenance-step') {
        this.emit('message', { id: message.id, result: { more: false, durationMs: 10 } })
      } else if (message.type === 'gc-step') {
        this.emit('message', { id: message.id, result: { cleaned: 0 } })
      } else if (message.type === 'vacuum-step') {
        this.emit('message', { id: message.id, result: { pages: 0 } })
      } else {
        this.emit('message', { id: message.id, result: null })
      }
    })
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

/**
 * Production measures storage accounting in a real worker thread, whose completion is real I/O that
 * fake timers cannot advance. This runner keeps the production StorageAccountingRunner (spawn,
 * message protocol, settle) but hosts the real `collectStorageAccounting` measurement in an in-process
 * worker stand-in that replies on a microtask, so periodic maintenance stays deterministic under
 * fake timers.
 */
function createInlineAccountingRunner(): StorageAccountingRunner {
  return new StorageAccountingRunner({
    workerPath: 'inline-accounting-worker',
    workerFactory: (_path, data) => {
      const worker = new EventEmitter() as EventEmitter & StorageAccountingWorkerLike
      worker.terminate = () => Promise.resolve(0)
      queueMicrotask(() => {
        try {
          worker.emit('message', { ok: true, report: collectStorageAccounting(data) })
        } catch (err) {
          worker.emit('message', {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
      return worker
    },
  })
}

/** Same idea for backup retention: production runner and protocol, in-process worker stand-in. */
function createInlineBackupRetentionRunner(): BackupRetentionRunner {
  return new BackupRetentionRunner({
    workerPath: 'inline-retention-worker',
    workerFactory: () => {
      const worker = new EventEmitter() as EventEmitter & {
        terminate: () => Promise<number>
      }
      worker.terminate = () => Promise.resolve(0)
      queueMicrotask(() => worker.emit('message', { purgedCount: 0 }))
      return worker as any
    },
  })
}

/**
 * A periodic run re-arms its timer only when it finishes. The tail of a run (name-projection backfill
 * free-disk probe) performs real filesystem I/O that fake timers cannot advance, so wait for the run
 * to actually finish before asserting the re-arm.
 */
async function waitForPeriodicRunToFinishAndRearm(scheduler: MaintenanceScheduler): Promise<void> {
  await vi.waitFor(() => {
    expect(scheduler.isPeriodicMaintenanceRunning()).toBe(false)
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(true)
  })
}

describe('Document Search V3 - Periodic Maintenance Lifecycle Suite (PAIR 18)', () => {
  let tempDir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    vi.useFakeTimers()
    tempDir = mkdtempSync(join(tmpdir(), 'doc-search-v3-maint-lifecycle-'))
    managers = []
  })

  afterEach(async () => {
    for (const manager of managers) {
      try {
        await manager.closeAsync()
      } catch {}
    }
    vi.clearAllTimers()
    vi.useRealTimers()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function createTestManager() {
    const worker = new MockMaintenanceWorker()
    const manager = new DocumentMemoryManager(tempDir, {
      workerFactory: () => worker as any,
      pollIntervalMs: 600_000, // prevent interference
      backupRetentionRunner: createInlineBackupRetentionRunner(),
    } as any)
    managers.push(manager)
    ;(manager as any).maintScheduler.storageAccountingRunner = createInlineAccountingRunner()
    return { manager, worker }
  }

  // =========================================================================
  // MAINT-01: Startup arms timer
  // =========================================================================
  it('MAINT-01: manager startup arms periodic maintenance timer', () => {
    const { manager } = createTestManager()
    const scheduler: MaintenanceScheduler = (manager as any).maintScheduler
    expect(scheduler).toBeDefined()
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(true)
  })

  // =========================================================================
  // MAINT-02: One interval triggers worker maintenance
  // =========================================================================
  it('MAINT-02: initial maintenance interval triggers worker maintenance steps', async () => {
    const { manager, worker } = createTestManager()
    const scheduler: MaintenanceScheduler = (manager as any).maintScheduler
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(true)

    // Advance to initial delay (5,000ms)
    await vi.advanceTimersByTimeAsync(INITIAL_MAINTENANCE_DELAY_MS)

    const reqTypes = worker.receivedRequests.map((r) => r.type)
    expect(reqTypes).toContain('fts-maintenance-step')
    expect(reqTypes).toContain('gc-step')
    expect(reqTypes).toContain('vacuum-step')
  })

  // =========================================================================
  // MAINT-03: Second interval triggers maintenance again (proving recurring re-arm)
  // =========================================================================
  it('MAINT-03: maintenance self-re-arms and triggers recurring interval', async () => {
    const { manager, worker } = createTestManager()
    const scheduler: MaintenanceScheduler = (manager as any).maintScheduler

    // Run first maintenance
    await vi.advanceTimersByTimeAsync(INITIAL_MAINTENANCE_DELAY_MS)
    // The startup `set-storage-budget` handshake is not maintenance work; count maintenance steps only.
    const maintenanceCount = () =>
      worker.receivedRequests.filter((r) => r.type !== 'set-storage-budget').length
    const countAfterFirst = maintenanceCount()
    expect(countAfterFirst).toBeGreaterThanOrEqual(3)

    // Verify timer is re-armed for next period
    await waitForPeriodicRunToFinishAndRearm(scheduler)
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(true)

    // Advance full periodic interval (60,000ms)
    await vi.advanceTimersByTimeAsync(PERIODIC_MAINTENANCE_INTERVAL_MS)
    const countAfterSecond = maintenanceCount()
    expect(countAfterSecond).toBeGreaterThan(countAfterFirst)

    // And re-armed yet again
    await waitForPeriodicRunToFinishAndRearm(scheduler)
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(true)
  })

  // =========================================================================
  // MAINT-04: Pause blocks GC and Vacuum
  // =========================================================================
  it('MAINT-04: paused state blocks execution of heavy maintenance steps', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath)
    const paused = true
    const requests: WorkerRequest[] = []

    const scheduler = new MaintenanceScheduler({
      store,
      isPaused: () => paused,
      storageAccountingRunner: createInlineAccountingRunner(),
      backupRetentionRunner: createInlineBackupRetentionRunner(),
      askWorker: async (req) => {
        requests.push(req)
        return null
      },
    })

    scheduler.schedulePeriodicMaintenance(100)
    await vi.advanceTimersByTimeAsync(100)

    // Paused state should not execute GC or Vacuum steps
    expect(requests.length).toBe(0)

    store.close()
    scheduler.dispose()
  })

  // =========================================================================
  // MAINT-05: Resume causes future maintenance to proceed
  // =========================================================================
  it('MAINT-05: pause does not kill future maintenance scheduling upon resume', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath)
    let paused = true
    const requests: WorkerRequest[] = []

    const scheduler = new MaintenanceScheduler({
      store,
      isPaused: () => paused,
      storageAccountingRunner: createInlineAccountingRunner(),
      backupRetentionRunner: createInlineBackupRetentionRunner(),
      askWorker: async (req) => {
        requests.push(req)
        return null
      },
    })

    // Trigger while paused
    scheduler.schedulePeriodicMaintenance(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(requests.length).toBe(0)
    // Scheduler must have re-armed even while paused!
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(true)

    // Now resume
    paused = false
    await vi.advanceTimersByTimeAsync(PERIODIC_MAINTENANCE_INTERVAL_MS)

    // Now maintenance must execute!
    expect(requests.length).toBeGreaterThan(0)

    store.close()
    scheduler.dispose()
  })

  // =========================================================================
  // MAINT-06: Manager close clears timers and rejects future scheduling
  // =========================================================================
  it('MAINT-06: manager close cleans up timers and rejects further scheduling', async () => {
    const { manager, worker } = createTestManager()
    const scheduler: MaintenanceScheduler = (manager as any).maintScheduler
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(true)

    manager.close()

    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(false)
    const countBefore = worker.receivedRequests.length

    // Advancing timers should never trigger any worker requests
    await vi.advanceTimersByTimeAsync(120_000)
    expect(worker.receivedRequests.length).toBe(countBefore)

    // Trying to manually schedule on disposed scheduler must be a no-op
    scheduler.schedulePeriodicMaintenance(10)
    expect(scheduler.isPeriodicMaintenanceArmed()).toBe(false)
  })

  // =========================================================================
  // MAINT-07: Repeated schedule calls do not create duplicate timers
  // =========================================================================
  it('MAINT-07: multiple schedulePeriodicMaintenance calls do not create duplicate timers', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath)
    let runs = 0

    const scheduler = new MaintenanceScheduler({
      store,
      storageAccountingRunner: createInlineAccountingRunner(),
      backupRetentionRunner: createInlineBackupRetentionRunner(),
      askWorker: async (req) => {
        // Compaction-lane messages (run-retention / optimize-fts / cancel-compaction) are not the maintenance
        // steps this test counts; they run in the worker now and are covered by worker-compaction tests.
        if (['fts-maintenance-step', 'gc-step', 'vacuum-step'].includes(req.type)) runs++
        return null
      },
    })

    // Call schedule multiple times consecutively
    scheduler.schedulePeriodicMaintenance(100)
    scheduler.schedulePeriodicMaintenance(100)
    scheduler.schedulePeriodicMaintenance(100)

    await vi.advanceTimersByTimeAsync(100)
    // Only 1 execution should have triggered
    expect(runs).toBe(3) // 3 steps: fts, gc, vacuum in single run

    store.close()
    scheduler.dispose()
  })

  // =========================================================================
  // MAINT-08: Maintenance step running slowly does not overlap itself
  // =========================================================================
  it('MAINT-08: maintenance does not overlap itself when a run is still pending', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath)
    let activeRuns = 0
    let maxConcurrent = 0
    let releaseGate: () => void
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })

    const scheduler = new MaintenanceScheduler({
      store,
      storageAccountingRunner: createInlineAccountingRunner(),
      backupRetentionRunner: createInlineBackupRetentionRunner(),
      askWorker: async () => {
        activeRuns++
        maxConcurrent = Math.max(maxConcurrent, activeRuns)
        await gate
        activeRuns--
        return null
      },
    })

    // Start first run
    const p1 = scheduler.runPeriodicMaintenance()
    // Simultaneously trigger second run while first is in-flight
    const p2 = scheduler.runPeriodicMaintenance()

    // Release all waiting worker steps
    releaseGate!()

    await Promise.all([p1, p2])
    expect(maxConcurrent).toBe(1)

    store.close()
    scheduler.dispose()
  })
})
