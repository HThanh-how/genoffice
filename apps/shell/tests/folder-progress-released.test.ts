import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/document-memory/worker?modulePath', () => ({ default: 'mock-worker-path' }))
vi.mock('@genoffice/file-parse', () => ({ parseFileToText: vi.fn(), pdfPageTextsSlice: vi.fn() }))
vi.mock('onnxruntime-node', () => ({ InferenceSession: { create: vi.fn() } }))
vi.mock('@huggingface/tokenizers', () => ({ Tokenizer: { fromFile: vi.fn() } }))

import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { foldFolderProgress } from '../src/main/document-memory/folder-progress'
import {
  ensureVectorEvictionSchema,
  markVectorsEvicted,
} from '../src/main/document-memory/storage/vector-eviction-marker'

/** Waiting vs released: vectors released by cache retention are not pending work. */
describe('folderChunkProgress released vs waiting', () => {
  let dir: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-released-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    ensureVectorEvictionSchema(store.rawDb)
  })
  afterEach(() => {
    try {
      store.close()
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  const add = (name: string, status: string, chunks = 2): number => {
    const path = join(dir, 'docs', name)
    store.replaceDocument(path, {
      hash: `h-${name}`,
      mtimeMs: 1,
      sizeBytes: 1,
      status: 'text-only',
      chunks: Array.from({ length: chunks }, (_, i) => ({ text: `${name} ${i}`, location: `p${i}` })),
    })
    const id = store.documentByPath(path)!.id
    store.rawDb.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, id)
    return id
  }

  function seed() {
    add('ready.txt', 'ready')
    add('empty.txt', 'empty', 0)
    add('pending.txt', 'pending')
    add('embedding.txt', 'text-only')
    add('broken.txt', 'error')
    const marked = add('marked.txt', 'text-only')
    markVectorsEvicted(store.rawDb, [marked], 1_000)
    const evicted = add('evicted.txt', 'text-only')
    store.rawDb.prepare('UPDATE documents SET content_evicted = 1, chunk_total = 0 WHERE id = ?').run(evicted)
    return { marked, evicted }
  }

  it('counts waiting, released, done and error separately and consistently', () => {
    seed()
    const p = store.folderChunkProgress(join(dir, 'docs'))
    expect(p.totalFiles).toBe(7)
    expect(p.readyFiles).toBe(2) // ready + empty
    expect(p.errorFiles).toBe(1)
    expect(p.releasedFiles).toBe(2)
    expect(p.pendingFiles).toBe(2) // pending + text-only that still has to be embedded
    expect(p.waitingFiles).toBe(p.pendingFiles)
    expect(p.pendingFiles! + p.releasedFiles! + p.readyFiles + p.errorFiles).toBe(p.totalFiles)
    // library scope equals the single folder here
    expect(store.folderChunkProgress(undefined, 'space-a')).toMatchObject({ totalFiles: 7, releasedFiles: 2, pendingFiles: 2 })
    // nothing released: the legacy payload shape is unchanged
    store.rawDb.prepare('DELETE FROM document_vector_evictions').run()
    store.rawDb.prepare('UPDATE documents SET content_evicted = 0').run()
    const none = store.folderChunkProgress(join(dir, 'docs'))
    expect(none.releasedFiles).toBeUndefined()
    expect(none.pendingFiles).toBe(4)
  })

  it('waiting equals the work the scheduler will actually do (incompletePaths)', () => {
    seed()
    expect(store.incompletePaths().length).toBe(store.folderChunkProgress().pendingFiles)
  })

  it('released documents do not hold the percentage below 100 or the chunk coverage below 1', () => {
    const only = add('only.txt', 'text-only', 3)
    markVectorsEvicted(store.rawDb, [only], 1_000)
    const p = store.folderChunkProgress(undefined, 'space-a')
    expect(p).toMatchObject({ totalFiles: 1, releasedFiles: 1, pendingFiles: 0, totalChunks: 0, completedChunks: 0 })
    expect(p.semanticCoverage).toBe(1)
    expect(foldFolderProgress(p, true).percent).toBe(100)
    const stats = store.stats('space-a')
    expect(stats.releasedDocs).toBe(1)
    expect(stats.chunks).toBe(3) // stored text chunks are still real
    expect(stats.semanticCoverage).toBe(1)
  })

  it('opening a released document again makes it waiting; changed content too', () => {
    const { marked } = seed()
    store.rawDb.prepare('UPDATE documents SET last_opened_at = 5_000 WHERE id = ?').run(marked)
    expect(store.folderChunkProgress().releasedFiles).toBe(1)
    expect(store.folderChunkProgress().pendingFiles).toBe(3)
    store.rawDb.prepare("UPDATE documents SET hash = 'new' WHERE id = ?").run(marked)
    expect(store.folderChunkProgress().releasedFiles).toBe(1)
  })

  it('tolerates extra marker columns / unknown states and treats them as released', () => {
    const id = add('skeleton.txt', 'text-only')
    markVectorsEvicted(store.rawDb, [id], 1_000)
    store.rawDb.exec("ALTER TABLE document_vector_evictions ADD COLUMN state TEXT NOT NULL DEFAULT 'mystery'")
    store.rawDb.prepare("UPDATE document_vector_evictions SET state = 'skeleton-v9'").run()
    const p = store.folderChunkProgress()
    expect(p).toMatchObject({ releasedFiles: 1, pendingFiles: 0 })
  })

  it('works without the marker table (older schema)', () => {
    add('a.txt', 'text-only')
    store.rawDb.exec('DROP TRIGGER IF EXISTS document_vector_evictions_revive; DROP TABLE document_vector_evictions')
    expect(store.folderChunkProgress()).toMatchObject({ pendingFiles: 1 })
  })
})
