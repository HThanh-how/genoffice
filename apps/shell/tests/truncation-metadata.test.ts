import { EventEmitter } from 'node:events'
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { ChunkUpgradeCoordinator } from '../src/main/document-memory/chunk-upgrade'
import { extractDocument, MAX_INDEX_TEXT_CHARS } from '../src/main/document-memory/worker'
import { resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import { storageBudgetAckReply, waitForManagerWriteReady } from './helpers/storage-budget-ack'

function normalizePathIdentity(p: string): string {
  const resolved = resolve(p)
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

const PDF_FIXTURE = join(__dirname, 'fixtures', 'mixed-scan.pdf')

class InProcessWorker extends EventEmitter {
  constructor(
    private readonly dbPath: string,
    private readonly failPaths: Set<string>,
  ) {
    super()
  }

  postMessage(message: {
    id: number
    type: string
    path?: string
    texts?: string[]
    maxPdfPages?: number
    configVersion?: number
    budget?: { maxDatabaseBytes?: number }
  }): void {
    setTimeout(async () => {
      try {
        const ack = storageBudgetAckReply(message)
        if (ack) {
          this.emit('message', ack)
          return
        }
        if (message.type === 'extract' && message.path) {
          const norm = normalizePathIdentity(message.path)
          const isFailing = [...this.failPaths].some((f) => normalizePathIdentity(f) === norm)
          if (isFailing) {
            this.emit('message', {
              id: message.id,
              error: 'Extraction error: file corrupted or unreadable',
            })
            return
          }
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
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: message.id,
            result: (message.texts ?? []).map(() => [0.1, 0.2]),
          })
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

describe('Document Search V3 - Truncation Metadata Persistence', () => {
  let tempDir: string
  let managers: DocumentMemoryManager[]
  let failPaths: Set<string>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'truncation-metadata-test-'))
    managers = []
    failPaths = new Set<string>()
  })

  afterEach(() => {
    for (const manager of managers) {
      manager.close()
    }
    resetIndexingPolicyBus()
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function createTestManager(): Promise<{
    manager: DocumentMemoryManager
    store: DocumentMemoryStore
    rawDb: DatabaseSync
  }> {
    const dbPath = join(tempDir, 'document-memory.db')
    const manager = new DocumentMemoryManager(tempDir, {
      workerFactory: () => new InProcessWorker(dbPath, failPaths) as unknown as Worker,
      pollIntervalMs: 60_000,
    })
    managers.push(manager)
    const store = (manager as unknown as { store: DocumentMemoryStore }).store
    await waitForManagerWriteReady(manager)
    return { manager, store, rawDb: store.rawDb }
  }

  it('TRUNC-01: content limit reason persisted', async () => {
    const { manager, store, rawDb } = await createTestManager()

    // Create a document exceeding MAX_INDEX_TEXT_CHARS (8MB text)
    expect(MAX_INDEX_TEXT_CHARS).toBe(8 * 1024 * 1024)
    const hugeFile = join(tempDir, 'huge-document.txt')
    const sampleLine = 'Enterprise search index cost control truncation policy line.\n'
    const repeatCount = Math.ceil((8.5 * 1024 * 1024) / sampleLine.length)
    writeFileSync(hugeFile, sampleLine.repeat(repeatCount), 'utf8')

    // Index via production pipeline
    const outcome = await manager.readNowDocument(hugeFile)
    expect(outcome.ok).toBe(true)

    // Verify stored document metadata
    const doc = store.documentByPath(hugeFile)
    expect(doc).not.toBeNull()
    expect(doc!.truncated).toBe(true)
    expect(doc!.truncatedReason).toBe('content-limit')

    // Verify direct SQLite row persistence
    const row = rawDb
      .prepare('SELECT status, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(hugeFile)) as {
      status: string
      truncated: number
      truncated_reason: string | null
    }
    expect(row).toBeDefined()
    expect(row.status).toBe('text-only')
    expect(row.truncated).toBe(1)
    expect(row.truncated_reason).toBe('content-limit')

    // Verify search hit carries truncatedReason
    const hits = store.search('Enterprise search index', null)
    const hit = hits.find((h) => h.path === resolve(hugeFile))
    expect(hit).toBeDefined()
    expect(hit!.truncated).toBe(true)
    expect(hit!.truncatedReason).toBe('content-limit')
  }, 60_000)

  it('TRUNC-02: PDF page limit reason persisted', async () => {
    const { manager, store, rawDb } = await createTestManager()

    // Fixture mixed-scan.pdf has 3 pages
    const pdfPath = join(tempDir, 'three-page.pdf')
    copyFileSync(PDF_FIXTURE, pdfPath)

    // Enforce PDF page limit = 2
    manager.setPdfMaxPages(2)

    // Index via production pipeline
    const outcome = await manager.readNowDocument(pdfPath)
    expect(outcome.ok).toBe(true)

    // Verify stored document metadata
    const doc = store.documentByPath(pdfPath)
    expect(doc).not.toBeNull()
    expect(doc!.truncated).toBe(true)
    expect(doc!.truncatedReason).toBe('pdf-page-limit')

    // Verify direct SQLite row persistence
    const row = rawDb
      .prepare('SELECT status, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(pdfPath)) as {
      status: string
      truncated: number
      truncated_reason: string | null
    }
    expect(row).toBeDefined()
    expect(row.truncated).toBe(1)
    expect(row.truncated_reason).toBe('pdf-page-limit')

    // Verify search hit carries truncatedReason
    const hits = store.search('page', null)
    const hit = hits.find((h) => h.path === resolve(pdfPath))
    expect(hit).toBeDefined()
    expect(hit!.truncated).toBe(true)
    expect(hit!.truncatedReason).toBe('pdf-page-limit')
  })

  it('TRUNC-03: legacy migrator reason persisted', async () => {
    const { manager, store, rawDb } = await createTestManager()

    // 1. Create a tabular document with 4000 rows (triggers tabular-sampling)
    const csvPath = join(tempDir, 'legacy-tabular.csv')
    const header = 'id,product,department,price,stock,description'
    const rows = Array.from(
      { length: 4_000 },
      (_, i) =>
        `${i + 1},Product_${i + 1},Warehouse,${10 + i},${100 - (i % 10)},Inventory audit catalog item`,
    )
    writeFileSync(csvPath, [header, ...rows].join('\n'), 'utf8')
    const stat = statSync(csvPath)
    const normPath = resolve(csvPath)
    const legacyDocId = 77

    // 2. Seed database with legacy V1 state (active_chunk_set_id IS NULL)
    rawDb
      .prepare(
        `INSERT INTO documents (
          id, path, name, status, embedding_model, active_chunk_set_id,
          priority_at, size_bytes, mtime_ms, chunk_total, chunk_done, chunk_counted, truncated, truncated_reason
        ) VALUES (?, ?, ?, 'ready', 'legacy-v1-model', NULL, 500, ?, ?, 1, 1, 1, 0, NULL)`,
      )
      .run(legacyDocId, normPath, 'legacy-tabular.csv', stat.size, stat.mtimeMs)

    rawDb
      .prepare(
        `INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, location)
         VALUES (?, NULL, 0, 'id,product,department,price,stock', 'Header')`,
      )
      .run(legacyDocId)

    // 3. Coordinator identifies document needing upgrade
    const coordinator = new ChunkUpgradeCoordinator(rawDb)
    const candidates = coordinator.getDocumentsNeedingUpgrade()
    const targetCandidate = candidates.find((c) => c.id === legacyDocId)
    expect(targetCandidate).toBeDefined()

    // 4. Run zero-downtime migration via LegacyChunkMigrator production path
    const migrated = await manager.migrateLegacyDocument(targetCandidate!)
    expect(migrated).toBe(true)

    // 5. Verify truncation metadata is persisted through legacy migrator
    const doc = store.documentByPath(csvPath)
    expect(doc).not.toBeNull()
    expect(doc!.truncated).toBe(true)
    expect(doc!.truncatedReason).toBe('tabular-sampling')

    // Verify direct SQLite row has active V2 chunk set and truncation metadata
    const row = rawDb
      .prepare(
        'SELECT status, truncated, truncated_reason, active_chunk_set_id FROM documents WHERE id = ?',
      )
      .get(legacyDocId) as {
      status: string
      truncated: number
      truncated_reason: string | null
      active_chunk_set_id: number | null
    }
    expect(row).toBeDefined()
    expect(row.truncated).toBe(1)
    expect(row.truncated_reason).toBe('tabular-sampling')
    expect(row.active_chunk_set_id).toBeGreaterThan(0)
  })

  it('TRUNC-04: successful reindex replaces old reason', async () => {
    const { manager, store, rawDb } = await createTestManager()

    // 1. Initial indexing with tabular-sampling truncation
    const docPath = join(tempDir, 'dynamic-doc.csv')
    const csvHeader = 'id,name,status,department,role,salary'
    const csvRows = Array.from(
      { length: 4_000 },
      (_, i) => `${i + 1},Employee_${i + 1},Active,Engineering,Developer,95000`,
    )
    writeFileSync(docPath, [csvHeader, ...csvRows].join('\n'), 'utf8')

    const firstOutcome = await manager.readNowDocument(docPath)
    expect(firstOutcome.ok).toBe(true)

    const initialDoc = store.documentByPath(docPath)
    expect(initialDoc).not.toBeNull()
    expect(initialDoc!.truncated).toBe(true)
    expect(initialDoc!.truncatedReason).toBe('tabular-sampling')

    // 2. Modify document to short normal CSV (not truncated)
    const smallCsv = 'id,name,status\n1,Alice,Active\n2,Bob,Active\n'
    writeFileSync(docPath, smallCsv, 'utf8')

    // Reindex document
    const secondOutcome = await manager.readNowDocument(docPath)
    expect(secondOutcome.ok).toBe(true)

    const clearedDoc = store.documentByPath(docPath)
    expect(clearedDoc).not.toBeNull()
    expect(clearedDoc!.truncated).toBe(false)
    expect(clearedDoc!.truncatedReason).toBeNull()

    const clearedRow = rawDb
      .prepare('SELECT status, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(docPath)) as {
      status: string
      truncated: number
      truncated_reason: string | null
    }
    expect(clearedRow.truncated).toBe(0)
    expect(clearedRow.truncated_reason).toBeNull()

    // 3. Update document with huge content (>8MB) exceeding content limit
    const hugeLine =
      '100,LargeDataRow,VeryLongInformationField,EngineeringDepartment,StaffEngineer,120000\n'
    const repeatCount = Math.ceil((8.5 * 1024 * 1024) / hugeLine.length)
    writeFileSync(docPath, [csvHeader, hugeLine.repeat(repeatCount)].join('\n'), 'utf8')

    // Reindex document again
    const thirdOutcome = await manager.readNowDocument(docPath)
    expect(thirdOutcome.ok).toBe(true)

    const updatedDoc = store.documentByPath(docPath)
    expect(updatedDoc).not.toBeNull()
    expect(updatedDoc!.truncated).toBe(true)
    expect(updatedDoc!.truncatedReason).toBe('content-limit')

    const updatedRow = rawDb
      .prepare('SELECT status, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(docPath)) as {
      status: string
      truncated: number
      truncated_reason: string | null
    }
    expect(updatedRow.truncated).toBe(1)
    expect(updatedRow.truncated_reason).toBe('content-limit')
  }, 60_000)

  it('TRUNC-05: error state clears stale reason (chuyển sang error thì truncated=0 và truncated_reason=NULL)', async () => {
    const { manager, store, rawDb } = await createTestManager()

    // 1. Establish a document with truncated state
    const docPath = join(tempDir, 'error-test-doc.txt')
    const sampleLine = 'Document destined to encounter an indexing error.\n'
    const repeatCount = Math.ceil((8.5 * 1024 * 1024) / sampleLine.length)
    writeFileSync(docPath, sampleLine.repeat(repeatCount), 'utf8')

    const initialOutcome = await manager.readNowDocument(docPath)
    expect(initialOutcome.ok).toBe(true)

    const initialDoc = store.documentByPath(docPath)
    expect(initialDoc).not.toBeNull()
    expect(initialDoc!.status).toBe('text-only')
    expect(initialDoc!.truncated).toBe(true)
    expect(initialDoc!.truncatedReason).toBe('content-limit')

    const initialRow = rawDb
      .prepare('SELECT status, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(docPath)) as {
      status: string
      truncated: number
      truncated_reason: string | null
    }
    expect(initialRow.truncated).toBe(1)
    expect(initialRow.truncated_reason).toBe('content-limit')

    // 2. Simulate worker extraction failure during re-read
    failPaths.add(resolve(docPath))
    // Update file content so manager triggers re-extraction
    writeFileSync(docPath, 'Corrupted content causing extraction failure.', 'utf8')

    const errorOutcome = await manager.readNowDocument(docPath)
    expect(errorOutcome.ok).toBe(false)
    expect(errorOutcome.error).toContain('Extraction error')

    // Production contract (document-repository.ts recordTransientError): a transient extraction failure on a
    // document that still has active cached content (`hash` set / status ready|text-only) keeps that content
    // searchable -- `const newStatus = hasActiveCachedContent ? 'pending' : 'error'` -- so the doc is requeued as
    // pending with the error recorded, and the retained (still truncated) chunks keep their truncation metadata.
    const errorDoc = store.documentByPath(docPath)
    expect(errorDoc).not.toBeNull()
    expect(errorDoc!.status).toBe('pending')
    expect(errorDoc!.error).toContain('Extraction error')
    expect(errorDoc!.truncated).toBe(true)
    expect(errorDoc!.truncatedReason).toBe('content-limit')

    const errorRow = rawDb
      .prepare('SELECT status, error, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(docPath)) as {
      status: string
      error: string | null
      truncated: number
      truncated_reason: string | null
    }
    expect(errorRow.status).toBe('pending')
    expect(errorRow.error).toContain('Extraction error')
    expect(errorRow.truncated).toBe(1)
    expect(errorRow.truncated_reason).toBe('content-limit')

    // A document with no cached content transitions to a hard error and has no stale truncation.
    const coldPath = join(tempDir, 'cold-error-doc.txt')
    writeFileSync(coldPath, 'Never extracted successfully.', 'utf8')
    failPaths.add(resolve(coldPath))
    const coldOutcome = await manager.readNowDocument(coldPath)
    expect(coldOutcome.ok).toBe(false)
    const coldRow = rawDb
      .prepare('SELECT status, error, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(coldPath)) as {
      status: string
      error: string | null
      truncated: number
      truncated_reason: string | null
    }
    expect(coldRow.status).toBe('error')
    expect(coldRow.error).toContain('Extraction error')
    expect(coldRow.truncated).toBe(0)
    expect(coldRow.truncated_reason).toBeNull()

    // 3. Additionally verify store.markError directly clears stale truncation
    const directDocPath = join(tempDir, 'direct-error-doc.txt')
    writeFileSync(directDocPath, 'Seed text', 'utf8')
    store.replaceDocument(directDocPath, {
      hash: 'hash-direct',
      mtimeMs: 1000,
      sizeBytes: 100,
      chunks: [{ text: 'Seed passage', location: 'Section 1' }],
      embeddingModel: null,
      status: 'text-only',
      truncated: true,
      truncatedReason: 'chunk-limit',
    })

    const directBefore = store.documentByPath(directDocPath)
    expect(directBefore!.truncated).toBe(true)
    expect(directBefore!.truncatedReason).toBe('chunk-limit')

    store.markError(directDocPath, 'Filesystem read permission denied')

    const directAfter = store.documentByPath(directDocPath)
    expect(directAfter).not.toBeNull()
    expect(directAfter!.status).toBe('error')
    expect(directAfter!.truncated).toBe(false)
    expect(directAfter!.truncatedReason).toBeNull()

    const directRow = rawDb
      .prepare('SELECT status, truncated, truncated_reason FROM documents WHERE path = ?')
      .get(resolve(directDocPath)) as {
      status: string
      truncated: number
      truncated_reason: string | null
    }
    expect(directRow.status).toBe('error')
    expect(directRow.truncated).toBe(0)
    expect(directRow.truncated_reason).toBeNull()
  }, 60_000)
})
