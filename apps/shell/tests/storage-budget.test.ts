import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STORAGE_BUDGET,
  SOFT_LIMIT_RATIO,
  HARD_LIMIT_RATIO,
  calculateStorageLimitState,
  createStorageBudgetSnapshot,
  checkFileSafetyBudget,
  canAcceptSemanticWork,
  canAcceptExpensiveWork,
  shouldTriggerStorageMaintenance,
  type DocumentIndexStorageBudget,
  type StorageBudgetSnapshot,
} from '../src/main/document-memory/storage-budget'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import { DiagnosticsRepository } from '../src/main/document-memory/storage/repositories/diagnostics-repository'
import { MaintenanceRepository } from '../src/main/document-memory/storage/repositories/maintenance-repository'
import {
  getDocumentIndexSnapshot,
  snapshotCache,
  diagnosticsCache,
} from '../src/main/fork/document-index-snapshot-service'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'

describe('Storage Budget Engine & User Limits Suite (DEV-16)', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-storage-budget-'))
    dbPath = join(directory, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
    snapshotCache.clear()
    diagnosticsCache.clear()
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
    snapshotCache.clear()
    diagnosticsCache.clear()
  })

  // =========================================================================
  // 1. Storage Budget Config & Default Thresholds
  // =========================================================================
  describe('Storage Budget Configuration & Thresholds', () => {
    it('provides enterprise default configurations without scattered hardcoding', () => {
      expect(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes).toBe(4 * 1024 * 1024 * 1024) // 4 GiB
      expect(DEFAULT_STORAGE_BUDGET.maxFileBytes).toBe(128 * 1024 * 1024)          // 128 MiB
      expect(DEFAULT_STORAGE_BUDGET.maxExtractedCharactersPerFile).toBe(8 * 1024 * 1024) // 8M chars
      expect(DEFAULT_STORAGE_BUDGET.maxChunksPerFile).toBe(4096)
      expect(DEFAULT_STORAGE_BUDGET.maxOcrPagesPerFile).toBe(50)
      expect(SOFT_LIMIT_RATIO).toBe(0.80)
      expect(HARD_LIMIT_RATIO).toBe(1.00)
    })

    it('correctly calculates limit states (ok, warning, full)', () => {
      const budgetBytes = 1000

      // Below 80%: ok
      expect(calculateStorageLimitState(0, budgetBytes)).toBe('ok')
      expect(calculateStorageLimitState(799, budgetBytes)).toBe('ok')

      // Between 80% and 100%: warning (SOFT LIMIT)
      expect(calculateStorageLimitState(800, budgetBytes)).toBe('warning')
      expect(calculateStorageLimitState(999, budgetBytes)).toBe('warning')

      // GRACE ZONE: 100%..110% of the soft quota is still 'warning' (writes/embeddings admitted,
      // compaction urgent). 'full' now means the HARD STOP at hardCapBytes = 110% (owner requirement:
      // "embedding must always keep working; the index may bloat at most 10% over the quota").
      expect(calculateStorageLimitState(1000, budgetBytes)).toBe('warning')
      expect(calculateStorageLimitState(1099, budgetBytes)).toBe('warning')

      // At or above the hard cap (110%): full (HARD STOP)
      expect(calculateStorageLimitState(1100, budgetBytes)).toBe('full')
      expect(calculateStorageLimitState(1200, budgetBytes)).toBe('full')

      // overshootRatio 0 restores the legacy "full at 100%" contract
      expect(calculateStorageLimitState(1000, budgetBytes, 0)).toBe('full')

      // Negative or zero handled gracefully
      expect(calculateStorageLimitState(-10, budgetBytes)).toBe('ok')
      expect(calculateStorageLimitState(100, 0)).toBe('ok')
    })
  })

  // =========================================================================
  // 2. Limit A: Per-File Safety Budget
  // =========================================================================
  describe('Limit A: Per-file safety budget', () => {
    it('rejects files exceeding maxFileBytes with clear error', () => {
      const result = checkFileSafetyBudget({
        sizeBytes: 150 * 1024 * 1024, // 150 MB > 128 MB
      })

      expect(result.accepted).toBe(false)
      expect(result.rejectionReason).toBe('file-too-large')
      expect(result.error).toContain('128 MB')
    })

    it('flags content-limit truncation when characters exceed maxExtractedCharactersPerFile', () => {
      const result = checkFileSafetyBudget({
        sizeBytes: 5 * 1024 * 1024,
        charCount: 9 * 1024 * 1024, // 9M chars > 8M chars
      })

      expect(result.accepted).toBe(true)
      expect(result.truncated).toBe(true)
      expect(result.truncatedReason).toBe('content-limit')
    })

    it('flags chunk-limit truncation when chunks exceed maxChunksPerFile', () => {
      const result = checkFileSafetyBudget({
        sizeBytes: 5 * 1024 * 1024,
        charCount: 1_000_000,
        chunkCount: 5000, // 5000 chunks > 4096 chunks
      })

      expect(result.accepted).toBe(true)
      expect(result.truncated).toBe(true)
      expect(result.truncatedReason).toBe('chunk-limit')
    })

    it('flags pdf-page-limit truncation when OCR pages exceed maxOcrPagesPerFile', () => {
      const result = checkFileSafetyBudget({
        sizeBytes: 10 * 1024 * 1024,
        ocrPages: 75, // 75 pages > 50 pages
      })

      expect(result.accepted).toBe(true)
      expect(result.truncated).toBe(true)
      expect(result.truncatedReason).toBe('pdf-page-limit')
    })
  })

  // =========================================================================
  // 3. Limit B & C: Global Index Budget & Backup Budget Isolation
  // =========================================================================
  describe('Limit B & C: Global Index Budget & Backup Budget Isolation', () => {
    it('does NOT count migration backup towards the 4 GB active index budget (Limit C isolation)', () => {
      // 2 GB active DB + 50 MB WAL, alongside 3 GB migration backup
      const activeDbSizeBytes = 2 * 1024 * 1024 * 1024
      const walSizeBytes = 50 * 1024 * 1024
      const backupBytes = 3 * 1024 * 1024 * 1024 // 3 GB backup

      const snapshot = createStorageBudgetSnapshot({
        activeDbSizeBytes,
        walSizeBytes,
        budgetBytes: DEFAULT_STORAGE_BUDGET.maxDatabaseBytes, // 4 GB
        backupBytes,
      })

      // Active databaseBytes is 2.05 GB (active + wal)
      expect(snapshot.databaseBytes).toBe(activeDbSizeBytes + walSizeBytes)
      // Backup is preserved and tracked separately
      expect(snapshot.backupBytes).toBe(backupBytes)
      // Usage ratio is strictly calculated on active DB against 4GB: ~51.2%
      expect(snapshot.usageRatio).toBeLessThan(0.60)
      // Limit state MUST be 'ok' despite total disk usage being > 5 GB
      expect(snapshot.limitState).toBe('ok')
    })

    it('triggers soft limit warning and maintenance when databaseBytes reaches 80%', () => {
      const snapshot = createStorageBudgetSnapshot({
        activeDbSizeBytes: 3.3 * 1024 * 1024 * 1024, // 3.3 GB / 4 GB = 82.5%
        walSizeBytes: 10 * 1024 * 1024,
        budgetBytes: DEFAULT_STORAGE_BUDGET.maxDatabaseBytes,
      })

      expect(snapshot.limitState).toBe('warning')
      expect(canAcceptSemanticWork(snapshot.limitState)).toBe(true)
      expect(shouldTriggerStorageMaintenance(snapshot.limitState)).toBe(true)
    })

    it('triggers hard stop full and halts expensive semantic work when databaseBytes reaches the 110% hard cap', () => {
      const snapshot = createStorageBudgetSnapshot({
        activeDbSizeBytes: 4.5 * 1024 * 1024 * 1024, // 4.5 GB / 4 GB = 112% >= hard cap (110%)
        walSizeBytes: 20 * 1024 * 1024,
        budgetBytes: DEFAULT_STORAGE_BUDGET.maxDatabaseBytes,
      })

      expect(snapshot.limitState).toBe('full')
      // Semantic work must be halted at hard limit to prevent disk exhaustion
      expect(canAcceptSemanticWork(snapshot.limitState)).toBe(false)
      expect(canAcceptExpensiveWork(snapshot.limitState)).toBe(false)
      expect(shouldTriggerStorageMaintenance(snapshot.limitState)).toBe(true)
    })
  })

  // =========================================================================
  // 4. Policy on Limit Exceeded: Never Corrupt Data, Persist Skip Reason
  // =========================================================================
  describe('Policy on Exceeding Limits & Safe Data Preservation', () => {
    it('maintains active data intact and provides MaintenanceScheduler budget gating', () => {
      // Mock store with small custom budget
      const customBudget: DocumentIndexStorageBudget = {
        maxDatabaseBytes: 1024, // 1 KB
        maxFileBytes: 1024 * 1024,
        maxExtractedCharactersPerFile: 10_000,
        maxChunksPerFile: 100,
        maxOcrPagesPerFile: 10,
      }

      const onBudgetStateChange = vi.fn()
      const scheduler = new MaintenanceScheduler({
        store,
        budget: customBudget,
        onBudgetStateChange,
      })

      // Populate database with real rows
      store.remember('/documents/test1.pdf')
      const doc = store.documentByPath('/documents/test1.pdf')
      expect(doc).toBeDefined()

      // Active file has content on disk, exceeding 1 KB budget
      const snapshot = scheduler.checkStorageBudget()
      expect(snapshot.databaseBytes).toBeGreaterThan(0)
      expect(snapshot.limitState).toBe('full')

      // canAcceptExpensiveWork reports false
      expect(scheduler.canAcceptExpensiveWork()).toBe(false)

      // Active data is NEVER deleted or corrupted
      const stillExistingDoc = store.documentByPath('/documents/test1.pdf')
      expect(stillExistingDoc).toBeDefined()
      expect(stillExistingDoc?.name).toBe('test1.pdf')
    })
  })

  // =========================================================================
  // 5. MaintenanceRepository & DiagnosticsRepository Integration
  // =========================================================================
  describe('MaintenanceRepository & DiagnosticsRepository Engine Integration', () => {
    it('MaintenanceRepository checks storage budget and executes maintenance', () => {
      const maintRepo = new MaintenanceRepository(store.rawDb, dbPath, 'worker')
      const budgetStatus = maintRepo.checkStorageBudget()

      expect(budgetStatus.databaseBytes).toBeGreaterThan(0)
      expect(budgetStatus.budgetBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes)
      expect(budgetStatus.limitState).toBe('ok')

      const result = maintRepo.runStorageBudgetMaintenance({ forceVacuum: false })
      expect(result.gc).toBeDefined()
      expect(result.vacuum).toBeDefined()
      expect(result.limitStateBefore).toBe('ok')
      expect(result.limitStateAfter).toBe('ok')
    })

    it('DiagnosticsRepository exposes all 10 required storage budget fields', () => {
      const diagRepo = new DiagnosticsRepository(store.rawDb, dbPath)
      const snapshot = diagRepo.getStorageBudgetSnapshot()

      // Required fields from DEV-16B:
      expect(typeof snapshot.databaseBytes).toBe('number')
      expect(typeof snapshot.budgetBytes).toBe('number')
      expect(typeof snapshot.usageRatio).toBe('number')
      expect(typeof snapshot.chunksBytes).toBe('number')
      expect(typeof snapshot.embeddingsBytes).toBe('number')
      expect(typeof snapshot.ftsBytes).toBe('number')
      expect(typeof snapshot.ocrBytes).toBe('number')
      expect(typeof snapshot.backupBytes).toBe('number')
      expect(typeof snapshot.reclaimableBytes).toBe('number')
      expect(['ok', 'warning', 'full']).toContain(snapshot.limitState)

      // Storage diagnostics also include budget metrics
      const diagnostics = diagRepo.getStorageDiagnostics()
      expect(diagnostics.databaseBytes).toBeDefined()
      expect(diagnostics.budgetBytes).toBeDefined()
      expect(diagnostics.limitState).toBeDefined()
    })
  })

  // =========================================================================
  // 6. IPC and Snapshot Exposure (DEV-16B)
  // =========================================================================
  describe('Snapshot & IPC Exposure (DEV-16B)', () => {
    it('getDocumentIndexSnapshot exposes storageBudget with all 10 fields', () => {
      const ctx = {
        getDocumentMemory: () => null,
        getFolderScan: () => null,
        getIssueReader: () => ({ summary: () => ({ total: 0, groups: [] }) }) as any,
        getFolderCounts: () => ({ get: () => ({}) }) as any,
        dbPath: () => dbPath,
      }

      const snapshot = getDocumentIndexSnapshot(ctx, true)
      expect(snapshot.storageBudget).toBeDefined()
      const b = snapshot.storageBudget!

      expect(b.databaseBytes).toBeGreaterThanOrEqual(0)
      expect(b.budgetBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes)
      expect(b.usageRatio).toBeGreaterThanOrEqual(0)
      expect(b.chunksBytes).toBeGreaterThanOrEqual(0)
      expect(b.embeddingsBytes).toBeGreaterThanOrEqual(0)
      expect(b.ftsBytes).toBeGreaterThanOrEqual(0)
      expect(b.ocrBytes).toBeGreaterThanOrEqual(0)
      expect(b.backupBytes).toBeGreaterThanOrEqual(0)
      expect(b.reclaimableBytes).toBeGreaterThanOrEqual(0)
      expect(['ok', 'warning', 'full']).toContain(b.limitState)
    })

    it('registers getDocumentIndexStorageBudget IPC channel exposing budget snapshot', async () => {
      const handlers = new Map<string, (...args: any[]) => any>()
      const fakeIpcMain = {
        handle: (channel: string, handler: (...args: any[]) => any) => {
          handlers.set(channel, handler)
        },
      }

      const unregister = registerDocumentIndexIpc({
        ipcMain: fakeIpcMain as any,
        getDocumentMemory: () => null,
        getFolderScan: () => null,
        dbPath: () => dbPath,
      })

      const budgetHandler = handlers.get(DOCUMENT_INDEX_CHANNELS.getDocumentIndexStorageBudget)
      expect(budgetHandler).toBeDefined()

      const budgetSnapshot: StorageBudgetSnapshot = await budgetHandler!({}, true)
      expect(budgetSnapshot).toBeDefined()
      expect(budgetSnapshot.databaseBytes).toBeGreaterThanOrEqual(0)
      expect(budgetSnapshot.budgetBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes)
      expect(['ok', 'warning', 'full']).toContain(budgetSnapshot.limitState)

      unregister()
    })
  })
})
