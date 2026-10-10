import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import type {
  WorkerRequest,
  WorkerReply,
  StorageBudgetWorkerRequest,
  StorageBudgetWorkerResult,
} from '../src/main/document-memory/worker-types'
import type { DocumentIndexStorageDiagnostics } from '../src/shared/fork/document-index-api'

describe('Pair 10: Diagnostics Worker Isolation Invariants Suite (QA-10)', () => {
  let tempDir: string
  let activeManagers: DocumentMemoryManager[] = []
  let activeStores: DocumentMemoryStore[] = []

  const sampleDiagnostics: DocumentIndexStorageDiagnostics = {
    activeDbSizeBytes: 1048576,
    walSizeBytes: 32768,
    pageSize: 4096,
    pageCount: 256,
    freelistCount: 8,
    estimatedReclaimableBytes: 32768,
    v2BackupSizeBytes: 524288,
    schemaVersion: '3',
    migrationStatus: 'completed',
    topOffendersByChunks: [{ documentId: 'doc-alpha', path: '/docs/alpha.pdf', chunkCount: 50 }],
    topOffendersBySize: [{ documentId: 'doc-alpha', path: '/docs/alpha.pdf', totalBytes: 128000 }],
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-qa10-worker-diag-'))
    activeManagers = []
    activeStores = []
  })

  afterEach(async () => {
    for (const m of activeManagers) {
      try {
        await m.closeAsync()
      } catch {
        // ignore
      }
    }
    for (const s of activeStores) {
      try {
        s.close()
      } catch {
        // ignore
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  // =========================================================================
  // WORKERDIAG-01: request reaches worker
  // =========================================================================
  it('WORKERDIAG-01 request reaches worker', async () => {
    const receivedRequests: Array<WorkerRequest & { id: number }> = []

    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn((msg: WorkerRequest & { id: number }) => {
        receivedRequests.push(msg)
        if (msg.type === 'set-storage-budget') {
          mockWorker.emit('message', {
            id: msg.id,
            result: {
              ok: true,
              appliedVersion: msg.configVersion,
              desiredVersion: msg.configVersion,
              appliedBudgetBytes: msg.budget.maxDatabaseBytes,
            } satisfies StorageBudgetWorkerResult,
          } satisfies WorkerReply)
        } else if (msg.type === 'storage-diagnostics') {
          mockWorker.emit('message', {
            id: msg.id,
            result: sampleDiagnostics,
          } satisfies WorkerReply)
        }
      }),
      terminate: vi.fn(() => Promise.resolve(0)),
    })

    const workerFactorySpy = vi.fn(() => mockWorker as any)

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: workerFactorySpy,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    const targetBackup = join(tempDir, 'backup-v2.db')
    writeFileSync(targetBackup, 'dummy-backup-payload', 'utf8')

    const result = await manager.getStorageDiagnosticsAsync(targetBackup)

    // Separate requests by contract type
    const diagRequests = receivedRequests.filter(
      (r): r is Extract<WorkerRequest, { type: 'storage-diagnostics' }> & { id: number } =>
        r.type === 'storage-diagnostics',
    )
    const handshakeRequests = receivedRequests.filter(
      (r): r is StorageBudgetWorkerRequest & { id: number } => r.type === 'set-storage-budget',
    )

    // Verify worker factory invoked exactly once
    expect(workerFactorySpy).toHaveBeenCalledTimes(1)

    // Verify total postMessage calls: 1 startup handshake + 1 diagnostics request
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(2)

    // Assert handshake count and version separately
    expect(handshakeRequests.length).toBe(1)
    const handshakeReq = handshakeRequests[0]
    expect(handshakeReq).toBeDefined()
    expect(handshakeReq.type).toBe('set-storage-budget')
    expect(typeof handshakeReq.configVersion).toBe('number')
    expect(handshakeReq.configVersion).toBe(manager.getStorageBudgetConfig().version)
    expect(handshakeReq.budget).toBeDefined()
    expect(typeof handshakeReq.budget.maxDatabaseBytes).toBe('number')

    // Diagnostics call count expectations
    expect(diagRequests.length).toBe(1)
    const req = diagRequests[0]
    expect(req).toBeDefined()
    expect(req.type).toBe('storage-diagnostics')
    expect(typeof req.id).toBe('number')
    expect(req.id).toBeGreaterThan(0)
    expect(req.backupPath).toBe(targetBackup)

    // Verify result returned cleanly to caller
    expect(result).toEqual(sampleDiagnostics)
  })

  // =========================================================================
  // WORKERDIAG-02: worker error propagated
  // =========================================================================
  it('WORKERDIAG-02 worker error propagated', async () => {
    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn((msg: WorkerRequest & { id: number }) => {
        if (msg.type === 'set-storage-budget') {
          mockWorker.emit('message', {
            id: msg.id,
            result: {
              ok: true,
              appliedVersion: msg.configVersion,
              desiredVersion: msg.configVersion,
              appliedBudgetBytes: msg.budget.maxDatabaseBytes,
            } satisfies StorageBudgetWorkerResult,
          } satisfies WorkerReply)
        } else if (msg.type === 'storage-diagnostics') {
          // Worker reports failure / error reply
          mockWorker.emit('message', {
            id: msg.id,
            error: 'SQLite database disk image is malformed or inaccessible',
          } satisfies WorkerReply)
        }
      }),
      terminate: vi.fn(() => Promise.resolve(0)),
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as any,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    // Manager must safely propagate/handle error without throwing unhandled exceptions
    const result = await manager.getStorageDiagnosticsAsync()
    expect(result).toBeNull()

    // Test catastrophic worker error event propagation
    const catastrophicWorker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn((_msg: WorkerRequest & { id: number }) => {
        catastrophicWorker.emit(
          'error',
          new Error('Segmentation fault inside worker sqlite runtime'),
        )
      }),
      terminate: vi.fn(() => Promise.resolve(0)),
    })

    const managerCrash = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => catastrophicWorker as any,
      initialEnabled: false,
    })
    activeManagers.push(managerCrash)

    const crashResult = await managerCrash.getStorageDiagnosticsAsync()
    expect(crashResult).toBeNull()
  })

  // =========================================================================
  // WORKERDIAG-03: timeout handled
  // =========================================================================
  it('WORKERDIAG-03 timeout handled', async () => {
    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn((_msg: WorkerRequest & { id: number }) => {
        // Intentionally unresponsive worker: never sends any reply
      }),
      terminate: vi.fn(() => Promise.resolve(0)),
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as any,
      workerTimeoutMs: 60,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    const startTime = Date.now()
    const result = await manager.getStorageDiagnosticsAsync()
    const duration = Date.now() - startTime

    // Must resolve to null cleanly
    expect(result).toBeNull()
    // Must timeout after the configured duration (>= 50ms)
    expect(duration).toBeGreaterThanOrEqual(50)
  })

  // =========================================================================
  // WORKERDIAG-04: main adapter doesn't directly call repository
  // =========================================================================
  it("WORKERDIAG-04 main adapter doesn't directly call repository", async () => {
    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn((msg: WorkerRequest & { id: number }) => {
        if (msg.type === 'set-storage-budget') {
          mockWorker.emit('message', {
            id: msg.id,
            result: {
              ok: true,
              appliedVersion: msg.configVersion,
              desiredVersion: msg.configVersion,
              appliedBudgetBytes: msg.budget.maxDatabaseBytes,
            } satisfies StorageBudgetWorkerResult,
          } satisfies WorkerReply)
        } else if (msg.type === 'storage-diagnostics') {
          mockWorker.emit('message', {
            id: msg.id,
            result: sampleDiagnostics,
          } satisfies WorkerReply)
        }
      }),
      terminate: vi.fn(() => Promise.resolve(0)),
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as any,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    // Spy on the main thread store and its underlying diagnostics repository
    const storeDiagSpy = vi.spyOn(manager.store, 'getStorageDiagnostics')
    const diagRepoInstance = (manager.store as any).diagRepo
    const repoDiagSpy = diagRepoInstance
      ? vi.spyOn(diagRepoInstance, 'getStorageDiagnostics')
      : null

    const result = await manager.getStorageDiagnosticsAsync()

    expect(result).toEqual(sampleDiagnostics)
    // Critical architectural invariant: Main thread store & repository MUST NEVER be invoked directly
    expect(storeDiagSpy).toHaveBeenCalledTimes(0)
    if (repoDiagSpy) {
      expect(repoDiagSpy).toHaveBeenCalledTimes(0)
    }
  })

  // =========================================================================
  // WORKERDIAG-05: repeated calls don't spawn workers
  // =========================================================================
  it("WORKERDIAG-05 repeated calls don't spawn workers", async () => {
    let workerSpawnCount = 0
    const receivedRequests: Array<WorkerRequest & { id: number }> = []

    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn((msg: WorkerRequest & { id: number }) => {
        receivedRequests.push(msg)
        if (msg.type === 'set-storage-budget') {
          mockWorker.emit('message', {
            id: msg.id,
            result: {
              ok: true,
              appliedVersion: msg.configVersion,
              desiredVersion: msg.configVersion,
              appliedBudgetBytes: msg.budget.maxDatabaseBytes,
            } satisfies StorageBudgetWorkerResult,
          } satisfies WorkerReply)
        } else if (msg.type === 'storage-diagnostics') {
          mockWorker.emit('message', {
            id: msg.id,
            result: sampleDiagnostics,
          } satisfies WorkerReply)
        }
      }),
      terminate: vi.fn(() => Promise.resolve(0)),
    })

    const workerFactorySpy = vi.fn(() => {
      workerSpawnCount++
      return mockWorker as any
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: workerFactorySpy,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    // Call 1: Initial call initializes the worker instance
    const res1 = await manager.getStorageDiagnosticsAsync()
    expect(res1).toEqual(sampleDiagnostics)
    expect(workerSpawnCount).toBe(1)
    expect(workerFactorySpy).toHaveBeenCalledTimes(1)

    // Call 2: Second sequential call must reuse the existing worker
    const res2 = await manager.getStorageDiagnosticsAsync()
    expect(res2).toEqual(sampleDiagnostics)
    expect(workerSpawnCount).toBe(1)
    expect(workerFactorySpy).toHaveBeenCalledTimes(1)

    // Calls 3 & 4: Concurrent calls must reuse the single worker
    const [res3, res4] = await Promise.all([
      manager.getStorageDiagnosticsAsync(),
      manager.getStorageDiagnosticsAsync(),
    ])
    expect(res3).toEqual(sampleDiagnostics)
    expect(res4).toEqual(sampleDiagnostics)
    expect(workerSpawnCount).toBe(1)
    expect(workerFactorySpy).toHaveBeenCalledTimes(1)

    // Separate requests by contract type
    const diagRequests = receivedRequests.filter(
      (req): req is Extract<WorkerRequest, { type: 'storage-diagnostics' }> & { id: number } =>
        req.type === 'storage-diagnostics',
    )
    const handshakeRequests = receivedRequests.filter(
      (req): req is StorageBudgetWorkerRequest & { id: number } =>
        req.type === 'set-storage-budget',
    )

    // Assert handshake count and version separately
    expect(handshakeRequests.length).toBe(1)
    const handshakeReq = handshakeRequests[0]
    expect(handshakeReq).toBeDefined()
    expect(handshakeReq.type).toBe('set-storage-budget')
    expect(typeof handshakeReq.configVersion).toBe('number')
    expect(handshakeReq.configVersion).toBe(manager.getStorageBudgetConfig().version)
    expect(handshakeReq.budget).toBeDefined()
    expect(typeof handshakeReq.budget.maxDatabaseBytes).toBe('number')

    // All 4 diagnostics requests were serviced by the same worker instance
    expect(diagRequests.length).toBe(4)

    // Total postMessage invocations: 1 startup handshake + 4 diagnostics requests
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(5)
  })
})
