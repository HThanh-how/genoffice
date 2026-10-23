import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { OcrSidecar } from '../src/main/document-memory/ocr-sidecar'
import { OcrStateStore } from '../src/main/document-memory/agy-ocr-state'
import {
  classifyOcrSourceError,
  sourceRetrySeconds,
} from '../src/main/document-memory/ocr-source-errors'
import { renderPdfPagesForOcr } from '../src/main/document-memory/agy-ocr-render'
import {
  recoverOcrSourcesPage,
  acknowledgeSourceRecovery,
} from '../src/main/document-memory/storage/repositories/ocr-source-recovery-repository'
import { OcrSourceRecovery } from '../src/main/document-memory/runtime/ocr-source-recovery'
import { rootAvailability, RootAvailability } from '../src/main/document-memory/root-availability'
import { createOcrHost } from '../src/main/document-memory/ocr-host'
import { LocalOcrJob } from '../src/main/document-memory/local-ocr/local-ocr-job'
import { DEFAULT_LOCAL_OCR_SETTINGS } from '../src/shared/fork/agy-ocr'
import { withOfflineSources } from '../src/main/document-memory/runtime/root-status'
import { FreshnessCoordinator } from '../src/main/document-memory/runtime/freshness-coordinator'
import type { WorkerRequest } from '../src/main/document-memory/worker-types'

let dir: string
let store: DocumentMemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), '.ocr-source-test-'))
  rootAvailability.register(dir)
  store = new DocumentMemoryStore(join(dir, 'test.db'))
})
afterEach(() => {
  vi.useRealTimers()
  rootAvailability.unregister(dir)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function document(name = 'synthetic.pdf', present = true) {
  const path = join(dir, name)
  if (present) writeFileSync(path, 'synthetic source; never parsed')
  const info = present ? statSync(path) : { mtimeMs: 1, size: 42 }
  const meta = { mtimeMs: info.mtimeMs, sizeBytes: info.size }
  store.replaceDocument(path, {
    ...meta,
    hash: 'synthetic',
    chunks: [],
    embeddingModel: null,
    status: 'empty',
    error: 'No readable text; scanned documents need OCR',
  })
  store.rawDb
    .prepare(
      "INSERT INTO ocr_local_failures(path, mtime_ms, size_bytes, code, attempts) VALUES (?, ?, ?, 'missing', 3)",
    )
    .run(path, meta.mtimeMs, meta.sizeBytes)
  return { path, meta }
}

function cloudState() {
  return new OcrStateStore(join(dir, 'agy-ocr-state.json'), Date.now, () => 0)
}

describe('source failure classification', () => {
  it('retains OS categories and consumes no attempts while a root is offline', async () => {
    const { path, meta } = document()
    const offline = await classifyOcrSourceError(path, { code: 'EIO' }, async () => false)
    expect(offline).toEqual({ code: 'offline', detail: 'EIO' })
    store.ocr.recordLocalFailure(path, meta, offline.code, false, offline.detail)
    expect(store.ocr.localFailure(path)).toMatchObject({ code: 'missing', attempts: 3 })
    for (const [detail, code] of [
      ['ENOENT', 'missing'],
      ['ENOTDIR', 'missing'],
      ['EACCES', 'source-permission'],
      ['EPERM', 'source-permission'],
      ['EBUSY', 'source-busy'],
      ['ETIMEDOUT', 'source-busy'],
      ['EHOSTUNREACH', 'source-busy'],
    ])
      expect(await classifyOcrSourceError(path, { code: detail }, async () => true)).toEqual({
        code,
        detail,
      })
  })

  it('classifies all three renderer source I/O failure sites before returning', async () => {
    for (const site of ['stat', 'read', 'freshness']) {
      let stats = 0
      const failure = () =>
        Promise.reject(Object.assign(new Error('synthetic offline'), { code: 'EIO' }))
      const result = await renderPdfPagesForOcr(
        join(dir, 'scan.pdf'),
        { done: [], count: 1, maxPages: 1 },
        {
          probeRoot: async () => false,
          stat: async () => {
            stats++
            if (site === 'stat' || (site === 'freshness' && stats === 2)) return failure()
            return { size: 1, mtimeMs: 1 }
          },
          readFile: async () => (site === 'read' ? failure() : new Uint8Array([1])),
          loadPdfium: async () => ({}) as never,
        },
      )
      expect(result).toMatchObject({ ok: false, code: 'offline', detail: 'EIO' })
    }
  })

  it('adds detail safely to an old ledger and preserves its rows', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(
      "CREATE TABLE ocr_local_failures(path TEXT PRIMARY KEY, mtime_ms REAL, size_bytes INTEGER, attempts INTEGER, code TEXT, updated_at INTEGER) WITHOUT ROWID; INSERT INTO ocr_local_failures VALUES ('synthetic', 1, 2, 3, 'missing', 1)",
    )
    OcrSidecar.ensureSchema(db)
    OcrSidecar.ensureSchema(db)
    expect(db.prepare('SELECT attempts, detail FROM ocr_local_failures').get()).toMatchObject({
      attempts: 3,
      detail: null,
    })
    db.close()
  })
})

describe('automatic source recovery', () => {
  it('weeks offline never open OCR sources or write a local/cloud failure, then candidates resume', async () => {
    const { path } = document()
    store.rawDb.prepare('DELETE FROM ocr_local_failures').run()
    let now = 1000
    let online = false
    const probe = vi.fn(async () => online)
    const roots = new RootAvailability(probe, () => now)
    roots.register(dir)
    const render = vi.fn()
    const select = vi.fn(() => null)
    const host = createOcrHost({
      store,
      isEnabled: () => true,
      reindex: vi.fn(),
      sourceSelectable: (path) => roots.selectable(path),
      sourceAvailable: (path) => roots.checkPath(path),
      renderInWorker: render,
    })
    const job = new LocalOcrJob({
      db: store.rawDb,
      settings: () => ({ ...DEFAULT_LOCAL_OCR_SETTINGS, enabled: true }),
      registry: { select },
      render,
      savePages: vi.fn(),
      reindex: vi.fn(),
      gate: () => ({ ok: true }),
      sourceAvailable: (path) => roots.checkPath(path),
    })
    const cloud = cloudState()
    for (let day = 0; day < 21; day++) {
      await roots.probeDue()
      await job.runOnce()
      expect(host.candidates(2)).toEqual([])
      now += 86400_000
    }
    expect(render).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(store.ocr.localFailure(path)).toBeNull()
    expect(cloud.get().files).toEqual({})
    expect(probe).toHaveBeenCalledTimes(21)
    online = true
    await roots.probeDue()
    expect(host.candidates(2).map((row) => row.path)).toContain(path)
  })

  it('an offline indexed mount on a reachable drive cannot purge or exclude indexed content', async () => {
    const { path } = document('absent.pdf', false)
    store.rawDb
      .prepare("UPDATE documents SET status = 'ready', error = NULL WHERE path = ?")
      .run(path)
    const roots = new RootAvailability(async () => false)
    roots.register(dir)
    const freshness = new FreshnessCoordinator({ store, roots })
    const tombstone = vi.spyOn(store, 'tombstoneSliced')
    expect(await freshness.reconcileFolder(dir, new Map())).toMatchObject({ removed: 0 })
    await freshness.finalizeMissing(path)
    expect(tombstone).not.toHaveBeenCalled()
    expect(store.documentByPath(path)).toMatchObject({ status: 'ready' })
    expect(store.ocr.localFailure(path)?.attempts).toBe(3)
    freshness.clearMissing()
  })

  it('a scan seeing the same file clears missing; permission faults require changed metadata', () => {
    const { path, meta } = document()
    const enqueue = vi.fn()
    const freshness = new FreshnessCoordinator({ store, onEnqueue: enqueue })
    freshness.enrollDiscoveredFile(path, meta)
    expect(store.ocr.localFailure(path)).toBeNull()
    expect(store.documentByPath(path)?.status).toBe('pending')
    expect(enqueue).toHaveBeenCalledWith(path, false, meta.sizeBytes)
    store.ocr.recordLocalFailure(path, meta, 'source-permission', false, 'EACCES')
    freshness.enrollDiscoveredFile(path, meta)
    expect(store.ocr.localFailure(path)?.code).toBe('source-permission')
    freshness.enrollDiscoveredFile(path, { ...meta, mtimeMs: meta.mtimeMs + 1 })
    expect(store.ocr.localFailure(path)).toBeNull()
    freshness.clearMissing()
  })

  it('reports offline roots with cached waiting counts, without probing files for the Index screen', () => {
    rootAvailability.observe(dir, false)
    const folder = vi.fn(() => ({
      totalFiles: 1454,
      pendingFiles: 8,
      emptyFiles: 1446,
      errorFiles: 0,
      readyFiles: 0,
      totalChunks: 0,
      completedChunks: 0,
      partialFileProgress: 0,
      truncatedFiles: 0,
    }))
    expect(withOfflineSources({ total: 0, groups: [] }, { folder }).offlineRoots).toEqual([
      {
        root: dir,
        since: rootAvailability.snapshot().find((state) => state.root === dir)!.offlineSince,
        waiting: 1454,
      },
    ])
    expect(folder).toHaveBeenCalledWith(dir)
  })

  it.each([false, true])(
    'heals the real empty + missing shape, changed metadata=%s',
    async (changed) => {
      const { path } = document()
      if (changed) writeFileSync(path, 'synthetic replacement with a different size')
      const page = await recoverOcrSourcesPage(store.rawDb, 0)
      expect(page.paths).toEqual([path])
      expect(store.ocr.localFailure(path)).toBeNull()
      expect(store.documentByPath(path)).toMatchObject({ status: 'pending', error: null })
      expect(store.incompletePaths()).toContain(path)
      expect(store.rawDb.prepare('SELECT count(*) AS n FROM ocr_pages').get()).toMatchObject({
        n: 0,
      })
    },
  )

  it('leaves offline legacy rows alone and gives online missing files a cooldown', async () => {
    const { path } = document('absent.pdf', false)
    await recoverOcrSourcesPage(store.rawDb, 0, { probe: async () => false })
    expect(store.ocr.localFailure(path)).toMatchObject({ code: 'missing', attempts: 3 })
    await recoverOcrSourcesPage(store.rawDb, 0, { probe: async () => true })
    expect(store.ocr.localFailure(path)).toMatchObject({ code: 'missing', attempts: 0 })
    expect(store.documentByPath(path)?.status).toBe('empty')
  })

  it('root recovery lifecycle automatically heals and clears only matching cloud missing entries', async () => {
    const { path } = document()
    const other = join(dir, 'unrelated.pdf')
    const cloud = cloudState()
    cloud.update((data) => {
      data.files[path] = {
        attempts: 3,
        nonRetryable: true,
        reason: 'The file is no longer there',
        updatedAt: 1,
      }
      data.files[other] = {
        attempts: 3,
        nonRetryable: true,
        reason: 'The PDF is damaged',
        updatedAt: 1,
      }
    })
    let online = false
    const enqueue = vi.fn()
    const recovery = new OcrSourceRecovery({
      isActive: () => true,
      enqueue,
      ask: async (request) => {
        if (request.type === 'ocr-source-recovery')
          return {
            id: 1,
            result: await recoverOcrSourcesPage(store.rawDb, request.afterId, {
              ...request,
              probe: async () => online,
            }),
          }
        if (request.type === 'ocr-source-recovery-ack')
          acknowledgeSourceRecovery(store.rawDb, request.paths)
        return { id: 1, result: true }
      },
    })
    recovery.subscribe((paths) => cloud.clearMissingSources(paths))
    await vi.waitFor(() =>
      expect(rootAvailability.snapshot().find((s) => s.root === dir)?.online).toBe(false),
    )
    online = true
    await rootAvailability.check(dir, true)
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledWith(path))
    await vi.waitFor(() => expect(cloudState().get().files[path]).toBeUndefined())
    expect(cloudState().get().files[other]?.reason).toBe('The PDF is damaged')
    expect(store.documentByPath(path)?.status).toBe('pending')
    recovery.dispose()
  })

  it('bounds pages to 128, resumes after pause, and drains the cloud handoff across restart', async () => {
    for (let i = 0; i < 260; i++) document(`synthetic-${i}.pdf`)
    let active = true
    const cursors: number[] = []
    const cloud = cloudState()
    const ask = async (request: WorkerRequest) => {
      if (request.type === 'ocr-source-recovery') {
        cursors.push(request.afterId)
        const page = await recoverOcrSourcesPage(store.rawDb, request.afterId)
        expect(page.paths.length).toBeLessThanOrEqual(128)
        if (cursors.length === 1) active = false
        return { id: 1, result: page }
      }
      if (request.type === 'ocr-source-recovery-ack')
        acknowledgeSourceRecovery(store.rawDb, request.paths)
      return { id: 1, result: true }
    }
    const recovery = new OcrSourceRecovery({ ask, isActive: () => active, enqueue: vi.fn() })
    await recovery.run()
    expect(cursors).toEqual([0])
    active = true
    await recovery.run()
    expect(cursors[1]).toBeGreaterThan(0)
    const restarted = new OcrSourceRecovery({ ask, isActive: () => true, enqueue: vi.fn() })
    restarted.subscribe((paths) => cloud.clearMissingSources(paths))
    await vi.waitFor(() =>
      expect(
        store.rawDb.prepare('SELECT count(*) AS n FROM ocr_source_recoveries').get(),
      ).toMatchObject({ n: 0 }),
    )
    await vi.waitFor(() =>
      expect(
        store.rawDb.prepare('SELECT count(*) AS n FROM ocr_local_failures').get(),
      ).toMatchObject({ n: 0 }),
    )
    recovery.dispose()
    restarted.dispose()
  })

  it('reconcile removes a genuinely deleted document and its failure row', async () => {
    const { path } = document('deleted.pdf', false)
    const freshness = new FreshnessCoordinator({ store })
    await freshness.reconcileFolder(dir, new Map())
    expect(store.documentByPath(path)).toBeNull()
    expect(store.ocr.localFailure(path)).toBeNull()
    freshness.clearMissing()
  })

  it('retries busy sources exponentially without exhausting attempts; permissions also get a one-day cooldown', async () => {
    const { path, meta } = document()
    // Restore the OCR candidate shape after the legacy missing row.
    store.rawDb
      .prepare(
        "UPDATE documents SET error = 'No readable text; scanned documents need OCR' WHERE path = ?",
      )
      .run(path)
    store.rawDb.prepare('DELETE FROM ocr_local_failures WHERE path = ?').run(path)
    for (let attempt = 1; attempt <= 7; attempt++) {
      store.ocr.recordLocalFailure(path, meta, 'source-busy', false, 'EBUSY')
      expect(store.ocr.candidates(2, { mode: 'local' })).toEqual([])
      store.rawDb
        .prepare('UPDATE ocr_local_failures SET updated_at = unixepoch() - ? WHERE path = ?')
        .run(sourceRetrySeconds(attempt) + 1, path)
      expect(store.ocr.candidates(2, { mode: 'local' }).map((row) => row.path)).toContain(path)
    }
    expect([1, 2, 3, 4, 5, 6, 7].map(sourceRetrySeconds)).toEqual([
      3600, 7200, 14400, 28800, 57600, 86400, 86400,
    ])
    store.ocr.recordLocalFailure(path, meta, 'source-permission', false, 'EACCES')
    expect(store.ocr.localFailure(path)?.attempts).toBe(0)
    expect(store.ocr.candidates(2, { mode: 'local' })).toEqual([])
    store.rawDb
      .prepare('UPDATE ocr_local_failures SET updated_at = unixepoch() - 86401 WHERE path = ?')
      .run(path)
    expect(store.ocr.candidates(2, { mode: 'local' }).map((row) => row.path)).toContain(path)
    expect((await recoverOcrSourcesPage(store.rawDb, 0)).paths).toEqual([])
    expect((await recoverOcrSourcesPage(store.rawDb, 0, { manual: true })).paths).toEqual([path])
  })
})
