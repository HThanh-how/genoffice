import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { ChunkUpgradeCoordinator } from '../src/main/document-memory/chunk-upgrade'
import { EmbeddingMigration } from '../src/main/document-memory/embedding-migration'
import { createBuildingSet } from '../src/main/document-memory/chunk-sets'

describe('Document Search V2 - Existing Data Chunk Migration Engine', () => {
  let directory: string
  let store: DocumentMemoryStore
  let db: DatabaseSync

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-chunk-upgrade-'))
    const dbPath = join(directory, 'memory.sqlite')
    store = new DocumentMemoryStore(dbPath)
    db = (store as unknown as { db: DatabaseSync }).db
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function insertLegacyV1Document(
    docId: number,
    path: string,
    name: string,
    chunks: Array<{ text: string; location: string }>,
    options?: { priorityAt?: number; sizeBytes?: number; status?: string; embeddingModel?: string },
  ): void {
    db.prepare(`
      INSERT INTO documents (
        id, path, name, status, embedding_model, active_chunk_set_id,
        priority_at, size_bytes, chunk_total, chunk_done, chunk_counted
      )
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0)
    `).run(
      docId,
      path,
      name,
      options?.status ?? 'ready',
      options?.embeddingModel ?? 'legacy-v1-model',
      options?.priorityAt ?? 0,
      options?.sizeBytes ?? 1000,
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

  it('migrates legacy V1 documents to V2 chunk sets atomically (create building set -> activate -> delete old chunks)', () => {
    insertLegacyV1Document(1, join(directory, 'doc1.docx'), 'doc1.docx', [
      { text: 'First paragraph of legacy document one.', location: 'Chunk 1' },
      { text: 'Second paragraph of legacy document one with extra details.', location: 'Chunk 2' },
    ])
    insertLegacyV1Document(2, join(directory, 'doc2.docx'), 'doc2.docx', [
      { text: 'Content of legacy document two.', location: 'Chunk 1' },
    ])

    const coordinator = new ChunkUpgradeCoordinator(db)

    // Initial state check
    const initialProgress = coordinator.getProgress()
    expect(initialProgress.totalDocuments).toBe(2)
    expect(initialProgress.completedDocuments).toBe(0)
    expect(initialProgress.state).toBe('pending')

    // 1. Upgrade first document
    const upgradedDoc1 = coordinator.upgradeDocument(1)
    expect(upgradedDoc1).toBe(true)

    // Verify V2 chunk set was created and activated
    const doc1Row = db
      .prepare('SELECT active_chunk_set_id FROM documents WHERE id = 1')
      .get() as { active_chunk_set_id: number }
    expect(doc1Row.active_chunk_set_id).toBeGreaterThan(0)

    const set1Row = db
      .prepare('SELECT state, chunker_version FROM chunk_sets WHERE id = ?')
      .get(doc1Row.active_chunk_set_id) as { state: string; chunker_version: number }
    expect(set1Row.state).toBe('active')
    expect(set1Row.chunker_version).toBe(2)

    // Verify old V1 chunks were purged
    const oldV1Chunks = db
      .prepare('SELECT count(*) AS count FROM chunks WHERE document_id = 1 AND chunk_set_id IS NULL')
      .get() as { count: number }
    expect(oldV1Chunks.count).toBe(0)

    // Check intermediate progress
    const progressAfter1 = coordinator.getProgress()
    expect(progressAfter1.completedDocuments).toBe(1)

    // 2. Upgrade second document via nextBatch
    const count = coordinator.nextBatch(1)
    expect(count).toBe(1)

    const finalProgress = coordinator.getProgress()
    expect(finalProgress.completedDocuments).toBe(2)
    expect(finalProgress.state).toBe('complete')
    expect(coordinator.isComplete()).toBe(true)
  })

  it('preserves continuous lexical searchability during migration (Zero-Downtime Cutover)', () => {
    const docPath = join(directory, 'security-audit.pdf')
    insertLegacyV1Document(10, docPath, 'security-audit.pdf', [
      {
        text: 'Báo cáo kiểm toán bảo mật hạ tầng thông tin và đánh giá rủi ro an toàn mạng năm 2026.',
        location: 'Chunk 1',
      },
    ])

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

    // Clean up temporary building set for coordinator to run clean migration
    db.prepare('DELETE FROM chunks WHERE chunk_set_id = ?').run(buildingSetId)
    db.prepare('DELETE FROM chunk_sets WHERE id = ?').run(buildingSetId)

    // 3. Run coordinator upgrade on document 10
    const coordinator = new ChunkUpgradeCoordinator(db)
    const ok = coordinator.upgradeDocument(10)
    expect(ok).toBe(true)

    // 4. Lexical search immediately serves the new V2 chunk without any missing interval
    const hitsAfter = store.searchLexical('bảo mật', 10)
    expect(hitsAfter).toHaveLength(1)
    expect(hitsAfter[0]?.documentId).toBe(10)
    expect(store.readChunk(hitsAfter[0]!.chunkId)?.text).toContain('bảo mật')
  })

  it('prioritizes documents strictly by priority_at DESC and size_bytes ASC (MIG-4)', () => {
    // Doc 1: Low priority, large
    insertLegacyV1Document(1, join(directory, 'doc1.txt'), 'doc1.txt', [{ text: 'Content 1', location: 'C1' }], {
      priorityAt: 100,
      sizeBytes: 5000,
    })
    // Doc 2: High priority (recently opened), medium size
    insertLegacyV1Document(2, join(directory, 'doc2.txt'), 'doc2.txt', [{ text: 'Content 2', location: 'C1' }], {
      priorityAt: 500,
      sizeBytes: 2000,
    })
    // Doc 3: High priority (recently opened), small size (should come before Doc 2)
    insertLegacyV1Document(3, join(directory, 'doc3.txt'), 'doc3.txt', [{ text: 'Content 3', location: 'C1' }], {
      priorityAt: 500,
      sizeBytes: 500,
    })
    // Doc 4: Lowest priority
    insertLegacyV1Document(4, join(directory, 'doc4.txt'), 'doc4.txt', [{ text: 'Content 4', location: 'C1' }], {
      priorityAt: 10,
      sizeBytes: 100,
    })

    const coordinator = new ChunkUpgradeCoordinator(db)
    const queue = coordinator.getDocumentsNeedingUpgrade()

    expect(queue.map((d) => d.id)).toEqual([3, 2, 1, 4])

    // Upgrading with batch size 1 should pick Doc 3 first
    const batch1Count = coordinator.nextBatch(1)
    expect(batch1Count).toBe(1)

    const remainingQueue = coordinator.getDocumentsNeedingUpgrade()
    expect(remainingQueue.map((d) => d.id)).toEqual([2, 1, 4])
  })

  it('recovers from crash/interruption by discarding dangling building sets and resuming cleanly (MIG-14)', () => {
    insertLegacyV1Document(1, join(directory, 'crash-doc.txt'), 'crash-doc.txt', [
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

    // Resume upgrade cleanly
    const upgraded = coordinator.upgradeAll()
    expect(upgraded).toBe(1)
    expect(coordinator.isComplete()).toBe(true)

    // Content is searchable with V2
    const hits = store.searchLexical('Stable', 10)
    expect(hits).toHaveLength(1)
  })

  it('ensures embedding-migration ignores V1 chunks and only embeds V2 active chunks (MIG-9)', () => {
    // 1. Doc 1 has legacy V1 chunks (active_chunk_set_id IS NULL)
    insertLegacyV1Document(1, join(directory, 'doc-v1.txt'), 'doc-v1.txt', [
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

  it('supports pause and resume during chunk upgrade', () => {
    insertLegacyV1Document(1, join(directory, 'pause1.txt'), 'pause1.txt', [{ text: 'Pausable 1', location: 'C1' }])
    insertLegacyV1Document(2, join(directory, 'pause2.txt'), 'pause2.txt', [{ text: 'Pausable 2', location: 'C1' }])

    const coordinator = new ChunkUpgradeCoordinator(db)
    coordinator.pause()
    expect(coordinator.getProgress().state).toBe('paused')

    // Calling nextBatch while paused should not process anything
    const pausedProcessed = coordinator.nextBatch(10)
    expect(pausedProcessed).toBe(0)
    expect(coordinator.getProgress().completedDocuments).toBe(0)

    coordinator.resume()
    expect(coordinator.getProgress().state).toBe('running')

    const resumedProcessed = coordinator.nextBatch(10)
    expect(resumedProcessed).toBe(2)
    expect(coordinator.getProgress().state).toBe('complete')
  })
})
