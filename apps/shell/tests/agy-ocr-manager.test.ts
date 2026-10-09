import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderPdfPagesForOcr } from '../src/main/document-memory/agy-ocr-render'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { extractDocument } from '../src/main/document-memory/worker'
import { buildScannedPdf, testPattern } from './helpers/scanned-pdf'
import { storageBudgetAckReply, waitForManagerWriteReady } from './helpers/storage-budget-ack'

let dir: string
let manager: DocumentMemoryManager | undefined
let reader: DocumentMemoryStore | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ocr-manager-'))
})
afterEach(() => {
  manager?.close()
  reader?.close()
  manager = undefined
  reader = undefined
  rmSync(dir, { recursive: true, force: true })
})

/** The index process, run in-process: the real extraction (with the OCR lookup) and real page rendering. */
class InProcessWorker extends EventEmitter {
  renders = 0
  constructor(private readonly dbPath: string) {
    super()
  }
  postMessage(message: { id: number; type: string; path?: string; texts?: string[]; ocr?: never }) {
    setTimeout(async () => {
      try {
        const ack = storageBudgetAckReply(message)
        if (ack) {
          this.emit('message', ack)
          return
        }
        if (message.type === 'extract') {
          const store = new DocumentMemoryStore(this.dbPath)
          try {
            const result = await extractDocument(message.path!, (p, h) => store.ocr.pages(p, h))
            this.emit('message', { id: message.id, result })
          } finally {
            store.close()
          }
        } else if (message.type === 'ocr-render') {
          this.renders++
          const result = await renderPdfPagesForOcr(message.path!, message.ocr!)
          this.emit('message', { id: message.id, result })
        } else if (message.type === 'embed') {
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: message.id,
            result: (message.texts ?? []).map(() => new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1)),
          })
        } else {
          this.emit('message', { id: message.id, result: [] })
        }
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

describe('scanned PDF through the real manager (in-process index worker)', () => {
  it('replaces a worker after a stalled native step and ignores its late model messages', async () => {
    class StalledWorker extends EventEmitter {
      terminated = false
      postMessage(message: { id: number; type?: string }) {
        setTimeout(() => {
          // Only the native render step stalls. The startup budget handshake is answered like a real
          // worker does (otherwise the manager refuses OCR work as "pending worker confirmation"), and
          // other requests are served normally.
          const ack = storageBudgetAckReply(message)
          if (ack) {
            this.emit('message', ack)
            return
          }
          if (message.type !== 'ocr-render') {
            this.emit('message', { id: message.id, result: [] })
            return
          }
          this.emit('message', {
            id: message.id,
            error: 'Native step stalled',
            restartRequired: true,
          })
        }, 0)
      }
      async terminate() {
        this.terminated = true
        return 0
      }
    }
    const workers: StalledWorker[] = []
    manager = new DocumentMemoryManager(dir, {
      pollIntervalMs: 60_000,
      workerFactory: () => {
        const worker = new StalledWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
    })
    await waitForManagerWriteReady(manager)
    const result = await manager
      .ocrHost()
      .render(join(dir, 'scan.pdf'), { done: [], maxPages: 1, count: 1 })
    expect(result).toMatchObject({ ok: false, message: 'Native step stalled' })
    expect(workers[0]!.terminated).toBe(true)
    workers[0]!.emit('message', { type: 'model', state: 'downloading' })
    expect(manager.indexingActivityStatus().modelState).not.toBe('downloading')
    // The recycled worker closes the budget write gate until its replacement ACKs the budget, and an
    // OCR render in that window is refused (`executeOcrRenderGated`: "Storage quota config pending
    // worker confirmation") without spawning anything. The replacement is spawned by the manager's
    // next contact with the index process, e.g. a search.
    await manager.search('anything')
    await waitForManagerWriteReady(manager)
    expect(workers).toHaveLength(2)
    const second = await manager
      .ocrHost()
      .render(join(dir, 'scan.pdf'), { done: [], maxPages: 1, count: 1 })
    expect(second).toMatchObject({ ok: false, message: 'Native step stalled' })
    expect(workers[1]!.terminated).toBe(true)
  })

  it('OCR text re-enters the index as OCR chunks, gets embedded, and keeps the counters exact', async () => {
    const jpegs = Array.from({ length: 3 }, (_, i) =>
      encodeGrayJpeg(testPattern(600, 800, i), 600, 800, 70),
    )
    const path = join(dir, 'scan.pdf')
    writeFileSync(path, buildScannedPdf(jpegs.map((jpeg) => ({ jpeg, width: 600, height: 800 }))))
    const dbPath = join(dir, 'document-memory.db')
    const worker = new InProcessWorker(dbPath)
    manager = new DocumentMemoryManager(dir, {
      pollIntervalMs: 60_000,
      workerFactory: () => worker as unknown as Worker,
    })
    reader = new DocumentMemoryStore(dbPath)
    await waitForManagerWriteReady(manager)

    // the normal pipeline finds no text: the file lands in the "no text" state the OCR job looks for
    manager.indexDiscoveredFile(path)
    await until(() => reader!.documentByPath(path)?.status === 'empty')
    const host = manager.ocrHost()
    expect(host.isEnabled()).toBe(true)
    expect(host.candidates(5).map((c) => c.path)).toEqual([path])

    // pages are rendered by the index process (the embedded scan JPEGs here)
    const rendered = await host.render(path, { done: [], maxPages: 2, count: 5 })
    expect(rendered).toMatchObject({ ok: true, totalPages: 3 })
    expect(worker.renders).toBe(1)
    if (!rendered || !rendered.ok) throw new Error('render failed')
    expect(rendered.pages.map((p) => p.page)).toEqual([1, 2])

    // the job stores the transcription and asks for a re-index
    const saved = await host.savePages(
      path,
      {
        hash: rendered.hash,
        mtimeMs: rendered.mtimeMs,
        sizeBytes: rendered.sizeBytes,
        totalPages: 3,
        model: 'gemini-3.8-flash-low',
      },
      [
        { page: 1, text: 'HÓA ĐƠN GIÁ TRỊ GIA TĂNG số 0042467' },
        { page: 2, text: 'Tổng cộng 4.919.750 đồng' },
      ],
    )
    // persistence is admission-gated and async: the job awaits it before asking for the re-index
    expect(saved).toMatchObject({ ok: true })
    host.reindex(path)
    await until(() => reader!.documentByPath(path)?.status === 'ready')

    const document = reader.documentByPath(path)!
    expect(document.truncated).toBe(true) // 2 of 3 pages were read (limit 2 of 3)
    const progress = reader.chunkProgress(path)
    expect(progress.totalChunks).toBe(2)
    expect(progress.completedChunks).toBe(2)
    const hits = reader.search('0042467', [1, 0], 5)
    expect(hits[0]).toMatchObject({ location: 'OCR page 1', ocr: true })
    // nothing is left for the job to do within the per-file limit of 2, but a raised limit finds page 3
    expect(host.candidates(2)).toEqual([])
    expect(host.candidates(5).map((c) => [c.path, c.pagesDone, c.totalPages])).toEqual([
      [path, 2, 3],
    ])
    expect(manager.getFolderIndexCounts(dir)).toMatchObject({ readyFiles: 1, truncatedFiles: 1 })
  })

  it('a document that disappears or is excluded cannot be re-indexed by a late OCR result', async () => {
    const path = join(dir, 'gone.pdf')
    writeFileSync(
      path,
      buildScannedPdf([
        { jpeg: encodeGrayJpeg(testPattern(600, 800), 600, 800, 70), width: 600, height: 800 },
      ]),
    )
    const dbPath = join(dir, 'document-memory.db')
    manager = new DocumentMemoryManager(dir, {
      pollIntervalMs: 60_000,
      workerFactory: () => new InProcessWorker(dbPath) as unknown as Worker,
    })
    reader = new DocumentMemoryStore(dbPath)
    await waitForManagerWriteReady(manager)
    manager.indexDiscoveredFile(path)
    await until(() => reader!.documentByPath(path)?.status === 'empty')
    // the 'empty' row is committed before the extraction bookkeeping (scan info) finishes; let the
    // read finish so the test does not close the manager underneath it
    await until(() => manager!.nowStatus().extracting.length === 0)
    const host = manager.ocrHost()
    manager.exclude(path)
    expect(host.documentById(reader.documentByPath(path)!.id)).toBeNull()
    expect(() => host.reindex(path)).not.toThrow()
    expect(reader.documentByPath(path)?.status).toBe('excluded')
  })
})
