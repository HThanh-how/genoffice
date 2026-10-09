import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BackupRetentionRunner,
  type BackupRetentionWorkerLike,
} from '../src/main/document-memory/runtime/backup-retention-runner'
import { runRetentionWorkerTask } from '../src/main/document-memory/runtime/backup-retention-worker'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import type { WorkerRequest } from '../src/main/document-memory/worker-types'

class MockRetentionWorker extends EventEmitter implements BackupRetentionWorkerLike {
  public terminateCalls = 0
  public postedMessages: any[] = []

  postMessage(msg: any): void {
    this.postedMessages.push(msg)
  }

  terminate(): Promise<number> {
    this.terminateCalls++
    return Promise.resolve(0)
  }
}

describe('BackupRetentionRunner - Dedicated Process Isolation Suite (JOB-05-RET1)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'backup-retention-runner-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('runs retention policy in dedicated worker once via workerData, avoids postMessage run, and terminates worker on success', async () => {
    const mockWorker = new MockRetentionWorker()
    let passedData: { dbPath: string } | undefined

    const runner = new BackupRetentionRunner({
      workerFactory: (_scriptPath, data) => {
        passedData = data
        return mockWorker
      },
      timeoutMs: 5000,
    })

    const runPromise = runner.run('/path/to/test.db')

    // Single run: dbPath passed once via workerData; runner does NOT send postMessage('run')
    expect(passedData).toEqual({ dbPath: '/path/to/test.db' })
    expect(mockWorker.postedMessages).toEqual([])
    expect(mockWorker.terminateCalls).toBe(0)
    expect(runner.isJobRunning()).toBe(true)

    // Simulate worker completing retention job and posting result
    mockWorker.emit('message', { purgedCount: 3 })

    const result = await runPromise
    expect(result).toEqual({ purgedCount: 3 })
    expect(mockWorker.postedMessages).toEqual([])
    // Terminated on success
    expect(mockWorker.terminateCalls).toBe(1)
    expect(runner.isJobRunning()).toBe(false)
  })

  it('terminates worker process and settles on worker error', async () => {
    const mockWorker = new MockRetentionWorker()
    const runner = new BackupRetentionRunner({
      workerFactory: () => mockWorker,
      timeoutMs: 5000,
    })

    const runPromise = runner.run('/path/to/test.db')
    expect(runner.isJobRunning()).toBe(true)

    // Simulate worker error
    mockWorker.emit('error', new Error('Retention worker crash'))

    const result = await runPromise
    expect(result).toEqual({ purgedCount: 0 })
    expect(mockWorker.terminateCalls).toBe(1)
    expect(runner.isJobRunning()).toBe(false)
  })

  it('terminates worker process and settles on worker exit', async () => {
    const mockWorker = new MockRetentionWorker()
    const runner = new BackupRetentionRunner({
      workerFactory: () => mockWorker,
      timeoutMs: 5000,
    })

    const runPromise = runner.run('/path/to/test.db')
    expect(runner.isJobRunning()).toBe(true)

    // Simulate unexpected worker process exit before message
    mockWorker.emit('exit', 1)

    const result = await runPromise
    expect(result).toEqual({ purgedCount: 0 })
    expect(mockWorker.terminateCalls).toBe(1)
    expect(runner.isJobRunning()).toBe(false)
  })

  it('guards against concurrent runs by reusing existing in-flight job', async () => {
    const mockWorker = new MockRetentionWorker()
    let workerCreated = 0

    const runner = new BackupRetentionRunner({
      workerFactory: () => {
        workerCreated++
        return mockWorker
      },
      timeoutMs: 5000,
    })

    const p1 = runner.run('/path/to/test.db')
    const p2 = runner.run('/path/to/test.db')

    // Both promises should be the exact same in-flight promise
    expect(p1).toBe(p2)
    expect(workerCreated).toBe(1)
    expect(runner.isJobRunning()).toBe(true)

    mockWorker.emit('message', { purgedCount: 2 })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ purgedCount: 2 })
    expect(r2).toEqual({ purgedCount: 2 })
    expect(mockWorker.terminateCalls).toBe(1)
    expect(runner.isJobRunning()).toBe(false)
  })

  it('enforces timeout guard and terminates slow worker process', async () => {
    const mockWorker = new MockRetentionWorker()
    const runner = new BackupRetentionRunner({
      workerFactory: () => mockWorker,
      timeoutMs: 50,
    })

    const runPromise = runner.run('/path/to/test.db')

    // Wait for timeout to expire
    const result = await runPromise
    expect(result).toEqual({ purgedCount: 0 })
    expect(mockWorker.terminateCalls).toBe(1)
    expect(runner.isJobRunning()).toBe(false)
  })

  it('terminates active worker process upon dispose', async () => {
    const mockWorker = new MockRetentionWorker()
    const runner = new BackupRetentionRunner({
      workerFactory: () => mockWorker,
      timeoutMs: 10_000,
    })

    void runner.run('/path/to/test.db')
    expect(runner.isJobRunning()).toBe(true)

    runner.dispose()
    expect(mockWorker.terminateCalls).toBe(1)
    expect(runner.isJobRunning()).toBe(false)

    // After dispose, subsequent run calls return { purgedCount: 0 } immediately
    const subsequent = await runner.run('/path/to/test.db')
    expect(subsequent).toEqual({ purgedCount: 0 })
  })

  it('delegates from MaintenanceScheduler without touching search/index worker', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath)
    const indexWorkerRequests: WorkerRequest[] = []

    const mockRetentionWorker = new MockRetentionWorker()
    const retentionRunner = new BackupRetentionRunner({
      workerFactory: () => mockRetentionWorker,
      timeoutMs: 5000,
    })

    const scheduler = new MaintenanceScheduler({
      store,
      backupRetentionRunner: retentionRunner,
      askWorker: async (req) => {
        indexWorkerRequests.push(req)
        return null
      },
    })

    const maintPromise = scheduler.runBackupRetentionMaintenance()
    mockRetentionWorker.emit('message', { purgedCount: 4 })

    const res = await maintPromise
    expect(res).toEqual({ purgedCount: 4 })
    expect(mockRetentionWorker.terminateCalls).toBe(1)

    // Index worker NEVER received backup-retention request
    expect(indexWorkerRequests.map((r) => r.type)).not.toContain('backup-retention')
    expect(indexWorkerRequests.length).toBe(0)

    store.close()
    scheduler.dispose()
  })

  it('delegates from DocumentMemoryManager.runBackupRetentionMaintenance()', async () => {
    const mockRetentionWorker = new MockRetentionWorker()
    const retentionRunner = new BackupRetentionRunner({
      workerFactory: () => mockRetentionWorker,
      timeoutMs: 5000,
    })

    const manager = new DocumentMemoryManager(tempDir, {
      backupRetentionRunner: retentionRunner,
      pollIntervalMs: 600_000,
    })

    const runPromise = manager.runBackupRetentionMaintenance()
    mockRetentionWorker.emit('message', { purgedCount: 1 })

    const res = await runPromise
    expect(res).toEqual({ purgedCount: 1 })
    expect(mockRetentionWorker.terminateCalls).toBe(1)

    manager.close()
  })

  it('instantiates BackupRetentionRunner with default workerPath imported via ?modulePath', () => {
    const runner = new BackupRetentionRunner()
    expect((runner as any).workerPath).toBeDefined()
    expect(typeof (runner as any).workerPath).toBe('string')
  })

  it('executes runRetentionWorkerTask and handles non-existent or clean db safely', () => {
    const result = runRetentionWorkerTask('/non/existent/path/db.sqlite')
    expect(result).toEqual({ purgedCount: 0 })
  })
})
