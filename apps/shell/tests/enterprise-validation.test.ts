import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateSyntheticFixture } from '../../scripts/document-memory-fixture.mjs'
import { runBenchmark } from '../../scripts/document-memory-benchmark.mjs'
import { migrateStorageV2ToV3, verifyDatabaseIntegrity } from '../src/main/document-memory/storage-migration'

describe('Document Search V3 Enterprise Validation Suite (IT-5)', () => {
  let directory: string
  let fixtureDbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-val-'))
    fixtureDbPath = join(directory, 'test-pathological.db')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('validates end-to-end migration on pathological fixture: purges auto-discovered artifacts, preserves user-opened and OCR, enforces incremental auto_vacuum and zero FK violations', () => {
    // 1. Generate pathological fixture with Chromium license files and retired sets
    const fixtureInfo = generateSyntheticFixture({ profile: 'pathological', out: fixtureDbPath })
    expect(fixtureInfo.documents).toBeGreaterThan(10)

    // Pre-migration checks
    const preDb = new DatabaseSync(fixtureDbPath, { readOnly: true })
    const preChromiumCount = (
      preDb.prepare("SELECT count(*) as c FROM documents WHERE name LIKE '%LICENSES.chromium%'").get() as { c: number }
    ).c
    expect(preChromiumCount).toBe(11) // 10 auto-discovered + 1 user-opened
    preDb.close()

    // 2. Execute V3 Storage Migration
    const migrationResult = migrateStorageV2ToV3(fixtureDbPath, {
      activeSpaceId: 'standard',
      activeDimensions: 320,
      backupDbPath: `${fixtureDbPath}.v2.backup.db`,
      tempDbPath: `${fixtureDbPath}.v3.tmp`,
    })

    expect(migrationResult.success).toBe(true)
    expect(migrationResult.verified).toBe(true)
    expect(migrationResult.documentsDroppedArtifacts).toBe(10) // Exactly 10 auto-discovered Chromium files dropped!

    // 3. Post-migration database state validation
    const postDb = new DatabaseSync(fixtureDbPath, { readOnly: true })
    try {
      // Exactly 1 user-opened Chromium file preserved
      const postChromiumDocs = postDb
        .prepare("SELECT path, last_opened_at FROM documents WHERE name LIKE '%LICENSES.chromium%'")
        .all() as Array<{ path: string; last_opened_at: number }>

      expect(postChromiumDocs).toHaveLength(1)
      expect(postChromiumDocs[0].last_opened_at).toBeGreaterThan(0) // User intent won!

      // Chunks table in V3 MUST NOT have vector or normalized columns
      const chunkCols = (
        postDb.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      expect(chunkCols).not.toContain('vector')
      expect(chunkCols).not.toContain('vector_dim')
      expect(chunkCols).not.toContain('normalized')

      // Canonical vectors exclusively in chunk_embeddings
      const postVecCount = (
        postDb.prepare('SELECT count(*) as c FROM chunk_embeddings').get() as { c: number }
      ).c
      expect(postVecCount).toBeGreaterThan(0)

      // OCR pages preserved
      const ocrPages = (
        postDb.prepare('SELECT count(*) as c FROM ocr_pages').get() as { c: number }
      ).c
      expect(ocrPages).toBe(1)

      // PRAGMA checks
      const autoVac = (postDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum
      expect(autoVac).toBe(2) // INCREMENTAL

      const jMode = (postDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
      expect(jMode.toLowerCase()).toBe('wal')
    } finally {
      postDb.close()
    }

    // 4. Verification tool check
    const integrity = verifyDatabaseIntegrity(fixtureDbPath)
    expect(integrity.ok).toBe(true)
    expect(integrity.integrity).toBe('ok')
    expect(integrity.foreignKeyErrors).toHaveLength(0)

    // 5. Benchmark check
    const bench = runBenchmark({ db: fixtureDbPath, queries: 10 })
    expect(bench.dbBytes).toBeGreaterThan(0)
    expect(bench.chunks).toBeGreaterThan(0)
    expect(bench.lexicalP95Ms).toBeLessThan(50) // Sub-50ms lexical search latency
  })
})
