import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DiagnosticsRepository } from '../src/main/document-memory/storage/repositories/diagnostics-repository'
import {
  inspectDatabaseVersion,
  inspectPhysicalStorageState,
} from '../src/main/document-memory/storage/schema-inspector'
import {
  getDocumentIndexDiagnostics,
  diagnosticsCache,
  type SnapshotContext,
} from '../src/main/fork/document-index-snapshot-service'
import type { DocumentIndexStorageDiagnostics } from '../src/shared/fork/document-index-api'

describe('Pair 11 — Truthful Storage Diagnostics Reporting Suite (QA-11)', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-qa11-diag-'))
    dbPath = join(directory, 'document-memory.db')
    diagnosticsCache.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    diagnosticsCache.clear()
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  // =========================================================================
  // DIAG-01 fresh V3 → schema 3
  // =========================================================================
  it('DIAG-01 fresh V3 → schema 3', () => {
    const store = new DocumentMemoryStore(dbPath)
    try {
      const diagnostics = store.getStorageDiagnostics()
      expect(diagnostics).toBeDefined()
      expect(diagnostics.schemaVersion).toBe('3')
      expect(diagnostics.migrationStatus).toBe('completed')

      // Physical state inspection verifies Canonical V3 layout
      const physicalState = inspectPhysicalStorageState(dbPath)
      expect(physicalState).toBe('v3')

      // Storage version report verifies V3 conformity
      const report = inspectDatabaseVersion(dbPath)
      expect(report.isV3).toBe(true)
      expect(report.state).toBe('v3')
      expect(report.schemaState).toBe('v3')
      expect(report.needsMigration).toBe(false)
      expect(report.hasObsoleteChunkColumns).toBe(false)
      expect(report.hasDocumentEmbeddingCounts).toBe(true)
    } finally {
      store.close()
    }
  })

  // =========================================================================
  // DIAG-02 V2 chunks.vector present → not V3
  // =========================================================================
  it('DIAG-02 V2 chunks.vector present → not V3', () => {
    const v2Db = new DatabaseSync(dbPath)
    v2Db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE chunk_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        chunker_version INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        chunk_set_id INTEGER REFERENCES chunk_sets(id),
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        normalized TEXT NOT NULL,
        location TEXT NOT NULL,
        vector BLOB,
        vector_dim INTEGER
      );
    `)

    try {
      // Physical inspection must detect obsolete vector layout and reject V3
      const physicalState = inspectPhysicalStorageState(v2Db, dbPath)
      expect(physicalState).not.toBe('v3')
      expect(physicalState).toBe('v2')

      const diagRepo = new DiagnosticsRepository(v2Db, dbPath)
      expect(diagRepo.getSchemaPhysicalState()).toBe('v2')

      const diagnostics = diagRepo.getStorageDiagnostics()
      expect(diagnostics.schemaVersion).not.toBe('3')
      expect(diagnostics.schemaVersion).toBe('v2')
      expect(diagnostics.migrationStatus).not.toBe('completed')
      expect(diagnostics.migrationStatus).toBe('none')

      const report = inspectDatabaseVersion(dbPath)
      expect(report.isV3).toBe(false)
      expect(report.needsMigration).toBe(true)
      expect(report.hasObsoleteChunkColumns).toBe(true)
    } finally {
      v2Db.close()
    }
  })

  // =========================================================================
  // DIAG-03 missing schema marker → not completed
  // =========================================================================
  it('DIAG-03 missing schema marker → not completed', () => {
    // 3a. Database has documents and chunks but lacks document_memory_meta marker and embedding tables
    const unmarkedDb = new DatabaseSync(dbPath)
    unmarkedDb.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        location TEXT NOT NULL
      );
    `)

    try {
      const physicalState = inspectPhysicalStorageState(unmarkedDb, dbPath)
      expect(physicalState).not.toBe('v3')

      const diagRepo = new DiagnosticsRepository(unmarkedDb, dbPath)
      const diagnostics = diagRepo.getStorageDiagnostics()

      // Invariant: Missing schema marker MUST NEVER report completed or schema '3'
      expect(diagnostics.migrationStatus).not.toBe('completed')
      expect(diagnostics.schemaVersion).not.toBe('3')

      const report = inspectDatabaseVersion(dbPath)
      expect(report.isV3).toBe(false)
      expect(report.needsMigration).toBe(true)
    } finally {
      unmarkedDb.close()
    }

    // 3b. Completely empty database without any tables or schema marker
    const emptyDbPath = join(directory, 'empty-database.db')
    const emptyDb = new DatabaseSync(emptyDbPath)
    try {
      const emptyState = inspectPhysicalStorageState(emptyDb, emptyDbPath)
      expect(emptyState).toBe('unknown')

      const emptyDiagRepo = new DiagnosticsRepository(emptyDb, emptyDbPath)
      const emptyDiag = emptyDiagRepo.getStorageDiagnostics()
      expect(emptyDiag.migrationStatus).not.toBe('completed')
      expect(emptyDiag.migrationStatus).toBe('none')
      expect(emptyDiag.schemaVersion).not.toBe('3')
      expect(emptyDiag.schemaVersion).toBe('unknown')
    } finally {
      emptyDb.close()
    }
  })

  // =========================================================================
  // DIAG-04 corrupt schema → not completed
  // =========================================================================
  it('DIAG-04 corrupt schema → not completed', () => {
    // 4a. Garbage file that is not a valid SQLite database
    writeFileSync(dbPath, 'INVALID_CORRUPTED_NON_SQLITE_PAYLOAD_GARBAGE_123456')

    const physicalStateGarbage = inspectPhysicalStorageState(dbPath)
    expect(physicalStateGarbage).toBe('corrupt')

    const reportGarbage = inspectDatabaseVersion(dbPath)
    expect(reportGarbage.isV3).toBe(false)
    expect(reportGarbage.state).toBe('corrupt')
    expect(reportGarbage.schemaState).toBe('corrupt')

    // DiagnosticsRepository on corrupt file path reports corrupt and not completed
    const diagRepoGarbage = new DiagnosticsRepository({
      prepare: () => {
        throw new Error('Database disk image is malformed')
      },
    } as any, dbPath)
    const diagGarbage = diagRepoGarbage.getStorageDiagnostics()
    expect(diagGarbage.migrationStatus).not.toBe('completed')
    expect(diagGarbage.migrationStatus).toBe('none')
    expect(diagGarbage.schemaVersion).toBe('corrupt')
    expect(diagGarbage.schemaVersion).not.toBe('3')

    // 4b. Corrupted SQLite header bytes
    rmSync(dbPath, { force: true })
    const validDb = new DatabaseSync(dbPath)
    validDb.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY);')
    validDb.close()

    // Overwrite header page with corrupt bytes
    writeFileSync(dbPath, Buffer.alloc(4096, 0xde))

    const physicalStateCorruptHeader = inspectPhysicalStorageState(dbPath)
    expect(physicalStateCorruptHeader).toBe('corrupt')

    const reportCorrupt = inspectDatabaseVersion(dbPath)
    expect(reportCorrupt.isV3).toBe(false)
    expect(reportCorrupt.state).toBe('corrupt')
    expect(reportCorrupt.needsMigration).toBe(true)
  })

  // =========================================================================
  // DIAG-05 migration manifest active → actual migration state
  // =========================================================================
  it('DIAG-05 migration manifest active → actual migration state', () => {
    // Setup base database
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE documents (id INTEGER PRIMARY KEY);')
    db.close()

    // 5a. Migration manifest active on disk
    const manifestPath = join(directory, 'document-memory.migration-state.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({ phase: 'copying-tables', completed: false }),
      'utf8',
    )

    const physicalState = inspectPhysicalStorageState(dbPath)
    expect(physicalState).toBe('migration-in-progress')

    const dbHandle = new DatabaseSync(dbPath)
    try {
      const diagRepo = new DiagnosticsRepository(dbHandle, dbPath)
      expect(diagRepo.getSchemaPhysicalState()).toBe('migration-in-progress')

      const diagnostics = diagRepo.getStorageDiagnostics()
      // Invariant: Must report truthful migration state, never hardcoded '3' or 'completed'
      expect(diagnostics.schemaVersion).toBe('migration-in-progress')
      expect(diagnostics.schemaVersion).not.toBe('3')
      expect(diagnostics.migrationStatus).toBe('in-progress')
      expect(diagnostics.migrationStatus).not.toBe('completed')
    } finally {
      dbHandle.close()
    }

    const report = inspectDatabaseVersion(dbPath)
    expect(report.isV3).toBe(false)
    expect(report.state).toBe('migration-in-progress')
    expect(report.needsMigration).toBe(true)

    // Remove manifest
    rmSync(manifestPath, { force: true })

    // 5b. In-database migration active (embedding_migrations with pending row)
    const dbActive = new DatabaseSync(dbPath)
    try {
      dbActive.exec(`
        CREATE TABLE embedding_migrations (
          id INTEGER PRIMARY KEY,
          state TEXT NOT NULL
        );
        INSERT INTO embedding_migrations (state) VALUES ('pending');
      `)

      const inDbPhysicalState = inspectPhysicalStorageState(dbActive, dbPath)
      expect(inDbPhysicalState).toBe('migration-in-progress')

      const diagRepoActive = new DiagnosticsRepository(dbActive, dbPath)
      const diagActive = diagRepoActive.getStorageDiagnostics()
      expect(diagActive.schemaVersion).toBe('migration-in-progress')
      expect(diagActive.schemaVersion).not.toBe('3')
      expect(diagActive.migrationStatus).toBe('in-progress')
      expect(diagActive.migrationStatus).not.toBe('completed')
    } finally {
      dbActive.close()
    }
  })

  // =========================================================================
  // DIAG-06 60s cache
  // =========================================================================
  it('DIAG-06 60s cache', async () => {
    vi.useFakeTimers()
    diagnosticsCache.clear()

    const asyncStorageMock = vi.fn().mockResolvedValue({
      activeDbSizeBytes: 1024 * 1024,
      walSizeBytes: 4096,
      pageSize: 4096,
      pageCount: 256,
      freelistCount: 0,
      estimatedReclaimableBytes: 0,
      v2BackupSizeBytes: null,
      schemaVersion: '3',
      migrationStatus: 'completed',
      topOffendersByChunks: [],
      topOffendersBySize: [],
    } satisfies DocumentIndexStorageDiagnostics)

    const mockMemory = {
      getStorageDiagnosticsAsync: asyncStorageMock,
      getMigrationDiagnostics: vi.fn().mockReturnValue({
        activeEmbeddingSpace: 'standard',
        state: 'idle',
        completedChunks: 100,
        totalChunks: 100,
      }),
    }

    const ctx: SnapshotContext = {
      getDocumentMemory: () => mockMemory as any,
      getFolderScan: () => null,
      getIssueReader: () => ({} as any),
      getFolderCounts: () => ({ get: (_root, fetcher) => fetcher() }),
      dbPath: () => dbPath,
    }

    // T = 0s: Initial request queries worker
    const initialResult = await getDocumentIndexDiagnostics(ctx, false)
    expect(initialResult).toBeDefined()
    expect(initialResult.storage.schemaVersion).toBe('3')
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)

    // T = 15s: Within 60s TTL -> cache hit, 0 additional worker calls
    vi.advanceTimersByTime(15_000)
    const cached15s = await getDocumentIndexDiagnostics(ctx, false)
    expect(cached15s).toBe(initialResult)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)

    // T = 45s: Within 60s TTL -> cache hit, 0 additional worker calls
    vi.advanceTimersByTime(30_000)
    const cached45s = await getDocumentIndexDiagnostics(ctx, false)
    expect(cached45s).toBe(initialResult)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)

    // T = 59s: Still within 60s TTL -> cache hit, 0 additional worker calls
    vi.advanceTimersByTime(14_000)
    const cached59s = await getDocumentIndexDiagnostics(ctx, false)
    expect(cached59s).toBe(initialResult)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)

    // T = 61s: Past 60s TTL -> cache expired, fresh query invoked
    vi.advanceTimersByTime(2_000)
    const refreshedResult = await getDocumentIndexDiagnostics(ctx, false)
    expect(refreshedResult).toBeDefined()
    expect(refreshedResult.storage.schemaVersion).toBe('3')
    expect(asyncStorageMock).toHaveBeenCalledTimes(2)
  })

  // =========================================================================
  // DIAG-07 cache miss invokes worker once
  // =========================================================================
  it('DIAG-07 cache miss invokes worker once', async () => {
    diagnosticsCache.clear()

    const asyncStorageMock = vi.fn().mockResolvedValue({
      activeDbSizeBytes: 2048 * 1024,
      walSizeBytes: 0,
      pageSize: 4096,
      pageCount: 512,
      freelistCount: 0,
      estimatedReclaimableBytes: 0,
      v2BackupSizeBytes: null,
      schemaVersion: '3',
      migrationStatus: 'completed',
      topOffendersByChunks: [],
      topOffendersBySize: [],
    } satisfies DocumentIndexStorageDiagnostics)

    const mockMemory = {
      getStorageDiagnosticsAsync: asyncStorageMock,
      getMigrationDiagnostics: vi.fn().mockReturnValue({
        activeEmbeddingSpace: 'standard',
        state: 'idle',
        completedChunks: 200,
        totalChunks: 200,
      }),
    }

    const ctx: SnapshotContext = {
      getDocumentMemory: () => mockMemory as any,
      getFolderScan: () => null,
      getIssueReader: () => ({} as any),
      getFolderCounts: () => ({ get: (_root, fetcher) => fetcher() }),
      dbPath: () => dbPath,
    }

    // 1. Initial cold cache miss: worker is called exactly once
    expect(diagnosticsCache.get(false)).toBeNull()
    const result1 = await getDocumentIndexDiagnostics(ctx, false)
    expect(result1).toBeDefined()
    expect(result1.storage.schemaVersion).toBe('3')
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)

    // 2. Subsequent call hits cache: 0 additional worker calls
    const resultCached = await getDocumentIndexDiagnostics(ctx, false)
    expect(resultCached).toBe(result1)
    expect(asyncStorageMock).toHaveBeenCalledTimes(1)

    // 3. forceRefresh causes cache bypass: invokes worker exactly once again
    const resultForce = await getDocumentIndexDiagnostics(ctx, true)
    expect(resultForce).toBeDefined()
    expect(asyncStorageMock).toHaveBeenCalledTimes(2)

    // 4. Cache clear causes next call to be a cache miss: invokes worker exactly once again
    diagnosticsCache.clear()
    const resultAfterClear = await getDocumentIndexDiagnostics(ctx, false)
    expect(resultAfterClear).toBeDefined()
    expect(asyncStorageMock).toHaveBeenCalledTimes(3)
  })
})
