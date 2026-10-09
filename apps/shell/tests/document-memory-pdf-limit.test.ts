import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clampPdfPages,
  chunkDocumentText,
  DEFAULT_PDF_PAGES,
  LARGE_PDF_PAGES,
} from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { storageBudgetAckReply } from './helpers/storage-budget-ack'

describe('the PDF page limit', () => {
  it('is 30 by default, can be changed, and never goes past 400 or below 1', () => {
    expect(DEFAULT_PDF_PAGES).toBe(30)
    expect(LARGE_PDF_PAGES).toBe(400)
    expect([0, -5, 12.4, 100, 1000, 400].map(clampPdfPages)).toEqual([1, 1, 12, 100, 400, 400])
    // nonsense falls back to the default instead of to a limit nobody chose
    expect([Number.NaN, 'x', undefined, null].map(clampPdfPages)).toEqual([30, 30, 30, 30])
  })
})

class SpyWorker extends EventEmitter {
  requests: Array<{ path: string; maxPdfPages?: number; interactive?: boolean }> = []
  postMessage(message: {
    id?: number
    type?: string
    path: string
    maxPdfPages?: number
    interactive?: boolean
    configVersion?: number
    budget?: { maxDatabaseBytes?: number }
  }): void {
    // The startup storage-budget handshake is answered (so metadata writes are admitted) and is
    // not an extraction request, so it is not recorded.
    const ack = storageBudgetAckReply(message)
    if (ack) {
      setTimeout(() => this.emit('message', ack), 0)
      return
    }
    this.requests.push(message)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

let dir: string
let managers: DocumentMemoryManager[]
let worker: SpyWorker
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-pdflimit-'))
  managers = []
  worker = new SpyWorker()
})
afterEach(() => {
  for (const manager of managers) manager.close()
  rmSync(dir, { recursive: true, force: true })
})

function open(): DocumentMemoryManager {
  const manager = new DocumentMemoryManager(join(dir, 'user'), {
    workerFactory: () => worker as unknown as Worker,
    pollIntervalMs: 3_600_000,
  })
  managers.push(manager)
  return manager
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

describe('the PDF page limit in the index', () => {
  it('starts at 30, is kept between starts, and is clamped', () => {
    const first = open()
    expect(first.getPdfMaxPages()).toBe(30)
    expect(first.setPdfMaxPages(100)).toEqual({ pages: 100, requeued: 0 })
    expect(first.setPdfMaxPages(5000).pages).toBe(400)
    expect(first.setPdfMaxPages(0).pages).toBe(1)
    first.setPdfMaxPages(60)
    first.close()
    expect(open().getPdfMaxPages()).toBe(60)
  })

  it('tells the reader what to use, for indexing and for checking a passage', async () => {
    const manager = open()
    manager.setPdfMaxPages(80)
    const path = join(dir, 'a.pdf')
    writeFileSync(path, '%PDF-1.4')
    const { mtimeMs, size } = statSync(path)
    manager.indexDiscoveredFile(path, { mtimeMs, sizeBytes: size })
    await until(() => worker.requests.length === 1)
    expect(worker.requests[0]).toMatchObject({ path, maxPdfPages: 80 })
  })

  it('reads the PDFs that were cut short again when the limit is raised, not when it is lowered', () => {
    const manager = open()
    const cut = join(dir, 'book.pdf')
    const whole = join(dir, 'short.pdf')
    const other = join(dir, 'long.docx')
    // Seed through a plain store on the manager's database file: the manager's own store is
    // write-gated until the worker acknowledges the storage budget, which this test is not about.
    const seeder = new DocumentMemoryStore(join(dir, 'user', 'document-memory.db'))
    const store = (
      manager as unknown as {
        store: {
          documentByPath(path: string): { status: string } | undefined
        }
      }
    ).store
    for (const [path, truncated] of [
      [cut, true],
      [whole, false],
      [other, true],
    ] as const) {
      writeFileSync(path, 'x')
      seeder.replaceDocument(path, {
        hash: 'h',
        mtimeMs: 1,
        sizeBytes: 1,
        chunks: chunkDocumentText('Giấy ra viện. '.repeat(20)),
        embeddingModel: null,
        status: 'text-only',
        truncated,
      })
    }
    seeder.close()

    expect(manager.setPdfMaxPages(10).requeued).toBe(0)
    expect(store.documentByPath(cut)!.status).toBe('text-only')

    expect(manager.setPdfMaxPages(50).requeued).toBe(1)
    expect(store.documentByPath(cut)!.status).toBe('pending')
    expect(store.documentByPath(whole)!.status).toBe('text-only')
    expect(store.documentByPath(other)!.status).toBe('text-only')
  })
})
