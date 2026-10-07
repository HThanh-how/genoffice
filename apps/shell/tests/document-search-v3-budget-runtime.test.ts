import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { extractDocument } from '../src/main/document-memory/worker'
import { DEFAULT_STORAGE_BUDGET, type DocumentIndexStorageBudget } from '../src/main/document-memory/storage-budget'

class MockBudgetWorker extends EventEmitter {
  public extractCalls = 0
  public embedCalls = 0

  constructor(private readonly dbPath: string) {
    super()
  }

  postMessage(message: {
    id: number
    type: string
    path?: string
    texts?: string[]
    maxPdfPages?: number
  }): void {
    setTimeout(async () => {
      try {
        if (message.type === 'extract' && message.path) {
          this.extractCalls++
          const store = new DocumentMemoryStore(this.dbPath)
          try {
            const result = await extractDocument(
              message.path,
              (p, h) => store.ocr.pages(p, h),
              message.maxPdfPages,
            )
            this.emit('message', { id: message.id, result })
          } finally {
            store.close()
          }
        } else if (message.type === 'embed') {
          this.embedCalls++
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: message.id,
            result: (message.texts ?? []).map(() => new Array(384).fill(0.01)),
          })
        } else if (message.type === 'search-semantic') {
          this.emit('message', { id: message.id, result: [] })
        } else {
          this.emit('message', { id: message.id, result: [] })
        }
      } catch (err) {
        this.emit('message', {
          id: message.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }, 0)
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('Document Search V3 - Hard-Limit Runtime Preservation Suite (PAIR 17)', () => {
  let tempDir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-search-v3-budget-runtime-'))
    managers = []
  })

  afterEach(() => {
    for (const manager of managers) {
      try {
        manager.close()
      } catch {}
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function createTestManager(opts: {
    budget?: DocumentIndexStorageBudget
    workerInstance?: MockBudgetWorker
  } = {}) {
    const dbPath = join(tempDir, 'document-memory.db')
    const worker = opts.workerInstance ?? new MockBudgetWorker(dbPath)
    const manager = new DocumentMemoryManager(tempDir, {
      workerFactory: () => worker as any,
      budget: opts.budget,
      pollIntervalMs: 60_000,
    })
    managers.push(manager)
    return { manager, worker, dbPath }
  }

  // =========================================================================
  // BUDGET-RUNTIME-01: Extraction at full budget preserves lexical chunks and FTS
  // =========================================================================
  it('BUDGET-RUNTIME-01: extract when budget=full preserves chunks and FTS with non-error text-only status', async () => {
    const sampleFile = join(tempDir, 'enterprise-doc.txt')
    writeFileSync(sampleFile, 'Enterprise quarterly financial audit report for deep text analysis.', 'utf8')

    // Set tight budget so active DB exceeds budget immediately (forcing limitState='full')
    const tightBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 1024, // 1 KB
    }

    const { manager } = createTestManager({ budget: tightBudget })
    manager.remember(sampleFile)

    await new Promise((resolve) => setTimeout(resolve, 300))

    const doc = manager.store.documentByPath(sampleFile)
    expect(doc).toBeDefined()
    expect(doc!.status).not.toBe('error')
    expect(doc!.status).toBe('text-only')

    const progress = manager.store.chunkProgress(sampleFile)
    expect(progress.totalChunks).toBeGreaterThan(0)

    // Verify FTS rows exist and resolve to path
    const lexicalMatches = manager.store.searchLexical('financial audit report')
    expect(lexicalMatches.length).toBeGreaterThan(0)
    const hydrated = manager.store.hydrateChunkHits(lexicalMatches)
    expect(hydrated[0]!.path).toBe(resolve(sampleFile))
  })

  // =========================================================================
  // BUDGET-RUNTIME-02: Embed worker is not called when budget is full
  // =========================================================================
  it('BUDGET-RUNTIME-02: embed worker calls remain zero when budget is full', async () => {
    const sampleFile = join(tempDir, 'budget-freeze.txt')
    writeFileSync(sampleFile, 'Sensitive operational budget documents with strict hard limit constraints.', 'utf8')

    const tightBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 1024,
    }

    const { manager, worker } = createTestManager({ budget: tightBudget })
    manager.remember(sampleFile)

    await new Promise((resolve) => setTimeout(resolve, 300))

    // embed worker must NOT be called when budget is full
    expect(worker.embedCalls).toBe(0)
  })

  // =========================================================================
  // BUDGET-RUNTIME-03: Lexical query after hard-limit still returns document
  // =========================================================================
  it('BUDGET-RUNTIME-03: lexical search returns document even when hard-limit prevented semantic embedding', async () => {
    const sampleFile = join(tempDir, 'contract-agreement.txt')
    writeFileSync(sampleFile, 'Confidential Master Services Agreement and SLA terms for client.', 'utf8')

    const tightBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 512,
    }

    const { manager } = createTestManager({ budget: tightBudget })
    manager.remember(sampleFile)

    await new Promise((resolve) => setTimeout(resolve, 300))

    const searchResult = await manager.search('Master Services Agreement')
    expect(searchResult.hits.length).toBeGreaterThan(0)
    expect(searchResult.hits[0]!.path).toBe(resolve(sampleFile))
    expect(searchResult.hits[0]!.text).toContain('Master Services Agreement')
  })

  // =========================================================================
  // BUDGET-RUNTIME-04: Multiple polls do not repeatedly re-extract unchanged text-only doc
  // =========================================================================
  it('BUDGET-RUNTIME-04: repeated polls do not continuously re-extract unchanged text-only doc', async () => {
    const sampleFile = join(tempDir, 'spec-v3.txt')
    writeFileSync(sampleFile, 'Technical architecture specification for document indexing.', 'utf8')

    const tightBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 512,
    }

    const { manager, worker } = createTestManager({ budget: tightBudget })
    manager.remember(sampleFile)

    await new Promise((resolve) => setTimeout(resolve, 300))
    const initialExtractCalls = worker.extractCalls
    expect(initialExtractCalls).toBeGreaterThanOrEqual(1)

    // Trigger multiple poll cycles while storage remains full
    for (let i = 0; i < 3; i++) {
      await (manager as any).poll()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Extraction call count must NOT increase because document is unchanged and budget remains full
    expect(worker.extractCalls).toBe(initialExtractCalls)
  })

  // =========================================================================
  // BUDGET-RUNTIME-05: Budget recovery allows semantic continuation to complete
  // =========================================================================
  it('BUDGET-RUNTIME-05: when budget recovers from full, semantic continuation resumes and completes', async () => {
    const sampleFile = join(tempDir, 'knowledge-base.txt')
    writeFileSync(sampleFile, 'Knowledge base article discussing distributed vector store resilience.', 'utf8')

    const dynamicBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 512, // start full
    }

    const { manager, worker } = createTestManager({ budget: dynamicBudget })
    manager.remember(sampleFile)

    await new Promise((resolve) => setTimeout(resolve, 300))

    let doc = manager.store.documentByPath(sampleFile)
    expect(doc!.status).toBe('text-only')
    expect(worker.embedCalls).toBe(0)

    // Recover budget (expand limit to standard 4GB)
    dynamicBudget.maxDatabaseBytes = 4 * 1024 * 1024 * 1024
    // Trigger budget check & poll
    ;(manager as any).maintScheduler.checkStorageBudget()
    await (manager as any).poll()

    // Wait for embedding worker to process
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(worker.embedCalls).toBeGreaterThan(0)
    doc = manager.store.documentByPath(sampleFile)
    expect(doc!.status).toBe('ready')
    const progress = manager.store.chunkProgress(sampleFile)
    expect(progress.completedChunks).toBe(progress.totalChunks)
    expect(progress.totalChunks).toBeGreaterThan(0)
  })

  // =========================================================================
  // BUDGET-RUNTIME-06: Restart when document is semantic-deferred preserves lexical
  // =========================================================================
  it('BUDGET-RUNTIME-06: restart while document is semantic-deferred keeps lexical search and resumes on recovery', async () => {
    const sampleFile = join(tempDir, 'persistent-memo.txt')
    writeFileSync(sampleFile, 'Strategic executive memo regarding fourth quarter performance.', 'utf8')

    const dynamicBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 512,
    }

    const { manager: m1 } = createTestManager({ budget: dynamicBudget })
    m1.remember(sampleFile)

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(m1.store.documentByPath(sampleFile)!.status).toBe('text-only')

    // Close manager to simulate application shutdown/restart
    m1.close()

    // Reopen with new manager instance on same DB directory
    const worker2 = new MockBudgetWorker(join(tempDir, 'document-memory.db'))
    const m2 = new DocumentMemoryManager(tempDir, {
      workerFactory: () => worker2 as any,
      budget: dynamicBudget,
      pollIntervalMs: 60_000,
    })
    managers.push(m2)

    // Immediately verify lexical search functions before any recovery
    const lexicalSearch = await m2.search('Strategic executive memo')
    expect(lexicalSearch.hits.length).toBeGreaterThan(0)
    expect(lexicalSearch.hits[0]!.path).toBe(resolve(sampleFile))

    // Now recover budget on restarted manager
    dynamicBudget.maxDatabaseBytes = 4 * 1024 * 1024 * 1024
    ;(m2 as any).maintScheduler.checkStorageBudget()
    await (m2 as any).poll()

    await new Promise((resolve) => setTimeout(resolve, 400))
    const docAfterRecovery = m2.store.documentByPath(sampleFile)
    expect(docAfterRecovery!.status).toBe('ready')
    const progressAfter = m2.store.chunkProgress(sampleFile)
    expect(progressAfter.completedChunks).toBe(progressAfter.totalChunks)
    expect(progressAfter.totalChunks).toBeGreaterThan(0)
  })
})
