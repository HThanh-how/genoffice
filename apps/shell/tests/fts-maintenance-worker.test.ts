import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  publishIndexingPolicy,
  resetIndexingPolicyBus,
} from '../src/main/fork/indexing-policy-bus'

const PAUSED_POLICY = {
  paused: true,
  pauseReason: 'low-battery' as const,
  threads: 1,
  cpuShare: 0,
  priority: 'idle' as const,
  tier: 'paused' as const,
  reason: 'test pause',
  onBattery: true,
  memoryTier: 'normal' as const,
  allowHeavyEmbedding: false,
  maxBatchTokens: 3000,
}

const RESUMED_POLICY = {
  paused: false,
  threads: 2,
  cpuShare: 0.5,
  priority: 'below-normal' as const,
  tier: 'active' as const,
  reason: 'test active',
  onBattery: false,
  memoryTier: 'normal' as const,
  allowHeavyEmbedding: true,
  maxBatchTokens: 3000,
}

class MockFtsWorker extends EventEmitter {
  sentRequests: Array<{ id: number; type: string }> = []
  moreQueue: boolean[] = []

  constructor() {
    super()
  }

  postMessage(message: { id: number; type: string }): void {
    this.sentRequests.push({ id: message.id, type: message.type })
    if (message.type === 'fts-maintenance-step') {
      const more = this.moreQueue.length > 0 ? this.moreQueue.shift()! : false
      setTimeout(() => {
        this.emit('message', {
          id: message.id,
          result: {
            more,
            durationMs: 4,
          },
        })
      }, 5)
    } else if (message.type === 'gc-step') {
      setTimeout(() => {
        this.emit('message', {
          id: message.id,
          result: {
            gcStats: {
              retiredSetsDeleted: 0,
              orphanChunksDeleted: 0,
              obsoleteEmbeddingsDeleted: 0,
              ftsRowsCleaned: 0,
            },
            durationMs: 4,
          },
        })
      }, 5)
    } else if (message.type === 'vacuum-step') {
      setTimeout(() => {
        this.emit('message', {
          id: message.id,
          result: {
            vacuumResult: {
              vacuumed: true,
              initialFreelistPages: 256,
              finalFreelistPages: 0,
              pagesReclaimed: 256,
              bytesReclaimed: 1048576,
            },
            durationMs: 4,
          },
        })
      }, 5)
    }
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('FTS Maintenance Worker Delegation', () => {
  let tempDir: string
  let mockWorker: MockFtsWorker

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-fts-test-'))
    mockWorker = new MockFtsWorker()
    publishIndexingPolicy(RESUMED_POLICY)
  })

  afterEach(() => {
    resetIndexingPolicyBus()
    vi.restoreAllMocks()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors in test
    }
  })

  it('delegates fts-maintenance-step to worker without calling mergeFtsStep on main thread', async () => {
    const mergeFtsStepSpy = vi.spyOn(DocumentMemoryStore.prototype, 'mergeFtsStep')

    mockWorker.moreQueue = [false]

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as unknown as Worker,
      pollIntervalMs: 60_000,
    })

    // Trigger maintenance
    void (manager as unknown as { runFtsMaintenance: () => Promise<void> }).runFtsMaintenance()

    // Wait for the async ask-reply cycle
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Verify main thread store was NOT called
    expect(mergeFtsStepSpy).not.toHaveBeenCalled()

    // Verify request was sent to worker process
    const ftsRequests = mockWorker.sentRequests.filter((r) => r.type === 'fts-maintenance-step')
    expect(ftsRequests.length).toBeGreaterThanOrEqual(1)

    manager.close()
  })

  it('schedules next step when worker reports more=true and stops when more=false', async () => {
    // First step returns more: true, second step returns more: false
    mockWorker.moreQueue = [true, false]

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as unknown as Worker,
      pollIntervalMs: 60_000,
    })

    void (manager as unknown as { runFtsMaintenance: () => Promise<void> }).runFtsMaintenance()

    // Wait enough for first turn, schedule delay (250ms), and second turn
    await new Promise((resolve) => setTimeout(resolve, 400))

    const ftsRequests = mockWorker.sentRequests.filter((r) => r.type === 'fts-maintenance-step')
    expect(ftsRequests.length).toBe(2)

    // Wait a bit more to ensure no 3rd step was scheduled
    await new Promise((resolve) => setTimeout(resolve, 300))
    const ftsRequestsAfter = mockWorker.sentRequests.filter((r) => r.type === 'fts-maintenance-step')
    expect(ftsRequestsAfter.length).toBe(2)

    manager.close()
  })

  it('delegates gc-step and vacuum-step to worker process', async () => {
    const runGcSpy = vi.spyOn(DocumentMemoryStore.prototype, 'runMaintenanceGc')
    const runVacuumSpy = vi.spyOn(DocumentMemoryStore.prototype, 'runIncrementalVacuum')

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as unknown as Worker,
      pollIntervalMs: 60_000,
    })

    await manager.runGcStep()
    await manager.runVacuumStep()

    // Verify main thread store was not called directly
    expect(runGcSpy).not.toHaveBeenCalled()
    expect(runVacuumSpy).not.toHaveBeenCalled()

    // Verify worker received both steps
    const gcRequests = mockWorker.sentRequests.filter((r) => r.type === 'gc-step')
    const vacuumRequests = mockWorker.sentRequests.filter((r) => r.type === 'vacuum-step')
    expect(gcRequests.length).toBe(1)
    expect(vacuumRequests.length).toBe(1)

    manager.close()
  })

  it('suspends maintenance when isIndexingPaused is active', async () => {
    publishIndexingPolicy(PAUSED_POLICY)

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as unknown as Worker,
      pollIntervalMs: 60_000,
    })

    await manager.runFtsMaintenance()
    await manager.runGcStep()
    await manager.runVacuumStep()

    // When paused, no requests should be sent to worker
    expect(mockWorker.sentRequests.length).toBe(0)

    manager.close()
  })
})
