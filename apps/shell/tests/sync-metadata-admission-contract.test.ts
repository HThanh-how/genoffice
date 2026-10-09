import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/main/document-memory/storage/database'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DocumentRepository } from '../src/main/document-memory/storage/repositories/document-repository'
import {
  SyncMetadataAdmissionCoordinator,
  StandaloneSyncMetadataGuard,
  wireSyncMetadataAdmission,
  unwireSyncMetadataAdmission,
} from '../src/main/document-memory/runtime/sync-metadata-admission'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import {
  createStorageBudget,
  type StorageBudgetSnapshot,
} from '../src/main/document-memory/storage-budget'
import {
  estimateNewDocumentMetadataBytes,
  setNameProjectionSyncGuard,
  syncProjectionInsert,
  CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
  BASE_PROJECTION_METADATA_BYTES,
} from '../src/main/document-memory/name-search-projection'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFreshSnapshot(overrides: Partial<StorageBudgetSnapshot> = {}): StorageBudgetSnapshot {
  return {
    databaseBytes: 100_000,
    nameMetadataBytes: 0,
    budgetBytes: 1_000_000,
    usageRatio: 0.1,
    chunksBytes: 50_000,
    embeddingsBytes: 20_000,
    ftsBytes: 20_000,
    ocrBytes: 10_000,
    backupBytes: 0,
    reclaimableBytes: 0,
    limitState: 'ok',
    totalManagedBytes: 100_000,
    measurementStatus: 'fresh',
    isDegraded: false,
    ...overrides,
  }
}

describe('SyncMetadataAdmissionCoordinator & SQLite Repository Integration Contract', () => {
  let tempDirs: string[] = []

  function createTempDir(prefix = 'sync-meta-test-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    vi.useRealTimers()
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  // =========================================================================
  // Case 1: Accounting, disk, byte count validation & Vietnamese UTF-8 estimation
  // =========================================================================
  describe('Case 1: Admission rejection on missing/degraded accounting, stale disk, and invalid bytes; healthy admission with Vietnamese UTF-8', () => {
    it('rejects without reservation when accounting snapshot is missing, degraded, or stale', async () => {
      const admission = new StorageAdmissionController()
      let currentSnapshot: StorageBudgetSnapshot | null | undefined = null

      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => currentSnapshot ?? null,
        getStorageBudgetSnapshot: () => currentSnapshot,
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })

      // Allow eager free disk warmup microtask to resolve
      await Promise.resolve()
      await Promise.resolve()

      // 1. Snapshot missing (null)
      currentSnapshot = null
      const decNull = coordinator.canAdmitNewDocument(
        { name: 'doc1.docx', path: '/docs/doc1.docx' },
        2048,
      )
      expect(decNull.admitted).toBe(false)
      expect(decNull.reason).toBe('accounting-unknown')
      expect(admission.listReservations().length).toBe(0)
      expect(admission.getReservedBytes()).toBe(0)

      // 2. Snapshot undefined
      currentSnapshot = undefined
      const decUndef = coordinator.canAdmitNewDocument(
        { name: 'doc2.docx', path: '/docs/doc2.docx' },
        2048,
      )
      expect(decUndef.admitted).toBe(false)
      expect(decUndef.reason).toBe('accounting-unknown')
      expect(admission.listReservations().length).toBe(0)

      // 3. Degraded accounting
      currentSnapshot = createFreshSnapshot({ isDegraded: true })
      const decDegraded = coordinator.canAdmitNewDocument(
        { name: 'doc3.docx', path: '/docs/doc3.docx' },
        2048,
      )
      expect(decDegraded.admitted).toBe(false)
      expect(decDegraded.reason).toBe('accounting-unknown')
      expect(admission.listReservations().length).toBe(0)

      // 4. Stale measurement status
      currentSnapshot = createFreshSnapshot({ measurementStatus: 'stale' })
      const decStale = coordinator.canAdmitNewDocument(
        { name: 'doc4.docx', path: '/docs/doc4.docx' },
        2048,
      )
      expect(decStale.admitted).toBe(false)
      expect(decStale.reason).toBe('accounting-unknown')
      expect(admission.listReservations().length).toBe(0)

      coordinator.close()
    })

    it('rejects without reservation when free disk space is unknown or expired past TTL', async () => {
      vi.useFakeTimers()
      const admission = new StorageAdmissionController()

      // 1. Unknown disk space (getFreeDiskBytes returns null)
      const coordinatorUnknownDisk = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => null,
        freeDiskHeadroomBytes: 0,
      })
      await vi.advanceTimersByTimeAsync(1)

      const decUnknown = coordinatorUnknownDisk.canAdmitNewDocument(
        { name: 'nodisk.docx', path: '/docs/nodisk.docx' },
        2048,
      )
      expect(decUnknown.admitted).toBe(false)
      expect(decUnknown.reason).toBe('disk-space-insufficient')
      expect(admission.listReservations().length).toBe(0)
      coordinatorUnknownDisk.close()

      // 2. Nonzero disk headroom: proves cumulative reserved + new headroom deny, and cache TTL expiry
      let diskMockVal = 50_000_000
      const coordinatorTtl = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(20_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot({ budgetBytes: 20_000_000 }),
        getStorageBudgetSnapshot: () => createFreshSnapshot({ budgetBytes: 20_000_000 }),
        getFreeDiskBytes: async () => diskMockVal,
        freeDiskTtlMs: 500,
        freeDiskHeadroomBytes: 1_000_000,
      })
      await vi.advanceTimersByTimeAsync(1)

      // Fresh disk: admitted initially with nonzero headroom
      const decFresh = coordinatorTtl.canAdmitNewDocument(
        { name: 'fresh.docx', path: '/docs/fresh.docx' },
        2048,
      )
      expect(
        decFresh.admitted,
        `expected fresh disk admission to succeed but got ${decFresh.reason} (${decFresh.error})`,
      ).toBe(true)
      expect(admission.getReservedBytes()).toBe(2048)

      // Cumulative reserved + new headroom deny:
      // Available disk: 1_003_000 bytes.
      // With headroom 1_000_000 + existing reservation 2048 = 1_002_048 required before new doc.
      // Next doc of 2048 requires 1_000_000 + 2048 + 2048 = 1_004_096 > 1_003_000: MUST deny!
      diskMockVal = 1_003_000
      vi.advanceTimersByTime(600)
      const staleProbe = coordinatorTtl.canAdmitNewDocument(
        { name: 'stale-probe.docx', path: '/docs/stale-probe.docx' }, 2048,
      )
      expect(staleProbe.admitted).toBe(false)
      expect(staleProbe.reason).toBe('disk-space-insufficient')
      await vi.advanceTimersByTimeAsync(1)

      const decCumulative = coordinatorTtl.canAdmitNewDocument(
        { name: 'overflow.docx', path: '/docs/overflow.docx' },
        2048,
      )
      expect(decCumulative.admitted).toBe(false)
      expect(decCumulative.reason).toBe('disk-space-insufficient')
      expect(coordinatorTtl.getLastRejectionReason()).toContain('1004096')

      // Rollback initial reservation
      coordinatorTtl.rollbackCommit(decFresh.reservationId!, decFresh.ownerToken!)
      expect(admission.getReservedBytes()).toBe(0)

      // Advance time past TTL (600ms > 500ms)
      vi.advanceTimersByTime(600)

      // Now expired: must reject fail-closed without accepting expired cache
      const decExpired = coordinatorTtl.canAdmitNewDocument(
        { name: 'expired.docx', path: '/docs/expired.docx' },
        2048,
      )
      expect(decExpired.admitted).toBe(false)
      expect(decExpired.reason).toBe('disk-space-insufficient')
      expect(admission.listReservations().length).toBe(0)

      coordinatorTtl.close()
    })

    it('rejects with min-metadata-unfit without reservation when estimatedBytes is non-positive or non-safe integer', async () => {
      const admission = new StorageAdmissionController()
      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await Promise.resolve()

      const invalidValues = [0, -1, -5000, 1.5, NaN, Infinity, -Infinity]
      for (const val of invalidValues) {
        const dec = coordinator.canAdmitNewDocument(
          { name: 'doc.docx', path: '/docs/doc.docx' },
          val,
        )
        expect(dec.admitted).toBe(false)
        expect(dec.reason).toBe('min-metadata-unfit')
        expect(admission.listReservations().length).toBe(0)
      }

      coordinator.close()
    })

    it('admits new document with valid reservation when disk and accounting are fresh; handles multi-byte Vietnamese UTF-8 estimation', async () => {
      const admission = new StorageAdmissionController()
      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await Promise.resolve()

      const vnName = 'Báo cáo quyết toán dự án quý 1 năm 2026.docx'
      const vnPath = '/Users/huythanh/Tài liệu/Kế toán/Báo cáo quyết toán dự án quý 1 năm 2026.docx'

      const estBytes = estimateNewDocumentMetadataBytes(vnName, vnPath)
      expect(Number.isSafeInteger(estBytes)).toBe(true)
      expect(estBytes).toBeGreaterThanOrEqual(BASE_PROJECTION_METADATA_BYTES)

      // UTF-8 byte length for Vietnamese diacritics exceeds character length
      const utf8NameBytes = Buffer.byteLength(vnName, 'utf8')
      expect(utf8NameBytes).toBeGreaterThan(vnName.length)

      const decision = coordinator.canAdmitNewDocument({ name: vnName, path: vnPath }, estBytes)
      expect(
        decision.admitted,
        `expected Vietnamese doc admission to succeed but got ${decision.reason} (${decision.error})`,
      ).toBe(true)
      expect(decision.reason).toBe('ok')
      expect(decision.reservationId).toBe(`meta:${vnPath}`)
      expect(decision.ownerToken).toBeDefined()
      expect(decision.estimatedBytes).toBe(estBytes)

      // Real central admission controller holds exact reserved debt
      expect(admission.getReservedBytes()).toBe(estBytes)
      const centralLease = admission.listReservations().find((r) => r.id === decision.reservationId)
      expect(centralLease).toBeDefined()
      expect(centralLease?.bytes).toBe(estBytes)
      expect(centralLease?.ownerId).toBe(decision.ownerToken)

      // Rollback cleans up fully
      coordinator.rollbackCommit(decision.reservationId!, decision.ownerToken!)
      expect(admission.getReservedBytes()).toBe(0)
      expect(admission.listReservations().length).toBe(0)

      coordinator.close()
    })
  })

  // =========================================================================
  // Case 2: Inflight cap accumulation, DB isolation & token ownership
  // =========================================================================
  describe('Case 2: Inflight accumulation and cap blocking, per-DB guard isolation, and token-exact debt protection', () => {
    it('accumulates uncommitted reservations in activeOwned and blocks at maxInflight cap', async () => {
      const admission = new StorageAdmissionController()
      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        maxInflightReservations: 3,
        freeDiskHeadroomBytes: 0,
      })
      await Promise.resolve()

      // Uncommitted reservations accumulate towards maxInflight
      const dec1 = coordinator.canAdmitNewDocument({ name: 'd1.docx', path: '/docs/d1.docx' }, 1000)
      const dec2 = coordinator.canAdmitNewDocument({ name: 'd2.docx', path: '/docs/d2.docx' }, 1000)
      const dec3 = coordinator.canAdmitNewDocument({ name: 'd3.docx', path: '/docs/d3.docx' }, 1000)

      expect(dec1.admitted, `dec1 rejected: ${dec1.reason} (${dec1.error})`).toBe(true)
      expect(dec2.admitted, `dec2 rejected: ${dec2.reason} (${dec2.error})`).toBe(true)
      expect(dec3.admitted, `dec3 rejected: ${dec3.reason} (${dec3.error})`).toBe(true)
      expect(admission.getReservedBytes()).toBe(3000)

      // 4th uncommitted reservation hits maxInflight cap
      const dec4 = coordinator.canAdmitNewDocument({ name: 'd4.docx', path: '/docs/d4.docx' }, 1000)
      expect(dec4.admitted).toBe(false)
      expect(dec4.reason).toBe('reservation-exceeded')
      expect(coordinator.getLastRejectionReason()).toContain('Inflight sync metadata reservations bounded limit reached (3/3)')
      expect(admission.getReservedBytes()).toBe(3000)

      // Rolling back one uncommitted entry allows next admission
      coordinator.rollbackCommit(dec1.reservationId!, dec1.ownerToken!)
      expect(admission.getReservedBytes()).toBe(2000)

      const decRetry = coordinator.canAdmitNewDocument({ name: 'd4.docx', path: '/docs/d4.docx' }, 1000)
      expect(decRetry.admitted, `decRetry rejected: ${decRetry.reason} (${decRetry.error})`).toBe(true)
      expect(admission.getReservedBytes()).toBe(3000)

      coordinator.close()
    })

    it('isolates guards per-database handle and never falls back to deprecated global guard on unguarded second DB', () => {
      const dir1 = createTempDir('db-iso-1-')
      const dir2 = createTempDir('db-iso-2-')
      const db1 = openDatabase(join(dir1, 'doc-mem-1.db'))
      const db2 = openDatabase(join(dir2, 'doc-mem-2.db'))

      try {
        const denyGuard = new StandaloneSyncMetadataGuard('deny')
        // Wire deny guard to DB1
        wireSyncMetadataAdmission(db1, denyGuard)

        // Set deprecated global guard to deny as well, testing that DB2 does NOT fall back to it
        setNameProjectionSyncGuard(denyGuard)

        // DB1 has guard wired: denied
        const res1 = syncProjectionInsert(db1, { id: 101, path: '/db1/file.docx', name: 'file.docx' })
        expect(res1).toBe(false)

        // DB2 is unguarded: must succeed and NOT be blocked by DB1's guard or deprecated global guard
        const res2 = syncProjectionInsert(db2, { id: 202, path: '/db2/file.docx', name: 'file.docx' })
        expect(res2).toBe(true)

        // Verify SQLite table state in DB2 has the row, DB1 does not
        const row2 = db2
          .prepare('SELECT document_id FROM document_name_projection WHERE document_id = ?')
          .get(202)
        expect(row2).toBeDefined()

        const row1 = db1
          .prepare('SELECT document_id FROM document_name_projection WHERE document_id = ?')
          .get(101)
        expect(row1).toBeUndefined()
      } finally {
        setNameProjectionSyncGuard(null)
        unwireSyncMetadataAdmission(db1)
        db1.close()
        db2.close()
      }
    })

    it('ignores settleCommit and rollbackCommit with missing or mismatched owner token, preserving rightful debt', async () => {
      const admission = new StorageAdmissionController()
      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await Promise.resolve()

      const dec = coordinator.canAdmitNewDocument({ name: 'safe.docx', path: '/docs/safe.docx' }, 4000)
      expect(dec.admitted, `dec rejected: ${dec.reason} (${dec.error})`).toBe(true)
      expect(admission.getReservedBytes()).toBe(4000)

      // 1. Rollback with wrong owner token: debt untouched
      coordinator.rollbackCommit(dec.reservationId!, 'wrong_token_xyz')
      expect(admission.getReservedBytes()).toBe(4000)
      expect(admission.listReservations().length).toBe(1)

      // 2. Rollback with missing token: debt untouched
      coordinator.rollbackCommit(dec.reservationId!, undefined)
      expect(admission.getReservedBytes()).toBe(4000)

      // 3. Settle with wrong owner token: debt untouched
      coordinator.settleCommit(dec.reservationId!, 'wrong_token_xyz')
      expect(admission.getReservedBytes()).toBe(4000)

      // 4. Settle with missing token: debt untouched
      coordinator.settleCommit(dec.reservationId!, undefined)
      expect(admission.getReservedBytes()).toBe(4000)

      // 5. Rollback with exact matching owner token: rightfully released
      coordinator.rollbackCommit(dec.reservationId!, dec.ownerToken!)
      expect(admission.getReservedBytes()).toBe(0)
      expect(admission.listReservations().length).toBe(0)

      coordinator.close()
    })

    it('canWriteProjection re-verifies central reservation owner and rejects hijacked or expired leases', async () => {
      const admission = new StorageAdmissionController()
      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await Promise.resolve()

      const dec = coordinator.canAdmitNewDocument({ name: 'proj.docx', path: '/docs/proj.docx' }, 1500)
      expect(dec.admitted, `dec rejected: ${dec.reason} (${dec.error})`).toBe(true)

      // With exact central lease intact: projection write admitted
      const canWriteBefore = coordinator.canWriteProjection(
        { id: 1, name: 'proj.docx', path: '/docs/proj.docx' },
        1500,
      )
      expect(canWriteBefore, 'expected canWriteProjection before hijack to be true').toBe(true)

      // Hijack central reservation with a different ownerId in central admission controller
      admission.release(dec.reservationId!)
      admission.reserve(
        dec.reservationId!,
        'lexical',
        1500,
        100_000,
        1_000_000,
        60_000,
        { ownerId: 'hijacked_foreign_token' },
      )

      // canWriteProjection re-checks central lease owner against activeOwned: mismatch evicts and rejects
      const canWriteAfter = coordinator.canWriteProjection(
        { id: 1, name: 'proj.docx', path: '/docs/proj.docx' },
        1500,
      )
      expect(canWriteAfter).toBe(false)

      coordinator.close()
    })
  })

  // =========================================================================
  // Case 3: Concurrent commits during deferred measurement & two-phase settlement
  // =========================================================================
  describe('Case 3: Concurrent commit during deferred accounting measurement, two-phase settlement, and close safety', () => {
    it('settles only covered snapshot when commit B occurs during measurement of commit A, retaining B until second settle', async () => {
      vi.useFakeTimers()
      const admission = new StorageAdmissionController()

      const deferredQueue: Deferred<StorageBudgetSnapshot | null>[] = []
      let measurementCalls = 0
      let inFlightMeasurements = 0
      let maxConcurrent = 0

      const refreshAccountingAsync = vi.fn().mockImplementation(() => {
        measurementCalls++
        inFlightMeasurements++
        if (inFlightMeasurements > maxConcurrent) maxConcurrent = inFlightMeasurements
        const d = createDeferred<StorageBudgetSnapshot | null>()
        deferredQueue.push(d)
        d.promise.finally(() => {
          inFlightMeasurements--
        })
        return d.promise
      })

      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync,
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })

      // Free disk warm-up
      await vi.advanceTimersByTimeAsync(1)

      // 1. Admit and commit A
      const decA = coordinator.canAdmitNewDocument({ name: 'A.docx', path: '/docs/A.docx' }, 1000)
      expect(decA.admitted, `decA rejected: ${decA.reason} (${decA.error})`).toBe(true)
      expect(admission.getReservedBytes()).toBe(1000)

      coordinator.settleCommit(decA.reservationId!, decA.ownerToken!)

      // 50ms timer triggers first measurement settle
      await vi.advanceTimersByTimeAsync(50)
      expect(measurementCalls).toBe(1)
      expect(deferredQueue.length).toBe(1)

      // 2. While measurement 1 is awaiting, admit and commit B
      const decB = coordinator.canAdmitNewDocument({ name: 'B.docx', path: '/docs/B.docx' }, 2000)
      expect(decB.admitted, `decB rejected: ${decB.reason} (${decB.error})`).toBe(true)
      expect(admission.getReservedBytes()).toBe(3000) // A(1000) + B(2000)

      coordinator.settleCommit(decB.reservationId!, decB.ownerToken!)

      // Advance timers: must NOT start overlapping measurement while one is in-flight
      await vi.advanceTimersByTimeAsync(100)
      expect(measurementCalls).toBe(1)
      expect(maxConcurrent).toBe(1)

      // 3. Resolve measurement 1 with fresh snapshot
      deferredQueue[0]!.resolve(createFreshSnapshot({ databaseBytes: 150_000 }))
      await Promise.resolve()
      await Promise.resolve()

      // A is released; B is RETAINED because it was not in snapshotToSettle!
      expect(admission.listReservations().find((r) => r.id === decA.reservationId)).toBeUndefined()
      const bLease = admission.listReservations().find((r) => r.id === decB.reservationId)
      expect(bLease).toBeDefined()
      expect(bLease?.bytes).toBe(2000)
      expect(admission.getReservedBytes()).toBe(2000)

      // 4. Second measurement triggers automatically for B via scheduled refresh
      await vi.advanceTimersByTimeAsync(50)
      expect(measurementCalls).toBe(2)
      expect(deferredQueue.length).toBe(2)

      // Resolve second measurement
      deferredQueue[1]!.resolve(createFreshSnapshot({ databaseBytes: 152_000 }))
      await Promise.resolve()
      await Promise.resolve()

      // B is now released; all debts clear
      expect(admission.getReservedBytes()).toBe(0)
      expect(admission.listReservations().length).toBe(0)

      coordinator.close()
    })

    it('prevents late close from restarting timers or releasing replacement owner reservations', async () => {
      vi.useFakeTimers()
      const admission = new StorageAdmissionController()

      let lingeringMeasurement: Deferred<StorageBudgetSnapshot | null> | null = null
      const refreshAccountingAsync = vi.fn().mockImplementation(() => {
        lingeringMeasurement = createDeferred<StorageBudgetSnapshot | null>()
        return lingeringMeasurement.promise
      })

      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync,
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await vi.advanceTimersByTimeAsync(1)

      const decC = coordinator.canAdmitNewDocument({ name: 'C.docx', path: '/docs/C.docx' }, 1500)
      expect(decC.admitted, `decC rejected: ${decC.reason} (${decC.error})`).toBe(true)
      coordinator.settleCommit(decC.reservationId!, decC.ownerToken!)

      // Start measurement settle
      await vi.advanceTimersByTimeAsync(50)
      expect(lingeringMeasurement).not.toBeNull()

      // Close coordinator while measurement is still pending
      coordinator.close()
      expect(admission.getReservedBytes()).toBe(0)

      // Another task creates a replacement reservation on the same ID
      const repDecision = admission.reserve(
        decC.reservationId!,
        'lexical',
        1500,
        100_000,
        1_000_000,
        60_000,
        { ownerId: 'replacement_token_456' },
      )
      expect(repDecision.admitted, `repDecision rejected: ${repDecision.reason} (${repDecision.error})`).toBe(true)
      expect(admission.getReservedBytes()).toBe(1500)

      // Lingering measurement finally resolves late
      lingeringMeasurement!.resolve(createFreshSnapshot())
      await Promise.resolve()
      await Promise.resolve()

      // Replacement reservation must NOT have been released by the late callback!
      expect(admission.getReservedBytes()).toBe(1500)
      const cur = admission.listReservations().find((r) => r.id === decC.reservationId)
      expect(cur?.ownerId).toBe('replacement_token_456')

      // Subsequent calls on closed coordinator remain rejected
      const decAfter = coordinator.canAdmitNewDocument({ name: 'D.docx', path: '/docs/D.docx' }, 1000)
      expect(decAfter.admitted).toBe(false)
      expect(decAfter.reason).toBe('stopped')
    })
  })

  // =========================================================================
  // Case 4: Failed/degraded measurement retains committed debt & fail-close retries
  // =========================================================================
  describe('Case 4: Failed/degraded measurement retains committed debt and failcloses next admission; bounded retries do not loop indefinitely', () => {
    it('retains committed debt and sets lastAccountingFailed when measurement throws or returns degraded snapshot', async () => {
      vi.useFakeTimers()
      const admission = new StorageAdmissionController()

      const throwError = true
      const returnNull = false
      const returnDegraded = false

      const refreshAccountingAsync = vi.fn().mockImplementation(async () => {
        if (throwError) throw new Error('Simulated I/O disk error')
        if (returnNull) return null
        if (returnDegraded) return createFreshSnapshot({ isDegraded: true })
        return createFreshSnapshot()
      })

      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync,
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await vi.advanceTimersByTimeAsync(1)

      // 1. Thrown measurement
      const decE = coordinator.canAdmitNewDocument({ name: 'E.docx', path: '/docs/E.docx' }, 3000)
      expect(decE.admitted, `decE rejected: ${decE.reason} (${decE.error})`).toBe(true)
      expect(admission.getReservedBytes()).toBe(3000)

      coordinator.settleCommit(decE.reservationId!, decE.ownerToken!)
      await vi.advanceTimersByTimeAsync(50)

      // Debt retained on error!
      expect(admission.getReservedBytes()).toBe(3000)
      expect(admission.listReservations().length).toBe(1)
      expect(coordinator.isReady()).toBe(false)

      // Next admission fails closed with accounting-unknown
      const decNext = coordinator.canAdmitNewDocument({ name: 'F.docx', path: '/docs/F.docx' }, 1000)
      expect(decNext.admitted).toBe(false)
      expect(decNext.reason).toBe('accounting-unknown')

      coordinator.close()
    })

    it('bounds settlement retries to MAX_SETTLE_RETRIES (3) and halts timer loop without indefinite spinning', async () => {
      vi.useFakeTimers()
      const admission = new StorageAdmissionController()

      const refreshAccountingAsync = vi.fn().mockRejectedValue(new Error('Persistent disk corruption'))

      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync,
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await vi.advanceTimersByTimeAsync(1)

      const dec = coordinator.canAdmitNewDocument({ name: 'retry.docx', path: '/docs/retry.docx' }, 2000)
      expect(dec.admitted, `dec rejected: ${dec.reason} (${dec.error})`).toBe(true)
      coordinator.settleCommit(dec.reservationId!, dec.ownerToken!)

      // Initial settle fires at 50ms: call 1
      await vi.advanceTimersByTimeAsync(50)
      expect(refreshAccountingAsync).toHaveBeenCalledTimes(1)

      // Retry 1 fires after backoff 50 * 2^1 = 100ms: call 2
      await vi.advanceTimersByTimeAsync(100)
      expect(refreshAccountingAsync).toHaveBeenCalledTimes(2)

      // Retry 2 fires after backoff 50 * 2^2 = 200ms: call 3
      await vi.advanceTimersByTimeAsync(200)
      expect(refreshAccountingAsync).toHaveBeenCalledTimes(3)

      // Retry 3 fires after backoff 50 * 2^3 = 400ms: call 4
      await vi.advanceTimersByTimeAsync(400)
      expect(refreshAccountingAsync).toHaveBeenCalledTimes(4)

      // Retries are now exhausted (MAX_SETTLE_RETRIES = 3). Advance further: NO more calls!
      await vi.advanceTimersByTimeAsync(10_000)
      expect(refreshAccountingAsync).toHaveBeenCalledTimes(4)

      // Committed debt is still safely retained fail-closed
      expect(admission.getReservedBytes()).toBe(2000)
      expect(admission.listReservations().length).toBe(1)

      coordinator.close()
    })
  })

  // =========================================================================
  // Case 5: Real SQLite / DocumentMemoryStore integration contracts
  // =========================================================================
  describe('Case 5: Real SQLite / DocumentMemoryStore integration: rejection cleanliness, SAVEPOINT safety, denied move, and projection updates', () => {
    it('leaves neither document rows nor projection rows when a new file admission is denied', () => {
      const dir = createTempDir('sqlite-deny-')
      const dbPath = join(dir, 'test.db')
      const db = openDatabase(dbPath)

      try {
        const denyGuard = new StandaloneSyncMetadataGuard('deny')
        const repo = new DocumentRepository(
          db,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          denyGuard,
        )

        const deniedFile1 = join(dir, 'denied1.docx')
        const deniedFile2 = join(dir, 'denied2.docx')

        const resEnsure = repo.ensureDocument(deniedFile1)
        expect(resEnsure).toBe(false)

        const resRemember = repo.remember(deniedFile2)
        expect(resRemember).toBe(false)

        // Verify SQLite tables: absolutely neither documents nor projection rows created
        const docCount = (
          db.prepare('SELECT count(*) as c FROM documents WHERE path IN (?, ?)').get(
            deniedFile1,
            deniedFile2,
          ) as { c: number }
        ).c
        expect(docCount).toBe(0)

        const projCount = (
          db
            .prepare(
              'SELECT count(*) as c FROM document_name_projection WHERE path_norm IN (?, ?)',
            )
            .get(deniedFile1, deniedFile2) as { c: number }
        ).c
        expect(projCount).toBe(0)
      } finally {
        db.close()
      }
    })

    it('cleanly releases SAVEPOINT ensure_doc on denial, allowing immediate subsequent transactions without error', () => {
      const dir = createTempDir('sqlite-savepoint-')
      const dbPath = join(dir, 'test.db')
      const db = openDatabase(dbPath)

      try {
        const denyGuard = new StandaloneSyncMetadataGuard('deny')
        const repoDenied = new DocumentRepository(
          db,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          denyGuard,
        )

        const deniedFile = join(dir, 'denied_sp.docx')
        const res = repoDenied.ensureDocument(deniedFile)
        expect(res).toBe(false)

        // SAVEPOINT ensure_doc was rolled back AND released cleanly.
        // Immediate independent transactions/savepoints must execute without savepoint stack errors:
        db.exec('SAVEPOINT independent_sp;')
        db.prepare('INSERT INTO documents(path, name, status) VALUES (?, ?, ?)').run(
          'indep.txt',
          'indep.txt',
          'pending',
        )
        db.exec('RELEASE independent_sp;')
        const row = db.prepare('SELECT id FROM documents WHERE path = ?').get('indep.txt')
        expect(row).toBeDefined()

        // Subsequent ensureDocument with an allowing guard succeeds cleanly
        const allowGuard = new StandaloneSyncMetadataGuard('allow')
        const repoAllowed = new DocumentRepository(
          db,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          allowGuard,
        )
        const allowedFile = join(dir, 'allowed_sp.docx')
        const resAllowed = repoAllowed.ensureDocument(allowedFile)
        expect(resAllowed).toBe(true)

        const allowedRow = db.prepare('SELECT id FROM documents WHERE path = ?').get(allowedFile)
        expect(allowedRow).toBeDefined()
      } finally {
        db.close()
      }
    })

    it('preserves existing document path, projection, and disk file on denied move, keeping old name searchable', async () => {
      const dir = createTempDir('sqlite-move-')
      const dbPath = join(dir, 'test.db')
      const admission = new StorageAdmissionController()

      let allowWrites = true
      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => allowWrites,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await Promise.resolve()

      const store = new DocumentMemoryStore(dbPath, { syncAdmission: coordinator })

      try {
        const origPath = join(dir, 'budget_report.docx')
        const newPath = join(dir, 'renamed_report.docx')
        writeFileSync(origPath, 'Quarterly budget report data')

        // 1. Initial document remember succeeds
        const remembered = store.remember(origPath)
        expect(
          remembered,
          `store.remember rejected: ${coordinator.getLastRejectionReason()}`,
        ).toBe(true)

        // Search finds original document
        const hitsBefore = store.searchNames('budget_report')
        expect(hitsBefore.length).toBeGreaterThan(0)
        expect(hitsBefore[0]?.path).toBe(origPath)

        // 2. Deny subsequent writes (e.g. quota exhausted / coordinator not ready)
        allowWrites = false

        // Attempt move: must throw admission error without double rollback
        expect(() => store.move(origPath, newPath)).toThrow()

        // 3. Verify original FS file is completely unchanged
        expect(existsSync(origPath)).toBe(true)
        expect(existsSync(newPath)).toBe(false)

        // 4. Verify SQLite documents table still holds original path and name
        const docRow = store.rawDb
          .prepare('SELECT path, name FROM documents WHERE path = ?')
          .get(origPath) as { path: string; name: string } | undefined
        expect(docRow).toBeDefined()
        expect(docRow?.name).toBe('budget_report.docx')

        const movedDocRow = store.rawDb
          .prepare('SELECT id FROM documents WHERE path = ?')
          .get(newPath)
        expect(movedDocRow).toBeUndefined()

        // 5. Existing valid filename remains searchable at full budget
        const hitsAfter = store.searchNames('budget_report')
        expect(hitsAfter.length).toBeGreaterThan(0)
        expect(hitsAfter[0]?.path).toBe(origPath)
      } finally {
        store.close()
        coordinator.close()
      }
    })

    it('acquires debt for existing document with missing or stale projection and settles upon successful commit', async () => {
      vi.useFakeTimers()
      const dir = createTempDir('sqlite-stale-proj-')
      const dbPath = join(dir, 'test.db')
      const db = openDatabase(dbPath)
      const admission = new StorageAdmissionController()

      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })
      await vi.advanceTimersByTimeAsync(1)

      try {
        const repo = new DocumentRepository(
          db,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          coordinator,
        )

        // 1. Insert raw document directly into documents table without projection row
        const unprojPath = join(dir, 'unprojected.docx')
        db.prepare(
          `INSERT INTO documents(path, name, status, chunk_counted) VALUES (?, 'unprojected.docx', 'pending', 1)`,
        ).run(unprojPath)
        const docRow = db.prepare('SELECT id FROM documents WHERE path = ?').get(unprojPath) as {
          id: number
        }

        const projBefore = db
          .prepare('SELECT document_id FROM document_name_projection WHERE document_id = ?')
          .get(docRow.id)
        expect(projBefore).toBeUndefined()
        expect(admission.getReservedBytes()).toBe(0)

        // 2. repo.remember identifies missing/stale projection, acquires debt, and writes projection
        const res = repo.remember(unprojPath)
        expect(
          res,
          `repo.remember rejected: ${repo.getLastAdmissionError() ?? coordinator.getLastRejectionReason()}`,
        ).toBe(true)

        // Projection debt acquired and committed
        expect(admission.getReservedBytes()).toBeGreaterThan(0)

        // Projection row is now populated with current algorithm version
        const projAfter = db
          .prepare(
            'SELECT document_id, row_version FROM document_name_projection WHERE document_id = ?',
          )
          .get(docRow.id) as { document_id: number; row_version: number } | undefined
        expect(projAfter).toBeDefined()
        expect(projAfter?.row_version).toBe(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION)

        // 3. 50ms timer triggers accounting settlement and clears debt
        await vi.advanceTimersByTimeAsync(50)
        expect(admission.getReservedBytes()).toBe(0)
      } finally {
        db.close()
        coordinator.close()
      }
    })

    it('rolls back document row, projection, and admission lease when SQL failure is injected during mutation', async () => {
      vi.useFakeTimers()
      const dir = createTempDir('sqlite-inject-fault-')
      const dbPath = join(dir, 'test.db')
      const db = openDatabase(dbPath)
      const admission = new StorageAdmissionController()

      const coordinator = new SyncMetadataAdmissionCoordinator({
        admission,
        getStorageBudget: () => createStorageBudget(1_000_000),
        isWriteReady: () => true,
        refreshAccountingAsync: async () => createFreshSnapshot(),
        getStorageBudgetSnapshot: () => createFreshSnapshot(),
        getFreeDiskBytes: async () => 100_000_000,
        freeDiskHeadroomBytes: 0,
      })

      try {
        const repo = new DocumentRepository(
          db,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          coordinator,
        )

        // 1. Initial healthy document setup creates real row & projection before fault injection
        await Promise.resolve()
        await Promise.resolve()
        const healthyPath = join(dir, 'healthy.docx')
        const healthyRes = repo.remember(healthyPath)
        expect(
          healthyRes,
          `healthy remember rejected: ${repo.getLastAdmissionError() ?? coordinator.getLastRejectionReason()}`,
        ).toBe(true)
        const healthyDoc = db.prepare('SELECT id FROM documents WHERE path = ?').get(healthyPath) as { id: number } | undefined
        expect(healthyDoc).toBeDefined()
        const healthyProj = db
          .prepare('SELECT document_id FROM document_name_projection WHERE document_id = ?')
          .get(healthyDoc!.id)
        expect(healthyProj).toBeDefined()
        await vi.advanceTimersByTimeAsync(50)
        expect(admission.getReservedBytes()).toBe(0)

        // 2. Inject SQL abort trigger on projection table
        db.exec(
          `CREATE TRIGGER fail_proj_trigger BEFORE INSERT ON document_name_projection
           BEGIN
             SELECT RAISE(ABORT, 'injected projection SQL failure');
           END;`,
        )

        const failPath = join(dir, 'will_fail.docx')
        expect(() => repo.remember(failPath)).toThrow(/injected projection SQL failure/)

        // 3. Transaction rolled back: documents row does NOT exist for failed document
        const docCount = (
          db.prepare('SELECT count(*) as c FROM documents WHERE path = ?').get(failPath) as {
            c: number
          }
        ).c
        expect(docCount).toBe(0)

        // 4. Projection row does NOT exist for failed document
        const projCount = (
          db
            .prepare('SELECT count(*) as c FROM document_name_projection')
            .get() as { c: number }
        ).c
        expect(projCount).toBe(1) // Only the healthy projection remains; no failed or orphan row.

        // 5. Admission lease rolled back cleanly: debt is 0
        expect(admission.getReservedBytes()).toBe(0)
        expect(admission.listReservations().length).toBe(0)
      } finally {
        db.close()
        coordinator.close()
      }
    })
  })
})
