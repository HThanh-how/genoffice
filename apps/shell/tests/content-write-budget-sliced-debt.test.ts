import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import {
  writeExtractedContentSliced,
  estimateTotalChunksBytes,
  CONSERVATIVE_HEADROOM_BYTES,
} from '../src/main/document-memory/runtime/content-write-budget'
import {
  createStorageBudget,
  createStorageBudgetSnapshot,
  contentWriteCapBytes,
  type StorageBudgetSnapshot,
} from '../src/main/document-memory/storage-budget'

describe('Content write budget: unmeasured committed debt invariant across slices', () => {
  let tempDir: string
  let dbPath: string
  let store: DocumentMemoryStore
  let admission: StorageAdmissionController

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dm-slice-debt-'))
    dbPath = join(tempDir, 'test.db')
    store = new DocumentMemoryStore(dbPath)
    admission = new StorageAdmissionController()
  })

  afterEach(() => {
    store.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function makeMockScheduler(initialUsageBytes: number, budgetBytes: number) {
    const budget = createStorageBudget({ maxDatabaseBytes: budgetBytes })
    let snapshot: StorageBudgetSnapshot = {
      ...createStorageBudgetSnapshot(budget),
      databaseBytes: initialUsageBytes,
      totalManagedBytes: initialUsageBytes,
      measurementStatus: 'fresh',
      isDegraded: false,
      limitState: 'normal',
      measuredAt: Date.now(),
    }

    const refreshCalls: number[] = []

    const maintScheduler = {
      budget,
      getLastBudgetSnapshot: () => snapshot,
      refreshAccountingAsync: vi.fn(async () => {
        refreshCalls.push(Date.now())
        // Simulate physical growth on disk when refreshed
        snapshot = {
          ...snapshot,
          databaseBytes: initialUsageBytes + 50_000,
          totalManagedBytes: initialUsageBytes + 50_000,
          measuredAt: Date.now(),
        }
        return snapshot
      }),
      invalidateAccounting: vi.fn(),
      makeRoom: vi.fn(async () => ({ retry: false })),
    }

    return { maintScheduler, refreshCalls, getSnapshot: () => snapshot }
  }

  const budgetCoord = {
    isWriteReady: () => true,
  }

  it('preserves ACCOUNTED_PHYSICAL + RESERVED_UNWRITTEN + UNMEASURED_COMMITTED <= STORAGE_CAP invariant across intermediate slices without intermediate physical scans', async () => {
    const initialUsage = 1_000_000
    const budgetBytes = 50_000_000
    const { maintScheduler, refreshCalls } = makeMockScheduler(initialUsage, budgetBytes)
    const storageCap = contentWriteCapBytes(maintScheduler.budget)

    // Create 120 chunks to force multiple batches (50 max chunks per batch)
    const chunks = Array.from({ length: 120 }, (_, i) => ({
      text: `Sample chunk content text for paragraph ${i}. `.repeat(20),
      location: `Section ${i + 1}`,
    }))

    const filePath = join(tempDir, 'large-doc.txt')
    writeFileSync(filePath, 'dummy file')
    store.remember(filePath)

    const reserveId = `extract:${filePath}`
    const totalEst = estimateTotalChunksBytes(chunks)

    // Pre-reserve lease as standard workflow does
    admission.reserve(reserveId, 'extract', totalEst, initialUsage, storageCap)

    const recordedReservations: number[] = []
    const originalReconcile = admission.reconcile.bind(admission)
    admission.reconcile = (id, opts) => {
      const res = originalReconcile(id, opts)
      if (id === reserveId) {
        recordedReservations.push(admission.getReservedBytes())
      }
      return res
    }

    const result = await writeExtractedContentSliced({
      store,
      admission,
      maintScheduler: maintScheduler as any,
      budgetCoord: budgetCoord as any,
      dbDir: tempDir,
      path: filePath,
      ext: {
        hash: 'hash-123',
        mtimeMs: Date.now(),
        sizeBytes: 50_000,
        chunks,
      },
      isCurrent: () => true,
    })

    expect(result.written).toBe(true)

    // Intermediate slice commits occurred
    expect(recordedReservations.length).toBeGreaterThanOrEqual(3)

    // The reservation at intermediate slices NEVER dropped below unmeasured committed debt!
    for (let i = 0; i < recordedReservations.length - 1; i++) {
      const reserved = recordedReservations[i]!
      // Invariant: accounted physical + reserved (which includes unmeasured committed) <= storage cap
      expect(initialUsage + reserved).toBeLessThanOrEqual(storageCap)
      // Must not drop to 0 or prematurely shrink below committed debt
      expect(reserved).toBeGreaterThan(0)
    }

    // Physical measurement refreshAsync was ONLY called for initial resize and final slice (not intermediate slices)
    expect(maintScheduler.refreshAccountingAsync).toHaveBeenCalledTimes(2)

    // After final slice completion, lease is reconciled to 0
    expect(recordedReservations[recordedReservations.length - 1]).toBe(0)
  })

  it('blocks concurrent writer when near quota because intermediate committed debt is truthfully accounted', async () => {
    // Set budget such that Writer 1 fits, but leaves only 10,000 bytes headroom
    const chunks = Array.from({ length: 110 }, (_, i) => ({
      text: `Chunk data ${i}. `.repeat(15),
      location: `Loc ${i}`,
    }))
    const totalEst = estimateTotalChunksBytes(chunks)

    const initialUsage = 10_000_000
    // Target cap allows initialUsage + 50_000 (refresh growth) + totalEst + CONSERVATIVE_HEADROOM_BYTES + 15_000 bytes headroom
    const targetCap = initialUsage + 50_000 + totalEst + CONSERVATIVE_HEADROOM_BYTES + 15_000
    const budgetBytes = Math.ceil(targetCap / 0.9) + 5000
    const { maintScheduler } = makeMockScheduler(initialUsage, budgetBytes)
    const storageCap = contentWriteCapBytes(maintScheduler.budget)

    const doc1 = join(tempDir, 'writer1.txt')
    writeFileSync(doc1, 'doc1')
    store.remember(doc1)

    let checkedConcurrentRejection = false

    // Intercept reconcile on intermediate slice to simulate concurrent writer arrival
    const origReconcile = admission.reconcile.bind(admission)
    admission.reconcile = (id, opts) => {
      const res = origReconcile(id, opts)
      if (id === `extract:${doc1}` && opts.remainingBytes && opts.remainingBytes > 0) {
        // Writer 2 tries to reserve 25,000 bytes (exceeding remaining 15,000 bytes headroom)
        const concurrentDecision = admission.canAdmit(
          'extract',
          25_000,
          initialUsage + 50_000,
          storageCap,
          {
            headroomBytes: CONSERVATIVE_HEADROOM_BYTES,
          },
        )
        // Must be rejected because Writer 1's intermediate committed debt is retained!
        expect(concurrentDecision.admitted).toBe(false)
        expect(concurrentDecision.reason).toBe('quota-exhausted')
        checkedConcurrentRejection = true
      }
      return res
    }

    const result = await writeExtractedContentSliced({
      store,
      admission,
      maintScheduler: maintScheduler as any,
      budgetCoord: budgetCoord as any,
      dbDir: tempDir,
      path: doc1,
      ext: {
        hash: 'hash-doc1',
        mtimeMs: Date.now(),
        sizeBytes: 30_000,
        chunks,
      },
      isCurrent: () => true,
    })

    expect(result.written).toBe(true)
    expect(checkedConcurrentRejection).toBe(true)
  })

  it('rejects subsequent intermediate slice when accumulated committed debt reaches hard quota cap', async () => {
    const chunks = Array.from({ length: 120 }, (_, i) => ({
      text: `Data ${i}. `.repeat(20),
      location: `L ${i}`,
    }))
    const totalEst = estimateTotalChunksBytes(chunks)

    // Budget cap that allows initial admission but tight enough that after batch 1 commits,
    // total usage + debt exceeds a lowered budget cap
    const initialUsage = 5_000_000
    const initialBudget = initialUsage + totalEst + 50_000
    const { maintScheduler } = makeMockScheduler(initialUsage, initialBudget)

    const docPath = join(tempDir, 'overflow-doc.txt')
    writeFileSync(docPath, 'overflow')
    store.remember(docPath)

    // Shrink budget during slice execution to simulate concurrent budget reduction or quota pressure
    let batchCount = 0
    const originalCheckedResize = admission.checkedResize.bind(admission)
    admission.checkedResize = (params, ...rest) => {
      batchCount++
      if (batchCount >= 2) {
        // Lower budget cap so intermediate batchResize fails
        return originalCheckedResize({
          ...(typeof params === 'object'
            ? params
            : { reservationId: params, newBytes: rest[0]!, currentUsageBytes: rest[1]! }),
          budgetBytes: initialUsage + 5_000, // lower than committed debt + remaining
        })
      }
      return originalCheckedResize(params, ...rest)
    }

    const result = await writeExtractedContentSliced({
      store,
      admission,
      maintScheduler: maintScheduler as any,
      budgetCoord: budgetCoord as any,
      dbDir: tempDir,
      path: docPath,
      ext: {
        hash: 'hash-overflow',
        mtimeMs: Date.now(),
        sizeBytes: 20_000,
        chunks,
      },
      isCurrent: () => true,
    })

    // Write failed due to quota denial on intermediate slice
    expect(result.written).toBe(false)
    expect(result.reason).toBe('quota-exhausted')
  })

  it('retains committed debt fail-closed when postCommit physical measurement refresh fails on final slice', async () => {
    const chunks = [{ text: 'Single chunk', location: 'L1' }]
    const initialUsage = 1_000_000
    const budgetBytes = 10_000_000
    const { maintScheduler } = makeMockScheduler(initialUsage, budgetBytes)

    // Refresh throws error on final slice
    maintScheduler.refreshAccountingAsync = vi
      .fn()
      .mockRejectedValue(new Error('I/O error during accounting'))

    const docPath = join(tempDir, 'fail-refresh.txt')
    writeFileSync(docPath, 'fail-refresh')
    store.remember(docPath)

    const reserveId = `extract:${docPath}`
    admission.reserve(reserveId, 'extract', 5000, initialUsage, budgetBytes, 60_000, {
      holdUntilJobEnds: true,
      ownerId: 'caller-owner-123',
    })

    await writeExtractedContentSliced({
      store,
      admission,
      maintScheduler: maintScheduler as any,
      budgetCoord: budgetCoord as any,
      dbDir: tempDir,
      path: docPath,
      ext: {
        hash: 'hash-fail',
        mtimeMs: Date.now(),
        sizeBytes: 500,
        chunks,
      },
      isCurrent: () => true,
    })

    // Scheduler was invalidated fail-closed
    expect(maintScheduler.invalidateAccounting).toHaveBeenCalled()
    // Lease remains charged with committed debt, preserving caller lease
    expect(admission.getReservedBytes()).toBeGreaterThan(0)
  })
})
