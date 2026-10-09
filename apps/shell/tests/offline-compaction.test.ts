import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { findUnexpectedTempArtifacts } from '../src/main/document-memory/storage-bootstrap'
import {
  SimulatedCompactionCrash,
  cleanupCompactionBackups,
  compactionPaths,
  planOfflineCompaction,
  readSqliteHeader,
  recoverInterruptedCompaction,
  runOfflineCompaction,
  type CompactionPhase,
} from '../src/main/document-memory/runtime/offline-compaction'
import { seedCorpus, type SeedResult } from './helpers/storage-optimizer-seed'

const OPTS = { enabled: true, minReclaimBytes: 1, minFreelistRatio: 0.05 } as const

describe('offline VACUUM INTO compaction', () => {
  let dir: string
  let dbPath: string
  let seed: SeedResult

  /** Seeds, then deletes ~70% of the documents without vacuuming (leaves a large freelist), then closes. */
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'offline-compaction-'))
    dbPath = join(dir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath, { role: 'worker' })
    seed = seedCorpus(store, dir, { targetLogicalMb: 2, chunksPerDoc: 10 })
    const db = store.rawDb
    const ids = (db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
    for (const id of ids.filter((_, i) => i % 10 < 7)) {
      db.prepare('DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)').run(id)
      db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(id)
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
      db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    }
    store.close()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const snapshot = (path = dbPath) => {
    const db = new DatabaseSync(path)
    try {
      const rows = (sql: string, ...a: Array<string | number>) => db.prepare(sql).all(...a)
      return {
        chunks: rows('SELECT id, document_id, ordinal, text FROM chunks ORDER BY id'),
        emb: rows('SELECT chunk_id, space_id, length(vector) l FROM chunk_embeddings ORDER BY chunk_id'),
        docs: rows('SELECT id, path, name FROM documents ORDER BY id'),
        fts: seed.queryWords.map((w) => rows('SELECT rowid, bm25(chunk_fts) r FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY r, rowid', `"${w}"`)),
        name: rows("SELECT rowid FROM document_name_fts WHERE document_name_fts MATCH 'doc*' ORDER BY rowid"),
        av: (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum,
        seq: rows('SELECT name, seq FROM sqlite_sequence ORDER BY name'),
      }
    } finally {
      db.close()
    }
  }
  const leftovers = (): string[] => readdirSync(dir).filter((n) => /compact-(wip|manifest)/.test(n))
  const backups = (): string[] => readdirSync(dir).filter((n) => /\.compact-prev\.\d+\.bak$/.test(n))

  it('is opt-in: disabled by default, dry-run only plans and creates nothing', () => {
    const before = readdirSync(dir).sort()
    expect(runOfflineCompaction(dbPath).status).toBe('disabled')
    const dry = runOfflineCompaction(dbPath, { ...OPTS, dryRun: true })
    expect(dry.status).toBe('dry-run')
    expect(dry.plan!.eligible).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(before)
  })

  it('plan reads the real header: page counts, freelist and thresholds', () => {
    const plan = planOfflineCompaction(dbPath, OPTS)
    const db = new DatabaseSync(dbPath)
    const pragma = (n: string): number => Number(Object.values(db.prepare(`PRAGMA ${n}`).get() as Record<string, number>)[0])
    expect(plan.pageSize).toBe(pragma('page_size'))
    expect(plan.pageCount).toBe(pragma('page_count'))
    expect(plan.freelistPages).toBe(pragma('freelist_count'))
    expect(plan.autoVacuum).toBe('incremental')
    expect(plan.freelistRatio).toBeGreaterThan(0.3)
    db.close()
    expect(readSqliteHeader(join(dir, 'missing.db'))).toBeNull()

    const strict = planOfflineCompaction(dbPath, { enabled: true, minFreelistRatio: 0.99 })
    expect(strict.eligible).toBe(false)
    expect(strict.reasons.join()).toContain('freelist-ratio-below-threshold')
    const poor = planOfflineCompaction(dbPath, { ...OPTS, freeDiskBytes: 1024 })
    expect(poor.reasons.join()).toContain('insufficient-free-disk')
    const unknown = planOfflineCompaction(dbPath, { ...OPTS, freeDiskBytes: null })
    expect(unknown.reasons).toContain('free-disk-unknown')
  })

  it('compacts: smaller file, identical content/ids/FTS/bm25, INCREMENTAL kept, backup kept, no temp artifacts', () => {
    const before = snapshot()
    const sizeBefore = statSync(dbPath).size
    const res = runOfflineCompaction(dbPath, OPTS)
    expect(res.status, res.error).toBe('compacted')
    expect(res.bytesAfter).toBeLessThan(sizeBefore * 0.6)
    expect(res.bytesSaved).toBe(res.bytesBefore - res.bytesAfter)
    expect(res.verification).toMatchObject({ integrityCheck: 'ok', quickCheck: 'ok', foreignKeyErrors: 0, schemaEqual: true, pragmasEqual: true })
    expect(res.verification!.ftsIntegrity.chunk_fts).toBe(true)
    expect(res.verification!.ftsIntegrity.document_name_fts).toBe(true)
    expect(res.verification!.ftsSamples).toBeGreaterThan(0)
    expect(statSync(dbPath).size).toBe(res.bytesAfter)
    expect(snapshot()).toEqual(before)
    expect(leftovers()).toEqual([])
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(backups()).toHaveLength(1)
    expect(statSync(res.backupPath!).size).toBe(res.bytesBefore)
    // bootstrap's fail-closed scan must not see any of our files as leftovers
    expect(findUnexpectedTempArtifacts(dir)).toEqual([])
    // the app can open the result like any database
    const store = new DocumentMemoryStore(dbPath, { role: 'search' })
    expect(store.searchLexical(`${seed.queryWords[0]}`, 5).length).toBeGreaterThan(0)
    expect((store.rawDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
    store.close()
  })

  it('keepBackup:false removes the previous file after verification', () => {
    const res = runOfflineCompaction(dbPath, { ...OPTS, keepBackup: false })
    expect(res.status).toBe('compacted')
    expect(backups()).toEqual([])
  })

  it('refuses while another connection is open (idle reader or writer) and changes nothing', () => {
    const other = new DatabaseSync(dbPath)
    other.exec('PRAGMA journal_mode = WAL')
    other.prepare('SELECT count(*) FROM documents').get()
    const before = snapshot()
    const size = statSync(dbPath).size
    const res = runOfflineCompaction(dbPath, OPTS)
    expect(res.status).toBe('failed')
    expect(res.error).toContain('database-in-use')
    other.close()
    expect(statSync(dbPath).size).toBe(size)
    expect(snapshot()).toEqual(before)
    expect(leftovers()).toEqual([])
    expect(backups()).toEqual([])
  })

  it('converts a legacy auto_vacuum=NONE database to INCREMENTAL and keeps data', () => {
    const legacy = join(dir, 'legacy', 'document-memory.db')
    rmSync(join(dir, 'legacy'), { recursive: true, force: true })
    mkdirSync(join(dir, 'legacy'))
    const db = new DatabaseSync(legacy)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); CREATE VIRTUAL TABLE f USING fts5(x)')
    for (let i = 1; i <= 2000; i++) {
      db.prepare('INSERT INTO t(id, v) VALUES (?, ?)').run(i, 'x'.repeat(500))
      db.prepare('INSERT INTO f(rowid, x) VALUES (?, ?)').run(i, `alpha beta gamma${i % 7}`)
    }
    db.exec('DELETE FROM t WHERE id % 4 != 0; DELETE FROM f WHERE rowid % 4 != 0')
    expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(0)
    db.close()
    const sizeBefore = statSync(legacy).size
    const res = runOfflineCompaction(legacy, { enabled: true })
    expect(res.status, res.error).toBe('compacted')
    const after = new DatabaseSync(legacy)
    expect((after.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
    expect((after.prepare('SELECT count(*) n FROM t').get() as { n: number }).n).toBe(500)
    expect((after.prepare("SELECT count(*) n FROM f WHERE f MATCH 'alpha'").get() as { n: number }).n).toBe(500)
    after.close()
    expect(statSync(legacy).size).toBeLessThan(sizeBefore * 0.5)
  })

  it('rolls back and keeps the original when verification of the copy fails (tampered copy)', () => {
    const before = snapshot()
    const p = compactionPaths(dbPath)
    const res = runOfflineCompaction(dbPath, {
      ...OPTS,
      onPhase: (phase) => {
        if (phase !== 'vacuumed') return
        const copy = new DatabaseSync(p.tmp)
        copy.exec('DELETE FROM chunk_embeddings WHERE rowid IN (SELECT rowid FROM chunk_embeddings LIMIT 3)')
        copy.close()
      },
    })
    expect(res.status).toBe('failed')
    expect(res.error).toMatch(/verification-failed.*table-mismatch:chunk_embeddings/)
    expect(snapshot()).toEqual(before)
    expect(leftovers()).toEqual([])
    expect(backups()).toEqual([])
  })

  for (const phase of ['prepared', 'source-backed-up', 'installed', 'post-verified'] as CompactionPhase[]) {
    it(`rolls back to the original database when a step fails after "${phase}"`, () => {
      const before = snapshot()
      const res = runOfflineCompaction(dbPath, {
        ...OPTS,
        onPhase: (p) => {
          if (p === phase) throw new Error(`boom at ${p}`)
        },
      })
      // nothing was renamed yet at "prepared": plain failure; afterwards the swap is undone: rolled-back
      expect(res.status).toBe(phase === 'prepared' ? 'failed' : 'rolled-back')
      expect(res.error).toContain(`boom at ${phase}`)
      expect(snapshot()).toEqual(before)
      expect(leftovers()).toEqual([])
      expect(backups()).toEqual([])
      expect(existsSync(dbPath)).toBe(true)
    })
  }

  describe('crash recovery (process dies mid-swap, no rollback code runs)', () => {
    const crashAt = (phase: CompactionPhase): void => {
      expect(() =>
        runOfflineCompaction(dbPath, {
          ...OPTS,
          onPhase: (p) => {
            if (p === phase) throw new SimulatedCompactionCrash(p)
          },
        }),
      ).toThrow(SimulatedCompactionCrash)
    }

    it('before the manifest (copy only): the unfinished copy is dropped, original untouched', () => {
      const before = snapshot()
      crashAt('verified')
      expect(existsSync(compactionPaths(dbPath).tmp)).toBe(true)
      expect(recoverInterruptedCompaction(dbPath)).toMatchObject({ recovered: true, action: 'removed-unfinished-copy' })
      expect(snapshot()).toEqual(before)
      expect(leftovers()).toEqual([])
    })

    it('manifest "prepared": copy removed, original untouched', () => {
      const before = snapshot()
      crashAt('prepared')
      expect(recoverInterruptedCompaction(dbPath).action).toBe('removed-unfinished-copy')
      expect(snapshot()).toEqual(before)
      expect(leftovers()).toEqual([])
    })

    it('between the two renames: live file is missing, recovery restores the previous database', () => {
      const before = snapshot()
      crashAt('source-backed-up')
      expect(existsSync(dbPath)).toBe(false)
      expect(recoverInterruptedCompaction(dbPath)).toMatchObject({ recovered: true, action: 'restored-previous-database' })
      expect(snapshot()).toEqual(before)
      expect(leftovers()).toEqual([])
      expect(backups()).toEqual([])
    })

    it('after install (new file in place): recovery keeps the verified new database and the backup', () => {
      const before = snapshot()
      const size = statSync(dbPath).size
      crashAt('installed')
      expect(recoverInterruptedCompaction(dbPath)).toMatchObject({ recovered: true, action: 'finalized-installed-database' })
      expect(snapshot()).toEqual(before)
      expect(statSync(dbPath).size).toBeLessThan(size)
      expect(leftovers()).toEqual([])
      expect(backups()).toHaveLength(1)
    })

    it('after install but new file unsound: recovery restores the previous database', () => {
      const before = snapshot()
      crashAt('installed')
      writeFileSync(dbPath, Buffer.alloc(4096, 7)) // damage the installed file
      expect(recoverInterruptedCompaction(dbPath).action).toBe('restored-previous-database')
      expect(snapshot()).toEqual(before)
      expect(backups()).toEqual([])
    })

    it('recovery is idempotent and a fresh run recovers automatically first', () => {
      crashAt('source-backed-up')
      const res = runOfflineCompaction(dbPath, OPTS)
      expect(res.status, res.error).toBe('compacted')
      expect(recoverInterruptedCompaction(dbPath).action).toBe('none')
    })
  })

  it('backup cleanup removes only expired compaction backups', () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const old = join(dir, `document-memory.compact-prev.${now - 2 * day}.bak`)
    const fresh = join(dir, `document-memory.compact-prev.${now - 1000}.bak`)
    const v2 = join(dir, 'document-memory.v2.1700000000000.backup.db')
    const other = join(dir, 'document-memory.something.bak')
    for (const f of [old, fresh, v2, other]) writeFileSync(f, 'x')
    utimesSync(v2, new Date(0), new Date(0))
    expect(cleanupCompactionBackups(dbPath, { now })).toEqual([old])
    expect(existsSync(old)).toBe(false)
    for (const f of [fresh, v2, other, dbPath]) expect(existsSync(f)).toBe(true)
    expect(cleanupCompactionBackups(dbPath, { now, olderThanMs: 0 })).toEqual([fresh])
    expect(existsSync(v2)).toBe(true)
  })
})
