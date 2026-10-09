import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as fsPromises from 'node:fs/promises'

type FsPromisesModule = typeof import('node:fs/promises')

const fsMockState = vi.hoisted(() => ({
  actualStat: undefined as FsPromisesModule['stat'] | undefined,
  actualStatfs: undefined as FsPromisesModule['statfs'] | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<FsPromisesModule>()
  fsMockState.actualStat = actual.stat
  fsMockState.actualStatfs = actual.statfs
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    statfs: vi.fn(actual.statfs),
  }
})

import { DocumentMemoryStore } from '../src/main/document-memory/store'
import type { OcrDocRow, OcrFileMeta, OcrPageText } from '../src/main/document-memory/ocr-sidecar'
import {
  persistOcrPagesGated,
  executeOcrRenderGated,
  validateBoundedRenderCount,
  safeReleaseOcrLease,
  sanitizeOcrPages,
  MAX_SINGLE_PAGE_TEXT_CHARS,
  MAX_BOUNDED_RENDER_PAGES,
  type PersistOcrPagesParams,
  type OcrSavePagesResult,
} from '../src/main/document-memory/runtime/ocr-write-budget'
import {
  StorageAdmissionController,
  safeReleaseExactOwnerReservation,
} from '../src/main/document-memory/runtime/storage-admission'
import {
  safeReleaseExactOwnerLease,
} from '../src/main/document-memory/runtime/post-write-accounting'
import { createOcrHost } from '../src/main/document-memory/ocr-host'
import {
  AgyOcrJob,
  type OcrJobHost,
  type OcrJobDeps,
} from '../src/main/document-memory/agy-ocr-job'
import { OcrStateStore, type OcrStateFs } from '../src/main/document-memory/agy-ocr-state'
import type { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import type { StorageBudgetCoordinator } from '../src/main/document-memory/runtime/storage-budget-coordinator'
import {
  createStorageBudgetSnapshot,
} from '../src/main/document-memory/storage-budget'
import { DEFAULT_AGY_OCR_SETTINGS, type AgyOcrSettings } from '../src/shared/fork/agy-ocr'

// ---- Test Helpers --------------------------------------------------------------------------

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class MemoryOcrStateFs implements OcrStateFs {
  private readonly files = new Map<string, string>()
  read(path: string): string | undefined {
    return this.files.get(path)
  }
  write(path: string, text: string): void {
    this.files.set(path, text)
  }
}

class TestOcrJobHost implements OcrJobHost {
  files = new Map<
    string,
    { id: number; total: number; mtimeMs: number; sizeBytes: number }
  >()
  reindexed: string[] = []
  saved: Array<{ path: string; pages: readonly OcrPageText[] }> = []
  savePagesFn?: (
    path: string,
    meta: OcrFileMeta,
    pages: readonly OcrPageText[],
  ) => Promise<OcrSavePagesResult | void> | OcrSavePagesResult | void

  addFile(path: string, id: number, total = 1): void {
    this.files.set(path, { id, total, mtimeMs: 1000, sizeBytes: 5000 })
  }
  isEnabled(): boolean {
    return true
  }
  candidates(maxPagesPerFile = 1000): OcrDocRow[] {
    const list: OcrDocRow[] = []
    for (const [path, f] of this.files.entries()) {
      const done = this.pagesDone(path).length
      if (f.total !== undefined && Math.min(f.total, maxPagesPerFile) - done <= 0) continue
      list.push({
        id: f.id,
        path,
        sizeBytes: f.sizeBytes,
        mtimeMs: f.mtimeMs,
        lastOpenedAt: 0,
        pagesDone: done,
        totalPages: f.total,
      })
    }
    return list
  }
  documentById(id: number): { id: number; path: string } | null {
    for (const [path, f] of this.files.entries()) {
      if (f.id === id) return { id, path }
    }
    return null
  }
  pagesDone(_path?: string, _mtimeMs?: number, _sizeBytes?: number): number[] {
    return []
  }
  async render(path: string): Promise<any> {
    const f = this.files.get(path)
    if (!f) return null
    return {
      ok: true,
      hash: `hash-${path}`,
      mtimeMs: f.mtimeMs,
      sizeBytes: f.sizeBytes,
      totalPages: f.total,
      pages: [
        {
          page: 1,
          jpeg: new Uint8Array([1]),
          width: 10,
          height: 10,
          source: 'rendered',
        },
      ],
    }
  }
  async savePages(
    path: string,
    meta: OcrFileMeta,
    pages: readonly OcrPageText[],
  ): Promise<OcrSavePagesResult | void> {
    if (this.savePagesFn) {
      return this.savePagesFn(path, meta, pages)
    }
    this.saved.push({ path, pages })
    return { ok: true, savedCount: pages.length }
  }
  reindex(path: string): void {
    this.reindexed.push(path)
  }
}

describe('OCR Persistence & Terminal Admission Contract', () => {
  let tempDir: string
  let dbPath: string
  let store: DocumentMemoryStore
  let sourcePath: string
  let sourceContent: Buffer
  let sourceMeta: OcrFileMeta

  beforeEach(() => {
    if (fsMockState.actualStat) {
      vi.mocked(fsPromises.stat).mockReset()
      vi.mocked(fsPromises.stat).mockImplementation(fsMockState.actualStat)
    }
    if (fsMockState.actualStatfs) {
      vi.mocked(fsPromises.statfs).mockReset()
      vi.mocked(fsPromises.statfs).mockImplementation(fsMockState.actualStatfs)
    }

    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-ocr-admission-'))
    dbPath = join(tempDir, 'memory.sqlite')
    store = new DocumentMemoryStore(dbPath)

    sourcePath = join(tempDir, 'sample-scanned.pdf')
    sourceContent = Buffer.from(
      '%PDF-1.4\n%scanned-vietnamese-source-document\n%%EOF',
    )
    writeFileSync(sourcePath, sourceContent)
    const st = statSync(sourcePath)

    sourceMeta = {
      hash: createHash('sha256').update(sourceContent).digest('hex'),
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      totalPages: 2,
      model: 'gemini-1.5-flash',
    }
  })

  afterEach(() => {
    try {
      store.close()
    } catch {
      // already closed
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // already removed
    }
    vi.restoreAllMocks()
    if (fsMockState.actualStat) {
      vi.mocked(fsPromises.stat).mockReset()
      vi.mocked(fsPromises.stat).mockImplementation(fsMockState.actualStat)
    }
    if (fsMockState.actualStatfs) {
      vi.mocked(fsPromises.statfs).mockReset()
      vi.mocked(fsPromises.statfs).mockImplementation(fsMockState.actualStatfs)
    }
  })

  // ==========================================================================================
  // Case 1: Real temp source file + actual SQLite OcrSidecar/store
  // ==========================================================================================
  it('CASE-1: real temp source file + actual SQLite store persists Vietnamese OCR pages with fresh post-write accounting before lease release', async () => {
    const vietnamesePages: OcrPageText[] = [
      {
        page: 1,
        text: 'Cộng hòa Xã hội Chủ nghĩa Việt Nam - Độc lập Tự do Hạnh phúc',
      },
      {
        page: 2,
        text: 'Bản trích xuất văn bản tiếng Việt có dấu với độ trung thực cao.',
      },
    ]

    const admission = new StorageAdmissionController()
    const budgetCoord = {
      isWriteReady: vi.fn().mockReturnValue(true),
    } as unknown as StorageBudgetCoordinator

    let accountingCalls = 0
    let reservationActiveDuringPostWriteMeasurement = false
    let recordedReservationId = ''

    const maintScheduler = {
      refreshAccountingAsync: vi.fn().mockImplementation(async () => {
        accountingCalls++
        if (accountingCalls >= 2) {
          // Second call: executePostWriteAccounting runs inside finally block
          const ocrReservations = admission
            .listReservations()
            .filter((r) => r.type === 'ocr')
          if (ocrReservations.length > 0 && ocrReservations[0]?.ownerId) {
            reservationActiveDuringPostWriteMeasurement = true
            recordedReservationId = ocrReservations[0].id
          }
        }
        return createStorageBudgetSnapshot({
          activeDbSizeBytes: 10_000,
          budgetBytes: 100_000_000,
          measurementStatus: 'fresh',
          isDegraded: false,
        })
      }),
      budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
      invalidateAccounting: vi.fn(),
    } as unknown as MaintenanceScheduler

    const params: PersistOcrPagesParams = {
      store,
      admission,
      maintScheduler,
      budgetCoord,
      dbDir: tempDir,
      path: sourcePath,
      meta: sourceMeta,
      pages: vietnamesePages,
    }

    const result = await persistOcrPagesGated(params)

    // 1. Result ok with saved count
    expect(result.ok).toBe(true)
    expect(result.savedCount).toBe(2)

    // 2. Data actually written and readable from SQLite OcrSidecar
    const stored = store.ocr.pages(sourcePath, sourceMeta.hash)
    expect(stored).not.toBeNull()
    expect(stored!.pages).toEqual(vietnamesePages)
    expect(stored!.pages[0]!.text).toBe(vietnamesePages[0]!.text)
    expect(stored!.pages[1]!.text).toBe(vietnamesePages[1]!.text)
    expect(
      store.ocr.pagesDone(
        sourcePath,
        sourceMeta.mtimeMs,
        sourceMeta.sizeBytes,
      ),
    ).toEqual([1, 2])

    // 3. Post-write accounting happened BEFORE lease was released
    expect(accountingCalls).toBe(2)
    expect(reservationActiveDuringPostWriteMeasurement).toBe(true)
    expect(recordedReservationId).toMatch(/^ocr-save:/)

    // 4. Own lease released cleanly after accounting
    expect(admission.listReservations()).toHaveLength(0)

    // 5. Original source file remains untouched
    const currentStat = statSync(sourcePath)
    expect(currentStat.mtimeMs).toBe(sourceMeta.mtimeMs)
    expect(currentStat.size).toBe(sourceMeta.sizeBytes)
    expect(readFileSync(sourcePath)).toEqual(sourceContent)
  })

  // ==========================================================================================
  // Case 2: Full budget / degraded measurement / unknown disk denies
  // ==========================================================================================
  describe('CASE-2: Admission, degraded accounting and disk denies protect existing rows', () => {
    const existingPages: OcrPageText[] = [
      { page: 1, text: 'Trang 1 dữ liệu gốc được bảo tồn nguyên vẹn' },
    ]

    beforeEach(() => {
      // Pre-seed database with existing page row
      store.ocr.savePages(sourcePath, sourceMeta, existingPages)
      const seeded = store.ocr.pages(sourcePath, sourceMeta.hash)
      expect(seeded?.pages).toEqual(existingPages)
    })

    it('denies on full budget and leaves existing rows untouched', async () => {
      const admission = new StorageAdmissionController()
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator

      // Configure snapshot where databaseBytes = budgetBytes (100% full quota)
      const maintScheduler = {
        refreshAccountingAsync: vi.fn().mockResolvedValue(
          createStorageBudgetSnapshot({
            activeDbSizeBytes: 10_000,
            budgetBytes: 10_000,
            totalManagedBytes: 10_000,
            measurementStatus: 'fresh',
            isDegraded: false,
          }),
        ),
        budget: { maxDatabaseBytes: 10_000, version: 1 } as any,
        invalidateAccounting: vi.fn(),
      } as unknown as MaintenanceScheduler

      const newPages: OcrPageText[] = [
        { page: 2, text: 'Nội dung mới bị từ chối do hết quota' },
      ]

      const result = await persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: newPages,
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('quota-denied')
      // Existing row remains completely untouched
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)?.pages).toEqual(
        existingPages,
      )
    })

    it('denies on degraded or unknown measurement state and leaves existing rows untouched', async () => {
      const admission = new StorageAdmissionController()
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator

      // 1. Snapshot with isDegraded: true
      const degradedScheduler = {
        refreshAccountingAsync: vi.fn().mockResolvedValue(
          createStorageBudgetSnapshot({
            activeDbSizeBytes: 10_000,
            budgetBytes: 100_000_000,
            measurementStatus: 'degraded',
            isDegraded: true,
          }),
        ),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
        invalidateAccounting: vi.fn(),
      } as unknown as MaintenanceScheduler

      const resDegraded = await persistOcrPagesGated({
        store,
        admission,
        maintScheduler: degradedScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: [{ page: 2, text: 'Trang mới' }],
      })

      expect(resDegraded.ok).toBe(false)
      expect(resDegraded.code).toBe('accounting-degraded')
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)?.pages).toEqual(
        existingPages,
      )

      // 2. Scheduler throwing during refresh
      const throwingScheduler = {
        refreshAccountingAsync: vi
          .fn()
          .mockRejectedValue(new Error('Accounting measurement timeout')),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
        invalidateAccounting: vi.fn(),
      } as unknown as MaintenanceScheduler

      const resThrowing = await persistOcrPagesGated({
        store,
        admission,
        maintScheduler: throwingScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: [{ page: 2, text: 'Trang mới' }],
      })

      expect(resThrowing.ok).toBe(false)
      expect(resThrowing.code).toBe('accounting-degraded')
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)?.pages).toEqual(
        existingPages,
      )
    })

    it('denies on unknown or insufficient disk space (spied statfs failure) and leaves existing rows untouched', async () => {
      const admission = new StorageAdmissionController()
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator

      const maintScheduler = {
        refreshAccountingAsync: vi.fn().mockResolvedValue(
          createStorageBudgetSnapshot({
            activeDbSizeBytes: 10_000,
            budgetBytes: 100_000_000,
            measurementStatus: 'fresh',
            isDegraded: false,
          }),
        ),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
        invalidateAccounting: vi.fn(),
      } as unknown as MaintenanceScheduler

      // Fault-inject statfs returning failure / null
      vi.mocked(fsPromises.statfs).mockRejectedValueOnce(
        new Error('EIO: Disk I/O error on statfs'),
      )

      const result = await persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: [{ page: 2, text: 'Trang mới khi đĩa hỏng' }],
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('disk-space-insufficient')
      expect(result.error).toContain('Insufficient disk space')
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)?.pages).toEqual(
        existingPages,
      )
    })
  })

  // ==========================================================================================
  // Case 3: Oversized text / page batch > 50 rejected truthfully
  // ==========================================================================================
  describe('CASE-3: Oversized text or batch size rejected without silent truncation or writes', () => {
    let admission: StorageAdmissionController
    let budgetCoord: StorageBudgetCoordinator
    let maintScheduler: MaintenanceScheduler

    beforeEach(() => {
      admission = new StorageAdmissionController()
      budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator
      maintScheduler = {
        refreshAccountingAsync: vi.fn().mockResolvedValue(
          createStorageBudgetSnapshot({
            activeDbSizeBytes: 10_000,
            budgetBytes: 100_000_000,
            measurementStatus: 'fresh',
            isDegraded: false,
          }),
        ),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
        invalidateAccounting: vi.fn(),
      } as unknown as MaintenanceScheduler
    })

    it('rejects batch exceeding MAX_BOUNDED_RENDER_PAGES (50 pages) with zero writes', async () => {
      const oversizedBatch: OcrPageText[] = Array.from(
        { length: MAX_BOUNDED_RENDER_PAGES + 1 },
        (_, i) => ({
          page: i + 1,
          text: `Trang số ${i + 1}`,
        }),
      )

      const result = await persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: oversizedBatch,
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('invalid')
      expect(result.error).toContain('OCR batch exceeds page limit')
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)).toBeNull()
    })

    it('rejects page text exceeding MAX_SINGLE_PAGE_TEXT_CHARS with truthful rejection and zero writes', async () => {
      const oversizedCharPage: OcrPageText[] = [
        {
          page: 1,
          text: 'V'.repeat(MAX_SINGLE_PAGE_TEXT_CHARS + 1),
        },
      ]

      const result = await persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: oversizedCharPage,
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('invalid')
      expect(result.error).toContain(
        'OCR page text exceeds storage limits; no pages were saved',
      )
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)).toBeNull()
    })

    it('truthfully bounds in sanitizeOcrPages for character and byte limits', () => {
      // 1. Character limit truncation check
      const resChars = sanitizeOcrPages([
        { page: 1, text: 'A'.repeat(MAX_SINGLE_PAGE_TEXT_CHARS + 50) },
      ])
      expect(resChars.truncated).toBe(true)
      expect(resChars.truncatedPages).toEqual([1])
      expect(resChars.pages[0]!.text.length).toBe(MAX_SINGLE_PAGE_TEXT_CHARS)

      // 2. Byte limit truncation check
      const resBytes = sanitizeOcrPages(
        [{ page: 2, text: 'Tiếng Việt kiểm tra dung lượng byte '.repeat(20) }],
        MAX_SINGLE_PAGE_TEXT_CHARS,
        64, // 64 byte limit
      )
      expect(resBytes.truncated).toBe(true)
      expect(resBytes.truncatedPages).toEqual([2])
      expect(
        Buffer.byteLength(resBytes.pages[0]!.text, 'utf8'),
      ).toBeLessThanOrEqual(64)
    })
  })

  // ==========================================================================================
  // Case 4: Cancellation / source metadata change / config notready after async stat
  // ==========================================================================================
  describe('CASE-4: Post-await guards and exact-owner lease release contract', () => {
    let admission: StorageAdmissionController
    let maintScheduler: MaintenanceScheduler

    beforeEach(() => {
      admission = new StorageAdmissionController()
      maintScheduler = {
        refreshAccountingAsync: vi.fn().mockResolvedValue(
          createStorageBudgetSnapshot({
            activeDbSizeBytes: 10_000,
            budgetBytes: 100_000_000,
            measurementStatus: 'fresh',
            isDegraded: false,
          }),
        ),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
        invalidateAccounting: vi.fn(),
      } as unknown as MaintenanceScheduler
    })

    it('cancels persistence when stopped after async stat with controlled deferred promise', async () => {
      let stopped = false
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator

      const deferredStat = createDeferred<any>()
      vi.mocked(fsPromises.stat).mockImplementationOnce(
        () => deferredStat.promise,
      )

      const persistPromise = persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: [{ page: 1, text: 'Trang chờ xử lý' }],
        isStopped: () => stopped,
      })

      // Change state during in-flight stat
      stopped = true
      deferredStat.resolve({
        mtimeMs: sourceMeta.mtimeMs,
        size: sourceMeta.sizeBytes,
      })

      const result = await persistPromise
      expect(result.ok).toBe(false)
      expect(result.code).toBe('aborted')
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)).toBeNull()
    })

    it('rejects stale persistence when source mtime changes after async stat', async () => {
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator

      const deferredStat = createDeferred<any>()
      vi.mocked(fsPromises.stat).mockImplementationOnce(
        () => deferredStat.promise,
      )

      const persistPromise = persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: [{ page: 1, text: 'Trang stale' }],
      })

      // Resolve stat with modified mtime (file changed concurrently)
      deferredStat.resolve({
        mtimeMs: sourceMeta.mtimeMs + 10_000,
        size: sourceMeta.sizeBytes,
      })

      const result = await persistPromise
      expect(result.ok).toBe(false)
      expect(result.code).toBe('invalid')
      expect(result.error).toContain(
        'Document changed on disk during OCR recognition',
      )
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)).toBeNull()
    })

    it('rejects persistence when write readiness drops after async stat', async () => {
      let writeReady = true
      const budgetCoord = {
        isWriteReady: () => writeReady,
      } as unknown as StorageBudgetCoordinator

      const deferredStat = createDeferred<any>()
      vi.mocked(fsPromises.stat).mockImplementationOnce(
        () => deferredStat.promise,
      )

      const persistPromise = persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: [{ page: 1, text: 'Trang pending' }],
      })

      // Configuration invalidated during in-flight stat
      writeReady = false
      deferredStat.resolve({
        mtimeMs: sourceMeta.mtimeMs,
        size: sourceMeta.sizeBytes,
      })

      const result = await persistPromise
      expect(result.ok).toBe(false)
      expect(result.code).toBe('quota-denied')
      expect(result.error).toContain('Storage budget is pending')
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)).toBeNull()
    })

    it('enforces exact owner token release; wrong or missing owner cannot release another lease', () => {
      const reservationId = 'ocr-save:sample-path:token-123'
      const ownerToken = 'token-123'

      const decision = admission.reserve({
        reservationId,
        type: 'ocr',
        estimatedBytes: 10_000,
        currentUsageBytes: 0,
        budgetBytes: 100_000_000,
        ownerId: ownerToken,
      })
      expect(decision.admitted).toBe(true)
      expect(admission.listReservations()).toHaveLength(1)

      // 1. Missing owner token cannot release
      expect(safeReleaseOcrLease(admission, reservationId, undefined)).toBe(
        false,
      )
      expect(admission.listReservations()).toHaveLength(1)

      // 2. Wrong owner token cannot release
      expect(safeReleaseOcrLease(admission, reservationId, 'wrong-token')).toBe(
        false,
      )
      expect(admission.listReservations()).toHaveLength(1)

      // 3. Exact matching owner token successfully releases
      expect(safeReleaseOcrLease(admission, reservationId, ownerToken)).toBe(
        true,
      )
      expect(admission.listReservations()).toHaveLength(0)

      // 4. Parity with safeReleaseExactOwnerLease / safeReleaseExactOwnerReservation
      admission.reserve({
        reservationId: 'ocr-save:sample-path:token-456',
        type: 'ocr',
        estimatedBytes: 10_000,
        currentUsageBytes: 0,
        budgetBytes: 100_000_000,
        ownerId: 'token-456',
      })
      expect(
        safeReleaseExactOwnerLease(
          admission,
          'ocr-save:sample-path:token-456',
          'other',
        ),
      ).toBe(false)
      expect(
        safeReleaseExactOwnerReservation(
          admission,
          'ocr-save:sample-path:token-456',
          'token-456',
        ),
      ).toBe(true)
      expect(admission.listReservations()).toHaveLength(0)
    })
  })

  // ==========================================================================================
  // Case 5: Committed persistence followed by null/degraded/thrown measurement
  // ==========================================================================================
  describe('CASE-5: Committed persistence returns truth and invalidates gate; throwing persistence rolls back', () => {
    it('returns truthful ok: true and invalidates scheduler when post-commit measurement degrades or throws', async () => {
      const admission = new StorageAdmissionController()
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator

      let callCount = 0
      const invalidateAccounting = vi.fn()

      const maintScheduler = {
        refreshAccountingAsync: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount === 1) {
            // First call: pre-admission check succeeds
            return createStorageBudgetSnapshot({
              activeDbSizeBytes: 10_000,
              budgetBytes: 100_000_000,
              measurementStatus: 'fresh',
              isDegraded: false,
            })
          }
          // Second call: post-write accounting throws measurement failure
          throw new Error('Post-write measurement hardware timeout')
        }),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
        invalidateAccounting,
      } as unknown as MaintenanceScheduler

      const pagesToPersist: OcrPageText[] = [
        {
          page: 1,
          text: 'Văn bản đã commit an toàn vào SQLite trước khi đo đạc gặp sự cố',
        },
      ]

      const result = await persistOcrPagesGated({
        store,
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        meta: sourceMeta,
        pages: pagesToPersist,
      })

      // Truthful saved result because commit actually succeeded on disk
      expect(result.ok).toBe(true)
      expect(result.savedCount).toBe(1)

      // Data is present in SQLite
      const stored = store.ocr.pages(sourcePath, sourceMeta.hash)
      expect(stored?.pages).toEqual(pagesToPersist)

      // Scheduler gate was invalidated due to failed post-write measurement
      expect(invalidateAccounting).toHaveBeenCalledWith(
        expect.stringContaining('ocr-persistence-terminal'),
      )
      expect(invalidateAccounting).toHaveBeenCalledWith(
        expect.stringContaining('Post-write measurement hardware timeout'),
      )

      // Lease was cleanly released
      expect(admission.listReservations()).toHaveLength(0)
    })

    it('throwing persistence rolls back, retains prior rows, executes terminal cleanup, and never swallows error', async () => {
      const admission = new StorageAdmissionController()
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator

      const maintScheduler = {
        refreshAccountingAsync: vi.fn().mockResolvedValue(
          createStorageBudgetSnapshot({
            activeDbSizeBytes: 10_000,
            budgetBytes: 100_000_000,
            measurementStatus: 'fresh',
            isDegraded: false,
          }),
        ),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
        invalidateAccounting: vi.fn(),
      } as unknown as MaintenanceScheduler

      // Pre-seed prior row
      const priorPages: OcrPageText[] = [
        { page: 1, text: 'Hàng dữ liệu cũ trước khi phát sinh lỗi ghi' },
      ]
      store.ocr.savePages(sourcePath, sourceMeta, priorPages)
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)?.pages).toEqual(
        priorPages,
      )

      // Inject fault in store.ocr.savePages
      vi.spyOn(store.ocr, 'savePages').mockImplementationOnce(() => {
        throw new Error('Simulated SQLite disk write failure during transaction')
      })

      // Must reject, not swallow error
      await expect(
        persistOcrPagesGated({
          store,
          admission,
          maintScheduler,
          budgetCoord,
          dbDir: tempDir,
          path: sourcePath,
          meta: sourceMeta,
          pages: [{ page: 2, text: 'Trang thất bại' }],
        }),
      ).rejects.toThrow('Simulated SQLite disk write failure during transaction')

      // Prior rows remain intact
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)?.pages).toEqual(
        priorPages,
      )

      // Terminal cleanup executed; reservation is not leaked
      expect(admission.listReservations()).toHaveLength(0)
    })
  })

  // ==========================================================================================
  // Case 6: Host savePages callback promise awaited before OCR job advances & render clamp
  // ==========================================================================================
  describe('CASE-6: Host savePages promise awaited before progress/reindex & render count clamp', () => {
    it('awaits host.savePages before advancing done/progress/reindex; rejection never marks done', async () => {
      const fakeFs = new MemoryOcrStateFs()
      const state = new OcrStateStore(
        '/state.json',
        () => Date.now(),
        () => -420,
        fakeFs,
      )
      const host = new TestOcrJobHost()
      host.addFile('/test-doc.pdf', 101, 1)

      const deferredSave = createDeferred<OcrSavePagesResult>()
      host.savePagesFn = vi.fn().mockImplementation(() => deferredSave.promise)

      const settings: AgyOcrSettings = {
        ...DEFAULT_AGY_OCR_SETTINGS,
        enabled: true,
      }

      const jobDeps: OcrJobDeps = {
        settings: () => settings,
        pdfPageLimit: () => 400,
        host,
        state,
        recognize: async () => ({
          text: '=== PAGE 1 ===\nNội dung trang 1 tiếng Việt',
        }),
        readUsage: async () => null,
        policy: () => ({ paused: false, onBattery: false }),
        idleSeconds: () => 600,
        now: () => Date.now(),
        timezoneOffset: () => -420,
        every: () => () => {},
      }

      const job = new AgyOcrJob(jobDeps)

      const readPromise = job.readNow(101)

      // Wait a tick for recognition to finish and savePages to be called
      await vi.waitFor(
        () => {
          expect(host.savePagesFn).toHaveBeenCalled()
        },
        { timeout: 10_000 },
      )

      // While savePages promise is unresolved:
      expect(job.status().progress?.done).toBe(0)
      expect(state.get().pendingReindexPaths ?? []).not.toContain(
        '/test-doc.pdf',
      )
      expect(host.reindexed).not.toContain('/test-doc.pdf')

      // Settle savePages with rejection / error
      deferredSave.reject(new Error('Persistence quota exceeded on savePages'))

      const outcome = await readPromise
      expect(outcome.ok).toBe(false)

      // Verify that progress NEVER marked done and file was NEVER reindexed
      expect(job.status().progress?.done ?? 0).toBe(0)
      expect(state.get().pendingReindexPaths ?? []).not.toContain(
        '/test-doc.pdf',
      )
      expect(host.reindexed).not.toContain('/test-doc.pdf')
      job.stop()
    })

    it('unconfigured host rejects with quota-denied and does not fall back to un-gated persistence', async () => {
      const unconfiguredHost = createOcrHost({
        store,
        isEnabled: () => true,
        reindex: () => {},
      })

      const pages: OcrPageText[] = [
        { page: 1, text: 'Văn bản không được lưu trực tiếp nếu thiếu admission' },
      ]

      const res = await unconfiguredHost.savePages(
        sourcePath,
        sourceMeta,
        pages,
      )

      expect(res).toEqual({
        ok: false,
        code: 'quota-denied',
        error: 'OCR persistence admission is not configured',
      })
      // Database remains untouched
      expect(store.ocr.pages(sourcePath, sourceMeta.hash)).toBeNull()
    })

    it('clamps worker render request count to MAX_BOUNDED_RENDER_PAGES (50)', async () => {
      const admission = new StorageAdmissionController()
      const budgetCoord = {
        isWriteReady: vi.fn().mockReturnValue(true),
      } as unknown as StorageBudgetCoordinator
      const maintScheduler = {
        checkStorageBudget: vi.fn().mockReturnValue(
          createStorageBudgetSnapshot({
            activeDbSizeBytes: 10_000,
            budgetBytes: 100_000_000,
            measurementStatus: 'fresh',
            isDegraded: false,
          }),
        ),
        budget: { maxDatabaseBytes: 100_000_000, version: 1 } as any,
      } as unknown as MaintenanceScheduler

      const askWorker = vi.fn().mockResolvedValue({
        type: 'ocr-render',
        result: {
          ok: true,
          hash: 'hash-xyz',
          mtimeMs: 1000,
          sizeBytes: 2000,
          totalPages: 100,
          pages: [],
        },
      })

      const renderResult = await executeOcrRenderGated({
        admission,
        maintScheduler,
        budgetCoord,
        dbDir: tempDir,
        path: sourcePath,
        request: {
          count: 100, // Oversized request
          maxPages: 100,
          done: [],
        },
        askWorker,
      })

      expect(renderResult?.ok).toBe(true)
      // Clamped count payload asserted
      expect(askWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ocr-render',
          path: sourcePath,
          ocr: expect.objectContaining({
            count: 50, // Clamped to 50
            maxPages: 100,
            done: [],
          }),
        }),
        undefined,
      )

      // Direct bounds validation
      expect(
        validateBoundedRenderCount({ count: 120, maxPages: 200, done: [] }),
      ).toBe(50)
      expect(
        validateBoundedRenderCount({ count: 50, maxPages: 200, done: [] }),
      ).toBe(50)
      expect(
        validateBoundedRenderCount({ count: 20, maxPages: 200, done: [] }),
      ).toBe(20)
      expect(
        validateBoundedRenderCount({ count: 40, maxPages: 25, done: [1, 2] }),
      ).toBe(23)
      expect(validateBoundedRenderCount({ count: -5 })).toBe(1)
      expect(validateBoundedRenderCount(null)).toBe(1)
    })
  })
})
