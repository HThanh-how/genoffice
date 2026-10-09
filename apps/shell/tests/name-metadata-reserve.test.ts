import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { contentWriteCapBytes, createStorageBudget, createStorageBudgetSnapshot, hardCapBytes, NAME_METADATA_RESERVE_BYTES } from '../src/main/document-memory/storage-budget'
import { measureNameMetadataBytes } from '../src/main/document-memory/runtime/name-metadata-accounting'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import { SyncMetadataAdmissionCoordinator } from '../src/main/document-memory/runtime/sync-metadata-admission'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import { optimizeFts } from '../src/main/document-memory/runtime/storage-optimizer'
import { CompactionDriver } from '../src/main/document-memory/runtime/compaction-driver'
import { HotMetadataSearch } from '../src/main/document-memory/hot-metadata-search'
import { wireSyncMetadataAdmission } from '../src/main/document-memory/runtime/sync-metadata-admission'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const budget = createStorageBudget(1_000_000_000)
const snapshot = (used: number, names: number) => createStorageBudgetSnapshot({
  activeDbSizeBytes: used, totalManagedBytes: used, budgetBytes: budget.maxDatabaseBytes,
  nameMetadataBytes: names, measurementStatus: 'fresh', isDegraded: false,
})

async function guard(used: number, names: number | undefined) {
  const admission = new StorageAdmissionController()
  const snap = snapshot(used, names ?? 0)
  snap.nameMetadataBytes = names
  const coordinator = new SyncMetadataAdmissionCoordinator({
    admission, getStorageBudget: () => budget, isWriteReady: () => true,
    getStorageBudgetSnapshot: () => snap, refreshAccountingAsync: async () => snap,
    getFreeDiskBytes: async () => 10_000_000_000,
  })
  cleanup.push(() => coordinator.close())
  await new Promise<void>((resolve) => setImmediate(resolve))
  return { coordinator, admission, snap }
}

describe('Protected name/path capacity', () => {
  it('keeps 100 MiB within the total cap: heavy content is denied while a new identity fits', async () => {
    expect(hardCapBytes(budget) - contentWriteCapBytes(budget)).toBe(NAME_METADATA_RESERVE_BYTES)
    const used = contentWriteCapBytes(budget)
    const { coordinator, admission } = await guard(used, 4096)
    expect(admission.canAdmit('ocr', 4096, used, contentWriteCapBytes(budget)).admitted).toBe(false)
    expect(coordinator.canAdmitNewDocument({ name: 'giấy ra viện Phạm Hữu Công.pdf', path: '/phamhuucong/giayravien.pdf', lowPriority: true }, 4096).admitted).toBe(true)
  })

  it('counts concurrent identity reservations and fails closed on unknown measurement', async () => {
    const { coordinator } = await guard(100_000, NAME_METADATA_RESERVE_BYTES - 4096)
    const first = coordinator.canAdmitNewDocument({ name: 'a', path: '/a' }, 4096)
    expect(first.admitted).toBe(true)
    expect(coordinator.canAdmitNewDocument({ name: 'b', path: '/b' }, 4096).reason).toBe('name-metadata-full')
    coordinator.rollbackCommit(first.reservationId!, first.ownerToken)
    expect(coordinator.canAdmitNewDocument({ name: 'b', path: '/b' }, 4096).admitted).toBe(true)
    const unknown = await guard(100_000, undefined)
    expect(unknown.coordinator.canAdmitNewDocument({ name: 'c', path: '/c' }, 4096).reason).toBe('accounting-unknown')
  })

  it('finds a real newly admitted file by name while heavy writes are blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-name-only-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'giấy ra viện Phạm Hữu Công.pdf')
    writeFileSync(path, 'scan fixture: not yet OCRed')
    const store = new DocumentMemoryStore(join(dir, 'index.db'))
    cleanup.push(() => store.close())
    const { coordinator, admission } = await guard(contentWriteCapBytes(budget), measureNameMetadataBytes(store.dbPath, store.rawDb))
    wireSyncMetadataAdmission(store.rawDb, coordinator)
    expect(admission.canAdmit('extract', 4096, contentWriteCapBytes(budget), contentWriteCapBytes(budget)).admitted).toBe(false)
    expect(store.remember(path)).toBe(true)
    const hits = new HotMetadataSearch(store.rawDb).searchNames('giay ra vien pham huu cong')
    expect(hits.map((hit) => hit.path)).toContain(path)
    expect(store.chunkProgress(path).totalChunks).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('scan fixture: not yet OCRed')
  })

  it('never admits metadata past the total hard cap, even if its own pool is empty', async () => {
    const { coordinator } = await guard(hardCapBytes(budget), 0)
    expect(coordinator.canAdmitNewDocument({ name: 'a', path: '/a' }, 4096).admitted).toBe(false)
  })

  it('measures real name tables, survives reopening and compacts deleted name segments without touching originals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-name-reserve-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const dbPath = join(dir, 'index.db')
    const original = join(dir, 'original.pdf')
    writeFileSync(original, 'original stays intact')
    let store = new DocumentMemoryStore(dbPath)
    cleanup.push(() => store.close())
    const initial = measureNameMetadataBytes(dbPath, store.rawDb)
    for (let i = 0; i < 400; i++) {
      const path = join(dir, `giấy ra viện Phạm Hữu Công ${i}.pdf`)
      writeFileSync(path, 'scan fixture')
      store.remember(path)
    }
    const populated = measureNameMetadataBytes(dbPath, store.rawDb)
    expect(populated).toBeGreaterThan(initial)
    const report = collectStorageAccounting({ dbPath, db: store.rawDb })
    expect(report.nameMetadataBytes).toBe(populated)
    expect(report.totalManagedBytes).toBeGreaterThanOrEqual(populated)
    store.close()
    store = new DocumentMemoryStore(dbPath)
    expect(measureNameMetadataBytes(dbPath, store.rawDb)).toBe(populated)
    for (let i = 0; i < 400; i++) store.tombstone(join(dir, `giấy ra viện Phạm Hữu Công ${i}.pdf`))
    const result = await optimizeFts(store.rawDb, { tables: ['document_name_fts', 'document_name_projection_fts'], maxPages: 8192, budgetMs: 10_000 })
    expect(result.stoppedReason).not.toBe('error')
    expect(measureNameMetadataBytes(dbPath, store.rawDb)).toBeLessThan(populated)
    expect(readFileSync(original, 'utf8')).toBe('original stays intact')
  })

  it('compacts name pressure below the overall quota without evicting unrelated content, and backs off if no progress', async () => {
    const requests: string[] = []
    const snap = snapshot(200_000_000, NAME_METADATA_RESERVE_BYTES)
    const driver = new CompactionDriver({
      getBudget: () => budget, getSnapshot: () => snap, refreshAccounting: async () => snap,
      isStopped: () => false, isPaused: () => false, isWriteReady: () => true, getEpoch: () => 1,
      askWorker: async (req) => {
        requests.push(req.type)
        return { id: 1, result: { kind: 'optimize-fts', status: 'completed', runId: 'runId' in req ? req.runId : '', result: { pending: [] } } } as any
      },
    })
    cleanup.push(() => driver.dispose())
    expect((await driver.makeRoom({ reason: 'name-metadata', neededBytes: 4096 })).retry).toBe(false)
    expect(requests).toEqual(['optimize-fts'])
    expect((await driver.makeRoom({ reason: 'name-metadata', neededBytes: 4096 })).reason).toBe('cooldown')
    expect(requests).toHaveLength(1)
  })
})
