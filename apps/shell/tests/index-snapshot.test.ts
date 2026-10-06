import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { getEventLoopMetrics, getSqliteTimingSummary } from '../src/main/document-memory/sqlite-timing'

describe('Document Memory Snapshot & Consolidated Telemetry Suite (IT-4)', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-snapshot-'))
    dbPath = join(directory, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('computes storage diagnostics with page metrics and top offenders', () => {
    // Populate with 2 test documents
    store.replaceDocument(join(directory, 'file1.docx'), {
      hash: 'hash-f1',
      mtimeMs: 100,
      sizeBytes: 1000,
      chunks: [
        { text: 'Chunk 1 text', location: 'Chunk 1' },
        { text: 'Chunk 2 text', location: 'Chunk 2' },
      ],
      embeddingModel: null,
      status: 'text-only',
    })

    store.replaceDocument(join(directory, 'file2.docx'), {
      hash: 'hash-f2',
      mtimeMs: 200,
      sizeBytes: 2000,
      chunks: [
        { text: 'Another passage 1', location: 'Chunk 1' },
        { text: 'Another passage 2', location: 'Chunk 2' },
        { text: 'Another passage 3', location: 'Chunk 3' },
      ],
      embeddingModel: null,
      status: 'text-only',
      truncated: true,
      truncatedReason: 'chunk-limit',
    })

    const diagnostics = store.getStorageDiagnostics()

    expect(diagnostics.activeDbSizeBytes).toBeGreaterThan(0)
    expect(diagnostics.pageSize).toBeGreaterThanOrEqual(512)
    expect(diagnostics.pageCount).toBeGreaterThan(0)
    expect(diagnostics.freelistCount).toBeGreaterThanOrEqual(0)
    expect(diagnostics.schemaVersion).toBe('3')
    expect(diagnostics.migrationStatus).toBe('completed')

    // Top offenders
    expect(diagnostics.topOffendersByChunks.length).toBe(2)
    expect(diagnostics.topOffendersByChunks[0].chunks).toBe(3)
    expect(diagnostics.topOffendersByChunks[0].name).toBe('file2.docx')
    expect(diagnostics.topOffendersByChunks[0].truncated).toBe(true)

    expect(diagnostics.topOffendersBySize.length).toBe(2)
    expect(diagnostics.topOffendersBySize[0].name).toBe('file2.docx')
    expect(diagnostics.topOffendersBySize[0].sizeBytes).toBe(2000)

    // Fallback breakdown
    if (diagnostics.breakdown) {
      expect(diagnostics.breakdown.chunksBytes).toBeGreaterThan(0)
      expect(diagnostics.breakdown.documentsBytes).toBeGreaterThan(0)
      expect(diagnostics.breakdown.ftsBytes).toBeGreaterThan(0)
    }
  })

  it('provides event-loop and SQLite latency metrics in performance diagnostics', () => {
    const timing = getSqliteTimingSummary()
    expect(timing).toHaveProperty('totalOperations')
    expect(timing).toHaveProperty('slowOperations')
    expect(timing).toHaveProperty('criticalOperations')

    const eventLoop = getEventLoopMetrics()
    expect(eventLoop).toHaveProperty('p50')
    expect(eventLoop).toHaveProperty('p95')
    expect(eventLoop).toHaveProperty('p99')
    expect(eventLoop).toHaveProperty('max')
  })
})
