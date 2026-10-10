import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planOcrBatch } from '@genoffice/ai-provider/agy-ocr'
import { renderPdfPagesForOcr } from '../src/main/document-memory/agy-ocr-render'
import { createOcrHost } from '../src/main/document-memory/ocr-host'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { decodePngGray } from '../src/main/document-memory/local-ocr/gray-image'
import {
  LocalOcrJob,
  FileChangedDuringReadError,
  type LocalOcrEvent,
  type LocalOcrJobDeps,
} from '../src/main/document-memory/local-ocr/local-ocr-job'
import { LocalOcrEngineRegistry } from '../src/main/document-memory/local-ocr/registry'
import { IMAGE_OCR_STATE, selectImageOcrCandidates } from '../src/main/document-memory/media/media-ocr-gate'
import { OcrSidecar, LOCAL_OCR_MAX_ATTEMPTS } from '../src/main/document-memory/ocr-sidecar'
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
const ID_TEXT = 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM CĂN CƯỚC CÔNG DÂN Số định danh cá nhân Họ và tên'

type Script = 'good' | 'bad' | 'id' | 'blank'

function recognition(kind: Script): LocalOcrRecognition {
  const text = kind === 'good' ? GOOD_TEXT : kind === 'bad' ? BAD_TEXT : kind === 'id' ? ID_TEXT : ''
  const confidence = kind === 'good' ? 0.95 : kind === 'blank' ? 0 : 0.9
  const tokens: LocalOcrToken[] = text ? text.split(/\s+/).map((word) => ({ text: word, confidence })) : []
  return { text, meanConfidence: confidence, tokens, ms: 7 }
}

class ScriptedEngine implements LocalOcrEngine {
  readonly id = 'apple-vision' // judged with Vision's 0.73 threshold
  readonly descriptor = {
    id: 'apple-vision', name: 'double', platforms: 'all' as const, minFreeRamMB: 1, dpi: 100,
    escalationThreshold: 0.73, license: 'test', available: true, notes: '',
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
    Array.from({ length: pages }, (_, i) => ({ jpeg: i === 0 ? jpeg : other, width: gray.width, height: gray.height })),
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

function makeJob(engine: LocalOcrEngine | null, overrides: Partial<LocalOcrJobDeps> & { light?: number; ramMB?: number } = {}) {
  const { light = 2, ramMB = 16_000, ...rest } = overrides
  const deps: LocalOcrJobDeps = {
    db: store.rawDb,
    settings: () => ({ enabled: true, lightPages: light, engine: 'auto' }),
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
    db.prepare("INSERT INTO ocr_pages(path, page, hash, mtime_ms, size_bytes, total_pages, text) VALUES ('/a.pdf', 1, 'h', 1, 2, 3, 'old')").run()
    OcrSidecar.ensureSchema(db)
    OcrSidecar.ensureSchema(db) // idempotent
    const sidecar = new OcrSidecar(db)
    expect(sidecar.pageTier('/a.pdf', 1)).toEqual({ tier: 'cloud', engine: null, quality: null, escalate: false })
    expect(sidecar.pagesDone('/a.pdf', 1, 2)).toEqual([1])
  })

  it('a local row is done unless it was escalated; cloud text replaces local text and local never replaces cloud', () => {
    const path = join(dir, 'x.pdf')
    const meta = { hash: 'h', mtimeMs: 1, sizeBytes: 2, totalPages: 4 }
    store.ocr.savePages(path, { ...meta, tier: 'local', engine: 'e', quality: 0.9, escalate: false, model: 'local:e' }, [{ page: 1, text: 'good local' }])
    store.ocr.savePages(path, { ...meta, tier: 'local', engine: 'e', quality: 0.2, escalate: true, model: 'local:e' }, [{ page: 2, text: 'bad local' }])
    expect(store.ocr.pagesDone(path, 1, 2)).toEqual([1])
    expect(store.ocr.pagesPresent(path, 1, 2)).toEqual([1, 2])
    expect(store.ocr.escalatedPages(path, 1, 2)).toEqual([2])
    expect(store.ocr.pageTier(path, 2)).toEqual({ tier: 'local', engine: 'e', quality: 0.2, escalate: true })

    store.ocr.savePages(path, { ...meta, model: 'gemini' }, [{ page: 2, text: 'cloud text' }])
    expect(store.ocr.pageTier(path, 2)).toEqual({ tier: 'cloud', engine: null, quality: null, escalate: false })
    expect(store.ocr.pagesDone(path, 1, 2)).toEqual([1, 2])
    expect(store.ocr.pages(path, 'h')!.pages.find((p) => p.page === 2)!.text).toBe('cloud text')

    // a later local pass over the same page must not overwrite what the cloud read
    store.ocr.savePages(path, { ...meta, tier: 'local', engine: 'e', quality: 0.1, escalate: true }, [{ page: 2, text: 'worse local' }])
    expect(store.ocr.pages(path, 'h')!.pages.find((p) => p.page === 2)!.text).toBe('cloud text')
    expect(store.ocr.pageTier(path, 2)!.tier).toBe('cloud')
  })
})

describe('LocalOcrJob on scanned PDFs (real SQLite, real PDFium render, engine double)', () => {
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
    expect(store.ocr.pageTier(path, 1)).toMatchObject({ tier: 'local', engine: 'apple-vision', escalate: false })
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

  it('cloud selection is exactly the escalated page; its text replaces the local text', async () => {
    const path = invoicePdf('scan 0002.pdf', 5)
    enrollEmpty(path)
    await makeJob(new ScriptedEngine(['good', 'bad'])).runOnce()
    await reindexNow(path)
    const { mtimeMs, sizeBytes } = stat(path)
    expect(store.ocr.pagesDone(path, mtimeMs, sizeBytes)).toEqual([1])
    expect(store.ocr.escalatedPages(path, mtimeMs, sizeBytes)).toEqual([2])

    const host = createOcrHost({ store, isEnabled: () => true, reindex: () => undefined, renderInWorker: async () => null })
    const rows = host.candidates(40)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path, totalPages: 5, skipPages: [1, 3, 4, 5] })
    // what the cloud job feeds its batch planner (agy-ocr-job.ts processFile): exactly page 2
    const done = new Set([...host.pagesDone(path, mtimeMs, sizeBytes), ...(rows[0]!.skipPages ?? [])])
    expect(planOcrBatch({ totalPages: 5, done, maxPagesPerFile: 40, pagesPerCall: 5, budget: 5 })).toEqual([2])

    // the cloud reads it: the row becomes cloud, the file leaves the list
    store.ocr.savePages(path, { hash: hashOf(path), mtimeMs, sizeBytes, totalPages: 5, model: 'gemini' }, [
      { page: 2, text: 'Tổng cộng 4.919.750 đồng' },
    ])
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
    for (const path of [named, neutral]) expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([1, 2])
    // named sensitive file: nothing escalated even though every score is terrible
    expect(store.ocr.escalatedPages(named, stat(named).mtimeMs, stat(named).sizeBytes)).toEqual([])
    // neutral name, ID text on page 1: page 1 never escalates, junk page 2 does
    expect(store.ocr.escalatedPages(neutral, stat(neutral).mtimeMs, stat(neutral).sizeBytes)).toEqual([2])
    const cloud = store.ocr.candidates(40).map((row) => row.path)
    expect(cloud).not.toContain(named)
    expect(store.ocr.candidates(40, { includeSensitive: false }).map((r) => r.path)).not.toContain(named)
    expect(store.ocr.candidates(40, { mode: 'cloud-all' }).map((r) => r.path)).not.toContain(named)
  })

  it('never sends images or sensitive images anywhere but the local engine; images are marked done once', async () => {
    const receipt = enrollImage('receipt.png')
    const passport = enrollImage('passport.png')
    const engine = new ScriptedEngine(['good', 'bad'])
    const summary = await makeJob(engine).runOnce()
    expect(summary).toMatchObject({ files: 2, pages: 2 })
    const states = Object.fromEntries(
      (store.rawDb.prepare('SELECT d.path AS path, m.ocr_state AS state FROM document_media m JOIN documents d ON d.id = m.document_id').all() as unknown as Array<{ path: string; state: number }>).map((r) => [r.path, r.state]),
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
    const job = makeJob(engine, { gate: () => (++gateCalls <= 2 ? { ok: true } : { ok: false, reason: 'on-battery' }) })
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
    const off = makeJob(new ScriptedEngine(['good']), { settings: () => ({ enabled: false, lightPages: 2, engine: 'auto' }) })
    expect((await off.runOnce()).stoppedBecause).toBe('disabled')
    const engine = new ScriptedEngine(['good', 'bad'])
    engine.fail = 'none'
    await makeJob(engine).runOnce()
    const logged = JSON.stringify(events)
    expect(events.filter((e) => e.kind === 'page')).toHaveLength(2)
    for (const secret of ['Viettel', '0433', 'Công ty', 'secret name', dir, 'xcvb']) expect(logged).not.toContain(secret)
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
    expect(events.some((e) => e.kind === 'file-failed' && e.code === 'embedded-decode-error')).toBe(true)

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
      .prepare('SELECT ocr_state AS state FROM document_media WHERE document_id = (SELECT id FROM documents WHERE path = ?)')
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
    expect(events.some((e) => e.kind === 'file-failed' && e.code === 'unsupported-image-format')).toBe(true)

    const states = store.rawDb
      .prepare('SELECT ocr_state AS state FROM document_media WHERE document_id = (SELECT id FROM documents WHERE path = ?)')
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
})
