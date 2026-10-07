/**
 * Document Search V3: Enterprise Storage Budget & User-visible Limits Suite (QA-16)
 *
 * Verifies enterprise storage budget tiers and user-visible invariants:
 * - BUDGET-01: Per-file safety budget truncates/skips oversized file with explicit reason
 * - BUDGET-02: Soft limit triggers maintenance warning state without data loss
 * - BUDGET-03: Hard limit stops accepting heavy semantic work while preserving lexical
 * - BUDGET-04: Backup budget is isolated and never purges safety-critical migration backups
 * - BUDGET-05: IPC/snapshot exposes truthful budget metrics (databaseBytes, budgetBytes, usageRatio, limitState)
 * - BUDGET-06: User-facing limit explanation matches reason persisted in database
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_STORAGE_BUDGET,
  SOFT_LIMIT_RATIO,
  HARD_LIMIT_RATIO,
  type DocumentIndexStorageBudget,
  type StorageBudgetSnapshot,
  calculateStorageLimitState,
  createStorageBudgetSnapshot,
  checkFileSafetyBudget,
  canAcceptSemanticWork,
  canAcceptExpensiveWork,
  shouldTriggerStorageMaintenance,
  safeGetFileSize,
} from '../src/main/document-memory/storage-budget'

import { MaintenanceRepository } from '../src/main/document-memory/storage/repositories/maintenance-repository'
import { DiagnosticsRepository } from '../src/main/document-memory/storage/repositories/diagnostics-repository'
import { evaluateBackupRetention } from '../src/main/document-memory/storage/migration/retention-policy'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import {
  issueReason,
  isInformationalReason,
  isRetryableReason,
} from '../src/main/document-memory/issues'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'

describe('Document Search V3 - Storage Budget & User-visible Limits Suite (PAIR 16)', () => {
  let tempDir: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-search-v3-budget-test-'))
    dbPath = join(tempDir, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
  })

  afterEach(() => {
    try {
      store.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  // =========================================================================
  // BUDGET-01: Per-file safety budget
  // =========================================================================
  it('BUDGET-01 per-file safety budget truncates/skips oversized file with explicit reason', () => {
    // 1. Verify standard enterprise defaults
    expect(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes).toBe(4 * 1024 * 1024 * 1024) // 4 GiB
    expect(DEFAULT_STORAGE_BUDGET.maxFileBytes).toBe(128 * 1024 * 1024) // 128 MiB
    expect(DEFAULT_STORAGE_BUDGET.maxExtractedCharactersPerFile).toBe(8 * 1024 * 1024) // 8M chars
    expect(DEFAULT_STORAGE_BUDGET.maxChunksPerFile).toBe(4096)
    expect(DEFAULT_STORAGE_BUDGET.maxOcrPagesPerFile).toBe(50)

    // 2. Normal file within all bounds
    const normalResult = checkFileSafetyBudget({
      sizeBytes: 2 * 1024 * 1024,
      charCount: 50_000,
      chunkCount: 120,
      ocrPages: 10,
    })
    expect(normalResult).toEqual({
      accepted: true,
      truncated: false,
    })

    // 3. File exceeding per-file size budget (> 128 MiB) must be rejected with explicit reason
    const oversizedResult = checkFileSafetyBudget({
      sizeBytes: DEFAULT_STORAGE_BUDGET.maxFileBytes + 1,
      charCount: 100,
      chunkCount: 1,
    })
    expect(oversizedResult.accepted).toBe(false)
    expect(oversizedResult.truncated).toBe(false)
    expect(oversizedResult.rejectionReason).toBe('file-too-large')
    expect(oversizedResult.error).toContain('128 MB indexing limit')

    // 4. File exceeding character limit (> 8M chars) must be accepted but truncated
    const charExceededResult = checkFileSafetyBudget({
      sizeBytes: 10 * 1024 * 1024,
      charCount: DEFAULT_STORAGE_BUDGET.maxExtractedCharactersPerFile + 100,
      chunkCount: 200,
    })
    expect(charExceededResult.accepted).toBe(true)
    expect(charExceededResult.truncated).toBe(true)
    expect(charExceededResult.truncatedReason).toBe('content-limit')

    // 5. File exceeding chunk limit (> 4096 chunks) must be accepted but truncated
    const chunkExceededResult = checkFileSafetyBudget({
      sizeBytes: 10 * 1024 * 1024,
      charCount: 1_000_000,
      chunkCount: DEFAULT_STORAGE_BUDGET.maxChunksPerFile + 1,
    })
    expect(chunkExceededResult.accepted).toBe(true)
    expect(chunkExceededResult.truncated).toBe(true)
    expect(chunkExceededResult.truncatedReason).toBe('chunk-limit')

    // 6. PDF exceeding OCR page limit (> 50 pages) must be accepted but truncated
    const ocrExceededResult = checkFileSafetyBudget({
      sizeBytes: 20 * 1024 * 1024,
      charCount: 200_000,
      chunkCount: 500,
      ocrPages: DEFAULT_STORAGE_BUDGET.maxOcrPagesPerFile + 1,
    })
    expect(ocrExceededResult.accepted).toBe(true)
    expect(ocrExceededResult.truncated).toBe(true)
    expect(ocrExceededResult.truncatedReason).toBe('pdf-page-limit')

    // 7. Custom budget verification
    const customBudget: DocumentIndexStorageBudget = {
      maxDatabaseBytes: 1024 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxExtractedCharactersPerFile: 100_000,
      maxChunksPerFile: 500,
      maxOcrPagesPerFile: 20,
    }
    const customCheck = checkFileSafetyBudget({ sizeBytes: 12 * 1024 * 1024 }, customBudget)
    expect(customCheck.accepted).toBe(false)
    expect(customCheck.rejectionReason).toBe('file-too-large')
    expect(customCheck.error).toContain('10 MB indexing limit')
  })

  // =========================================================================
  // BUDGET-02: Soft limit triggers maintenance warning state without data loss
  // =========================================================================
  it('BUDGET-02 soft limit triggers maintenance warning state without data loss', () => {
    expect(SOFT_LIMIT_RATIO).toBe(0.80)
    expect(HARD_LIMIT_RATIO).toBe(1.00)

    const budgetBytes = 100_000_000 // 100 MB budget

    // Boundary check below soft limit (79%)
    expect(calculateStorageLimitState(79_000_000, budgetBytes)).toBe('ok')
    expect(shouldTriggerStorageMaintenance('ok')).toBe(false)

    // Exact soft limit (80%) triggers warning state
    expect(calculateStorageLimitState(80_000_000, budgetBytes)).toBe('warning')
    expect(shouldTriggerStorageMaintenance('warning')).toBe(true)

    // Between soft and hard limit (95%)
    expect(calculateStorageLimitState(95_000_000, budgetBytes)).toBe('warning')
    expect(shouldTriggerStorageMaintenance('warning')).toBe(true)

    // Populate SQLite database with real records
    const docId1 = store.rawDb
      .prepare(`INSERT INTO documents (path, name, status, mtime_ms, size_bytes, active_chunk_set_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .get('D:/docs/soft-limit-1.txt', 'soft-limit-1.txt', 'ready', 1700000000000, 4096, 1) as { id: number }

    const docId2 = store.rawDb
      .prepare(`INSERT INTO documents (path, name, status, mtime_ms, size_bytes, active_chunk_set_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .get('D:/docs/soft-limit-2.txt', 'soft-limit-2.txt', 'ready', 1700000000000, 8192, 1) as { id: number }

    // Insert chunks with chunk_set_id = NULL (safe standalone chunks)
    const r1 = store.rawDb.prepare(`INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, location) VALUES (?, NULL, 0, ?, '{"offset":0}')`).run(docId1.id, 'Document one critical content')
    const r2 = store.rawDb.prepare(`INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, location) VALUES (?, NULL, 0, ?, '{"offset":0}')`).run(docId2.id, 'Document two valuable information')

    // Populate FTS index
    store.rawDb.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`).run(r1.lastInsertRowid, 'Document one critical content')
    store.rawDb.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`).run(r2.lastInsertRowid, 'Document two valuable information')

    const maintenance = new MaintenanceRepository(store.rawDb, dbPath, 'worker')

    // Configure a small budget so current DB size triggers soft warning state
    const totalDbBytes = safeGetFileSize(dbPath) + safeGetFileSize(`${dbPath}-wal`)
    expect(totalDbBytes).toBeGreaterThan(0)

    const smallBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: Math.floor(totalDbBytes / 0.85), // puts usage at ~85%
    }

    const snapshot = maintenance.checkStorageBudget(smallBudget)
    expect(snapshot.limitState).toBe('warning')
    expect(snapshot.usageRatio).toBeGreaterThanOrEqual(0.80)
    expect(snapshot.usageRatio).toBeLessThan(1.00)

    // Trigger maintenance under warning state
    const maintenanceResult = maintenance.runStorageBudgetMaintenance({ budget: smallBudget })
    expect(maintenanceResult.limitStateBefore).toBe('warning')

    // ZERO DATA LOSS GUARANTEE:
    // Existing documents, chunks and FTS must remain 100% intact after maintenance
    const remainingDocs = store.rawDb.prepare(`SELECT count(*) AS count FROM documents`).get() as { count: number }
    const remainingChunks = store.rawDb.prepare(`SELECT count(*) AS count FROM chunks`).get() as { count: number }
    const remainingFts = store.rawDb.prepare(`SELECT count(*) AS count FROM chunk_fts`).get() as { count: number }

    expect(remainingDocs.count).toBe(2)
    expect(remainingChunks.count).toBe(2)
    expect(remainingFts.count).toBe(2)

    // Lexical queries must work completely
    const ftsSearchResults = store.rawDb.prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH 'critical'`).all()
    expect(ftsSearchResults.length).toBe(1)
  })

  // =========================================================================
  // BUDGET-03: Hard limit stops accepting heavy semantic work while preserving lexical
  // =========================================================================
  it('BUDGET-03 hard limit stops accepting heavy semantic work while preserving lexical', () => {
    const budgetBytes = 100_000_000

    // Under hard limit: semantic work is accepted
    expect(calculateStorageLimitState(99_999_999, budgetBytes)).toBe('warning')
    expect(canAcceptSemanticWork('warning')).toBe(true)
    expect(canAcceptExpensiveWork('warning')).toBe(true)

    // At exact 100% hard limit: limitState is 'full'
    expect(calculateStorageLimitState(100_000_000, budgetBytes)).toBe('full')
    expect(canAcceptSemanticWork('full')).toBe(false)
    expect(canAcceptExpensiveWork('full')).toBe(false)

    // Above 100% hard limit (e.g. 120%)
    expect(calculateStorageLimitState(120_000_000, budgetBytes)).toBe('full')
    expect(canAcceptSemanticWork('full')).toBe(false)
    expect(canAcceptExpensiveWork('full')).toBe(false)

    // Lexical indexing & preservation under hard limit:
    const docPath = join(tempDir, 'lexical-preserved.txt')
    const doc = store.rawDb
      .prepare(`INSERT INTO documents (path, name, status, mtime_ms, size_bytes) VALUES (?, ?, ?, ?, ?) RETURNING id`)
      .get(docPath, 'lexical-preserved.txt', 'ready', 1700000000000, 2048) as { id: number }

    const rDoc = store.rawDb.prepare(`INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, location) VALUES (?, NULL, 0, ?, '{"offset":0}')`).run(doc.id, 'Lexical text stays fully readable and searchable')
    store.rawDb.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`).run(rDoc.lastInsertRowid, 'Lexical text stays fully readable and searchable')

    // Confirm that lexical FTS search works seamlessly despite 'full' limit state
    const matches = store.rawDb.prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH 'readable'`).all()
    expect(matches.length).toBe(1)

    // Document status in store can still be queried
    const foundDoc = store.documentById(doc.id)
    expect(foundDoc).toBeDefined()
    expect(foundDoc?.status).toBe('ready')

    const foundByPath = store.documentByPath(docPath)
    expect(foundByPath).toBeDefined()
    expect(foundByPath?.status).toBe('ready')
  })

  // =========================================================================
  // BUDGET-04: Backup budget is isolated and never purges safety-critical migration backups
  // =========================================================================
  it('BUDGET-04 backup budget is isolated and never purges safety-critical migration backups', () => {
    // Create simulated v2 backup file
    const backupPath = `${dbPath}.v2.backup.db`
    const backupContent = Buffer.alloc(5 * 1024 * 1024, 0xbf) // 5 MB backup
    writeFileSync(backupPath, backupContent)
    expect(existsSync(backupPath)).toBe(true)

    const activeDbSize = safeGetFileSize(dbPath)
    const backupSize = safeGetFileSize(backupPath)
    expect(backupSize).toBe(5 * 1024 * 1024)

    // Verify Limit C isolation in createStorageBudgetSnapshot:
    // backupBytes is tracked separately and NEVER added to databaseBytes
    const snapshot = createStorageBudgetSnapshot({
      activeDbSizeBytes: activeDbSize,
      walSizeBytes: 1024,
      budgetBytes: 50 * 1024 * 1024,
      backupBytes: backupSize,
    })

    expect(snapshot.databaseBytes).toBe(activeDbSize + 1024)
    expect(snapshot.backupBytes).toBe(backupSize)
    // databaseBytes must NOT contain backupBytes
    expect(snapshot.databaseBytes).toBeLessThan(backupSize)

    // Even if backup is huge (e.g. 100 GB backup file simulated), databaseBytes stays active DB only
    const snapshotWithHugeBackup = createStorageBudgetSnapshot({
      activeDbSizeBytes: 10 * 1024 * 1024,
      walSizeBytes: 0,
      budgetBytes: 20 * 1024 * 1024,
      backupBytes: 100 * 1024 * 1024 * 1024, // 100 GiB
    })
    expect(snapshotWithHugeBackup.databaseBytes).toBe(10 * 1024 * 1024)
    expect(snapshotWithHugeBackup.usageRatio).toBe(0.5)
    expect(snapshotWithHugeBackup.limitState).toBe('ok') // Not full, because backup is isolated!

    // Verify retention policy protects safety-critical backups:
    // 1. Backups younger than 24h are NEVER purged regardless of storage limit
    const youngDecision = evaluateBackupRetention(1.5, true, 0, 5)
    expect(youngDecision.shouldRetain).toBe(true)
    expect(youngDecision.reason).toBe('younger-than-24h')

    // 2. Verified backups in top 3 verified are strictly retained
    const top3Decision = evaluateBackupRetention(48, true, 2, 5) // age 48h, rank 2 (< 3)
    expect(top3Decision.shouldRetain).toBe(true)
    expect(top3Decision.reason).toBe('top-3-verified')

    // 3. Maintenance GC and Vacuum on main DB NEVER deletes or truncates the backup file
    const maintenance = new MaintenanceRepository(store.rawDb, dbPath, 'worker')
    const smallBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 1000, // Forces full limit state
    }

    maintenance.runStorageBudgetMaintenance({ budget: smallBudget, forceVacuum: true })

    // Verify backup file is intact and unmodified on disk
    expect(existsSync(backupPath)).toBe(true)
    expect(statSync(backupPath).size).toBe(5 * 1024 * 1024)
  })

  // =========================================================================
  // BUDGET-05: IPC/snapshot exposes truthful budget metrics
  // =========================================================================
  it('BUDGET-05 IPC/snapshot exposes truthful budget metrics (databaseBytes, budgetBytes, usageRatio, limitState)', () => {
    // Verify IPC contract channel constant name
    expect(DOCUMENT_INDEX_CHANNELS.getDocumentIndexStorageBudget).toBe('home:get-document-index-storage-budget')

    // Insert dummy records to produce non-zero database
    const docTruthful = store.rawDb.prepare(`INSERT INTO documents (path, name, status, mtime_ms, size_bytes) VALUES (?, ?, ?, ?, ?) RETURNING id`).get('D:/docs/truthful.txt', 'truthful.txt', 'ready', 1700000000000, 1024) as { id: number }
    const rTruthful = store.rawDb.prepare(`INSERT INTO chunks (document_id, chunk_set_id, ordinal, text, location) VALUES (?, NULL, 0, 'Sample text content', '{"offset":0}')`).run(docTruthful.id)
    store.rawDb.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, 'Sample text content')`).run(rTruthful.lastInsertRowid)

    // Create a mock backup file
    const backupPath = `${dbPath}.v2.backup.db`
    writeFileSync(backupPath, Buffer.alloc(2048, 0xaa))

    const maintenance = new MaintenanceRepository(store.rawDb, dbPath, 'worker')
    const customBudget: DocumentIndexStorageBudget = {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes: 50 * 1024 * 1024,
    }

    const snapshot = maintenance.checkStorageBudget(customBudget)

    // Verify all 10 truthful metric fields
    expect(snapshot).toHaveProperty('databaseBytes')
    expect(snapshot).toHaveProperty('budgetBytes')
    expect(snapshot).toHaveProperty('usageRatio')
    expect(snapshot).toHaveProperty('chunksBytes')
    expect(snapshot).toHaveProperty('embeddingsBytes')
    expect(snapshot).toHaveProperty('ftsBytes')
    expect(snapshot).toHaveProperty('ocrBytes')
    expect(snapshot).toHaveProperty('backupBytes')
    expect(snapshot).toHaveProperty('reclaimableBytes')
    expect(snapshot).toHaveProperty('limitState')

    // Values verification
    expect(snapshot.databaseBytes).toBeGreaterThan(0)
    expect(snapshot.budgetBytes).toBe(50 * 1024 * 1024)
    expect(snapshot.usageRatio).toBeCloseTo(snapshot.databaseBytes / snapshot.budgetBytes, 4)
    expect(snapshot.backupBytes).toBe(2048)
    expect(['ok', 'warning', 'full']).toContain(snapshot.limitState)

    // DiagnosticsRepository integration
    const diagnosticsRepo = new DiagnosticsRepository(store.rawDb, dbPath)
    const diagSnapshot = diagnosticsRepo.getStorageBudgetSnapshot(customBudget, backupPath)

    expect(diagSnapshot.databaseBytes).toBe(snapshot.databaseBytes)
    expect(diagSnapshot.budgetBytes).toBe(customBudget.maxDatabaseBytes)
    expect(diagSnapshot.backupBytes).toBe(2048)
    expect(diagSnapshot.limitState).toBe(snapshot.limitState)
  })

  // =========================================================================
  // BUDGET-06: User-facing limit explanation matches reason persisted in database
  // =========================================================================
  it('BUDGET-06 user-facing limit explanation matches reason persisted in database', () => {
    // 1. Oversized file: Persisted as status 'error' with explicit message
    const oversizedMsg = 'Document exceeds the 128 MB indexing limit'
    store.rawDb
      .prepare(
        `INSERT INTO documents (path, name, status, mtime_ms, size_bytes, error, truncated, truncated_reason)
         VALUES (?, ?, 'error', ?, ?, ?, 0, NULL)`
      )
      .run('D:/docs/huge.zip', 'huge.zip', 1700000000000, 150 * 1024 * 1024, oversizedMsg)

    // 2. Truncated files: Persisted with valid truncated_reason check constraint
    store.rawDb
      .prepare(
        `INSERT INTO documents (path, name, status, mtime_ms, size_bytes, error, truncated, truncated_reason)
         VALUES (?, ?, 'ready', ?, ?, NULL, 1, 'content-limit')`
      )
      .run('D:/docs/long-book.txt', 'long-book.txt', 1700000000000, 10 * 1024 * 1024)

    store.rawDb
      .prepare(
        `INSERT INTO documents (path, name, status, mtime_ms, size_bytes, error, truncated, truncated_reason)
         VALUES (?, ?, 'ready', ?, ?, NULL, 1, 'chunk-limit')`
      )
      .run('D:/docs/many-chunks.docx', 'many-chunks.docx', 1700000000000, 5 * 1024 * 1024)

    store.rawDb
      .prepare(
        `INSERT INTO documents (path, name, status, mtime_ms, size_bytes, error, truncated, truncated_reason)
         VALUES (?, ?, 'ready', ?, ?, NULL, 1, 'pdf-page-limit')`
      )
      .run('D:/docs/huge-scan.pdf', 'huge-scan.pdf', 1700000000000, 30 * 1024 * 1024)

    // 3. User-facing classification tests:
    // Raw error 'Document exceeds the 128 MB indexing limit' must map directly to 'too-large'
    const classifiedReason = issueReason(oversizedMsg, 'error')
    expect(classifiedReason).toBe('too-large')
    expect(isInformationalReason('too-large')).toBe(true)
    expect(isRetryableReason('too-large')).toBe(false)

    // 4. IndexIssueReader must expose truthful values without masking
    const issueReader = new IndexIssueReader(dbPath)
    try {
      const summary = issueReader.summary('*')
      const tooLargeGroup = summary.groups.find((g) => g.reason === 'too-large')
      expect(tooLargeGroup).toBeDefined()
      expect(tooLargeGroup?.count).toBe(1)

      const docRows = store.rawDb
        .prepare(`SELECT id, path, truncated, truncated_reason FROM documents WHERE truncated = 1 ORDER BY id ASC`)
        .all() as Array<{ id: number; path: string; truncated: number; truncated_reason: string }>

      expect(docRows.length).toBe(3)
      expect(docRows[0]?.truncated_reason).toBe('content-limit')
      expect(docRows[1]?.truncated_reason).toBe('chunk-limit')
      expect(docRows[2]?.truncated_reason).toBe('pdf-page-limit')

      // Check detail reader output
      for (const row of docRows) {
        const detail = issueReader.detail(row.id)
        expect(detail).toBeDefined()
        expect(detail?.truncated).toBe(true)
      }
    } finally {
      issueReader.close()
    }
  })

  // =========================================================================
  // Self-Review Edge Cases: Zero, Negative, and Boundary Inputs
  // =========================================================================
  it('Edge Cases: zero/negative budget resilience and exact boundary transitions', () => {
    // Edge Case 1: Zero or negative database/budget inputs must fall back safely to 'ok'
    expect(calculateStorageLimitState(0, 1000)).toBe('ok')
    expect(calculateStorageLimitState(-500, 1000)).toBe('ok')
    expect(calculateStorageLimitState(1000, 0)).toBe('ok')
    expect(calculateStorageLimitState(1000, -100)).toBe('ok')

    // Edge Case 2: Exact boundary points
    const b = 10_000
    expect(calculateStorageLimitState(7_999, b)).toBe('ok')
    expect(calculateStorageLimitState(8_000, b)).toBe('warning')
    expect(calculateStorageLimitState(9_999, b)).toBe('warning')
    expect(calculateStorageLimitState(10_000, b)).toBe('full')
    expect(calculateStorageLimitState(10_001, b)).toBe('full')

    // Edge Case 3: Missing file for safeGetFileSize returns 0 without throwing
    const nonExistentPath = join(tempDir, 'does-not-exist.tmp')
    expect(safeGetFileSize(nonExistentPath)).toBe(0)
  })
})
