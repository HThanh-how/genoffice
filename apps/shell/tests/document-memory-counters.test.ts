import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import { issueReason } from '../src/main/document-memory/issues'

let dir: string
let dbPath: string
let store: DocumentMemoryStore
const stores: DocumentMemoryStore[] = []
const open = (path = dbPath): DocumentMemoryStore => {
  const instance = new DocumentMemoryStore(path)
  stores.push(instance)
  return instance
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-counters-'))
  dbPath = join(dir, 'memory.sqlite')
  store = open()
})
afterEach(() => {
  for (const instance of stores.splice(0)) {
    try {
      instance.close()
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

const MODEL = EMBEDDING_PROFILES.standard.embeddingId
const mockVector320 = () => new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1)
const root = (): string => join(dir, 'selected')
const chunks = (count: number, vectored = false) =>
  Array.from({ length: count }, (_, i) => ({
    text: `chunk ${i} of the sample document`,
    location: `Chunk ${i + 1}`,
    ...(vectored ? { vector: mockVector320() } : {}),
  }))
const vectors = (count: number): number[][] => Array.from({ length: count }, () => mockVector320())
const replace = (
  path: string,
  count: number,
  status: 'ready' | 'text-only' | 'empty' | 'error' = 'text-only',
  extra: { vectored?: boolean; truncated?: boolean; hash?: string } = {},
) =>
  store.replaceDocument(path, {
    hash: extra.hash ?? `hash-${path}`,
    mtimeMs: 10,
    sizeBytes: 100,
    chunks: chunks(count, extra.vectored),
    embeddingModel: extra.vectored ? MODEL : null,
    status,
    ...(extra.truncated ? { truncated: true } : {}),
  })

/** The progress aggregates exactly as they were computed before the counters (full chunk scans). */
function scanFolder(path: string, prefixRoot: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const prefix = prefixRoot + (prefixRoot.includes('\\') ? '\\' : '/')
    const hasChunkEmbeddings = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'")
      .get()
    const completedChunksSql = hasChunkEmbeddings
      ? '(SELECT count(e.chunk_id) FROM chunks c2 JOIN chunk_embeddings e ON e.chunk_id = c2.id WHERE c2.document_id = d.id)'
      : 'coalesce(sum(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END), 0)'
    const row = db
      .prepare(
        `WITH per_document AS (
          SELECT d.id, d.status, d.truncated, count(c.id) AS total_chunks,
            ${completedChunksSql} AS completed_chunks
          FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
          WHERE d.excluded = 0 AND (d.path = ? OR substr(d.path, 1, length(?)) = ?)
          GROUP BY d.id
        )
        SELECT count(*) AS total_files,
          sum(CASE WHEN status IN ('ready', 'empty') THEN 1 ELSE 0 END) AS ready_files,
          sum(CASE WHEN status IN ('pending', 'text-only') THEN 1 ELSE 0 END) AS pending_files,
          sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_files,
          sum(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty_files,
          coalesce(sum(truncated), 0) AS truncated_files,
          coalesce(sum(completed_chunks), 0) AS completed_chunks,
          coalesce(sum(total_chunks), 0) AS total_chunks,
          coalesce(sum(CASE WHEN status IN ('ready','empty') THEN 1.0
            WHEN status = 'text-only' AND total_chunks > 0
              THEN (completed_chunks * 1.0 / total_chunks)
            ELSE 0.0 END), 0.0) AS partial_file_progress
        FROM per_document`,
      )
      .get(prefixRoot, prefix, prefix) as Record<string, number>
    return {
      totalFiles: row.total_files ?? 0,
      readyFiles: row.ready_files ?? 0,
      pendingFiles: row.pending_files ?? 0,
      errorFiles: row.error_files ?? 0,
      emptyFiles: row.empty_files ?? 0,
      completedChunks: row.completed_chunks ?? 0,
      totalChunks: row.total_chunks ?? 0,
      partialFileProgress: row.partial_file_progress ?? 0,
      truncatedFiles: row.truncated_files ?? 0,
    }
  } finally {
    db.close()
  }
}
function scanStats(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const hasChunkEmbeddings = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'")
      .get()
    const vectorSql = hasChunkEmbeddings
      ? '(SELECT count(e.chunk_id) FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE d.excluded = 0)'
      : '(SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.excluded = 0 AND c.vector IS NOT NULL)'
    return db
      .prepare(
        `SELECT
      (SELECT count(*) FROM documents WHERE excluded = 0) AS docs,
      (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.excluded = 0) AS chunks,
      ${vectorSql} AS vectors,
      (SELECT count(*) FROM documents WHERE excluded = 0 AND status = 'error') AS errors`,
      )
      .get() as unknown as { docs: number; chunks: number; vectors: number; errors: number }
  } finally {
    db.close()
  }
}
/** Every document's stored counters equal a fresh count of its chunks. */
function perDocumentMismatches(path: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const hasChunkEmbeddings = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'")
      .get()
    const realDoneSql = hasChunkEmbeddings
      ? '(SELECT count(e.chunk_id) FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id WHERE c.document_id = d.id)'
      : '(SELECT count(*) FROM chunks c WHERE c.document_id = d.id AND c.vector IS NOT NULL)'
    return db
      .prepare(
        `SELECT d.id, d.path, d.chunk_total, d.chunk_done,
          (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS real_total,
          ${realDoneSql} AS real_done
        FROM documents d
        WHERE d.chunk_total <> real_total OR d.chunk_done <> real_done`,
      )
      .all()
  } finally {
    db.close()
  }
}
function expectSameAsScan(selected = root()): void {
  expect(store.folderChunkProgress(selected)).toEqual(scanFolder(dbPath, selected))
  expect(store.stats()).toEqual(scanStats(dbPath))
  expect(perDocumentMismatches(dbPath)).toEqual([])
}

/** A library exercising every way chunks and vectors change. */
function seed(): void {
  const file = (name: string) => join(root(), name)
  // fully embedded in one replace
  replace(file('ready.docx'), 3, 'ready', { vectored: true })
  // partial embeddings, then a resumed batch at an offset
  replace(file('partial.docx'), 5)
  store.setChunkVectors(
    file('partial.docx'),
    `hash-${file('partial.docx')}`,
    0,
    vectors(2),
    MODEL,
    false,
  )
  store.setChunkVectors(
    file('partial.docx'),
    `hash-${file('partial.docx')}`,
    2,
    vectors(2),
    MODEL,
    false,
  )
  // embedded batch by batch until complete
  replace(file('batched.docx'), 4)
  store.setChunkVectors(
    file('batched.docx'),
    `hash-${file('batched.docx')}`,
    0,
    vectors(2),
    MODEL,
    false,
  )
  store.setChunkVectors(
    file('batched.docx'),
    `hash-${file('batched.docx')}`,
    2,
    vectors(2),
    MODEL,
    true,
  )
  // replaced with fewer chunks (replace deletes old chunks first)
  replace(file('shrunk.docx'), 6, 'ready', { vectored: true })
  replace(file('shrunk.docx'), 2, 'text-only', { hash: 'second' })
  // forgotten
  replace(file('gone.docx'), 3)
  store.tombstone(file('gone.docx'))
  // moved keeps its chunks
  replace(file('before-move.docx'), 4, 'ready', { vectored: true })
  store.move(file('before-move.docx'), file('after-move.docx'))
  // truncated and lexical-only (numeric table: ready without vectors)
  replace(file('table.csv'), 7, 'ready', { truncated: true })
  // excluded after being indexed
  replace(file('excluded.docx'), 3, 'ready', { vectored: true })
  store.exclude(file('excluded.docx'))
  // error after having chunks
  replace(file('failing.docx'), 3, 'ready', { vectored: true })
  store.markError(file('failing.docx'), 'Document is unavailable.', null)
  // empty (no chunks) and never-extracted
  replace(file('empty.pdf'), 0, 'empty')
  store.remember(file('pending.docx'))
  // errored then retried
  store.markError(file('retried.docx'), 'timeout', null)
  store.retryDocument(store.documentByPath(file('retried.docx'))!.id)
  // another folder
  replace(join(dir, 'elsewhere', 'other.docx'), 4, 'ready', { vectored: true })
}

describe('per-document chunk counters', () => {
  it('persists a fresh OCR re-read even when a mixed PDF was ready, without discarding saved text', () => {
    const path = join(root(), 'mixed.pdf')
    replace(path, 2, 'ready', { vectored: true })
    expect(store.markOcrPending(path)).toBe(true)
    expect(store.documentByPath(path)?.status).toBe('pending')
    expect(store.resumeVectorOffset(path, `hash-${path}`, MODEL)).toBeNull()
    expect(store.folderChunkProgress().totalChunks).toBe(2)
    store.close()
    store = open()
    expect(store.documentByPath(path)?.status).toBe('pending')
    store.exclude(path)
    expect(store.markOcrPending(path)).toBe(false)
    expect(store.documentByPath(path)?.status).toBe('excluded')
  })
  it('counts the complete library once, including files outside the most recently scanned folder', () => {
    seed()
    const complete = store.folderChunkProgress()
    const first = store.folderChunkProgress(root())
    const second = store.folderChunkProgress(join(dir, 'elsewhere'))
    expect(complete.totalFiles).toBe(first.totalFiles + second.totalFiles)
    expect(complete.readyFiles).toBe(first.readyFiles + second.readyFiles)
    expect(complete.completedChunks).toBe(first.completedChunks + second.completedChunks)
    expect(complete.totalChunks).toBe(first.totalChunks + second.totalChunks)
    expect(complete.partialFileProgress).toBeCloseTo(
      first.partialFileProgress + second.partialFileProgress,
    )
    expect(complete.totalFiles).toBe(store.stats().docs)
    expect(complete.completedChunks).toBe(store.stats().vectors)
  })
  it('match the old full-scan queries across every kind of write', () => {
    seed()
    expectSameAsScan()
    expectSameAsScan(join(dir, 'elsewhere'))
    expectSameAsScan(join(dir, 'nothing-here'))
    const progress = store.folderChunkProgress(root())
    // spot check the interesting numbers instead of only trusting the comparison
    expect(progress.truncatedFiles).toBe(1)
    expect(progress.completedChunks).toBe(3 + 4 + 4 + 0 + 0 + 4 + 0 + 0)
    expect(store.chunkProgress(join(root(), 'partial.docx'))).toMatchObject({
      completedChunks: 4,
      totalChunks: 5,
    })
  })

  it('stay exact through retry, clear and writes made after a clear', () => {
    seed()
    store.clear()
    expect(store.stats()).toEqual({ docs: 0, chunks: 0, vectors: 0, errors: 0 })
    expect(perDocumentMismatches(dbPath)).toEqual([])
    replace(join(root(), 'again.docx'), 3, 'ready', { vectored: true })
    expectSameAsScan()
    expect(store.stats()).toEqual({ docs: 1, chunks: 3, vectors: 3, errors: 0 })
  })

  it('are idempotent to migrate and safe when several handles open the same file', () => {
    seed()
    const before = store.stats()
    const handles = Array.from({ length: 4 }, () => open())
    for (const handle of handles) expect(handle.stats()).toEqual(before)
    // a write through one handle is counted for all of them
    handles[2]!.replaceDocument(join(root(), 'via-handle.docx'), {
      hash: 'h',
      mtimeMs: 1,
      sizeBytes: 1,
      chunks: chunks(2),
      embeddingModel: null,
      status: 'text-only',
    })
    expect(handles[0]!.stats().chunks).toBe(before.chunks + 2)
    expect(perDocumentMismatches(dbPath)).toEqual([])
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'chunks_counter_%'",
      )
      .all()
    db.close()
    expect(triggers).toHaveLength(2)
  })

  it('count the covering partial index, not vector BLOBs, when backfilling', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT document_id, count(*) AS n FROM chunks
        WHERE document_id BETWEEN ? AND ? GROUP BY document_id`,
      )
      .all(1, 10)
      .map((row) => String(row.detail))
      .join(' ')
    db.close()
    expect(plan).toContain('chunks_document_id')
  })
})

/** A database written by a build that predates the counters: no columns, no triggers. */
function createLegacy(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL,
      mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT, error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      truncated INTEGER NOT NULL DEFAULT 0, last_opened_at INTEGER NOT NULL DEFAULT 0,
      priority_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, text TEXT NOT NULL, location TEXT NOT NULL,
      vector BLOB, vector_dim INTEGER,
      CHECK ((vector IS NULL AND vector_dim IS NULL) OR (vector IS NOT NULL AND vector_dim > 0))
    );
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
    CREATE INDEX chunks_document_id ON chunks(document_id);
    CREATE INDEX chunks_vector_lookup ON chunks(vector_dim, document_id) WHERE vector IS NOT NULL;
    CREATE INDEX documents_excluded_status ON documents(excluded, status);
  `)
  const addDoc = db.prepare(
    'INSERT INTO documents(path, name, status, embedding_model) VALUES (?, ?, ?, ?)',
  )
  const addChunk = db.prepare(
    'INSERT INTO chunks(document_id, ordinal, text, location, vector, vector_dim) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const blob = new Uint8Array(new Float32Array(mockVector320()).buffer)
  for (let d = 0; d < 25; d++) {
    const status = d % 5 === 0 ? 'pending' : d % 2 ? 'ready' : 'text-only'
    const id = Number(
      addDoc.run(join(root(), `legacy-${d}.docx`), `legacy-${d}.docx`, status, MODEL)
        .lastInsertRowid,
    )
    const total = d % 5 === 0 ? 0 : (d % 4) + 1
    for (let o = 0; o < total; o++) {
      const vectored = status === 'ready' || o % 2 === 0
      addChunk.run(
        id,
        o,
        `t${o}`,
        `L${o}`,
        vectored ? blob : null,
        vectored ? EMBEDDING_PROFILES.standard.dimensions : null,
      )
    }
  }
  db.close()
}

describe('migration and backfill of an existing database', () => {
  it('adds the columns without losing data and keeps aggregates exact while uncounted', () => {
    const legacy = join(dir, 'legacy.sqlite')
    createLegacy(legacy)
    const before = scanStats(legacy)
    expect(before.chunks).toBeGreaterThan(20)
    const migrated = open(legacy)
    expect(migrated.hasUncountedDocuments()).toBe(true)
    // exact before a single document is counted (falls back to the covering indexes)
    expect(migrated.stats()).toEqual(before)
    expect(migrated.folderChunkProgress(root())).toEqual(scanFolder(legacy, root()))
    // a write made before the backfill reached the document must not break either view
    migrated.replaceDocument(join(root(), 'legacy-1.docx'), {
      hash: 'rewritten',
      mtimeMs: 1,
      sizeBytes: 1,
      chunks: chunks(2),
      embeddingModel: null,
      status: 'text-only',
    })
    migrated.markError(join(root(), 'legacy-3.docx'), 'timeout', null)
    expect(migrated.stats()).toEqual(scanStats(legacy))
  })

  it('backfills in short resumable slices and converges to the scan results', () => {
    const legacy = join(dir, 'legacy.sqlite')
    createLegacy(legacy)
    const migrated = open(legacy)
    let slices = 0
    const seen: number[] = []
    while (migrated.backfillCounters(4)) {
      slices++
      // sane at every step: totals never exceed the real figures nor move backwards
      const chunksNow = migrated.folderChunkProgress(root()).totalChunks
      expect(chunksNow).toBe(scanFolder(legacy, root()).totalChunks)
      seen.push(chunksNow)
      expect(migrated.stats()).toEqual(scanStats(legacy))
    }
    expect(slices).toBeGreaterThanOrEqual(5)
    expect(migrated.hasUncountedDocuments()).toBe(false)
    expect(migrated.backfillCounters(4)).toBe(false)
    expect(migrated.folderChunkProgress(root())).toEqual(scanFolder(legacy, root()))
    expect(migrated.stats()).toEqual(scanStats(legacy))
    // counters now live in the table: compare per document
    const db = new DatabaseSync(legacy, { readOnly: true })
    const mismatches = db
      .prepare(
        `SELECT d.id FROM documents d WHERE d.chunk_total <>
          (SELECT count(*) FROM chunks c WHERE c.document_id = d.id)
          OR d.chunk_done <> (SELECT count(e.chunk_id) FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id WHERE c.document_id = d.id)`,
      )
      .all()
    db.close()
    expect(mismatches).toEqual([])
  })

  it('treats rows written by the new code as already counted and resumes after a restart', () => {
    const legacy = join(dir, 'legacy.sqlite')
    createLegacy(legacy)
    let migrated = open(legacy)
    migrated.backfillCounters(5)
    migrated.close()
    migrated = open(legacy)
    migrated.remember(join(root(), 'brand-new.docx'))
    expect(migrated.hasUncountedDocuments()).toBe(true)
    while (migrated.backfillCounters(5));
    expect(migrated.hasUncountedDocuments()).toBe(false)
    expect(migrated.stats()).toEqual(scanStats(legacy))
  })
})

describe('time-sliced writes', () => {
  const replacement = (count: number, hash = 'sliced') => ({
    hash,
    mtimeMs: 5,
    sizeBytes: 50,
    chunks: chunks(count),
    embeddingModel: null,
    status: 'text-only' as const,
  })
  const chunkRows = (path: string) => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db
        .prepare(
          `SELECT c.ordinal, c.text, c.location,
            (SELECT text FROM chunk_fts WHERE rowid = c.id) AS fts
          FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY c.ordinal`,
        )
        .all(path)
    } finally {
      db.close()
    }
  }

  it('write the same rows as the single-transaction replace, one chunk per slice', async () => {
    const a = join(root(), 'a.docx')
    const b = join(root(), 'b.docx')
    replace(a, 9, 'ready', { vectored: true })
    replace(b, 9, 'ready', { vectored: true })
    store.replaceDocument(a, replacement(7))
    let yields = 0
    const done = await store.replaceDocumentSliced(b, replacement(7), {
      budgetMs: 0.001,
      yield: async () => {
        yields++
      },
    })
    expect(done).toBe(true)
    expect(yields).toBeGreaterThanOrEqual(6)
    expect(chunkRows(b)).toEqual(chunkRows(a))
    const rowA = store.documentByPath(a)!
    const rowB = store.documentByPath(b)!
    expect({ ...rowB, id: 0, path: '', name: '' }).toEqual({ ...rowA, id: 0, path: '', name: '' })
    expectSameAsScan()
  })

  it('replace a document that fits one slice atomically', async () => {
    const path = join(root(), 'small.docx')
    let yields = 0
    await store.replaceDocumentSliced(path, replacement(3), {
      budgetMs: 10_000,
      yield: async () => {
        yields++
      },
    })
    expect(yields).toBe(0)
    expect(store.documentByPath(path)?.status).toBe('text-only')
    expect(store.chunkProgress(path).totalChunks).toBe(3)
  })

  it('leave an abandoned replacement pending (no hash) so it is extracted again', async () => {
    const path = join(root(), 'abandoned.docx')
    replace(path, 6, 'ready', { vectored: true })
    let calls = 0
    const done = await store.replaceDocumentSliced(path, replacement(6, 'new'), {
      budgetMs: 0.001,
      shouldContinue: () => ++calls < 3,
    })
    expect(done).toBe(false)
    const document = store.documentByPath(path)!
    expect(document.status).toBe('pending')
    expect(document.hash).toBeNull()
    expect(store.incompletePaths()).toContain(path)
    expect(perDocumentMismatches(dbPath)).toEqual([])
  })

  it('stop quietly when the document is excluded between slices', async () => {
    const path = join(root(), 'excluded-midway.docx')
    replace(path, 6, 'ready', { vectored: true })
    const done = await store.replaceDocumentSliced(path, replacement(6, 'new'), {
      budgetMs: 0.001,
      yield: async () => store.exclude(path),
    })
    expect(done).toBe(false)
    expect(store.documentByPath(path)?.status).toBe('excluded')
    expect(store.chunkProgress(path).totalChunks).toBe(0)
  })

  it('still refuses to index an excluded document (sliced path declines quietly, replaceDocument throws)', async () => {
    const path = join(root(), 'excluded.docx')
    replace(path, 1)
    store.exclude(path)
    const chunksBefore = store.stats().chunks
    expect(await store.replaceDocumentSliced(path, replacement(1))).toBe(false)
    expect(store.stats().chunks).toBe(chunksBefore)
    expect(() => store.replaceDocument(path, replacement(1))).toThrow(/Excluded/)
  })

  it('tombstone and markError in slices match their single-transaction forms', async () => {
    const gone = join(root(), 'gone.docx')
    const bad = join(root(), 'bad.docx')
    replace(gone, 8, 'ready', { vectored: true })
    replace(bad, 8, 'ready', { vectored: true })
    expect(await store.tombstoneSliced(gone, { budgetMs: 0 })).toBe(true)
    expect(store.documentByPath(gone)).toBeNull()
    expect(await store.tombstoneSliced(gone, { budgetMs: 0 })).toBe(false)
    expect(
      await store.markErrorSliced(
        bad,
        'Document is unavailable.',
        { mtimeMs: 7, sizeBytes: 8 },
        { budgetMs: 0 },
      ),
    ).toBe(true)
    expect(store.documentByPath(bad)).toMatchObject({
      status: 'error',
      hash: null,
      mtimeMs: 7,
      sizeBytes: 8,
    })
    expect(store.chunkProgress(bad).totalChunks).toBe(0)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const fts = db.prepare('SELECT count(*) AS n FROM chunk_fts').get() as { n: number }
    db.close()
    expect(fts.n).toBe(0)
    expectSameAsScan()
  })
})

describe('issue reader paging', () => {
  it('pages in SQL with the same results as filtering every row', () => {
    for (let i = 0; i < 14; i++)
      store.markError(
        join(root(), `f-${i}.docx`),
        i % 3 === 0 ? 'Password protected' : i % 3 === 1 ? 'Document is unavailable.' : 'boom',
        null,
      )
    replace(join(root(), 'scan.pdf'), 0, 'empty')
    const reader = new IndexIssueReader(dbPath)
    try {
      const all = reader.page(root(), 0, undefined, 1000)
      expect(all.total).toBe(15)
      for (const reason of ['password', 'unavailable', 'other', 'no-text', 'model'] as const) {
        const expected = all.items.filter((item) => item.reason === reason)
        expect(issueReason(null, 'empty')).toBe('no-text')
        const first = reader.page(root(), 0, reason, 2)
        expect(first.total).toBe(expected.length)
        expect(first.items.map((item) => item.id)).toEqual(expected.slice(0, 2).map((i) => i.id))
        const next = reader.page(root(), 2, reason, 2)
        expect(next.items.map((item) => item.id)).toEqual(expected.slice(2, 4).map((i) => i.id))
        expect(reader.ids(root(), reason)).toEqual(expected.map((item) => item.id))
      }
      expect(reader.page(root(), 10).items).toHaveLength(5)
    } finally {
      reader.close()
    }
  })
})

describe('full-text merging', () => {
  it('turns FTS5 automerge off and merges in small steps without changing search results', () => {
    const raw = new DatabaseSync(dbPath)
    const setting = () =>
      raw.prepare("SELECT v FROM chunk_fts_config WHERE k = 'automerge'").get() as { v: number }
    try {
      expect(setting().v).toBe(0)
      for (let d = 0; d < 24; d++) replace(join(root(), `merge-${d}.docx`), 5, 'ready')
      const before = store.search('sample document', null, 20).map((hit) => hit.chunkId)
      expect(before.length).toBeGreaterThan(0)
      let steps = 0
      while (store.mergeFtsStep(2) && steps < 2000) steps++
      expect(steps).toBeLessThan(2000)
      expect(store.mergeFtsStep(2)).toBe(false) // compact: nothing left to merge
      expect(store.search('sample document', null, 20).map((hit) => hit.chunkId)).toEqual(before)
      expect(() =>
        raw.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('integrity-check')"),
      ).not.toThrow()
      // reopening keeps the setting (and does not rewrite it)
      open().close()
      expect(setting().v).toBe(0)
    } finally {
      raw.close()
    }
  })
})

describe('manager backfill', () => {
  it('counts an old database in the background while status() stays exact', async () => {
    createLegacy(join(dir, 'document-memory.db'))
    writeFileSync(join(dir, 'document-memory-settings.json'), JSON.stringify({ enabled: false }))
    const expected = scanStats(join(dir, 'document-memory.db'))
    const manager = new DocumentMemoryManager(dir, {
      workerFactory: () => new EventEmitter() as never,
      workerPath: 'unused',
      pollIntervalMs: 3_600_000,
    })
    try {
      expect(manager.status()).toMatchObject({
        documents: expected.docs,
        chunks: expected.chunks,
        vectors: expected.vectors,
      })
      await manager.countersReady()
      expect(manager.status()).toMatchObject({
        documents: expected.docs,
        chunks: expected.chunks,
        vectors: expected.vectors,
      })
      expect(manager.getFolderIndexCounts(root())).toMatchObject(
        scanFolder(join(dir, 'document-memory.db'), root()),
      )
      expect(perDocumentMismatches(join(dir, 'document-memory.db'))).toEqual([])
    } finally {
      await manager.closeAsync()
    }
  })
})
