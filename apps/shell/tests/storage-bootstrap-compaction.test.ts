import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  SimulatedCompactionCrash,
  compactionPaths,
  runOfflineCompaction,
} from '../src/main/document-memory/runtime/offline-compaction'
import {
  COMPACTION_SETTINGS_FILENAME,
  readOfflineCompactionSetting,
} from '../src/main/document-memory/storage/offline-compaction-setting'
import { seedCorpus } from './helpers/storage-optimizer-seed'

/**
 * Offline compaction at storage bootstrap: crash recovery and backup clean-up always run; the compaction itself is
 * OPT-IN (setting file or option), off by default, and every failure keeps the previous database.
 */
describe('storage bootstrap: offline compaction wiring', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-compaction-'))
    dbPath = join(dir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath, { role: 'worker' })
    seedCorpus(store, dir, { targetLogicalMb: 2, chunksPerDoc: 10 })
    const db = store.rawDb
    const ids = (
      db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: number }>
    ).map((r) => r.id)
    db.exec('BEGIN')
    for (const id of ids.filter((_, i) => i % 10 < 7)) {
      db.prepare(
        'DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)',
      ).run(id)
      db.prepare(
        'DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)',
      ).run(id)
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
      db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    }
    db.exec('COMMIT')
    store.close()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const backups = (): string[] =>
    readdirSync(dir).filter((n) => /\.compact-prev\.\d+\.bak$/.test(n))

  it('is OFF by default: startup does not compact', async () => {
    const size = statSync(dbPath).size
    const res = await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })
    expect(res.ready).toBe(true)
    expect(statSync(dbPath).size).toBeGreaterThanOrEqual(size * 0.9)
    expect(backups()).toEqual([])
    expect(readOfflineCompactionSetting(dir)).toBe(false)
    expect(readOfflineCompactionSetting(undefined)).toBe(false)
  })

  it('runs when opted in through the option or the settings file, before any connection exists', async () => {
    const size = statSync(dbPath).size
    writeFileSync(
      join(dir, COMPACTION_SETTINGS_FILENAME),
      JSON.stringify({ offlineCompaction: true }),
    )
    expect(readOfflineCompactionSetting(dir)).toBe(true)
    // the setting only opts in: the default thresholds (16 MB reclaimable) skip this tiny database
    expect((await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })).ready).toBe(true)
    expect(statSync(dbPath).size).toBeGreaterThanOrEqual(size * 0.9)
    expect(backups()).toEqual([])
    // thresholds lowered through the option object: it compacts
    const res = await ensureDocumentMemoryStorageReady(dir, {
      settingsDir: dir,
      offlineCompaction: { minReclaimBytes: 1, minFreelistRatio: 0.05 },
    })
    expect(res.ready).toBe(true)
    expect(statSync(dbPath).size).toBeLessThan(size * 0.7)
    expect(backups()).toHaveLength(1)
    // an explicit option wins over the file
    const again = await ensureDocumentMemoryStorageReady(dir, {
      settingsDir: dir,
      offlineCompaction: false,
    })
    expect(again.ready).toBe(true)
    // the database is intact and usable afterwards
    const store = new DocumentMemoryStore(dbPath, { role: 'search' })
    expect(
      (store.rawDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check,
    ).toBe('ok')
    store.close()
  })

  it('a failed compaction (database in use is simulated by a corrupt settings value) never blocks startup', async () => {
    writeFileSync(join(dir, COMPACTION_SETTINGS_FILENAME), '{not json')
    expect(readOfflineCompactionSetting(dir)).toBe(false)
    expect((await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })).ready).toBe(true)
  })

  it('recovers a compaction that crashed mid-swap before anything else opens the database', async () => {
    const before = statSync(dbPath).size
    expect(() =>
      runOfflineCompaction(dbPath, {
        enabled: true,
        minReclaimBytes: 1,
        minFreelistRatio: 0.05,
        onPhase: (phase) => {
          if (phase === 'source-backed-up') throw new SimulatedCompactionCrash(phase)
        },
      }),
    ).toThrow(/simulated crash/)
    // the live file was renamed away: the directory is in the half-swapped state
    expect(existsSync(compactionPaths(dbPath).manifest)).toBe(true)
    const res = await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })
    expect(res.ready).toBe(true)
    expect(existsSync(compactionPaths(dbPath).manifest)).toBe(false)
    expect(statSync(dbPath).size).toBeGreaterThanOrEqual(before * 0.9) // the previous database is back
    const store = new DocumentMemoryStore(dbPath, { role: 'search' })
    expect(
      (store.rawDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check,
    ).toBe('ok')
    store.close()
  })

  it('removes expired .compact-prev backups at startup and keeps fresh ones', async () => {
    const p = compactionPaths(dbPath, Date.now() - 3 * 86_400_000)
    const fresh = compactionPaths(dbPath, Date.now() - 60_000)
    writeFileSync(p.backup, 'old')
    writeFileSync(fresh.backup, 'new')
    const old = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(p.backup, old, old)
    const res = await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })
    expect(res.ready).toBe(true)
    expect(existsSync(p.backup)).toBe(false)
    expect(existsSync(fresh.backup)).toBe(true)
  })
})
