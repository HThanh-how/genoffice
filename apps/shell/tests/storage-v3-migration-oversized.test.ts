import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import {
  EMBEDDING_PROFILES,
  LEGACY_E5_EMBEDDING_ID,
  LEGACY_VIETNAMESE_EMBEDDING_ID,
} from '../src/main/document-memory/embedding-profiles'
import {
  MAX_MIGRATION_BATCH_BYTES,
  MigrationBudgetContract,
  estimateBatchMigrationGrowth,
  estimateMigrationGrowthBytes,
} from '../src/main/document-memory/runtime/backup-write-budget'
import { MAX_MIGRATION_CHUNK_TEXT_BYTES } from '../src/main/document-memory/storage/migration/chunk-pager'

const ACTIVE = EMBEDDING_PROFILES.base
const ACTIVE_ID = ACTIVE.embeddingId
const ACTIVE_DIM = ACTIVE.dimensions

function vec(dim: number, seed: number): Uint8Array {
  const f = new Float32Array(dim)
  for (let i = 0; i < dim; i++) f[i] = seed + (i % 31) * 0.01
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
}

interface FixtureDoc {
  id: number
  status: string
  model: string | null
  chunks: number
  /** legacy vector per chunk: dimension (4096 bytes for 1024) or 0 for none; function = decide per chunk index */
  vectorDim?: number | ((i: number) => number)
  textBytes?: number
  lastOpenedAt?: number
  truncated?: number
  truncatedReason?: string | null
}

/** The legacy V2 shape found on real user machines: no chunk_sets, chunks carry inline vector / vector_dim. */
function buildLegacyV2(dbPath: string, docs: FixtureDoc[], extra?: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL,
      mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT, error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      truncated INTEGER NOT NULL DEFAULT 0, truncated_reason TEXT,
      last_opened_at INTEGER NOT NULL DEFAULT 0, priority_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      chunk_total INTEGER NOT NULL DEFAULT 0, chunk_done INTEGER NOT NULL DEFAULT 0, chunk_counted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL, location TEXT NOT NULL,
      vector BLOB, vector_dim INTEGER
    );
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text);
    CREATE TABLE ocr_pages (
      path TEXT NOT NULL, page INTEGER NOT NULL, hash TEXT NOT NULL, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL,
      total_pages INTEGER NOT NULL, text TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (path, page)
    ) WITHOUT ROWID;
    CREATE TABLE pdf_scan_info (
      path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL, total_pages INTEGER NOT NULL, scanned TEXT NOT NULL
    ) WITHOUT ROWID;
  `)
  const insDoc = db.prepare(
    `INSERT INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, embedding_model, truncated, truncated_reason, last_opened_at, priority_at, chunk_total, chunk_done, chunk_counted)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  const insChunk = db.prepare(
    'INSERT INTO chunks (document_id, ordinal, text, normalized, location, vector, vector_dim) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  db.exec('BEGIN')
  for (const d of docs) {
    const vdim = (i: number): number => (typeof d.vectorDim === 'function' ? d.vectorDim(i) : (d.vectorDim ?? 0))
    let withVec = 0
    for (let i = 0; i < d.chunks; i++) if (vdim(i) > 0) withVec++
    insDoc.run(
      d.id, `/data/doc-${d.id}.txt`, `doc-${d.id}.txt`, d.status, `h${d.id}`, d.model, d.truncated ?? 0, d.truncatedReason ?? null,
      d.lastOpenedAt ?? 0, d.lastOpenedAt ?? 0, d.chunks, withVec,
    )
    for (let i = 0; i < d.chunks; i++) {
      const filler = 'x'.repeat(Math.max(0, (d.textBytes ?? 400) - 40))
      const text = `bao cao hop dong so ${d.id} doan ${i} ${filler}`
      const dim = vdim(i)
      insChunk.run(d.id, i, text, text, `{"p":${i}}`, dim > 0 ? vec(dim, d.id) : null, dim > 0 ? dim : null)
    }
  }
  db.exec('COMMIT')
  extra?.(db)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}

function ids(db: DatabaseSync, sql: string): any[] {
  return db.prepare(sql).all() as any[]
}

describe('V2 -> V3 migration of oversized documents (UT real-database regression)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-mig-oversized-'))
    dbPath = join(dir, 'document-memory.db')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const migrate = (extra: Record<string, unknown> = {}) =>
    migrateStorageV2ToV3(dbPath, { activeSpaceId: ACTIVE_ID, activeDimensions: ACTIVE_DIM, budgetBytes: 4 * 1024 ** 3, ...extra })

  it('REGRESSION document estimated size exceeds maximum migration batch size: 4300 chunks with 4096-byte legacy vectors migrate', () => {
    buildLegacyV2(dbPath, [
      { id: 4905, status: 'ready', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 4300, vectorDim: 1024 },
      { id: 7, status: 'ready', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 3, vectorDim: 1024, lastOpenedAt: 99 },
      { id: 8, status: 'pending', model: null, chunks: 0 },
      { id: 9, status: 'empty', model: null, chunks: 0 },
    ])
    const src = new DatabaseSync(dbPath, { readOnly: true })
    // the exact failure of the real database: this one document alone exceeds the per-batch bound
    expect(estimateBatchMigrationGrowth(src, [4905], ACTIVE_DIM)).toBeGreaterThan(MAX_MIGRATION_BATCH_BYTES)
    // ... but only because of vectors that are never copied: with the active space known it is ~vector-free
    const conservative = estimateBatchMigrationGrowth(src, [4905], ACTIVE_DIM)
    const vectorFree = estimateBatchMigrationGrowth(src, [4905], ACTIVE_DIM, ACTIVE_ID)
    const wholeDb = estimateMigrationGrowthBytes(src, ACTIVE_ID, ACTIVE_DIM)
    src.close()
    expect(conservative - vectorFree).toBeGreaterThanOrEqual(Math.floor(4300 * (ACTIVE_DIM * 4 + 64) * 1.5) - 1)
    expect(wholeDb).toBeLessThan(vectorFree + 1024 * 1024) // legacy vectors are not budgeted

    const result = migrate()
    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(4)
    expect(result.chunksCopied).toBe(4303)
    expect(result.embeddingsCopied).toBe(0)

    const v3 = new DatabaseSync(dbPath, { readOnly: true })
    expect(ids(v3, 'SELECT count(*) n FROM chunks')[0].n).toBe(4303)
    expect(ids(v3, 'SELECT count(*) n FROM chunk_fts')[0].n).toBe(4303)
    expect(ids(v3, 'SELECT count(*) n FROM chunk_embeddings')[0].n).toBe(0)
    expect(ids(v3, 'SELECT count(*) n FROM document_embedding_counts')[0].n).toBe(0)
    const big = ids(v3, 'SELECT status, embedding_model, chunk_total, chunk_done, chunk_counted FROM documents WHERE id = 4905')[0]
    expect(big).toEqual({ status: 'text-only', embedding_model: null, chunk_total: 4300, chunk_done: 0, chunk_counted: 1 })
    const statuses = Object.fromEntries(ids(v3, 'SELECT id, status FROM documents').map((r) => [r.id, r.status]))
    expect(statuses).toEqual({ 4905: 'text-only', 7: 'text-only', 8: 'pending', 9: 'empty' })
    // user-opened priority survives, so the background re-embedding handles opened / newest first
    expect(ids(v3, 'SELECT priority_at p FROM documents WHERE id = 7')[0].p).toBe(99)
    // searchable by text immediately
    const hits = ids(v3, "SELECT count(*) n FROM chunk_fts WHERE chunk_fts MATCH 'hop dong'")[0].n
    expect(hits).toBe(4303)
    expect(ids(v3, 'PRAGMA integrity_check')[0].integrity_check).toBe('ok')
    v3.close()
  })

  it('keeps the V2 backup a full copy (vectors included) so rollback stays possible', () => {
    buildLegacyV2(dbPath, [{ id: 1, status: 'ready', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 50, vectorDim: 1024 }])
    const before = statSync(dbPath).size
    const result = migrate()
    expect(existsSync(result.backupDbPath)).toBe(true)
    const backup = new DatabaseSync(result.backupDbPath, { readOnly: true })
    expect(ids(backup, 'SELECT count(*) n FROM chunks WHERE vector IS NOT NULL AND length(vector) = 4096')[0].n).toBe(50)
    backup.close()
    expect(statSync(result.backupDbPath).size).toBe(before)
    expect(readdirSync(dir).some((f) => f.endsWith('.migrating') || f.endsWith('.tmp'))).toBe(false)
  })

  it('does not copy vectors of non-active legacy spaces (Vietnamese fp32 1024d, e5 q8 384d)', () => {
    buildLegacyV2(dbPath, [
      { id: 1, status: 'ready', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 5, vectorDim: 1024 },
      { id: 2, status: 'ready', model: LEGACY_E5_EMBEDDING_ID, chunks: 5, vectorDim: ACTIVE_DIM },
      { id: 3, status: 'text-only', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 6, vectorDim: (i) => (i < 2 ? 1024 : 0) },
    ])
    migrate()
    const v3 = new DatabaseSync(dbPath, { readOnly: true })
    expect(ids(v3, 'SELECT count(*) n FROM chunk_embeddings')[0].n).toBe(0)
    for (const r of ids(v3, 'SELECT status, embedding_model, chunk_total, chunk_done FROM documents ORDER BY id')) {
      expect(r.status).toBe('text-only')
      expect(r.embedding_model).toBeNull()
      expect(r.chunk_done).toBe(0)
    }
    v3.close()
  })

  it('copies legacy vectors that are in the ACTIVE space, with exact counters, across slices of an oversized document', () => {
    // 3000 chunks x (1536 B vector + 400 B text) is well above the 2 MB batch bound -> sliced
    buildLegacyV2(dbPath, [
      { id: 10, status: 'ready', model: ACTIVE_ID, chunks: 3000, vectorDim: ACTIVE_DIM },
      { id: 11, status: 'text-only', model: ACTIVE_ID, chunks: 2500, vectorDim: (i) => (i % 3 === 0 ? ACTIVE_DIM : 0) },
      { id: 12, status: 'ready', model: ACTIVE_ID, chunks: 4, vectorDim: ACTIVE_DIM },
      // a vector with a wrong width inside an active-space document is not trusted
      { id: 13, status: 'ready', model: ACTIVE_ID, chunks: 3, vectorDim: (i) => (i === 0 ? 1024 : ACTIVE_DIM) },
    ])
    const src = new DatabaseSync(dbPath, { readOnly: true })
    expect(estimateBatchMigrationGrowth(src, [10], ACTIVE_DIM, ACTIVE_ID)).toBeGreaterThan(MAX_MIGRATION_BATCH_BYTES)
    src.close()

    const result = migrate()
    const expectedVectors = 3000 + Math.ceil(2500 / 3) + 4 + 2
    expect(result.embeddingsCopied).toBe(expectedVectors)

    const v3 = new DatabaseSync(dbPath, { readOnly: true })
    const doc = (id: number) => ids(v3, `SELECT status, embedding_model, chunk_total, chunk_done FROM documents WHERE id = ${id}`)[0]
    expect(doc(10)).toEqual({ status: 'ready', embedding_model: ACTIVE_ID, chunk_total: 3000, chunk_done: 3000 })
    expect(doc(11)).toEqual({ status: 'text-only', embedding_model: ACTIVE_ID, chunk_total: 2500, chunk_done: Math.ceil(2500 / 3) })
    expect(doc(12)).toEqual({ status: 'ready', embedding_model: ACTIVE_ID, chunk_total: 4, chunk_done: 4 })
    expect(doc(13)).toEqual({ status: 'text-only', embedding_model: ACTIVE_ID, chunk_total: 3, chunk_done: 2 })
    const counts = Object.fromEntries(ids(v3, 'SELECT document_id d, completed_chunks c FROM document_embedding_counts').map((r) => [r.d, r.c]))
    expect(counts).toEqual({ 10: 3000, 11: Math.ceil(2500 / 3), 12: 4, 13: 2 })
    expect(ids(v3, 'SELECT count(*) n FROM chunk_embeddings')[0].n).toBe(expectedVectors)
    const first = ids(v3, 'SELECT e.vector v FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = 12 AND c.ordinal = 1')[0].v as Uint8Array
    expect(Buffer.from(first).equals(Buffer.from(vec(ACTIVE_DIM, 12)))).toBe(true)
    expect(ids(v3, `SELECT count(*) n FROM chunk_embeddings WHERE space_id = '${ACTIVE_ID}' AND length(vector) = ${ACTIVE_DIM * 4}`)[0].n).toBe(expectedVectors)
    expect(ids(v3, 'SELECT count(*) n FROM chunk_fts')[0].n).toBe(3000 + 2500 + 4 + 3)
    v3.close()
  })

  it('copies a big document\'s OCR pages, scan info and keeps pending status when only some chunks exist', () => {
    buildLegacyV2(
      dbPath,
      [
        { id: 20, status: 'text-only', model: null, chunks: 10 },
        { id: 21, status: 'pending', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 12, vectorDim: 1024 },
      ],
      (db) => {
        const ins = db.prepare('INSERT INTO ocr_pages (path, page, hash, mtime_ms, size_bytes, total_pages, text, model) VALUES (?, ?, ?, 1, 1, 400, ?, ?)')
        db.exec('BEGIN')
        for (let p = 1; p <= 400; p++) ins.run('/data/doc-20.txt', p, 'h', `trang ${p} ${'y'.repeat(20 * 1024)}`, 'ocr-model')
        db.exec('COMMIT')
        db.prepare('INSERT INTO pdf_scan_info (path, mtime_ms, size_bytes, total_pages, scanned) VALUES (?, 1, 1, 400, ?)').run('/data/doc-20.txt', 'scan')
      },
    )
    migrate()
    const v3 = new DatabaseSync(dbPath, { readOnly: true })
    expect(ids(v3, "SELECT count(*) n FROM ocr_pages WHERE path = '/data/doc-20.txt'")[0].n).toBe(400)
    expect(ids(v3, "SELECT sum(length(text)) n FROM ocr_pages")[0].n).toBeGreaterThan(7 * 1024 * 1024)
    expect(ids(v3, 'SELECT count(*) n FROM pdf_scan_info')[0].n).toBe(1)
    const pending = ids(v3, 'SELECT status, embedding_model, chunk_total, chunk_done FROM documents WHERE id = 21')[0]
    expect(pending).toEqual({ status: 'pending', embedding_model: null, chunk_total: 12, chunk_done: 0 })
    v3.close()
  })

  it('truncates a single chunk larger than the per-row cap deterministically (truncation metadata) instead of aborting', () => {
    buildLegacyV2(dbPath, [
      { id: 30, status: 'text-only', model: null, chunks: 4 },
      { id: 31, status: 'text-only', model: null, chunks: 2, truncated: 1, truncatedReason: 'chunk-limit' },
    ], (db) => {
      const huge = 'z'.repeat(MAX_MIGRATION_CHUNK_TEXT_BYTES * 2)
      db.prepare('UPDATE chunks SET text = ?, normalized = ? WHERE document_id = 30 AND ordinal = 2').run(huge, huge)
      db.prepare('UPDATE chunks SET text = ?, normalized = ? WHERE document_id = 31 AND ordinal = 0').run(huge, huge)
    })
    const result = migrate()
    expect(result.success).toBe(true)
    const v3 = new DatabaseSync(dbPath, { readOnly: true })
    expect(ids(v3, 'SELECT count(*) n FROM chunks')[0].n).toBe(6)
    const cut = ids(v3, 'SELECT length(CAST(text AS BLOB)) b FROM chunks WHERE document_id = 30 AND ordinal = 2')[0].b
    expect(cut).toBeLessThanOrEqual(MAX_MIGRATION_CHUNK_TEXT_BYTES)
    expect(cut).toBeGreaterThan(0)
    expect(ids(v3, 'SELECT truncated, truncated_reason FROM documents WHERE id = 30')[0]).toEqual({ truncated: 1, truncated_reason: 'content-limit' })
    // an existing truncation reason is never overwritten
    expect(ids(v3, 'SELECT truncated, truncated_reason FROM documents WHERE id = 31')[0]).toEqual({ truncated: 1, truncated_reason: 'chunk-limit' })
    // untouched documents are not flagged
    v3.close()
  })

  it('fails closed mid-document when a slice is denied: source untouched, no temp / guard left behind', () => {
    buildLegacyV2(dbPath, [{ id: 40, status: 'ready', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 4300, vectorDim: 1024 }])
    const sizeBefore = statSync(dbPath).size
    class DenyingContract extends MigrationBudgetContract {
      calls = 0
      override admitBatch(bytes: number, free?: number | null, base?: number) {
        if (++this.calls > 3) return { admitted: false, reason: 'test quota exhausted mid-document' }
        return super.admitBatch(bytes, free, base)
      }
    }
    const contract = new DenyingContract(dbPath, 1024, 4 * 1024 ** 3)
    expect(() => migrate({ budgetContract: contract })).toThrow(/Storage quota exceeded during migration batch: test quota exhausted/)
    expect(contract.calls).toBeGreaterThan(3)
    expect(statSync(dbPath).size).toBe(sizeBefore)
    expect(readdirSync(dir).sort()).toEqual(['document-memory.db'])
    const src = new DatabaseSync(dbPath, { readOnly: true })
    expect(ids(src, 'SELECT count(*) n FROM chunks WHERE vector IS NOT NULL')[0].n).toBe(4300)
    src.close()
  })

  it('failure injected before cutover on an oversized document leaves the V2 database untouched', () => {
    buildLegacyV2(dbPath, [{ id: 41, status: 'ready', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 4300, vectorDim: 1024 }])
    expect(() => migrate({ testFailureInjectionPoint: 'before-cutover' })).toThrow(/injected failure/)
    expect(readdirSync(dir).sort()).toEqual(['document-memory.db'])
    const src = new DatabaseSync(dbPath, { readOnly: true })
    expect(ids(src, 'SELECT count(*) n FROM chunks')[0].n).toBe(4300)
    src.close()
  })

  it('still denies a migration whose total growth cannot fit the storage budget (admission unchanged)', () => {
    buildLegacyV2(dbPath, [{ id: 42, status: 'ready', model: ACTIVE_ID, chunks: 3000, vectorDim: ACTIVE_DIM }])
    expect(() => migrate({ budgetBytes: 30 * 1024 * 1024 })).toThrow(/admission rejected|Storage budget exceeded/)
    expect(readdirSync(dir).sort()).toEqual(['document-memory.db'])
  })

  it('bootstrap migrates the real-shaped database end to end with the active profile from settings', async () => {
    buildLegacyV2(dbPath, [
      { id: 50, status: 'ready', model: LEGACY_VIETNAMESE_EMBEDDING_ID, chunks: 4300, vectorDim: 1024 },
      { id: 51, status: 'pending', model: null, chunks: 0 },
    ])
    writeFileSync(join(dir, 'document-memory-embedding.json'), JSON.stringify({ profile: 'base' }))
    const res = await ensureDocumentMemoryStorageReady(dir)
    expect(res.error).toBeUndefined()
    expect(res.ready).toBe(true)
    expect(res.migrated).toBe(true)
    expect(res.migrationResult?.chunksCopied).toBe(4300)
    const v3 = new DatabaseSync(dbPath, { readOnly: true })
    expect(ids(v3, 'SELECT status FROM documents WHERE id = 50')[0].status).toBe('text-only')
    v3.close()
    // a second start is a no-op
    const again = await ensureDocumentMemoryStorageReady(dir)
    expect(again.ready).toBe(true)
    expect(again.migrated).toBe(false)
  })
})
