import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import type { WorkerRequest, WorkerReply } from '../src/main/document-memory/worker-types'
import type { DocumentIndexStorageDiagnostics } from '../src/shared/fork/document-index-api'

describe('Off-Main Process Storage Diagnostics Suite (QA-12)', () => {
  let tempDir: string
  let dbPath: string
  let activeManagers: DocumentMemoryManager[] = []
  let activeStores: DocumentMemoryStore[] = []

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-diag-worker-'))
    dbPath = join(tempDir, 'document-memory.db')
    activeManagers = []
    activeStores = []
  })

  afterEach(async () => {
    for (const m of activeManagers) {
      try {
        await m.closeAsync()
      } catch {}
    }
    for (const s of activeStores) {
      try {
        s.close()
      } catch {}
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('DIAGWORKER-01: DocumentMemoryStore provides complete storage diagnostics for worker consumption', () => {
    const store = new DocumentMemoryStore(dbPath)
    activeStores.push(store)
    const diag: DocumentIndexStorageDiagnostics = store.getStorageDiagnostics()
    expect(diag).toBeDefined()
    expect(diag.schemaVersion).toBe('3')
    expect(diag.migrationStatus).toBe('completed')
    expect(typeof diag.activeDbSizeBytes).toBe('number')
    expect(typeof diag.pageSize).toBe('number')
    expect(typeof diag.pageCount).toBe('number')
    expect(typeof diag.freelistCount).toBe('number')
  })

  it('DIAGWORKER-02: DocumentMemoryManager routes storage diagnostics off-main through worker request', async () => {
    const receivedRequests: WorkerRequest[] = []

    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage(msg: WorkerRequest & { id: number }) {
        receivedRequests.push(msg)
        if (msg.type === 'storage-diagnostics') {
          const store = new DocumentMemoryStore(dbPath, { role: 'worker' })
          try {
            const diag = store.getStorageDiagnostics(msg.backupPath)
            mockWorker.emit('message', { id: msg.id, result: diag } satisfies WorkerReply)
          } finally {
            store.close()
          }
        }
      },
      terminate() {
        return Promise.resolve(0)
      },
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as any,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    const result = await manager.getStorageDiagnosticsAsync()
    expect(result).not.toBeNull()
    expect(typeof result?.schemaVersion).toBe('string')
    expect(result?.migrationStatus).toMatch(/completed|in-progress/)
    expect(receivedRequests.length).toBeGreaterThan(0)
    const diagReq = receivedRequests.find((r) => r.type === 'storage-diagnostics')
    expect(diagReq).toBeDefined()
    expect(diagReq?.type).toBe('storage-diagnostics')
  })

  it('DIAGWORKER-03: getStorageDiagnosticsAsync gracefully returns null on worker timeout without crashing', async () => {
    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage(_msg: WorkerRequest & { id: number }) {
        // Intentionally simulate worker timeout by not replying
      },
      terminate() {
        return Promise.resolve(0)
      },
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as any,
      workerTimeoutMs: 50,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    const result = await manager.getStorageDiagnosticsAsync()
    expect(result).toBeNull()
  })

  it('DIAGWORKER-04: getStorageDiagnosticsAsync gracefully returns null on worker error', async () => {
    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage(msg: WorkerRequest & { id: number }) {
        if (msg.type === 'storage-diagnostics') {
          mockWorker.emit('message', {
            id: msg.id,
            error: 'Worker sqlite query failed',
          } satisfies WorkerReply)
        }
      },
      terminate() {
        return Promise.resolve(0)
      },
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as any,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    const result = await manager.getStorageDiagnosticsAsync()
    expect(result).toBeNull()
  })

  it('DIAGWORKER-05: Backup path parameter is propagated to worker request', async () => {
    let capturedBackupPath: string | undefined

    const mockWorker = Object.assign(new EventEmitter(), {
      postMessage(msg: WorkerRequest & { id: number }) {
        if (msg.type === 'storage-diagnostics') {
          capturedBackupPath = msg.backupPath
          const store = new DocumentMemoryStore(dbPath, { role: 'worker' })
          try {
            const diag = store.getStorageDiagnostics(msg.backupPath)
            mockWorker.emit('message', { id: msg.id, result: diag } satisfies WorkerReply)
          } finally {
            store.close()
          }
        }
      },
      terminate() {
        return Promise.resolve(0)
      },
    })

    const manager = new DocumentMemoryManager(tempDir, {
      dbDir: tempDir,
      workerFactory: () => mockWorker as any,
      initialEnabled: false,
    })
    activeManagers.push(manager)

    const customBackup = join(tempDir, 'document-memory-custom.backup.db')
    writeFileSync(customBackup, 'custom-backup-binary-data')

    const result = await manager.getStorageDiagnosticsAsync(customBackup)
    expect(capturedBackupPath).toBe(customBackup)
    expect(result).not.toBeNull()
    expect(result?.v2BackupSizeBytes).toBeGreaterThan(0)
  })
})
