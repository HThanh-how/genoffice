import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  createBuildingSet,
  activateSet,
  retireOldSets,
} from '../src/main/document-memory/chunk-sets'

describe('Chunk Sets Lifecycle & Atomic Cutover', () => {
  let directory: string
  let store: DocumentMemoryStore
  let db: import('node:sqlite').DatabaseSync

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-chunkset-'))
    const dbPath = join(directory, 'memory.sqlite')
    store = new DocumentMemoryStore(dbPath)
    db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('manages chunk set states from building to active to retired', () => {
    const docPath = join(directory, 'doc-set.txt')
    store.replaceDocument(docPath, {
      hash: 'h-initial',
      mtimeMs: 1000,
      sizeBytes: 20,
      chunks: [{ text: 'Initial v1 chunk', location: 'C1' }],
      embeddingModel: 'test-v1',
      status: 'ready',
    })

    const docRow = db.prepare('SELECT id FROM documents WHERE path = ?').get(docPath) as { id: number }
    const docId = docRow.id

    // 1. Create a building chunk set for chunker v2
    const set1 = createBuildingSet(db, docId, 2)
    expect(set1).toBeGreaterThan(0)

    const set1Row = db.prepare('SELECT state, chunker_version FROM chunk_sets WHERE id = ?').get(set1) as {
      state: string
      chunker_version: number
    }
    expect(set1Row.state).toBe('building')
    expect(set1Row.chunker_version).toBe(2)

    // 2. Activate set 1
    activateSet(db, docId, set1)
    const activeDoc = db.prepare('SELECT active_chunk_set_id FROM documents WHERE id = ?').get(docId) as {
      active_chunk_set_id: number
    }
    expect(activeDoc.active_chunk_set_id).toBe(set1)

    const set1ActiveRow = db.prepare('SELECT state FROM chunk_sets WHERE id = ?').get(set1) as { state: string }
    expect(set1ActiveRow.state).toBe('active')

    // 3. Create set 2 (e.g. re-chunking)
    const set2 = createBuildingSet(db, docId, 2)
    // While set 2 is building, set 1 remains active
    const set2Row = db.prepare('SELECT state FROM chunk_sets WHERE id = ?').get(set2) as { state: string }
    expect(set2Row.state).toBe('building')

    // 4. Activate set 2
    activateSet(db, docId, set2)
    const set1Retired = db.prepare('SELECT state FROM chunk_sets WHERE id = ?').get(set1) as { state: string }
    const set2Active = db.prepare('SELECT state FROM chunk_sets WHERE id = ?').get(set2) as { state: string }
    expect(set1Retired.state).toBe('retired')
    expect(set2Active.state).toBe('active')

    // 5. Test retireOldSets maintains integrity
    retireOldSets(db, docId)
    const finalSet1 = db.prepare('SELECT state FROM chunk_sets WHERE id = ?').get(set1) as { state: string }
    const finalSet2 = db.prepare('SELECT state FROM chunk_sets WHERE id = ?').get(set2) as { state: string }
    expect(finalSet1.state).toBe('retired')
    expect(finalSet2.state).toBe('active')
  })
})
