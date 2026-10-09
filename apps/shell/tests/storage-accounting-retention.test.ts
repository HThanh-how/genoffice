import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import {
  StorageAdmissionController,
} from '../src/main/document-memory/runtime/storage-admission'
import {
  executeCacheRetentionPolicy,
  shouldTriggerCacheRetention,
  calculateReclaimTarget,
} from '../src/main/document-memory/runtime/cache-retention-policy'
import { openDatabase } from '../src/main/document-memory/storage/database'
import { applyCanonicalSchemaV3 } from '../src/main/document-memory/storage/schema-v3'

describe('Checkpoint 3: Storage Accounting, Admission & Tiered Retention', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dm-accounting-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('ACCOUNT-01: collectStorageAccounting tracks DB, WAL, ANN, OCR, temp, and backups', () => {
    const dbPath = join(tempDir, 'document-memory.db')
    writeFileSync(dbPath, Buffer.alloc(100_000)) // 100 KB
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(20_000)) // 20 KB

    // ANN index
    const vectorsDir = join(tempDir, 'vectors')
    mkdirSync(vectorsDir, { recursive: true })
    writeFileSync(join(vectorsDir, 'standard.usearch'), Buffer.alloc(50_000)) // 50 KB

    // OCR storage
    const ocrDir = join(tempDir, 'ocr')
    mkdirSync(ocrDir, { recursive: true })
    writeFileSync(join(ocrDir, 'page1.png'), Buffer.alloc(30_000)) // 30 KB

    // Temp file
    writeFileSync(join(tempDir, 'active.tmp'), Buffer.alloc(10_000)) // 10 KB

    // V2 backup
    writeFileSync(join(tempDir, 'document-memory.v2.backup.db'), Buffer.alloc(200_000)) // 200 KB

    const report = collectStorageAccounting({
      dbPath,
      vectorsDir,
      ocrDir,
      tempDir,
    })

    expect(report.dbSizeBytes).toBe(100_000)
    expect(report.walSizeBytes).toBe(20_000)
    expect(report.databaseBytes).toBe(120_000)
    expect(report.annSizeBytes).toBe(50_000)
    expect(report.ocrSizeBytes).toBe(30_000)
    expect(report.tempSizeBytes).toBe(10_000)
    expect(report.backupSizeBytes).toBe(200_000)
    expect(report.totalTrackedBytes).toBe(410_000)
  })

  it('ADMIT-01: StorageAdmissionController admits within budget and blocks at hard limit', () => {
    const controller = new StorageAdmissionController()
    const budget = 1_000_000 // 1 MB

    // Normal work at 50% usage
    const okDecision = controller.canAdmit('embed', 100_000, 500_000, budget)
    expect(okDecision.admitted).toBe(true)
    expect(okDecision.reason).toBe('ok')

    // Embedding pushing usage to 100% -> blocked
    const blockDecision = controller.canAdmit('embed', 600_000, 500_000, budget)
    expect(blockDecision.admitted).toBe(false)
    expect(blockDecision.reason).toBe('hard-limit-exceeded')
  })

  it('ADMIT-02: new backups require capacity in the total managed quota', () => {
    const controller = new StorageAdmissionController()
    const budget = 1_000_000 // 1 MB
    const currentUsage = 950_000 // 95% full

    // A NEW backup cannot bypass total managed capacity just because it is protected later.
    const backupDecision = controller.canAdmit('backup', 500_000, currentUsage, budget)
    expect(backupDecision.admitted).toBe(false)
    expect(backupDecision.reason).toBe('quota-exhausted')
    const withCapacity = controller.canAdmit('backup', 500_000, 100_000, budget)
    expect(withCapacity.admitted).toBe(true)
    expect(withCapacity.reason).toBe('ok')
  })

  it('ADMIT-03: Tracks reservations and prevents oversubscription', () => {
    const controller = new StorageAdmissionController()
    const budget = 1_000_000
    const currentUsage = 700_000

    // Reserve 200 KB
    const res1 = controller.reserve('task-1', 'extract', 200_000, currentUsage, budget)
    expect(res1.admitted).toBe(true)
    expect(controller.getReservedBytes()).toBe(200_000)

    // Now projected is 700k + 200k = 900k. Trying to reserve another 150k exceeds 1MB budget
    const res2 = controller.reserve('task-2', 'embed', 150_000, currentUsage, budget)
    expect(res2.admitted).toBe(false)
    expect(res2.reason).toBe('hard-limit-exceeded')

    // Release task-1
    controller.release('task-1')
    expect(controller.getReservedBytes()).toBe(0)

    // Now task-2 can be admitted
    const res3 = controller.reserve('task-2', 'embed', 150_000, currentUsage, budget)
    expect(res3.admitted).toBe(true)
  })

  it('RETENTION-01: Hysteresis thresholds trigger at 90% and calculate target to 80%', () => {
    const budget = 1_000_000_000 // 1 GB
    expect(shouldTriggerCacheRetention(890_000_000, budget)).toBe(false)
    expect(shouldTriggerCacheRetention(910_000_000, budget)).toBe(true)

    // At 950 MB, target to reclaim down to 80% (800 MB) is 150 MB
    expect(calculateReclaimTarget(950_000_000, budget)).toBe(150_000_000)
  })

  it('RETENTION-02: Enforces tiered retention order (orphans -> low importance -> normal -> protect important)', async () => {
    const dbPath = join(tempDir, 'retention.db')
    const db = openDatabase(dbPath)
    applyCanonicalSchemaV3(db)

    // Seed test documents:
    // 1. Important doc (Tier 4) - should be protected!
    db.prepare(`
      INSERT INTO documents (id, path, name, status, importance_override, chunk_total, last_opened_at)
      VALUES (1, '/docs/cccd.pdf', 'cccd.pdf', 'ready', 'important', 5, 1000)
    `).run()

    // 2. Low-importance doc (Tier 2) - should be pruned first
    db.prepare(`
      INSERT INTO documents (id, path, name, status, importance_override, chunk_total, last_opened_at)
      VALUES (2, '/docs/scratch.tmp', 'scratch.tmp', 'ready', 'low', 10, 2000)
    `).run()

    // 3. Normal doc (Tier 3) - rarely opened
    db.prepare(`
      INSERT INTO documents (id, path, name, status, importance_override, chunk_total, last_opened_at)
      VALUES (3, '/docs/report.docx', 'report.docx', 'ready', 'auto', 8, 500)
    `).run()

    // Embedding space
    db.prepare(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('standard', 'repo', 'rev', 'cls', 384, 'none')
    `).run()

    // Chunks & chunk_embeddings
    for (let c = 1; c <= 5; c++) {
      db.prepare(`INSERT INTO chunks (id, document_id, ordinal, text, location) VALUES (?, 1, ?, 'cccd text', '')`).run(c, c)
      db.prepare(`INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, 'standard', X'000102', 384)`).run(c)
    }
    for (let c = 6; c <= 15; c++) {
      db.prepare(`INSERT INTO chunks (id, document_id, ordinal, text, location) VALUES (?, 2, ?, 'scratch text', '')`).run(c, c)
      db.prepare(`INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, 'standard', X'000102', 384)`).run(c)
    }
    for (let c = 16; c <= 23; c++) {
      db.prepare(`INSERT INTO chunks (id, document_id, ordinal, text, location) VALUES (?, 3, ?, 'normal text', '')`).run(c, c)
      db.prepare(`INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, 'standard', X'000102', 384)`).run(c)
    }

    // Force run cache retention
    const report = await executeCacheRetentionPolicy(db, dbPath, 1000, { force: true })
    expect(report.error).toBeUndefined()
    expect(report.triggered).toBe(true)
    expect(report.tier2LowImportanceDocsPruned).toBeGreaterThanOrEqual(1)
    expect(report.tier4ProtectedDocsCount).toBe(1)

    // Verify important doc's embeddings are 100% PRESERVED
    const importantEmbeddings = db
      .prepare(`SELECT count(*) as c FROM chunk_embeddings WHERE chunk_id <= 5`)
      .get() as { c: number }
    expect(importantEmbeddings.c).toBe(5)

    // Verify low importance doc's embeddings are PRUNED
    const lowEmbeddings = db
      .prepare(`SELECT count(*) as c FROM chunk_embeddings WHERE chunk_id >= 6 AND chunk_id <= 15`)
      .get() as { c: number }
    expect(lowEmbeddings.c).toBe(0)

    db.close()
  })
})
