import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderPdfPagesForOcr } from '../src/main/document-memory/agy-ocr-render'
import { AgyOcrJob, type OcrJobHost } from '../src/main/document-memory/agy-ocr-job'
import { OcrStateStore } from '../src/main/document-memory/agy-ocr-state'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { IMAGE_OCR_STATE } from '../src/main/document-memory/media/media-ocr-gate'
import { decodePngGray } from '../src/main/document-memory/local-ocr/gray-image'
import { LocalOcrEngineRegistry } from '../src/main/document-memory/local-ocr/registry'
import { prepareForTesseract } from '../src/main/document-memory/local-ocr/tesseract-prepare'
import { TESSERACT_ENGINE_ID } from '../src/main/document-memory/local-ocr/tesseract-engine'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { extractDocument } from '../src/main/document-memory/worker'
import type {
  LocalOcrEngine,
  LocalOcrRecognition,
} from '../src/main/document-memory/runtime/local-ocr-engine'
import type { LocalOcrSettings } from '../src/main/document-memory/../../shared/fork/agy-ocr'
import { publishIndexingPolicy, resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import { bundleIndexWorker, realIndexWorkerFactory } from './helpers/index-worker-process'
import { buildScannedPdf, testPattern } from './helpers/scanned-pdf'
import { storageBudgetAckReply, waitForManagerWriteReady } from './helpers/storage-budget-ack'

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'))
const GOOD_TEXT =
  'HÓA ĐƠN GIÁ TRỊ GIA TĂNG\nSố: 0433 Ngày 15 tháng 09 năm 2025\nĐơn vị bán hàng: Công ty TNHH Viettel Tiền Giang\nMã số thuế: 0101234567'
const BAD_TEXT = 'xcvb ttirrn qwrty hhhh lllii vnmz kkkp wwwq zzzx'

let dir: string
let manager: DocumentMemoryManager | undefined
let reader: DocumentMemoryStore | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-local-ocr-wiring-'))
})
afterEach(() => {
  resetIndexingPolicyBus()
  manager?.close()
  reader?.close()
  manager = undefined
  reader = undefined
  rmSync(dir, { recursive: true, force: true })
})

/** The index process in-process: real extraction (with the OCR lookup), real rendering, real image preparation. */
class InProcessWorker extends EventEmitter {
  prepared = 0
  constructor(private readonly dbPath: string) {
    super()
  }
  postMessage(message: {
    id: number
    type: string
    path?: string
    texts?: string[]
    ocr?: never
    bytes?: Uint8Array
    dpi?: number
  }) {
    setTimeout(async () => {
      try {
        const ack = storageBudgetAckReply(message)
        if (ack) return void this.emit('message', ack)
        if (message.type === 'extract') {
          const store = new DocumentMemoryStore(this.dbPath)
          try {
            this.emit('message', {
              id: message.id,
              result: await extractDocument(message.path!, (p, h) => store.ocr.pages(p, h)),
            })
          } finally {
            store.close()
          }
        } else if (message.type === 'ocr-render') {
          this.emit('message', {
            id: message.id,
            result: await renderPdfPagesForOcr(message.path!, message.ocr!),
          })
        } else if (message.type === 'ocr-prepare') {
          this.prepared++
          this.emit('message', {
            id: message.id,
            result: prepareForTesseract(message.bytes!, message.dpi ?? 150),
          })
        } else if (message.type === 'embed') {
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: message.id,
            result: (message.texts ?? []).map(() =>
              new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1),
            ),
          })
        } else this.emit('message', { id: message.id, result: [] })
      } catch (error) {
        this.emit('message', {
          id: message.id,
          error: error instanceof Error ? error.message : 'failed',
        })
      }
    }, 0)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

async function until(check: () => boolean, timeout = 8000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for the manager')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

// ---- the engine double: forces specific recognised text, nothing else ---------------------------

function recognition(text: string, confidence: number): LocalOcrRecognition {
  const tokens = text ? text.split(/\s+/).map((word) => ({ text: word, confidence })) : []
  return { text, meanConfidence: confidence, tokens, ms: 5 }
}

class ScriptedEngine implements LocalOcrEngine {
  readonly id = 'apple-vision' // judged with Vision's threshold
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
  calls: Array<{ hash: string; bytes: number }> = []
  disposed = 0
  /** text by sha256 of the bytes it receives; PNG images always read well */
  /** what a picture (PNG) reads as */
  imageKind: 'good' | 'blank' = 'good'
  constructor(
    private readonly pageTexts: Map<string, 'good' | 'bad'>,
    private readonly onCall?: (n: number) => void | Promise<void>,
  ) {}
  isAvailable(): boolean {
    return true
  }
  async recognizePage(input: { bytes?: Uint8Array }): Promise<LocalOcrRecognition> {
    const bytes = input.bytes!
    const hash = createHash('sha256').update(bytes).digest('hex')
    this.calls.push({ hash, bytes: bytes.length })
    await this.onCall?.(this.calls.length)
    const kind = bytes[0] === 0x89 ? this.imageKind : (this.pageTexts.get(hash) ?? 'bad')
    if (kind === 'blank') return recognition('', 0)
    return kind === 'good' ? recognition(GOOD_TEXT, 0.95) : recognition(BAD_TEXT, 0.9)
  }
  async dispose(): Promise<void> {
    this.disposed++
  }
}

const settings =
  (patch: Partial<LocalOcrSettings> = {}): (() => LocalOcrSettings) =>
  () => ({
    enabled: true,
    lightPages: 2,
    engine: 'auto',
    ...patch,
  })

/** a registry that hands out one engine (or none), as the real one would when the chain can / cannot run */
function registryOf(engine: LocalOcrEngine | null): LocalOcrEngineRegistry {
  const registry = new LocalOcrEngineRegistry({
    platform: 'linux',
    freeRamMB: () => 99_999,
    factories: {},
  })
  ;(registry as unknown as { select: () => unknown }).select = () =>
    engine ? { engine, skipped: [] } : null
  return registry
}

function startManager(): { worker: InProcessWorker; dbPath: string } {
  const dbPath = join(dir, 'document-memory.db')
  const worker = new InProcessWorker(dbPath)
  manager = new DocumentMemoryManager(dir, {
    pollIntervalMs: 60_000,
    workerFactory: () => worker as unknown as Worker,
  })
  reader = new DocumentMemoryStore(dbPath)
  return { worker, dbPath }
}

interface Library {
  scan: string
  passportPdf: string
  receipt: string
  idPhoto: string
  pageTexts: Map<string, 'good' | 'bad'>
}

/** scan.pdf (page 1 reads well, page 2 does not), a sensitive PDF whose pages read badly, a receipt photo and an ID photo */
async function buildLibrary(): Promise<Library> {
  const gray = decodePngGray(FIXTURE)!
  const good = encodeGrayJpeg(gray.data, gray.width, gray.height, 85)
  const odd = (seed: number) =>
    encodeGrayJpeg(testPattern(gray.width, gray.height, seed), gray.width, gray.height, 70)
  const pages = (jpegs: Uint8Array[]) =>
    jpegs.map((jpeg) => ({ jpeg, width: gray.width, height: gray.height }))
  const scanJpegs = [good, odd(2), odd(3)]
  const idJpegs = [odd(4), odd(5), odd(6)]
  const scan = join(dir, 'scan.pdf')
  const passportPdf = join(dir, 'passport-scan.pdf')
  writeFileSync(scan, buildScannedPdf(pages(scanJpegs)))
  writeFileSync(passportPdf, buildScannedPdf(pages(idJpegs)))
  const receipt = join(dir, 'receipt.png')
  const idPhoto = join(dir, 'cccd-front.png')
  copyFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'), receipt)
  copyFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'), idPhoto)
  const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const pageTexts = new Map<string, 'good' | 'bad'>()
  // the renderer hands embedded scan JPEGs through unchanged
  pageTexts.set(hashOf(good), 'good')
  return { scan, passportPdf, receipt, idPhoto, pageTexts }
}

async function indexLibrary(lib: Library): Promise<void> {
  await waitForManagerWriteReady(manager)
  for (const path of [lib.scan, lib.passportPdf, lib.receipt, lib.idPhoto])
    manager!.indexDiscoveredFile(path)
  await until(
    () =>
      reader!.documentByPath(lib.scan)?.status === 'empty' &&
      reader!.documentByPath(lib.passportPdf)?.status === 'empty' &&
      reader!.documentByPath(lib.receipt)?.status === 'ready' &&
      reader!.documentByPath(lib.idPhoto)?.status === 'ready',
  )
  await until(() => manager!.nowStatus().extracting.length === 0)
}

const cloudPaths = (host: OcrJobHost, options?: { manual?: boolean }) =>
  host.candidates(5, options).map((row) => [basename(row.path), row.skipPages ?? []] as const)

describe('scheduler tick -> local pass -> tiers -> cloud selection (real SQLite, scripted engine)', () => {
  it('reads the light pages locally, tiers them, and leaves the cloud exactly the escalated non-sensitive pages', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const engine = new ScriptedEngine(lib.pageTexts)
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })

    // before the local pass: with a local engine that can run, the cloud reader waits (nothing to read yet)
    expect(cloudPaths(wiring.host)).toEqual([])

    const summary = await wiring.runner.tick()
    expect(summary).toMatchObject({ pages: 6, failed: 0 }) // scan p1-2, passport p1-2, receipt, ID photo
    expect(summary!.stoppedBecause).toBeUndefined()

    const ocr = reader!.ocr
    expect(ocr.pageTier(lib.scan, 1)).toMatchObject({
      tier: 'local',
      engine: 'apple-vision',
      escalate: false,
    })
    expect(ocr.pageTier(lib.scan, 2)).toMatchObject({ tier: 'local', escalate: true })
    // identity papers are read here and never flagged for the cloud, whatever the score
    expect(ocr.pageTier(lib.passportPdf, 1)).toMatchObject({ tier: 'local', escalate: false })
    expect(ocr.pageTier(lib.passportPdf, 2)).toMatchObject({ tier: 'local', escalate: false })
    expect(ocr.pageTier(lib.receipt, 1)).toMatchObject({ tier: 'local', escalate: false })
    expect(ocr.pageTier(lib.idPhoto, 1)).toMatchObject({ tier: 'local' })

    // cloud candidates: ONLY the escalated page of the non-sensitive PDF; no images, nothing sensitive
    expect(cloudPaths(wiring.host)).toEqual([['scan.pdf', [1, 3]]])
    expect(cloudPaths(wiring.host, { manual: true }).map(([name]) => name)).toEqual(['scan.pdf'])

    // a second tick has nothing left to do and never calls the engine again
    const calls = engine.calls.length
    expect(await wiring.runner.tick()).toMatchObject({ files: 0, pages: 0 })
    expect(engine.calls.length).toBe(calls)
    expect(engine.disposed).toBeGreaterThan(0) // a Tesseract worker is not kept between runs
  })

  it('image OCR text becomes searchable through the real search entrypoints without breaking the media invariants', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const before = reader!.documentByPath(lib.receipt)!
    expect(
      reader!.rawDb.prepare('SELECT priority_at FROM documents WHERE id = ?').get(before.id),
    ).toEqual({ priority_at: 0 })
    const engine = new ScriptedEngine(lib.pageTexts)
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    await wiring.runner.tick()

    await until(
      () =>
        (reader!.documentByPath(lib.receipt)?.status ?? '') !== 'ready' ||
        reader!.chunkProgress(lib.receipt).totalChunks > 0,
    )
    await until(
      () =>
        reader!.chunkProgress(lib.receipt).totalChunks > 0 &&
        reader!.chunkProgress(lib.receipt).completedChunks > 0,
    )
    await until(() => manager!.nowStatus().extracting.length === 0)

    // found by the words of the picture, as an OCR hit on a media row
    const lexical = reader!.search('Viettel Tiền Giang', null, 10)
    const hit = lexical.find((h) => h.path === lib.receipt)
    expect(hit).toBeTruthy()
    expect(hit).toMatchObject({ ocr: true, location: 'OCR page 1' })
    const hits = reader!.search(
      'Viettel Tiền Giang',
      new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1),
      10,
    )
    expect(hits.some((h) => h.path === lib.receipt)).toBe(true)
    const viaManager = await manager!.search('Viettel Tiền Giang', 10)
    expect(viaManager.hits.some((h) => h.path === lib.receipt)).toBe(true)

    // the sensitive photo is read on this device too (it never leaves it)
    expect(reader!.search('Viettel', null, 10).some((h) => h.path === lib.idPhoto)).toBe(true)

    // media invariants: still a media row, never pending / error, no priority, ocr_state set by markImageOcr
    const doc = reader!.documentByPath(lib.receipt)!
    expect(['ready', 'text-only']).toContain(doc.status)
    expect(doc.error).toBeNull()
    expect(
      reader!.rawDb.prepare('SELECT priority_at FROM documents WHERE id = ?').get(doc.id),
    ).toEqual({ priority_at: 0 })
    expect(
      reader!.rawDb
        .prepare('SELECT kind, ocr_candidate, ocr_state FROM document_media WHERE document_id = ?')
        .get(doc.id),
    ).toEqual({
      kind: 'image',
      ocr_candidate: 1,
      ocr_state: 1,
    })
    await until(() => reader!.documentByPath(lib.receipt)?.status === 'ready') // embedded: no longer waiting for vectors
    expect(reader!.incompletePaths().filter((p) => p === lib.receipt)).toEqual([])
  })

  it('re-reads an image only when its mtime or size changes', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const engine = new ScriptedEngine(lib.pageTexts)
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    await wiring.runner.tick()
    await until(() => manager!.nowStatus().extracting.length === 0)
    const imageCalls = () => engine.calls.filter((c) => c.bytes === FIXTURE.length).length
    expect(imageCalls()).toBe(2)

    // an unchanged file (rescan) is not read again
    manager!.indexDiscoveredFile(lib.receipt)
    expect(await wiring.runner.tick()).toMatchObject({ pages: 0 })
    expect(imageCalls()).toBe(2)

    // a new mtime re-enrolls the row (ocr_state back to 0) and the next tick reads it again
    const later = new Date(Date.now() + 60_000)
    utimesSync(lib.receipt, later, later)
    manager!.indexDiscoveredFile(lib.receipt)
    expect(
      reader!.rawDb
        .prepare('SELECT ocr_state FROM document_media WHERE document_id = ?')
        .get(reader!.documentByPath(lib.receipt)!.id),
    ).toEqual({ ocr_state: 0 })
    expect(await wiring.runner.tick()).toMatchObject({ pages: 1 })
    expect(imageCalls()).toBe(3)
    expect(statSyncSize(lib.receipt)).toBe(FIXTURE.length)
  })
})

const statSyncSize = (path: string) => statSync(path).size
const registryEngine = () => new ScriptedEngine(new Map())

describe('media rows stay lean until OCR text exists', () => {
  it('a picture without text is never indexed as an empty document or an error, and is not read again', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    // the extractor on its own: no OCR rows -> a finished, chunk-less media result
    const lookup = (p: string, h: string) => reader!.ocr.pages(p, h)
    expect(await extractDocument(lib.receipt, lookup)).toMatchObject({
      chunks: [],
      media: true,
      status: 'ready',
    })

    const engine = new ScriptedEngine(lib.pageTexts)
    engine.imageKind = 'blank'
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    await wiring.runner.tick()
    await until(() => manager!.nowStatus().extracting.length === 0)
    const doc = reader!.documentByPath(lib.receipt)!
    expect(doc).toMatchObject({ status: 'ready', error: null })
    expect(reader!.chunkProgress(lib.receipt).totalChunks).toBe(0)
    expect(
      reader!.rawDb
        .prepare('SELECT ocr_state FROM document_media WHERE document_id = ?')
        .get(doc.id),
    ).toEqual({ ocr_state: IMAGE_OCR_STATE.done })
    expect(reader!.incompletePaths()).not.toContain(lib.receipt)
    const calls = engine.calls.length
    await wiring.runner.tick()
    expect(engine.calls.length).toBe(calls)
  })

  it('text of an older version of the picture is removed when the new version has none', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const engine = new ScriptedEngine(lib.pageTexts)
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    await wiring.runner.tick()
    await until(() => reader!.chunkProgress(lib.receipt).totalChunks > 0)
    await until(() => manager!.nowStatus().extracting.length === 0)

    // the picture is replaced by one with no text (new size): re-enrolled, read again, chunks dropped
    writeFileSync(lib.receipt, Buffer.concat([FIXTURE, Buffer.alloc(64)]))
    manager!.indexDiscoveredFile(lib.receipt)
    engine.imageKind = 'blank'
    await wiring.runner.tick()
    await until(() => reader!.chunkProgress(lib.receipt).totalChunks === 0)
    await until(() => manager!.nowStatus().extracting.length === 0)
    expect(reader!.documentByPath(lib.receipt)).toMatchObject({ status: 'ready', error: null })
    expect(reader!.search('Viettel', null, 10).some((h) => h.path === lib.receipt)).toBe(false)
  })
})

describe('stop, pause and RAM', () => {
  it('a pause published mid-job ends the run at the next page (no further engine call, rows kept)', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const engine = new ScriptedEngine(lib.pageTexts, (n) => {
      if (n === 1)
        publishIndexingPolicy({
          paused: true,
          pauseReason: 'low-memory',
          threads: 1,
          cpuShare: 0,
          priority: 'idle',
          tier: 'paused',
          reason: 'test',
          onBattery: false,
          memoryTier: 'low',
          allowHeavyEmbedding: false,
          maxBatchTokens: 0,
        })
    })
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    const summary = await wiring.runner.tick()
    expect(summary!.stoppedBecause).toMatch(/aborted|gate:indexing-paused|stopped/)
    expect(engine.calls).toHaveLength(1)
    expect(wiring.runner.isRunning).toBe(false)
    // while paused a new tick does not even start
    expect(await wiring.runner.tick()).toBeNull()
    expect(engine.calls).toHaveLength(1)
  })

  it('closing the manager mid-job stops the run and disposes the engines', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const engine = new ScriptedEngine(lib.pageTexts, (n) => {
      if (n === 1) manager!.close()
    })
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    const summary = await wiring.runner.tick()
    expect(summary!.stoppedBecause).toBeTruthy()
    expect(engine.calls).toHaveLength(1)
    expect(engine.disposed).toBeGreaterThan(0)
  })

  it('disabling document memory (epoch bump) ends the run', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const engine = new ScriptedEngine(lib.pageTexts, (n) => {
      if (n === 1) manager!.setEnabled(false)
    })
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    const summary = await wiring.runner.tick()
    // the page in flight is dropped by the persistence gate (document memory is disabled), nothing more is read
    expect(summary!.stoppedBecause).toMatch(/^(stopped|storage-denied)$/)
    expect(engine.calls).toHaveLength(1)
  })

  it('the idle / AC gate is consulted before every page', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    const engine = new ScriptedEngine(lib.pageTexts)
    let open = true
    const wiring = manager!.localOcr(
      settings(),
      () => (open ? { ok: true } : { ok: false, reason: 'not-idle' }),
      {
        registry: registryOf(engine),
        coolDown: async () => void (open = false), // the user comes back after the first page
      },
    )
    const summary = await wiring.runner.tick()
    expect(summary!.stoppedBecause).toBe('gate:not-idle')
    expect(engine.calls).toHaveLength(1)
  })

  it('low RAM refuses: no engine call, no rows, and the cloud reader is not held back', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    // the REAL registry with an engine that needs more RAM than is free
    const engine = new ScriptedEngine(lib.pageTexts)
    ;(engine as { descriptor: { minFreeRamMB: number } }).descriptor.minFreeRamMB = 1024
    engine.isAvailable = (_platform: NodeJS.Platform, free: number) => free >= 1024
    const registry = new LocalOcrEngineRegistry({
      platform: 'linux',
      freeRamMB: () => 100,
      factories: { [TESSERACT_ENGINE_ID]: () => engine },
    })
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry,
      coolDown: async () => undefined,
    })
    expect(registry.select()).toBeNull()
    // no local engine can run, so the cloud reader may take the (non-sensitive) scanned PDF itself
    expect(cloudPaths(wiring.host).map(([name]) => name)).toEqual(['scan.pdf'])
    expect(await wiring.runner.tick()).toBeNull() // not even started
    expect(engine.calls).toHaveLength(0)
    expect(reader!.rawDb.prepare('SELECT count(*) AS n FROM ocr_pages').get()).toEqual({ n: 0 })
  })

  it('cloud candidates never include images without opt-in, never sensitive files, whatever the local settings', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    // local OCR switched off: the cloud reader is not held back, but still sees only the non-sensitive PDF
    const wiring = manager!.localOcr(settings({ enabled: false }), () => ({ ok: true }), {
      registry: registryOf(registryEngine()),
    })
    expect(cloudPaths(wiring.host).map(([name]) => name)).toEqual(['scan.pdf'])
    expect(cloudPaths(wiring.host, { manual: true }).map(([name]) => name)).toEqual(['scan.pdf'])
  })
})

describe('the OCR scheduler tick', () => {
  it('starts the local pass on every tick, even when the cloud reader itself is switched off', async () => {
    startManager()
    let passes = 0
    const state = new OcrStateStore(join(dir, 'state.json'), Date.now, () => 0)
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(null),
    })
    const job = new AgyOcrJob({
      settings: () => ({ enabled: false }) as never,
      host: wiring.host,
      state,
      recognize: async () => ({ text: '' }),
      readUsage: async () => null,
      policy: () => ({ paused: false, onBattery: false }),
      idleSeconds: () => 999,
      localPass: async () => void passes++,
      now: Date.now,
      timezoneOffset: () => 0,
      every: () => () => undefined,
    })
    await job.tick()
    await job.tick()
    expect(passes).toBe(2)
    job.stop()
  })

  it('is single-flight: a tick that finds the previous one running returns at once', async () => {
    startManager()
    const lib = await buildLibrary()
    await indexLibrary(lib)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const engine = new ScriptedEngine(lib.pageTexts, async (n) => {
      if (n === 1) await gate
    })
    const wiring = manager!.localOcr(settings(), () => ({ ok: true }), {
      registry: registryOf(engine),
      coolDown: async () => undefined,
    })
    const first = wiring.runner.tick()
    await until(() => engine.calls.length === 1)
    expect(await wiring.runner.tick()).toBeNull()
    release()
    expect((await first)!.pages).toBeGreaterThan(0)
  })
})

describe('real Tesseract through the manager (image prepared by the index worker)', () => {
  it('reads the synthetic invoice photo, stores a local row and makes it searchable', async () => {
    const { worker } = startManager()
    const receipt = join(dir, 'real-invoice.png')
    copyFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'), receipt)
    await waitForManagerWriteReady(manager)
    manager!.indexDiscoveredFile(receipt)
    await until(() => reader!.documentByPath(receipt)?.status === 'ready')
    // the default registry (real Tesseract; its image preparation is an `ocr-prepare` request to the index worker)
    const wiring = manager!.localOcr(
      () => ({ enabled: true, lightPages: 1, engine: 'tesseract-vie' }),
      () => ({ ok: true }),
      {
        coolDown: async () => undefined,
        totalRamMB: () => 16_000,
      },
    )
    try {
      const summary = await wiring.runner.tick()
      expect(summary).toMatchObject({ files: 1, pages: 1 })
      expect(worker.prepared).toBeGreaterThan(0) // decode / flatten ran in the worker, not in this thread
      expect(reader!.ocr.pageTier(receipt, 1)).toMatchObject({
        tier: 'local',
        engine: TESSERACT_ENGINE_ID,
      })
      await until(() => reader!.chunkProgress(receipt).totalChunks > 0)
      await until(() => manager!.nowStatus().extracting.length === 0)
      expect(reader!.search('Viettel', null, 10).some((h) => h.path === receipt)).toBe(true)
    } finally {
      await wiring.dispose()
    }
  }, 90_000)
})

describe('the bundled index worker', () => {
  it('answers ocr-prepare in its own process and does not bundle tesseract.js', async () => {
    const { modules } = await bundleIndexWorker()
    expect(modules.some((m) => m.includes('local-ocr/tesseract-prepare.ts'))).toBe(true)
    expect(modules.some((m) => m.includes('node_modules/tesseract.js/'))).toBe(false)
    const factory = await realIndexWorkerFactory()
    const worker = factory('unused', {
      cacheDir: join(dir, 'models'),
      dbPath: join(dir, 'worker.db'),
    } as never)
    try {
      const reply = await new Promise<{ id: number; result?: Uint8Array; error?: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no reply')), 60_000)
          worker.on('message', (m: { id?: number }) => {
            if (m.id === 7) {
              clearTimeout(timer)
              resolve(m as never)
            }
          })
          worker.postMessage({
            id: 7,
            type: 'ocr-prepare',
            bytes: new Uint8Array(FIXTURE),
            dpi: 150,
          })
        },
      )
      expect(reply.error).toBeUndefined()
      expect(reply.result![0]).toBe(0x89) // a PNG again: gray, flattened
      expect(reply.result!.length).toBeGreaterThan(1000)
    } finally {
      await worker.terminate?.()
    }
  }, 120_000)
})
