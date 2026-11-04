import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planOcrBatch } from '@genoffice/ai-provider/agy-ocr'
import { renderPdfPagesForOcr } from '../src/main/document-memory/agy-ocr-render'
import { createOcrHost } from '../src/main/document-memory/ocr-host'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { decodePngGray } from '../src/main/document-memory/local-ocr/gray-image'
import {
  LocalOcrJob,
  REST_COOL_FACTOR,
  REST_VISITS_PER_RUN,
  FileChangedDuringReadError,
  type LocalOcrEvent,
  type LocalOcrJobDeps,
} from '../src/main/document-memory/local-ocr/local-ocr-job'
import { LocalOcrEngineRegistry } from '../src/main/document-memory/local-ocr/registry'
import {
  IMAGE_OCR_STATE,
  selectImageOcrCandidates,
} from '../src/main/document-memory/media/media-ocr-gate'
import {
  OcrSidecar,
  LOCAL_OCR_MAX_ATTEMPTS,
  healLegacyLocalFailures,
} from '../src/main/document-memory/ocr-sidecar'
import {
  LocalOcrUnavailableError,
  type LocalOcrEngine,
  type LocalOcrRecognition,
  type LocalOcrToken,
} from '../src/main/document-memory/runtime/local-ocr-engine'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { extractDocument } from '../src/main/document-memory/worker'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { buildScannedPdf, testPattern } from './helpers/scanned-pdf'

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'))
const NO_TEXT = 'No readable text; scanned documents need OCR'

// ---- what the engine double says -----------------------------------------------------------

const GOOD_TEXT =
  'HÓA ĐƠN GIÁ TRỊ GIA TĂNG\nSố: 0433 Ngày 15 tháng 09 năm 2025\nĐơn vị bán hàng: Công ty TNHH Viettel Tiền Giang\nMã số thuế: 0101234567'
const BAD_TEXT = 'xcvb ttirrn qwrty hhhh lllii vnmz kkkp wwwq zzzx'
const ID_TEXT =
  'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM CĂN CƯỚC CÔNG DÂN Số định danh cá nhân Họ và tên'

type Script = 'good' | 'bad' | 'id' | 'blank'

function recognition(kind: Script): LocalOcrRecognition {
  const text =
    kind === 'good' ? GOOD_TEXT : kind === 'bad' ? BAD_TEXT : kind === 'id' ? ID_TEXT : ''
  const confidence = kind === 'good' ? 0.95 : kind === 'blank' ? 0 : 0.9
  const tokens: LocalOcrToken[] = text
    ? text.split(/\s+/).map((word) => ({ text: word, confidence }))
    : []
  return { text, meanConfidence: confidence, tokens, ms: 7 }
}

class ScriptedEngine implements LocalOcrEngine {
  readonly id = 'apple-vision' // judged with Vision's 0.73 threshold
  readonly descriptor = {
    id: 'apple-vision',
    name: 'double',
    platforms: 'all' as const,
    minFreeRamMB: 1,
    dpi: 100,
    escalationThreshold: 0.73,
    license: 'test',
    available: true,
    notes: '',
  }
  calls = 0
  disposed = 0
  fail: 'none' | 'generic' | 'unavailable' = 'none'
  constructor(public script: Script[]) {}
  isAvailable(): boolean {
    return true
  }
  async recognizePage(): Promise<LocalOcrRecognition> {
    this.calls++
    if (this.fail === 'generic') throw new Error('boom: SECRET-NAME')
    if (this.fail === 'unavailable') throw new LocalOcrUnavailableError(this.id, 'gone')
    return recognition(this.script[(this.calls - 1) % this.script.length]!)
  }
  async dispose(): Promise<void> {
    this.disposed++
  }
}

// ---- fixtures ------------------------------------------------------------------------------

let dir: string
let store: DocumentMemoryStore
let events: LocalOcrEvent[]
let reindexed: string[]
let gateState: { ok: true } | { ok: false; reason: string }
let coolDowns: number[]
let saveResult: { ok: boolean; error?: string }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-local-ocr-'))
  store = new DocumentMemoryStore(join(dir, 'memory.sqlite'))
  store.ensureEmbeddingSpace(EMBEDDING_PROFILES.standard)
  events = []
  reindexed = []
  gateState = { ok: true }
  coolDowns = []
  saveResult = { ok: true }
})
afterEach(() => {
  try {
    store.close()
  } catch {
    // closed
  }
  rmSync(dir, { recursive: true, force: true })
})

function invoicePdf(name: string, pages = 3): string {
  const gray = decodePngGray(FIXTURE)!
  const jpeg = encodeGrayJpeg(gray.data, gray.width, gray.height, 85)
  const other = encodeGrayJpeg(testPattern(gray.width, gray.height, 3), gray.width, gray.height, 70)
  const bytes = buildScannedPdf(
    Array.from({ length: pages }, (_, i) => ({
      jpeg: i === 0 ? jpeg : other,
      width: gray.width,
      height: gray.height,
    })),
  )
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

function enrollEmpty(path: string): void {
  const st = statSync(path)
  store.replaceDocument(path, {
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtimeMs: st.mtimeMs,
    sizeBytes: st.size,
    chunks: [],
    embeddingModel: null,
    status: 'empty',
    error: NO_TEXT,
  })
}

function enrollImage(name: string): string {
  const path = join(dir, name)
  writeFileSync(path, FIXTURE)
  const st = statSync(path)
  expect(store.enrollMedia(path, st.mtimeMs, st.size).outcome).toBe('created')
  return path
}

/** what the index worker does after the job asks for a re-extraction */
async function reindexNow(path: string): Promise<void> {
  const extracted = await extractDocument(path, (p, h) => store.ocr.pages(p, h))
  store.replaceDocument(path, {
    hash: extracted.hash,
    mtimeMs: extracted.mtimeMs,
    sizeBytes: extracted.sizeBytes,
    chunks: extracted.chunks,
    embeddingModel: null,
    status: extracted.chunks.length ? 'text-only' : 'empty',
    ...(extracted.error ? { error: extracted.error } : {}),
    ...(extracted.truncated ? { truncated: true } : {}),
  })
}

function makeJob(
  engine: LocalOcrEngine | null,
  overrides: Partial<LocalOcrJobDeps> & { light?: number; maxPages?: number; ramMB?: number } = {},
) {
  const { light = 2, maxPages = light, ramMB = 16_000, ...rest } = overrides
  const deps: LocalOcrJobDeps = {
    db: store.rawDb,
    settings: () => ({ enabled: true, lightPages: light, maxPages, engine: 'auto' }),
    registry: { select: () => (engine ? { engine, skipped: [] } : null) },
    render: (path, request) => renderPdfPagesForOcr(path, request),
    savePages: (path, meta, pages) => {
      if (saveResult.ok) store.ocr.savePages(path, meta, pages)
      return saveResult
    },
    reindex: (path) => void reindexed.push(path),
    gate: () => gateState,
    coolDown: async (ms) => void coolDowns.push(ms),
    totalRamMB: () => ramMB,
    log: (event) => void events.push(event),
    ...rest,
  }
  return new LocalOcrJob(deps)
}

const stat = (path: string) => {
  const st = statSync(path)
  return { mtimeMs: st.mtimeMs, sizeBytes: st.size }
}

// ---- tests ---------------------------------------------------------------------------------

describe('quality tier on ocr_pages', () => {
  it('adds the columns to a database created before they existed; old rows are cloud and done', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE ocr_pages (path TEXT NOT NULL, page INTEGER NOT NULL, hash TEXT NOT NULL, mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL, total_pages INTEGER NOT NULL, text TEXT NOT NULL, model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (path, page)) WITHOUT ROWID`)
    db.prepare(
      "INSERT INTO ocr_pages(path, page, hash, mtime_ms, size_bytes, total_pages, text) VALUES ('/a.pdf', 1, 'h', 1, 2, 3, 'old')",
    ).run()
    OcrSidecar.ensureSchema(db)
    OcrSidecar.ensureSchema(db) // idempotent
    const sidecar = new OcrSidecar(db)
    expect(sidecar.pageTier('/a.pdf', 1)).toEqual({
      tier: 'cloud',
      engine: null,
      quality: null,
      escalate: false,
    })
    expect(sidecar.pagesDone('/a.pdf', 1, 2)).toEqual([1])
  })

  it('a local row is done unless it was escalated; cloud text replaces local text and local never replaces cloud', () => {
    const path = join(dir, 'x.pdf')
    const meta = { hash: 'h', mtimeMs: 1, sizeBytes: 2, totalPages: 4 }
    store.ocr.savePages(
      path,
      { ...meta, tier: 'local', engine: 'e', quality: 0.9, escalate: false, model: 'local:e' },
      [{ page: 1, text: 'good local' }],
    )
    store.ocr.savePages(
      path,
      { ...meta, tier: 'local', engine: 'e', quality: 0.2, escalate: true, model: 'local:e' },
      [{ page: 2, text: 'bad local' }],
    )
    expect(store.ocr.pagesDone(path, 1, 2)).toEqual([1])
    expect(store.ocr.pagesPresent(path, 1, 2)).toEqual([1, 2])
    expect(store.ocr.escalatedPages(path, 1, 2)).toEqual([2])
    expect(store.ocr.pageTier(path, 2)).toEqual({
      tier: 'local',
      engine: 'e',
      quality: 0.2,
      escalate: true,
    })

    store.ocr.savePages(path, { ...meta, model: 'gemini' }, [{ page: 2, text: 'cloud text' }])
    expect(store.ocr.pageTier(path, 2)).toEqual({
      tier: 'cloud',
      engine: null,
      quality: null,
      escalate: false,
    })
    expect(store.ocr.pagesDone(path, 1, 2)).toEqual([1, 2])
    expect(store.ocr.pages(path, 'h')!.pages.find((p) => p.page === 2)!.text).toBe('cloud text')

    // a later local pass over the same page must not overwrite what the cloud read
    store.ocr.savePages(
      path,
      { ...meta, tier: 'local', engine: 'e', quality: 0.1, escalate: true },
      [{ page: 2, text: 'worse local' }],
    )
    expect(store.ocr.pages(path, 'h')!.pages.find((p) => p.page === 2)!.text).toBe('cloud text')
    expect(store.ocr.pageTier(path, 2)!.tier).toBe('cloud')
  })
})

describe('LocalOcrJob on scanned PDFs (real SQLite, real PDFium render, engine double)', () => {
  it('does not quarantine files while rendering waits for worker or storage readiness', async () => {
    const path = invoicePdf('temporary-render-gate.pdf', 1)
    enrollEmpty(path)
    const engine = new ScriptedEngine(['good'])
    const deferred = makeJob(engine, {
      render: async () => ({
        ok: false,
        code: 'render',
        message: 'Worker not ready',
        retryable: true,
      }),
    })
    for (let i = 0; i < 4; i++) {
      expect(await deferred.runOnce()).toMatchObject({
        failed: 0,
        pages: 0,
        stoppedBecause: 'render-deferred',
      })
      expect(store.ocr.localFailure(path)).toBeNull()
    }
    expect(await makeJob(engine).runOnce()).toMatchObject({ pages: 1, failed: 0 })
  })

  it('preserves the actual render error for failures that belong to the file', async () => {
    const path = invoicePdf('bad-render.pdf', 1)
    enrollEmpty(path)
    await makeJob(new ScriptedEngine(['good']), {
      render: async () => ({
        ok: false,
        code: 'render',
        message: 'PDF bitmap could not be allocated',
      }),
    }).runOnce()
    expect(
      store.rawDb.prepare('SELECT detail FROM ocr_local_failures WHERE path = ?').get(path),
    ).toMatchObject({ detail: 'PDF bitmap could not be allocated' })
  })

  it('clears the failure row once a later read of the same version succeeds', async () => {
    const path = invoicePdf('recovered-render.pdf', 1)
    enrollEmpty(path)
    const engine = new ScriptedEngine(['good', 'good'])
    await makeJob(engine, {
      render: async () => ({ ok: false, code: 'render', message: 'Failed to rasterize page 1' }),
    }).runOnce()
    expect(store.ocr.localFailure(path)).toMatchObject({ code: 'render', attempts: 1 })
    expect(await makeJob(engine).runOnce()).toMatchObject({ pages: 1, failed: 0 })
    // the file no longer shows up as failed (issue list, attempt budget)
    expect(store.ocr.localFailure(path)).toBeNull()
  })

  it('heals failure rows that older builds left behind after a successful local read', () => {
    const db = store.rawDb
    const ok = invoicePdf('healed.pdf', 1)
    const changed = invoicePdf('changed-since.pdf', 1)
    const offline = invoicePdf('offline-source.pdf', 1)
    const meta = (path: string) => ({
      hash: hashOf(path),
      ...stat(path),
      totalPages: 1,
      tier: 'local' as const,
      engine: 'test',
      quality: 0.9,
      escalate: false,
    })
    for (const path of [ok, changed, offline])
      store.ocr.savePages(path, meta(path), [{ page: 1, text: 'x' }])
    const insert = db.prepare(
      'INSERT INTO ocr_local_failures(path, mtime_ms, size_bytes, attempts, code, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    // failed (as v0.12.34 recorded transient gates) long before its page was stored
    insert.run(ok, stat(ok).mtimeMs, stat(ok).sizeBytes, 3, 'render', 1)
    // another version of the file failed: the stored page says nothing about it
    insert.run(changed, stat(changed).mtimeMs + 1, stat(changed).sizeBytes, 3, 'render', 1)
    // source faults are handled by the source-recovery pass, not here
    insert.run(offline, stat(offline).mtimeMs, stat(offline).sizeBytes, 0, 'missing', 1)
    OcrSidecar.ensureSchema(db)
    expect(store.ocr.localFailure(ok)).toBeNull()
    expect(store.ocr.localFailure(changed)).toMatchObject({ code: 'render' })
    expect(store.ocr.localFailure(offline)).toMatchObject({ code: 'missing' })
  })

  it('gives a legacy render failure without pages its attempts back once, and only once', async () => {
    const db = store.rawDb
    const legacy = invoicePdf('legacy-render.pdf', 1)
    const corrupt = invoicePdf('corrupt.pdf', 1)
    const healed = invoicePdf('healed-later.pdf', 1)
    for (const path of [legacy, corrupt, healed]) enrollEmpty(path)
    store.ocr.savePages(
      healed,
      {
        hash: hashOf(healed),
        ...stat(healed),
        totalPages: 1,
        tier: 'local',
        engine: 'test',
        quality: 0.9,
      },
      [{ page: 1, text: 'x' }],
    )
    const insert = db.prepare(
      'INSERT INTO ocr_local_failures(path, mtime_ms, size_bytes, attempts, code, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    // what 0.12.34 left: three spent attempts, no detail
    insert.run(legacy, stat(legacy).mtimeMs, stat(legacy).sizeBytes, 3, 'render', null, 1)
    insert.run(corrupt, stat(corrupt).mtimeMs, stat(corrupt).sizeBytes, 3, 'corrupt', null, 1)
    insert.run(healed, stat(healed).mtimeMs, stat(healed).sizeBytes, 3, 'render', null, 1)
    expect(new OcrSidecar(db).candidates(2, { mode: 'local' }).map((r) => r.path)).toEqual([])

    expect(healLegacyLocalFailures(db)).toEqual({ cleared: 1, reset: 1 })
    expect(store.ocr.localFailure(healed)).toBeNull()
    expect(store.ocr.localFailure(legacy)).toMatchObject({ code: 'render', attempts: 0 })
    expect(store.ocr.localFailure(corrupt)).toMatchObject({ code: 'corrupt', attempts: 3 })
    // the legacy file is local OCR work again; the corrupt one stays out
    expect(new OcrSidecar(db).candidates(2, { mode: 'local' }).map((r) => r.path)).toEqual([legacy])

    // a second open changes nothing, even after the retry fails for real again
    expect(healLegacyLocalFailures(db)).toEqual({ cleared: 0, reset: 0 })
    await makeJob(new ScriptedEngine(['good']), {
      render: async () => ({ ok: false, code: 'render', message: 'Failed to rasterize page 1' }),
    }).runOnce()
    expect(store.ocr.localFailure(legacy)).toMatchObject({ code: 'render', attempts: 1 })
    expect(healLegacyLocalFailures(db)).toEqual({ cleared: 0, reset: 0 })
    expect(store.ocr.localFailure(legacy)).toMatchObject({ attempts: 1 })
  })

  it('repairs the ledger with primary-key lookups into ocr_pages', () => {
    const plan = store.rawDb
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM ocr_local_failures f WHERE EXISTS (SELECT 1 FROM ocr_pages p
           WHERE p.path = f.path AND p.mtime_ms = f.mtime_ms AND p.size_bytes = f.size_bytes
             AND p.tier = 'local' AND p.created_at > f.updated_at)`,
      )
      .all() as Array<{ detail: string }>
    const probe = plan.map((row) => row.detail).find((d) => / p\b| ocr_pages\b/.test(d))
    expect(probe).toMatch(/SEARCH .*PRIMARY KEY \(path=\?/)
  })

  it('reads the light pages locally, writes tier=local rows, and the file becomes findable by its OCR text', async () => {
    const path = invoicePdf('hoa don scan.pdf', 5)
    enrollEmpty(path)
    const engine = new ScriptedEngine(['good'])
    const summary = await makeJob(engine).runOnce()
    expect(summary).toMatchObject({ files: 1, pages: 2, escalated: 0, failed: 0 })
    expect(engine.calls).toBe(2)
    expect(engine.disposed).toBe(1)
    const { mtimeMs, sizeBytes } = stat(path)
    expect(store.ocr.pagesPresent(path, mtimeMs, sizeBytes)).toEqual([1, 2])
    expect(store.ocr.pageTier(path, 1)).toMatchObject({
      tier: 'local',
      engine: 'apple-vision',
      escalate: false,
    })
    expect(store.ocr.pageTier(path, 1)!.quality!).toBeGreaterThan(0.73)
    expect(reindexed).toEqual([path])
    expect(coolDowns).toHaveLength(2) // the duty-cycle hook runs after every page

    await reindexNow(path)
    const hits = store.searchLexical('0433 Viettel')
    expect(hits.length).toBeGreaterThan(0)
    expect(store.documentByPath(path)!.status).toBe('text-only')

    // everything good: nothing for the automatic cloud pass...
    expect(store.ocr.candidates(40)).toEqual([])
    // ...but a person asking to read the whole file still gets pages 3-5
    const manual = store.ocr.candidates(40, { mode: 'cloud-all' })
    expect(manual).toHaveLength(1)
    expect(manual[0]).toMatchObject({ path, pagesDone: 2, totalPages: 5 })
  })

  describe('the slow pass over the pages after the first ones', () => {
    const present = (path: string): number[] =>
      store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)

    it('reads the later pages a few at a time once the quick pass is done, up to the limit, and they become searchable', async () => {
      const path = invoicePdf('quyen sach scan.pdf', 12)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 8 })
      expect(job.restPages()).toBe(8)

      await job.runOnce() // the quick pass: pages 1-2 only
      expect(present(path)).toEqual([1, 2])
      await reindexNow(path)

      const second = await job.runOnce() // REST_PAGES_PER_VISIT pages
      expect(second).toMatchObject({ files: 1, pages: 5, failed: 0 })
      expect(present(path)).toEqual([1, 2, 3, 4, 5, 6, 7])
      // (not put back in the index yet: the file is not finished, and every visit would make a new version)
      expect(reindexed).toEqual([path])
      await reindexNow(path)

      await job.runOnce() // up to the limit of 8, not further
      expect(reindexed).toEqual([path, path]) // finished: now
      expect(present(path)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      await reindexNow(path)

      const done = await job.runOnce()
      expect(done).toMatchObject({ files: 0, pages: 0 })
      expect(present(path)).toHaveLength(8)
      expect(engine.calls).toBe(8)
      expect(store.searchLexical('0433 Viettel').length).toBeGreaterThan(0)
    })

    it('follows the scan info the indexer records (pages that have a text layer are never read)', async () => {
      const path = invoicePdf('mixed book.pdf', 12)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 9 })
      await job.runOnce()
      await reindexNow(path)
      // what the index worker writes after each extraction (pages 3 and 4 hold their own text)
      const file = stat(path)
      store.ocr.saveScanInfo(path, file, {
        totalPages: 12,
        scannedPages: [1, 2, 5, 6, 7, 8, 9, 10, 11, 12],
      })
      await job.runOnce()
      await reindexNow(path)
      store.ocr.saveScanInfo(path, file, {
        totalPages: 12,
        scannedPages: [1, 2, 5, 6, 7, 8, 9, 10, 11, 12],
      })
      await job.runOnce()
      // the limit of 9 counts the pages that need OCR: the first nine of them, none of 3 and 4
      expect(present(path)).toEqual([1, 2, 5, 6, 7, 8, 9, 10, 11])
      expect(engine.calls).toBe(9)
      await reindexNow(path)
      const done = await job.runOnce()
      expect(done).toMatchObject({ files: 0, pages: 0 })
    })

    it('reads a scan whose scan info lists every page, up to the limit', async () => {
      const path = invoicePdf('book.pdf', 12)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 7 })
      await job.runOnce()
      await reindexNow(path)
      store.ocr.saveScanInfo(path, stat(path), {
        totalPages: 12,
        scannedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      })
      await job.runOnce()
      expect(present(path)).toEqual([1, 2, 3, 4, 5, 6, 7])
      await reindexNow(path)
      expect(await job.runOnce()).toMatchObject({ pages: 0 })
    })

    it('goes on with the slow pass when the only file of the quick queue is in a paused folder', async () => {
      const read = invoicePdf('read.pdf', 8)
      enrollEmpty(read)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 8 })
      await job.runOnce()
      await reindexNow(read)
      const { mkdirSync } = await import('node:fs')
      const { folderPauses } = await import('../src/main/document-memory/folder-pause')
      mkdirSync(join(dir, 'sub'))
      const waiting = invoicePdf('sub/unread.pdf', 4)
      enrollEmpty(waiting)
      folderPauses.replace([join(dir, 'sub')])
      try {
        // the quick queue holds one file, which is not to be read now: it must not hold back the rest
        const run = await job.runOnce()
        expect(run.pages).toBeGreaterThan(0)
        expect(present(read).length).toBeGreaterThan(2)
        expect(present(waiting)).toEqual([])
      } finally {
        folderPauses.replace([])
      }
    })

    it('goes on with the slow pass when the file of the quick queue is on a drive that is away', async () => {
      const read = invoicePdf('read.pdf', 8)
      enrollEmpty(read)
      const away = invoicePdf('away.pdf', 4)
      enrollEmpty(away)
      const engine = new ScriptedEngine(['good'])
      // only `read` can be reached: the quick pass reads its first pages, `away` waits for its drive
      const job = makeJob(engine, {
        light: 2,
        maxPages: 8,
        sourceAvailable: async (p) => p === read,
      })
      await job.runOnce()
      await reindexNow(read)
      expect((await job.runOnce()).pages).toBeGreaterThan(0)
      expect(present(read).length).toBeGreaterThan(2)
      expect(present(away)).toEqual([])
    })

    it('visits at most two files per run, so that a new file waits for no more than that', async () => {
      const paths = ['a', 'b', 'c', 'd'].map((n) => invoicePdf(`${n}.pdf`, 10))
      for (const path of paths) enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 10 })
      await job.runOnce()
      for (const path of paths) await reindexNow(path)
      const run = await job.runOnce()
      expect(run.files).toBe(REST_VISITS_PER_RUN)
      expect(paths.filter((p) => present(p).length > 2)).toHaveLength(REST_VISITS_PER_RUN)
    })

    it('does not run on battery, but the quick pass is not held back', async () => {
      const path = invoicePdf('battery.pdf', 8)
      enrollEmpty(path)
      let onBattery = true
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 8, onBattery: () => onBattery })
      expect(await job.runOnce()).toMatchObject({ pages: 2 }) // quick pass: as before
      await reindexNow(path)
      expect(await job.runOnce()).toMatchObject({ pages: 0 })
      expect(present(path)).toEqual([1, 2])
      onBattery = false
      expect((await job.runOnce()).pages).toBeGreaterThan(0)
    })

    it('stops between two pages when the charger is pulled out', async () => {
      const path = invoicePdf('unplug.pdf', 10)
      enrollEmpty(path)
      let onBattery = false
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 10, onBattery: () => onBattery })
      await job.runOnce()
      await reindexNow(path)
      const base = engine.calls
      const recognize = engine.recognizePage.bind(engine)
      engine.recognizePage = async () => {
        const r = await recognize()
        if (engine.calls - base === 1) onBattery = true
        return r
      }
      const run = await job.runOnce()
      expect(run.stoppedBecause).toBe('gate:on-battery')
      expect(present(path)).toEqual([1, 2, 3])
    })

    it('puts the pages it did read in the index when a later page fails for good, or the run is stopped', async () => {
      const path = invoicePdf('middle.pdf', 12)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const slow = makeJob(engine, { light: 2, maxPages: 12 })
      await slow.runOnce()
      await reindexNow(path)
      reindexed.length = 0
      const base = engine.calls
      const recognize = engine.recognizePage.bind(engine)
      engine.recognizePage = async () => {
        if (engine.calls - base === 3) {
          engine.calls++
          throw new Error('the engine cannot read this page')
        }
        return recognize()
      }
      const run = await slow.runOnce()
      expect(run.failed).toBe(1)
      expect(present(path)).toEqual([1, 2, 3, 4, 5]) // 3-5 were read before page 6 failed
      expect(reindexed).toEqual([path]) // so that they can be found, though the file is not finished

      // and a run that is stopped in the middle of a visit
      engine.recognizePage = recognize
      const other = invoicePdf('stopped.pdf', 12)
      enrollEmpty(other)
      await slow.runOnce()
      await reindexNow(other)
      reindexed.length = 0
      gateState = { ok: true }
      const again = engine.recognizePage.bind(engine)
      const mark = engine.calls
      engine.recognizePage = async () => {
        const r = await again()
        if (engine.calls - mark === 2) gateState = { ok: false, reason: 'user-active' }
        return r
      }
      const stopped = await slow.runOnce()
      expect(stopped.stoppedBecause).toBe('gate:user-active')
      expect(reindexed.length).toBeGreaterThan(0)
    })

    describe('pages of an earlier visit are put in the index when a later visit ends before it saves a page', () => {
      async function afterOneVisit(job: LocalOcrJob, path: string): Promise<void> {
        await job.runOnce() // the quick pass
        await reindexNow(path)
        reindexed.length = 0
        const visit = await job.runOnce() // pages 3-7: an ordinary visit, not put in the index
        expect(present(path)).toEqual([1, 2, 3, 4, 5, 6, 7])
        expect(visit.failed).toBe(0)
        expect(reindexed).toEqual([])
      }

      it('a gate that closes before the next visit saves anything', async () => {
        const path = invoicePdf('gate-first.pdf', 12)
        enrollEmpty(path)
        const job = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
        await afterOneVisit(job, path)
        gateState = { ok: false, reason: 'user-active' }
        // a new run, as the runner makes one for every batch
        const next = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
        expect((await next.runOnce()).stoppedBecause).toBe('gate:user-active')
        expect(reindexed).toEqual([path])
        gateState = { ok: true }
        expect((await next.runOnce()).pages).toBeGreaterThan(0) // and the file goes on
        await next.runOnce()
        expect(reindexed.filter((p) => p === path)).toHaveLength(2) // once at the stop, once when finished
      })

      it('an abort before the next visit saves anything', async () => {
        const path = invoicePdf('abort-first.pdf', 12)
        enrollEmpty(path)
        const job = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
        await afterOneVisit(job, path)
        const controller = new AbortController()
        controller.abort()
        const run = await makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 }).runOnce(
          {
            signal: controller.signal,
          },
        )
        expect(run.stoppedBecause).toBe('aborted')
        expect(reindexed).toEqual([path])
      })

      it('the engine fails for good on the first page of the next visit', async () => {
        const path = invoicePdf('engine-first.pdf', 12)
        enrollEmpty(path)
        const job = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
        await afterOneVisit(job, path)
        const failing = new ScriptedEngine(['good'])
        failing.fail = 'generic'
        const run = await makeJob(failing, { light: 2, maxPages: 12 }).runOnce()
        expect(run.failed).toBe(1)
        expect(present(path)).toEqual([1, 2, 3, 4, 5, 6, 7])
        expect(reindexed).toEqual([path])
      })

      it('the render of the next visit fails or does not answer', async () => {
        for (const answer of [{ ok: false, code: 'corrupt', message: 'damaged' } as const, null]) {
          reindexed.length = 0
          const path = invoicePdf(`render-${answer ? 'fail' : 'null'}.pdf`, 12)
          enrollEmpty(path)
          const job = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
          await afterOneVisit(job, path)
          let broken = false
          const next = makeJob(new ScriptedEngine(['good']), {
            light: 2,
            maxPages: 12,
            render: async (file, request) =>
              broken ? answer : renderPdfPagesForOcr(file, request),
          })
          broken = true
          const run = await next.runOnce()
          expect(run.failed).toBe(1)
          expect(reindexed).toEqual([path])
        }
      })

      it('the file is no longer wanted by the slow pass (the limit was lowered, but still above the quick pass)', async () => {
        const path = invoicePdf('lowered.pdf', 12)
        enrollEmpty(path)
        const job = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
        await afterOneVisit(job, path)
        const lowered = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 4 })
        const run = await lowered.runOnce()
        expect(run).toMatchObject({ files: 0, pages: 0 })
        expect(reindexed).toEqual([path])
        await lowered.runOnce()
        expect(reindexed).toEqual([path])
      })

      it('the file is on a drive that is away or in a paused folder', async () => {
        const path = invoicePdf('away-after.pdf', 12)
        enrollEmpty(path)
        const job = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
        await afterOneVisit(job, path)
        const away = makeJob(new ScriptedEngine(['good']), {
          light: 2,
          maxPages: 12,
          sourceAvailable: async () => false,
        })
        expect(await away.runOnce()).toMatchObject({ files: 0, pages: 0 })
        expect(reindexed).toEqual([path])
      })

      it('nothing more will be read now (on battery): what was read is indexed, once', async () => {
        const path = invoicePdf('battery-after.pdf', 12)
        enrollEmpty(path)
        const job = makeJob(new ScriptedEngine(['good']), { light: 2, maxPages: 12 })
        await afterOneVisit(job, path)
        const onBattery = makeJob(new ScriptedEngine(['good']), {
          light: 2,
          maxPages: 12,
          onBattery: () => true,
        })
        await onBattery.runOnce()
        expect(reindexed).toEqual([path])
        await onBattery.runOnce()
        expect(reindexed).toEqual([path]) // not again
      })
    })

    it('stops between two pages on an abort during the slow pass', async () => {
      const path = invoicePdf('abort-mid.pdf', 10)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 10 })
      await job.runOnce()
      await reindexNow(path)
      const controller = new AbortController()
      const base = engine.calls
      const recognize = engine.recognizePage.bind(engine)
      engine.recognizePage = async () => {
        const r = await recognize()
        if (engine.calls - base === 2) controller.abort()
        return r
      }
      const run = await job.runOnce({ signal: controller.signal })
      expect(run.stoppedBecause).toBe('aborted')
      expect(present(path)).toEqual([1, 2, 3, 4])
    })

    it('leaves a file above the size limit alone in the slow pass too, once', async () => {
      const path = invoicePdf('big.pdf', 6)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      await makeJob(engine, { light: 2, maxPages: 6 }).runOnce()
      await reindexNow(path)
      const calls = engine.calls
      const small = makeJob(engine, { light: 2, maxPages: 6, maxPdfBytes: 10 })
      expect(await small.runOnce()).toMatchObject({ skipped: 1, pages: 0 })
      expect(engine.calls).toBe(calls)
      expect(await small.runOnce()).toMatchObject({ files: 0, skipped: 0 })
    })

    it('does not run a slow pass when the limit is not above the quick pass', async () => {
      const path = invoicePdf('off.pdf', 6)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 2 })
      expect(job.restPages()).toBe(2)
      await job.runOnce()
      await reindexNow(path)
      await job.runOnce()
      expect(present(path)).toEqual([1, 2])
      expect(engine.calls).toBe(2)
    })

    it('never reads past the indexer page limit, and a small machine reads at most ten pages', () => {
      const engine = new ScriptedEngine(['good'])
      expect(makeJob(engine, { maxPages: 100, pdfPageLimit: () => 4 }).restPages()).toBe(4)
      expect(makeJob(engine, { maxPages: 100 }).restPages()).toBe(30) // the indexer default
      // text of pages after the 50th is never put in the index, so it is not read
      expect(makeJob(engine, { maxPages: 100, pdfPageLimit: () => 400 }).restPages()).toBe(50)
      expect(makeJob(engine, { maxPages: 45, pdfPageLimit: () => 400 }).restPages()).toBe(45)
      expect(
        makeJob(engine, { maxPages: 100, pdfPageLimit: () => 400, ramMB: 4096 }).restPages(),
      ).toBe(10)
      // a limit below the quick pass never shrinks the quick pass
      expect(makeJob(engine, { light: 3, maxPages: 1 }).restPages()).toBe(3)
      expect(makeJob(engine, { ramMB: 4096, maxPages: 1 }).restPages()).toBe(1)
    })

    it('waits for the quick pass: a file with unread first pages is served before the rest of an older one', async () => {
      const old = invoicePdf('old book.pdf', 8)
      enrollEmpty(old)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 8 })
      await job.runOnce()
      await reindexNow(old)
      const fresh = invoicePdf('new scan.pdf', 8)
      enrollEmpty(fresh)

      const run = await job.runOnce()
      expect(run).toMatchObject({ files: 1, pages: 2 })
      expect(present(fresh)).toEqual([1, 2])
      expect(present(old)).toEqual([1, 2]) // its later pages are for a run with an empty quick queue
      await reindexNow(fresh)
      await job.runOnce()
      expect(present(old).length).toBeGreaterThan(2)
    })

    it('stops at the next page when the gate closes, and picks up where it stopped', async () => {
      const path = invoicePdf('gate.pdf', 10)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 10 })
      await job.runOnce()
      await reindexNow(path)
      const base = engine.calls
      const recognize = engine.recognizePage.bind(engine)
      engine.recognizePage = async () => {
        const r = await recognize()
        if (engine.calls - base === 2) gateState = { ok: false, reason: 'user-active' }
        return r
      }
      const stopped = await job.runOnce()
      expect(stopped.stoppedBecause).toBe('gate:user-active')
      expect(present(path)).toEqual([1, 2, 3, 4])
      gateState = { ok: true }
      engine.recognizePage = recognize
      await reindexNow(path)
      await job.runOnce()
      expect(present(path).length).toBeGreaterThan(4)
    })

    it('stops at once on an aborted signal', async () => {
      const path = invoicePdf('abort.pdf', 10)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const job = makeJob(engine, { light: 2, maxPages: 10 })
      await job.runOnce()
      await reindexNow(path)
      const controller = new AbortController()
      controller.abort()
      const run = await job.runOnce({ signal: controller.signal })
      expect(run).toMatchObject({ pages: 0, stoppedBecause: 'aborted' })
      expect(present(path)).toEqual([1, 2])
    })

    it('pauses twice after each page, once more than the quick pass (one pause is capped by the duty cycle)', async () => {
      const path = invoicePdf('pause.pdf', 8)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good'])
      const durations: number[] = []
      const job = makeJob(engine, {
        light: 2,
        maxPages: 8,
        coolDown: async (ms) => void durations.push(ms),
      })
      // a clock that moves 10 ms at every reading: the time of a page is the same in both passes
      let clock = 0
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10))
      try {
        await job.runOnce()
        const quick = durations.splice(0)
        await reindexNow(path)
        await job.runOnce()
        expect(quick).toHaveLength(2)
        expect(REST_COOL_FACTOR).toBe(2)
        expect(durations).toHaveLength(5 * REST_COOL_FACTOR)
        // (the first page of a visit also counts the time of the render, so the second page is compared)
        expect(durations[2]).toBe(quick[1]!)
        expect(durations[3]).toBe(quick[1]!)
      } finally {
        spy.mockRestore()
      }
    })

    it('flags a poorly read later page for the cloud like a page of the quick pass, and keeps the sensitive-text rule', async () => {
      const path = invoicePdf('mixed.pdf', 6)
      enrollEmpty(path)
      const engine = new ScriptedEngine(['good', 'good', 'bad', 'id', 'good'])
      const job = makeJob(engine, { light: 2, maxPages: 6 })
      await job.runOnce()
      await reindexNow(path)
      await job.runOnce()
      const { mtimeMs, sizeBytes } = stat(path)
      expect(store.ocr.escalatedPages(path, mtimeMs, sizeBytes)).toEqual([3]) // 'id' text never goes to the cloud
      expect(present(path)).toEqual([1, 2, 3, 4, 5, 6])
    })
  })

  it('cloud selection is exactly the escalated page; its text replaces the local text', async () => {
    const path = invoicePdf('scan 0002.pdf', 5)
    enrollEmpty(path)
    await makeJob(new ScriptedEngine(['good', 'bad'])).runOnce()
    await reindexNow(path)
    const { mtimeMs, sizeBytes } = stat(path)
    expect(store.ocr.pagesDone(path, mtimeMs, sizeBytes)).toEqual([1])
    expect(store.ocr.escalatedPages(path, mtimeMs, sizeBytes)).toEqual([2])

    const host = createOcrHost({
      store,
      isEnabled: () => true,
      reindex: () => undefined,
      renderInWorker: async () => null,
    })
    const rows = host.candidates(40)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path, totalPages: 5, skipPages: [1, 3, 4, 5] })
    // what the cloud job feeds its batch planner (agy-ocr-job.ts processFile): exactly page 2
    const done = new Set([
      ...host.pagesDone(path, mtimeMs, sizeBytes),
      ...(rows[0]!.skipPages ?? []),
    ])
    expect(
      planOcrBatch({ totalPages: 5, done, maxPagesPerFile: 40, pagesPerCall: 5, budget: 5 }),
    ).toEqual([2])

    // the cloud reads it: the row becomes cloud, the file leaves the list
    store.ocr.savePages(
      path,
      { hash: hashOf(path), mtimeMs, sizeBytes, totalPages: 5, model: 'gemini' },
      [{ page: 2, text: 'Tổng cộng 4.919.750 đồng' }],
    )
    expect(store.ocr.pageTier(path, 2)).toMatchObject({ tier: 'cloud', escalate: false })
    expect(host.candidates(40)).toEqual([])
  })

  it('a one-page PDF whose only page was escalated stays cloud work after the local text was indexed', async () => {
    const path = invoicePdf('one page.pdf', 1)
    enrollEmpty(path)
    await makeJob(new ScriptedEngine(['bad'])).runOnce()
    // junk text still produced chunks, so the document is no longer "empty" ...
    await reindexNow(path)
    expect(store.documentByPath(path)!.status).toBe('text-only')
    expect(store.documentByPath(path)!.truncated).toBeFalsy()
    // ... yet the cloud reader is offered the page
    expect(store.ocr.candidates(40).map((r) => r.path)).toEqual([path])
  })

  it('privacy: sensitive files are read locally but are never cloud work, whatever the score', async () => {
    const named = invoicePdf('cccd nguyen van a.pdf', 2)
    const neutral = invoicePdf('scan0001.pdf', 2)
    enrollEmpty(named)
    enrollEmpty(neutral)
    // the neutral name hides an identity card: the recognised text gives it away (page 1), page 2 is unremarkable junk
    // the newest file (scan0001) is read first
    const summary = await makeJob(new ScriptedEngine(['id', 'bad', 'bad', 'bad'])).runOnce()
    expect(summary.files).toBe(2)
    expect(summary.pages).toBe(4)
    for (const path of [named, neutral])
      expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([1, 2])
    // named sensitive file: nothing escalated even though every score is terrible
    expect(store.ocr.escalatedPages(named, stat(named).mtimeMs, stat(named).sizeBytes)).toEqual([])
    // neutral name, ID text on page 1: page 1 never escalates, junk page 2 does
    expect(
      store.ocr.escalatedPages(neutral, stat(neutral).mtimeMs, stat(neutral).sizeBytes),
    ).toEqual([2])
    const cloud = store.ocr.candidates(40).map((row) => row.path)
    expect(cloud).not.toContain(named)
    expect(store.ocr.candidates(40, { includeSensitive: false }).map((r) => r.path)).not.toContain(
      named,
    )
    expect(store.ocr.candidates(40, { mode: 'cloud-all' }).map((r) => r.path)).not.toContain(named)
  })

  it('never sends images or sensitive images anywhere but the local engine; images are marked done once', async () => {
    const receipt = enrollImage('receipt.png')
    const passport = enrollImage('passport.png')
    const engine = new ScriptedEngine(['good', 'bad'])
    const summary = await makeJob(engine).runOnce()
    expect(summary).toMatchObject({ files: 2, pages: 2 })
    const states = Object.fromEntries(
      (
        store.rawDb
          .prepare(
            'SELECT d.path AS path, m.ocr_state AS state FROM document_media m JOIN documents d ON d.id = m.document_id',
          )
          .all() as unknown as Array<{ path: string; state: number }>
      ).map((r) => [r.path, r.state]),
    )
    expect(states[receipt]).toBe(IMAGE_OCR_STATE.done)
    expect(states[passport]).toBe(IMAGE_OCR_STATE.done)
    expect(store.ocr.pageTier(receipt, 1)).toMatchObject({ tier: 'local' })
    expect(store.ocr.pageTier(passport, 1)).toMatchObject({ tier: 'local', escalate: false }) // sensitive name: never escalated
    // the cloud paths see none of it
    expect(selectImageOcrCandidates(store.rawDb, { engine: 'cloud' })).toEqual([])
    expect(selectImageOcrCandidates(store.rawDb, { engine: 'cloud', cloudOptIn: true })).toEqual([]) // done anyway
    expect(store.ocr.candidates(40, { includeSensitive: true, mode: 'cloud-all' })).toEqual([])
    // idempotent: a second run does not call the engine again
    const again = await makeJob(engine).runOnce()
    expect(again).toMatchObject({ files: 0, pages: 0 })
    expect(engine.calls).toBe(2)
  })

  it('refuses to start any engine when free RAM is too low (real registry), and records nothing', async () => {
    const path = invoicePdf('low ram.pdf', 2)
    enrollEmpty(path)
    const registry = new LocalOcrEngineRegistry({ platform: 'linux', freeRamMB: () => 120 })
    const job = makeJob(null, { registry })
    const summary = await job.runOnce()
    expect(summary).toMatchObject({ files: 0, pages: 0, stoppedBecause: 'no-engine' })
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([])
    expect(store.ocr.localFailure(path)).toBeNull() // it will simply try again later
  })

  it('a machine with 4 GB or less reads one page per file', async () => {
    const path = invoicePdf('small machine.pdf', 3)
    enrollEmpty(path)
    const engine = new ScriptedEngine(['good'])
    const job = makeJob(engine, { ramMB: 4096 })
    expect(job.lightPages()).toBe(1)
    await job.runOnce()
    expect(engine.calls).toBe(1)
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([1])
  })

  it('respects the idle / AC / pause gate between pages and resumes where it stopped', async () => {
    const path = invoicePdf('resume.pdf', 4)
    enrollEmpty(path)
    const engine = new ScriptedEngine(['good'])
    let allowed = 1
    const job = makeJob(engine, {
      gate: () => (allowed-- > 0 ? { ok: true } : { ok: false, reason: 'not-idle' }),
    })
    // the file-level check consumes one gate call, the first page another: the second page is held back
    const first = await job.runOnce()
    expect(first.stoppedBecause).toBe('gate:not-idle')
    expect(first.pages).toBe(0)
    gateState = { ok: true }
    allowed = 100
    const second = await makeJob(engine).runOnce()
    expect(second).toMatchObject({ pages: 2 })
    // a third run finds nothing left: no engine call
    const calls = engine.calls
    expect(await makeJob(engine).runOnce()).toMatchObject({ pages: 0, files: 0 })
    expect(engine.calls).toBe(calls)
  })

  it('stops after page 1 when the gate closes mid-file and a later run reads only the missing page', async () => {
    const path = invoicePdf('midway.pdf', 4)
    enrollEmpty(path)
    const engine = new ScriptedEngine(['good'])
    let gateCalls = 0
    const job = makeJob(engine, {
      gate: () => (++gateCalls <= 2 ? { ok: true } : { ok: false, reason: 'on-battery' }),
    })
    const first = await job.runOnce()
    expect(first.stoppedBecause).toBe('gate:on-battery')
    expect(first.pages).toBe(1)
    expect(reindexed).toEqual([path]) // what was read is indexed even though the run stopped
    const second = await makeJob(engine).runOnce()
    expect(second.pages).toBe(1)
    expect(engine.calls).toBe(2)
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([1, 2])
  })

  it('a refused write (storage budget) ends the run without recording a failure or losing the file', async () => {
    const path = invoicePdf('quota.pdf', 2)
    enrollEmpty(path)
    saveResult = { ok: false, error: 'quota-denied' }
    const summary = await makeJob(new ScriptedEngine(['good'])).runOnce()
    expect(summary.stoppedBecause).toBe('storage-denied')
    expect(store.ocr.localFailure(path)).toBeNull()
    saveResult = { ok: true }
    expect((await makeJob(new ScriptedEngine(['good'])).runOnce()).pages).toBe(2)
  })

  it('engine errors are counted per file version and stop after the limit; an unavailable engine just ends the run', async () => {
    const path = invoicePdf('flaky.pdf', 2)
    enrollEmpty(path)
    const engine = new ScriptedEngine(['good'])
    engine.fail = 'generic'
    for (let attempt = 1; attempt <= LOCAL_OCR_MAX_ATTEMPTS; attempt++) {
      const summary = await makeJob(engine).runOnce()
      expect(summary.failed).toBe(1)
      expect(store.ocr.localFailure(path)!.attempts).toBe(attempt)
    }
    expect((await makeJob(engine).runOnce()).files).toBe(0) // given up on this version of the file
    expect(store.ocr.candidates(2, { mode: 'local', includeSensitive: true })).toEqual([])

    const other = invoicePdf('unavailable.pdf', 2)
    enrollEmpty(other)
    const gone = new ScriptedEngine(['good'])
    gone.fail = 'unavailable'
    expect((await makeJob(gone).runOnce()).stoppedBecause).toBe('no-engine')
    expect(store.ocr.localFailure(other)).toBeNull()
  })

  it('unreadable PDFs (password, damaged) are marked permanent and never retried; the cloud may take over unread files only when asked to', async () => {
    const fixtures = join(__dirname, 'fixtures')
    const enc = join(dir, 'locked.pdf')
    const bad = join(dir, 'damaged.pdf')
    copyFileSync(join(fixtures, 'certEncrypted.pdf'), enc)
    copyFileSync(join(fixtures, 'corruptExample.pdf'), bad)
    enrollEmpty(enc)
    enrollEmpty(bad)
    const unread = invoicePdf('later.pdf', 1)
    enrollEmpty(unread)
    // before the local pass: a cloud pass that defers to local sees nothing, a plain cloud pass sees everything
    expect(store.ocr.candidates(40, { leaveToLocal: true })).toEqual([])
    expect(store.ocr.candidates(40)).toHaveLength(3)
    const engine = new ScriptedEngine(['good'])
    const summary = await makeJob(engine).runOnce()
    expect(summary.failed).toBe(2)
    expect(store.ocr.localFailure(enc)!.attempts).toBe(LOCAL_OCR_MAX_ATTEMPTS)
    expect(store.ocr.localFailure(bad)!.attempts).toBe(LOCAL_OCR_MAX_ATTEMPTS)
    const again = await makeJob(engine).runOnce()
    expect(again.files).toBe(0)
  })

  it('does nothing when switched off, and logs carry no text or file names', async () => {
    const path = invoicePdf('Công ty ABC secret name.pdf', 2)
    enrollEmpty(path)
    const off = makeJob(new ScriptedEngine(['good']), {
      settings: () => ({ enabled: false, lightPages: 2, maxPages: 2, engine: 'auto' }),
    })
    expect((await off.runOnce()).stoppedBecause).toBe('disabled')
    const engine = new ScriptedEngine(['good', 'bad'])
    engine.fail = 'none'
    await makeJob(engine).runOnce()
    const logged = JSON.stringify(events)
    expect(events.filter((e) => e.kind === 'page')).toHaveLength(2)
    for (const secret of ['Viettel', '0433', 'Công ty', 'secret name', dir, 'xcvb'])
      expect(logged).not.toContain(secret)
    // a failing engine whose message contains a name: the event still carries only a code
    const flaky = invoicePdf('another secret.pdf', 1)
    enrollEmpty(flaky)
    const broken = new ScriptedEngine(['good'])
    broken.fail = 'generic'
    events = []
    await makeJob(broken).runOnce()
    expect(JSON.stringify(events)).not.toContain('SECRET-NAME')
    expect(JSON.stringify(events)).toContain('engine-error')
  })
})

describe('LocalOcrJob with the real Tesseract engine end to end', () => {
  it('OCRs a rendered scanned PDF, stores it as a local row, and search finds the file by the text', async () => {
    const path = invoicePdf('Viettel.pdf', 1)
    enrollEmpty(path)
    const registry = new LocalOcrEngineRegistry({ platform: 'linux', freeRamMB: () => 8000 })
    const started = performance.now()
    const summary = await makeJob(null, { registry }).runOnce()
    const seconds = (performance.now() - started) / 1000
    await registry.disposeAll()
    expect(summary).toMatchObject({ files: 1, pages: 1, failed: 0 })
    expect(store.ocr.pageTier(path, 1)).toMatchObject({ tier: 'local', engine: 'tesseract-vie' })
    await reindexNow(path)
    expect(store.searchLexical('Viettel Tien Giang').length).toBeGreaterThan(0)
    expect(store.searchLexical('0433').length).toBeGreaterThan(0)
    expect(seconds).toBeLessThan(30)
  }, 60_000)
})

function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('OCR Pipeline Repair Round 2: PDF fallback and persistence regression', () => {
  it('OCR2-PDF-03 & OCR2-PDF-04: Fallback image is genuinely recognized, persisted and searchable', async () => {
    const path = invoicePdf('fallback-success.pdf', 1)
    enrollEmpty(path)

    let calls = 0
    const engine: LocalOcrEngine = {
      id: 'tesseract-vie',
      descriptor: {
        id: 'tesseract-vie',
        name: 'test',
        platforms: 'all',
        minFreeRamMB: 1,
        dpi: 150,
        escalationThreshold: 0.5,
        license: 'test',
        available: true,
        notes: '',
      },
      isAvailable: () => true,
      recognizePage: async () => {
        calls++
        if (calls === 1) {
          throw new Error('Error attempting to read image.')
        }
        return recognition('good')
      },
      dispose: async () => {},
    }

    const summary = await makeJob(engine).runOnce()
    expect(summary).toMatchObject({ files: 1, pages: 1, failed: 0 })
    expect(calls).toBe(2)
    expect(events.some((e) => e.kind === 'file-failed' && e.code === 'embedded-decode-error')).toBe(
      true,
    )

    const text = store.ocr.pageTier(path, 1)
    expect(text).not.toBeNull()
    expect(text?.tier).toBe('local')

    await reindexNow(path)
    expect(store.searchLexical('Viettel').length).toBeGreaterThan(0)
    expect(store.searchLexical('0433').length).toBeGreaterThan(0)
  })

  it('OCR2-PDF-05: Unrecoverable page fails without infinite retry', async () => {
    const path = invoicePdf('unrecoverable.pdf', 1)
    enrollEmpty(path)

    let calls = 0
    const engine: LocalOcrEngine = {
      id: 'tesseract-vie',
      descriptor: {
        id: 'tesseract-vie',
        name: 'test',
        platforms: 'all',
        minFreeRamMB: 1,
        dpi: 150,
        escalationThreshold: 0.5,
        license: 'test',
        available: true,
        notes: '',
      },
      isAvailable: () => true,
      recognizePage: async () => {
        calls++
        throw new Error('Error attempting to read image.')
      },
      dispose: async () => {},
    }

    const summary = await makeJob(engine).runOnce()
    expect(summary.failed).toBe(1)
    expect(calls).toBe(2)
    expect(store.ocr.localFailure(path)?.attempts).toBe(1)
  })

  it('OCR2-PDF-06: Successful earlier pages remain persisted when later page fails', async () => {
    const path = invoicePdf('partial.pdf', 2)
    enrollEmpty(path)

    let calls = 0
    const engine: LocalOcrEngine = {
      id: 'tesseract-vie',
      descriptor: {
        id: 'tesseract-vie',
        name: 'test',
        platforms: 'all',
        minFreeRamMB: 1,
        dpi: 150,
        escalationThreshold: 0.5,
        license: 'test',
        available: true,
        notes: '',
      },
      isAvailable: () => true,
      recognizePage: async () => {
        calls++
        if (calls === 1) return recognition('good')
        throw new Error('Unrecoverable failure on page 2')
      },
      dispose: async () => {},
    }

    const summary = await makeJob(engine).runOnce()
    expect(summary.pages).toBe(1)
    expect(summary.failed).toBe(1)
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toContain(1)
  })

  it('OCR2-PDF-08: Input modification during retry prevents stale OCR persistence', async () => {
    const path = invoicePdf('modified.pdf', 1)
    enrollEmpty(path)

    const engine: LocalOcrEngine = {
      id: 'tesseract-vie',
      descriptor: {
        id: 'tesseract-vie',
        name: 'test',
        platforms: 'all',
        minFreeRamMB: 1,
        dpi: 150,
        escalationThreshold: 0.5,
        license: 'test',
        available: true,
        notes: '',
      },
      isAvailable: () => true,
      recognizePage: async () => {
        throw new Error('Error attempting to read image.')
      },
      dispose: async () => {},
    }

    const job = makeJob(engine, {
      render: async (p, req) => {
        if (req.retryRenderedPage) {
          writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from('\n%modified')]))
        }
        return renderPdfPagesForOcr(p, req)
      },
    })

    const summary = await job.runOnce()
    expect(summary.failed).toBe(1)
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([])
  })

  it('Image: FileChangedDuringReadError safely skips file and logs file-modified', async () => {
    const imgPath = enrollImage('concurrent.png')

    const engine = new ScriptedEngine(['good'])
    const job = makeJob(engine, {
      readImage: async (p) => {
        throw new FileChangedDuringReadError(p)
      },
    })

    const summary = await job.runOnce()
    expect(summary.skipped).toBe(1)
    expect(summary.failed).toBe(0)
    expect(events.some((e) => e.kind === 'file-skipped' && e.code === 'file-modified')).toBe(true)

    const states = store.rawDb
      .prepare(
        'SELECT ocr_state AS state FROM document_media WHERE document_id = (SELECT id FROM documents WHERE path = ?)',
      )
      .get(imgPath) as { state: number } | undefined
    expect(states?.state).not.toBe(IMAGE_OCR_STATE.failed)
  })

  it('Image: Unsupported HEIC format marks skipped and logs unsupported-image-format', async () => {
    const heicPath = join(dir, 'photo.heic')
    const heicBytes = Buffer.concat([
      Buffer.from([
        0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66,
        0x31,
      ]),
      Buffer.alloc(20_000),
    ])
    writeFileSync(heicPath, heicBytes)
    const st = statSync(heicPath)
    store.enrollMedia(heicPath, st.mtimeMs, st.size)

    let engineCalled = false
    const engine: LocalOcrEngine = {
      id: 'tesseract-vie',
      descriptor: {
        id: 'tesseract-vie',
        name: 'test',
        platforms: 'all',
        minFreeRamMB: 1,
        dpi: 150,
        escalationThreshold: 0.5,
        license: 'test',
        available: true,
        notes: '',
      },
      isAvailable: () => true,
      recognizePage: async () => {
        engineCalled = true
        return recognition('good')
      },
      dispose: async () => {},
    }

    const summary = await makeJob(engine).runOnce()
    expect(engineCalled).toBe(false)
    expect(summary.failed).toBe(1)
    expect(
      events.some((e) => e.kind === 'file-failed' && e.code === 'unsupported-image-format'),
    ).toBe(true)

    const states = store.rawDb
      .prepare(
        'SELECT ocr_state AS state FROM document_media WHERE document_id = (SELECT id FROM documents WHERE path = ?)',
      )
      .get(heicPath) as { state: number } | undefined
    expect(states?.state).toBe(IMAGE_OCR_STATE.skipped)
  })

  it('Image & Store: Valid image OCR persists and survives store restart', async () => {
    const imgPath = enrollImage('invoice-persisted.png')
    const registry = new LocalOcrEngineRegistry({ platform: 'linux', freeRamMB: () => 8000 })

    const summary = await makeJob(null, { registry }).runOnce()
    await registry.disposeAll()
    expect(summary.files).toBe(1)
    expect(summary.failed).toBe(0)

    await reindexNow(imgPath)
    expect(store.searchLexical('Viettel').length).toBeGreaterThan(0)

    const dbPath = join(dir, 'memory.sqlite')
    store.close()

    const reopenedStore = new DocumentMemoryStore(dbPath)
    try {
      const hits = reopenedStore.searchLexical('Viettel')
      expect(hits.length).toBeGreaterThan(0)
      expect(reopenedStore.documentById(hits[0]!.documentId)?.path).toBe(imgPath)
    } finally {
      reopenedStore.close()
    }
  }, 60_000)

  it('OCR-E2E-REAL: Scanned PDF rendered via PDFium -> real Tesseract recognition -> SQLite persistence -> FTS search -> restart -> search', async () => {
    const pdfPath = invoicePdf('e2e-scanned-real.pdf', 1)
    enrollEmpty(pdfPath)
    const registry = new LocalOcrEngineRegistry({ platform: 'linux', freeRamMB: () => 8000 })

    const summary = await makeJob(null, { registry }).runOnce()
    await registry.disposeAll()
    expect(summary.files).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.pages).toBe(1)

    await reindexNow(pdfPath)
    const hits = store.searchLexical('Viettel')
    expect(hits.length).toBeGreaterThan(0)
    expect(store.documentById(hits[0]!.documentId)?.path).toBe(pdfPath)

    const dbPath = join(dir, 'memory.sqlite')
    store.close()

    const reopenedStore = new DocumentMemoryStore(dbPath)
    try {
      const reopenedHits = reopenedStore.searchLexical('Viettel')
      expect(reopenedHits.length).toBeGreaterThan(0)
      expect(reopenedStore.documentById(reopenedHits[0]!.documentId)?.path).toBe(pdfPath)
    } finally {
      reopenedStore.close()
    }
  }, 60_000)
})
