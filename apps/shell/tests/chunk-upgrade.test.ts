import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { ChunkUpgradeCoordinator } from '../src/main/document-memory/chunk-upgrade'
import { EmbeddingMigration } from '../src/main/document-memory/embedding-migration'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { capChunks, chunkDocumentTextV2 } from '../src/main/document-memory/chunks'
import { createBuildingSet } from '../src/main/document-memory/chunk-sets'
import { publishIndexingPolicy, resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'

class FakeWorker extends EventEmitter {
  constructor() {
    super()
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }

  postMessage(message: {
    id: number
    type: string
    path?: string
    texts?: string[]
  }) {
    setTimeout(() => {
      try {
        if (message.type === 'extract' && message.path) {
          const bytes = readFileSync(message.path)
          const text = bytes.toString('utf8')
          const stat = statSync(message.path)
          const v2 = capChunks(
            chunkDocumentTextV2(text, {
              title: message.path.split(/[\\/]/).pop(),
            }),
          )
          this.emit('message', {
            id: message.id,
            result: {
              hash: createHash('sha256').update(bytes).digest('hex'),
              mtimeMs: stat.mtimeMs,
              sizeBytes: stat.size,
              chunks: v2.chunks,
              status: 'ready',
            },
          })
        } else if (message.type === 'embed' && message.texts) {
          this.emit('message', {
            id: message.id,
            result: message.texts.map(() => [0.1, 0.2, 0.3]),
          })
        }
      } catch (err) {
        this.emit('message', {
          id: message.id,
          error: (err as Error).message,
        })
      }
    }, 5)
  }
}

describe('Document Search V2 - Existing Data Chunk Migration Engine', () => {
  let directory: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-chunk-upgrade-'))
    managers = []
  })

  afterEach(() => {
    for (const m of managers) {
      m.close()
    }
    resetIndexingPolicyBus()
    rmSync(directory, { recursive: true, force: true })
  })

  function createManager(): { manager: DocumentMemoryManager; db: DatabaseSync; store: DocumentMemoryStore } {
    const worker = new FakeWorker()
    const manager = new DocumentMemoryManager(directory, {
      dbDir: directory,
      workerFactory: () => worker as unknown as Worker,
      pollIntervalMs: 60_000,
    })
    managers.push(manager)
    const store = (manager as unknown as { store: DocumentMemoryStore }).store
    const db = store.rawDb
    return { manager, db, store }
  }

  function insertLegacyV1Document(
    db: DatabaseSync,
    docId: number,
    path: string,
    name: string,
    chunks: Array<{ text: string; location: string }>,
    options?: { priorityAt?: number; sizeBytes?: number; mtimeMs?: number; status?: string; embeddingModel?: string },
  ): void {
    const normalizedPath = resolve(path)
    db.prepare(`
      INSERT INTO documents (
        id, path, name, status, embedding_model, active_chunk_set_id,
        priority_at, size_bytes, mtime_ms, chunk_total, chunk_done, chunk_counted
      )
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0)
    `).run(
      docId,
      normalizedPath,
      name,
      options?.status ?? 'ready',
      options?.embeddingModel ?? 'legacy-v1-model',
      options?.priorityAt ?? 0,
      options?.sizeBytes ?? 1000,
      options?.mtimeMs ?? 1000,
      chunks.length,
    )

    const insertChunk = db.prepare(`
      INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES (?, NULL, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)')

    chunks.forEach((c, idx) => {
      const norm = c.text.toLowerCase()
      const res = insertChunk.run(docId, idx, c.text, norm, c.location)
      insertFts.run(res.lastInsertRowid, norm)
    })
  }

  it('eliminates text overlap duplication by re-extracting from pristine source file (Zero Overlap Corruption)', async () => {
    // 1. Create source file with distinct paragraphs on disk
    const filePath = join(directory, 'overlap-doc.txt')
    const sourceContent = 'Paragraph A.\n\nParagraph B.\n\nParagraph C.'
    writeFileSync(filePath, sourceContent, 'utf8')
    const fileStat = statSync(filePath)

    const { manager, db, store } = createManager()

    // 2. Seed database with legacy V1 overlapping chunks:
    // Chunk 1 has Paragraph A + B
    // Chunk 2 has Paragraph B + C
    insertLegacyV1Document(
      db,
      1,
      filePath,
      'overlap-doc.txt',
      [
        { text: 'Paragraph A.\n\nParagraph B.', location: 'Chunk 1' },
        { text: 'Paragraph B.\n\nParagraph C.', location: 'Chunk 2' },
      ],
      {
        priorityAt: 100,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      },
    )

    // Verify initial lexical search works on legacy chunks
    const initialHits = store.searchLexical('Paragraph B', 10)
    expect(initialHits.length).toBeGreaterThan(0)
    expect(initialHits[0]?.documentId).toBe(1)

    // 3. Coordinator identifies document needing upgrade
    const coordinator = new ChunkUpgradeCoordinator(db)
    const needing = coordinator.getDocumentsNeedingUpgrade()
    expect(needing).toHaveLength(1)
    expect(needing[0]?.id).toBe(1)

    // 4. Run migration step through DocumentMemoryManager (reads from pristine source file via Worker)
    const ok = await (manager as unknown as { migrateLegacyDocument: (doc: unknown) => Promise<boolean> }).migrateLegacyDocument(needing[0]!)
    expect(ok).toBe(true)

    // 5. Verification:
    // a. Active chunk set is now V2
    const docRow = db.prepare('SELECT active_chunk_set_id FROM documents WHERE id = 1').get() as {
      active_chunk_set_id: number
    }
    expect(docRow.active_chunk_set_id).toBeGreaterThan(0)
    const setRow = db
      .prepare('SELECT state, chunker_version FROM chunk_sets WHERE id = ?')
      .get(docRow.active_chunk_set_id) as { state: string; chunker_version: number }
    expect(setRow.state).toBe('active')
    expect(setRow.chunker_version).toBe(2)

    // b. Old V1 chunks purged
    const oldV1Count = db
      .prepare('SELECT count(*) AS count FROM chunks WHERE document_id = 1 AND chunk_set_id IS NULL')
      .get() as { count: number }
    expect(oldV1Count.count).toBe(0)

    // c. TEXT OVERLAP CHECK: Paragraph B. MUST NOT BE DUPLICATED!
    const v2Chunks = db
      .prepare('SELECT text FROM chunks WHERE document_id = 1')
      .all() as Array<{ text: string }>
    const fullMigratedText = v2Chunks.map((c) => c.text).join('\n\n')

    // Count occurrences of "Paragraph B." in migrated text
    const matches = fullMigratedText.match(/Paragraph B\./g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1) // EXACTLY 1 occurrence, NOT 2!

    // d. Coordinator state is updated to complete
    expect(coordinator.getProgress().completedDocuments).toBe(1)
    expect(coordinator.isComplete()).toBe(true)

    // e. Lexical search immediately serves new V2 chunks seamlessly
    const hitsAfter = store.searchLexical('Paragraph B', 10)
    expect(hitsAfter).toHaveLength(1)
    expect(hitsAfter[0]?.documentId).toBe(1)
  })

  it('preserves continuous lexical searchability during migration (Zero-Downtime Cutover)', async () => {
    const filePath = join(directory, 'security-audit.txt')
    const content = 'Báo cáo kiểm toán bảo mật hạ tầng thông tin và đánh giá rủi ro an toàn mạng năm 2026.'
    writeFileSync(filePath, content, 'utf8')
    const fileStat = statSync(filePath)

    const { manager, db, store } = createManager()

    insertLegacyV1Document(
      db,
      10,
      filePath,
      'security-audit.txt',
      [{ text: content, location: 'Chunk 1' }],
      {
        priorityAt: 50,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      },
    )

    // 1. Lexical search matches V1 chunk initially
    const hitsInitial = store.searchLexical('bảo mật', 10)
    expect(hitsInitial).toHaveLength(1)
    expect(hitsInitial[0]?.documentId).toBe(10)
    expect(store.readChunk(hitsInitial[0]!.chunkId)?.text).toContain('Báo cáo kiểm toán bảo mật')

    // 2. Simulate intermediate building set state: building set created, chunks inserted, NOT yet activated
    const buildingSetId = createBuildingSet(db, 10, 2)
    const insertChunk = db.prepare(`
      INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)')
    const res = insertChunk.run(
      10,
      buildingSetId,
      0,
      'Bản nháp mới về bảo mật thông tin.',
      'bản nháp mới về bảo mật thông tin.',
      'Chunk 1',
    )
    insertFts.run(res.lastInsertRowid, 'bản nháp mới về bảo mật thông tin.')

    // Building set must NOT leak into active search results (search still reads active/legacy chunks)
    const hitsDuringBuilding = store.searchLexical('bảo mật', 10)
    expect(hitsDuringBuilding).toHaveLength(1)
    expect(store.readChunk(hitsDuringBuilding[0]!.chunkId)?.text).toContain('Báo cáo kiểm toán bảo mật')

    // Clean up temporary building set
    db.prepare('DELETE FROM chunk_fts WHERE rowid = ?').run(res.lastInsertRowid)
    db.prepare('DELETE FROM chunks WHERE chunk_set_id = ?').run(buildingSetId)
    db.prepare('DELETE FROM chunk_sets WHERE id = ?').run(buildingSetId)

    // 3. Migrate document 10
    const coordinator = new ChunkUpgradeCoordinator(db)
    const candidate = coordinator.getDocumentsNeedingUpgrade()[0]!
    const ok = await (manager as unknown as { migrateLegacyDocument: (doc: unknown) => Promise<boolean> }).migrateLegacyDocument(candidate)
    expect(ok).toBe(true)

    // 4. Lexical search immediately serves the new V2 chunk without any missing interval
    const hitsAfter = store.searchLexical('bảo mật', 10)
    expect(hitsAfter).toHaveLength(1)
    expect(hitsAfter[0]?.documentId).toBe(10)
    expect(store.readChunk(hitsAfter[0]!.chunkId)?.text).toContain('bảo mật')
  })

  it('skips migration and retains legacy chunks when source file is unavailable / offline', async () => {
    const { manager, db, store } = createManager()

    // File does NOT exist on disk
    const missingPath = join(directory, 'offline-drive', 'report.pdf')

    insertLegacyV1Document(
      db,
      20,
      missingPath,
      'report.pdf',
      [{ text: 'Important offline data that must not be deleted.', location: 'Chunk 1' }],
    )

    const coordinator = new ChunkUpgradeCoordinator(db)
    const candidate = coordinator.getDocumentsNeedingUpgrade()[0]!

    // Attempt migration
    const ok = await (manager as unknown as { migrateLegacyDocument: (doc: unknown) => Promise<boolean> }).migrateLegacyDocument(candidate)
    expect(ok).toBe(false)

    // Legacy chunks must be strictly preserved!
    const chunkCount = db.prepare('SELECT count(*) AS count FROM chunks WHERE document_id = 20').get() as {
      count: number
    }
    expect(chunkCount.count).toBe(1)

    // Lexical search still finds the document via its cached index
    const hits = store.searchLexical('offline data', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.documentId).toBe(20)

    // Document is skipped from immediate re-upgrade in subsequent steps
    const skippedNeeding = coordinator.getDocumentsNeedingUpgrade(1, [20])
    expect(skippedNeeding).toHaveLength(0)
  })

  it('detects modified source files and routes them to normal P1 queue', async () => {
    const filePath = resolve(join(directory, 'modified-file.txt'))
    writeFileSync(filePath, 'New content modified on disk.', 'utf8')

    const { manager, db } = createManager()

    // Stored metadata has old mtime and size
    insertLegacyV1Document(
      db,
      30,
      filePath,
      'modified-file.txt',
      [{ text: 'Old content.', location: 'Chunk 1' }],
      {
        sizeBytes: 99999,
        mtimeMs: 12345,
      },
    )

    const coordinator = new ChunkUpgradeCoordinator(db)
    const candidate = coordinator.getDocumentsNeedingUpgrade()[0]!

    const enqueueSpy = vi.spyOn(manager as any, 'enqueue')

    // Attempt migration
    const ok = await (manager as unknown as { migrateLegacyDocument: (doc: unknown) => Promise<boolean> }).migrateLegacyDocument(candidate)
    expect(ok).toBe(false)

    // File was diverted to P1 queue with prioritize = true
    expect(enqueueSpy).toHaveBeenCalledWith(candidate.path, true)
  })

  it('prioritizes documents strictly by priority_at DESC and size_bytes ASC (MIG-4)', () => {
    const { db } = createManager()

    // Doc 1: Low priority, large
    insertLegacyV1Document(db, 1, join(directory, 'doc1.txt'), 'doc1.txt', [{ text: 'Content 1', location: 'C1' }], {
      priorityAt: 100,
      sizeBytes: 5000,
    })
    // Doc 2: High priority (recently opened), medium size
    insertLegacyV1Document(db, 2, join(directory, 'doc2.txt'), 'doc2.txt', [{ text: 'Content 2', location: 'C1' }], {
      priorityAt: 500,
      sizeBytes: 2000,
    })
    // Doc 3: High priority (recently opened), small size (should come before Doc 2)
    insertLegacyV1Document(db, 3, join(directory, 'doc3.txt'), 'doc3.txt', [{ text: 'Content 3', location: 'C1' }], {
      priorityAt: 500,
      sizeBytes: 500,
    })
    // Doc 4: Lowest priority
    insertLegacyV1Document(db, 4, join(directory, 'doc4.txt'), 'doc4.txt', [{ text: 'Content 4', location: 'C1' }], {
      priorityAt: 10,
      sizeBytes: 100,
    })

    const coordinator = new ChunkUpgradeCoordinator(db)
    const queue = coordinator.getDocumentsNeedingUpgrade()

    expect(queue.map((d) => d.id)).toEqual([3, 2, 1, 4])
  })

  it('recovers from crash/interruption by discarding dangling building sets and resuming cleanly (MIG-14)', () => {
    const { db } = createManager()

    insertLegacyV1Document(db, 1, join(directory, 'crash-doc.txt'), 'crash-doc.txt', [
      { text: 'Stable legacy content before crash', location: 'C1' },
    ])

    // Simulate crash: an incomplete building set was created with chunks in DB but never activated
    const danglingSetId = createBuildingSet(db, 1, 2)
    const insertChunk = db.prepare(`
      INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, normalized, location)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)')
    const res = insertChunk.run(1, danglingSetId, 0, 'Dangling text chunk', 'dangling text chunk', 'C1')
    insertFts.run(res.lastInsertRowid, 'dangling text chunk')

    // Verify dangling state exists
    const beforeDangling = db.prepare("SELECT count(*) AS count FROM chunk_sets WHERE state = 'building'").get() as {
      count: number
    }
    expect(beforeDangling.count).toBe(1)

    // Coordinator instance starts up: autoRecover purges dangling sets (MIG-14)
    const coordinator = new ChunkUpgradeCoordinator(db)

    const afterDangling = db.prepare("SELECT count(*) AS count FROM chunk_sets WHERE state = 'building'").get() as {
      count: number
    }
    expect(afterDangling.count).toBe(0)

    // Orphaned chunks of building set are removed
    const orphanChunks = db.prepare('SELECT count(*) AS count FROM chunks WHERE chunk_set_id = ?').get(danglingSetId) as {
      count: number
    }
    expect(orphanChunks.count).toBe(0)

    // Document is still pending upgrade
    expect(coordinator.getDocumentsNeedingUpgrade()).toHaveLength(1)
  })

  it('supports pause and resume during chunk upgrade', () => {
    const { db } = createManager()

    insertLegacyV1Document(db, 1, join(directory, 'pause1.txt'), 'pause1.txt', [{ text: 'Pausable 1', location: 'C1' }])
    insertLegacyV1Document(db, 2, join(directory, 'pause2.txt'), 'pause2.txt', [{ text: 'Pausable 2', location: 'C1' }])

    const coordinator = new ChunkUpgradeCoordinator(db)
    coordinator.pause()
    expect(coordinator.getProgress().state).toBe('paused')

    // Calling getDocumentsNeedingUpgrade while paused returns empty
    const pausedNeeding = coordinator.getDocumentsNeedingUpgrade()
    expect(pausedNeeding).toHaveLength(0)

    coordinator.resume()
    expect(coordinator.getProgress().state).toBe('running')

    const resumedNeeding = coordinator.getDocumentsNeedingUpgrade()
    expect(resumedNeeding).toHaveLength(2)
  })

  it('ensures embedding-migration ignores V1 chunks and only embeds V2 active chunks (MIG-9)', () => {
    const { db, store } = createManager()

    // 1. Doc 1 has legacy V1 chunks (active_chunk_set_id IS NULL)
    insertLegacyV1Document(db, 1, join(directory, 'doc-v1.txt'), 'doc-v1.txt', [
      { text: 'Legacy chunk text that should NOT be embedded by target model', location: 'C1' },
    ])

    // 2. Doc 2 has been upgraded to Chunker V2
    store.replaceDocument(join(directory, 'doc-v2.txt'), {
      hash: 'h-v2',
      mtimeMs: 1000,
      sizeBytes: 50,
      chunks: [{ text: 'Upgraded V2 chunk ready for modern target embedding', location: 'C1' }],
      embeddingModel: 'test-source',
      status: 'ready',
    })

    const embeddingMigration = new EmbeddingMigration(db)
    embeddingMigration.setTarget('target-qwen3-0.6b:v1')

    const progress = embeddingMigration.getProgress()
    // Total chunks to embed MUST ONLY count V2 chunks (1 chunk from Doc 2), NOT V1 chunk from Doc 1
    expect(progress.totalChunks).toBe(1)

    // nextBatch MUST only return chunks belonging to V2 active chunk sets
    const batch = embeddingMigration.nextBatch(10)
    expect(batch.chunks).toHaveLength(1)
    expect(batch.chunks[0]?.text).toBe('Upgraded V2 chunk ready for modern target embedding')
  })
})
