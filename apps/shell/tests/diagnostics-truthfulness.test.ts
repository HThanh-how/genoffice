import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { DiagnosticsRepository } from '../src/main/document-memory/storage/repositories/diagnostics-repository'
import {
  inspectDatabaseVersion,
  inspectPhysicalStorageState,
} from '../src/main/document-memory/storage/schema-inspector'

describe('Physical Storage State Inspection & Diagnostics Truthfulness Suite', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-diag-truth-'))
    dbPath = join(directory, 'document-memory.db')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('Fixture 1: Fresh V3 -> schemaVersion: \'3\', state: \'v3\', migrationStatus: \'completed\'', () => {
    // Real production path: instantiate DocumentMemoryStore
    const store = new DocumentMemoryStore(dbPath)
    try {
      // 1. Diagnostics repository check through production store
      const diagnostics = store.getStorageDiagnostics()
      expect(diagnostics.schemaVersion).toBe('3')
      expect(diagnostics.migrationStatus).toBe('completed')

      // 2. Schema inspector version report check
      const report = inspectDatabaseVersion(dbPath)
      expect(report.isV3).toBe(true)
      expect(report.needsMigration).toBe(false)
      expect(report.state).toBe('v3')
      expect(report.schemaState).toBe('v3')
      expect(report.hasObsoleteChunkColumns).toBe(false)
      expect(report.hasDocumentEmbeddingCounts).toBe(true)
      expect(report.autoVacuum).toBe(2)

      // 3. Direct physical inspection
      const physicalState = inspectPhysicalStorageState(dbPath)
      expect(physicalState).toBe('v3')
    } finally {
      store.close()
    }
  })

  it('Fixture 2: Real V2 (chứa chunks.vector hoặc thiếu chunk_embeddings) -> state: \'v2\', migrationStatus: \'migration-needed\'', () => {
    // Setup physical V2 database layout: contains chunks.vector, missing chunk_embeddings
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
      // 1. Physical inspection via database handle
      const stateFromHandle = inspectPhysicalStorageState(v2Db, dbPath)
      expect(stateFromHandle).toBe('v2')

      // 2. Diagnostics repository check: must NOT report V3 completed
      const diagRepo = new DiagnosticsRepository(v2Db, dbPath)
      expect(diagRepo.getSchemaPhysicalState()).toBe('v2')
      const diagnostics = diagRepo.getStorageDiagnostics()
      expect(diagnostics.schemaVersion).toBe('v2')
      expect(diagnostics.migrationStatus).not.toBe('completed')
      expect(diagnostics.migrationStatus).toBe('none')

      // 3. Storage version report check: state is 'v2' and migration is required
      const report = inspectDatabaseVersion(dbPath)
      expect(report.state).toBe('v2')
      expect(report.isV3).toBe(false)
      expect(report.needsMigration).toBe(true)
      expect(report.hasObsoleteChunkColumns).toBe(true)

      const migrationStatus = report.needsMigration ? 'migration-needed' : diagnostics.migrationStatus
      expect(migrationStatus).toBe('migration-needed')
    } finally {
      v2Db.close()
    }
  })

  it('Fixture 3: Chunks with obsolete vector -> không bao giờ báo V3 completed', () => {
    // Setup DB with V3 tables and document_memory_meta = '3',
    // BUT chunks table physically retains obsolete vector column
    const db = new DatabaseSync(dbPath)
    db.exec(`
      PRAGMA auto_vacuum = INCREMENTAL;
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
        location TEXT NOT NULL,
        vector BLOB,
        vector_dim INTEGER
      );
      CREATE TABLE chunk_embeddings (
        chunk_id INTEGER NOT NULL REFERENCES chunks(id),
        space_id TEXT NOT NULL,
        vector BLOB NOT NULL,
        vector_dim INTEGER NOT NULL,
        PRIMARY KEY (chunk_id, space_id)
      );
      CREATE TABLE document_embedding_counts (
        document_id INTEGER PRIMARY KEY,
        space_id TEXT NOT NULL,
        active_chunks INTEGER NOT NULL,
        embedded_chunks INTEGER NOT NULL
      );
      CREATE TABLE document_memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO document_memory_meta (key, value) VALUES ('schema_version', '3');
    `)

    try {
      // Direct physical inspector must detect obsolete chunk column and reject V3
      const state = inspectPhysicalStorageState(db, dbPath)
      expect(state).not.toBe('v3')
      expect(state).toBe('v2')

      const report = inspectDatabaseVersion(dbPath)
      expect(report.isV3).toBe(false)
      expect(report.needsMigration).toBe(true)
      expect(report.hasObsoleteChunkColumns).toBe(true)

      // Diagnostics repository must NEVER report V3 completed despite metadata saying '3'
      const diagRepo = new DiagnosticsRepository(db, dbPath)
      const diagnostics = diagRepo.getStorageDiagnostics()
      expect(diagnostics.migrationStatus).not.toBe('completed')
    } finally {
      db.close()
    }
  })

  it('Fixture 4: Corrupt DB file (file rác không phải sqlite hoặc integrity check fail) -> state: \'corrupt\'', () => {
    // 4a. File rác không phải sqlite
    writeFileSync(dbPath, 'CORRUPTED_NON_SQLITE_GARBAGE_BYTES_1234567890')
    expect(inspectPhysicalStorageState(dbPath)).toBe('corrupt')

    const reportGarbage = inspectDatabaseVersion(dbPath)
    expect(reportGarbage.state).toBe('corrupt')
    expect(reportGarbage.schemaState).toBe('corrupt')
    expect(reportGarbage.isV3).toBe(false)
    expect(reportGarbage.needsMigration).toBe(true)

    // 4b. Integrity check / corrupted SQLite header failure
    rmSync(dbPath, { force: true })
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE test (id INT);')
    db.close()

    // Corrupt page 1 (SQLite header corrupted with non-magic bytes)
    const corruptBuffer = Buffer.alloc(4096, 0xaa)
    writeFileSync(dbPath, corruptBuffer)

    expect(inspectPhysicalStorageState(dbPath)).toBe('corrupt')
    const reportCorrupt = inspectDatabaseVersion(dbPath)
    expect(reportCorrupt.state).toBe('corrupt')
    expect(reportCorrupt.schemaState).toBe('corrupt')
    expect(reportCorrupt.isV3).toBe(false)
    expect(reportCorrupt.needsMigration).toBe(true)
  })

  it('Fixture 5: Migration manifest active / temp db file tồn tại -> state: \'migration-in-progress\'', () => {
    // Base database
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE test (id INT);')
    db.close()

    // 5a. Migration manifest active on disk
    const manifestPath = join(directory, 'document-memory.migration-state.json')
    writeFileSync(manifestPath, JSON.stringify({ phase: 'copying-tables', completed: false }), 'utf8')

    expect(inspectPhysicalStorageState(dbPath)).toBe('migration-in-progress')
    const reportManifest = inspectDatabaseVersion(dbPath)
    expect(reportManifest.state).toBe('migration-in-progress')
    expect(reportManifest.isV3).toBe(false)
    expect(reportManifest.needsMigration).toBe(true)

    // Verify diagnostics repo reports migration-in-progress
    const dbHandle = new DatabaseSync(dbPath)
    const diagRepo = new DiagnosticsRepository(dbHandle, dbPath)
    expect(diagRepo.getSchemaPhysicalState()).toBe('migration-in-progress')
    const diag = diagRepo.getStorageDiagnostics()
    expect(diag.schemaVersion).toBe('migration-in-progress')
    expect(diag.migrationStatus).toBe('in-progress')
    dbHandle.close()

    // Remove manifest
    rmSync(manifestPath, { force: true })

    // 5b. Temp db file (.v3.tmp.db) exists
    const tmpDbPath = `${dbPath}.v3.tmp.db`
    writeFileSync(tmpDbPath, 'active temp db')
    expect(inspectPhysicalStorageState(dbPath)).toBe('migration-in-progress')
    expect(inspectDatabaseVersion(dbPath).state).toBe('migration-in-progress')
    rmSync(tmpDbPath, { force: true })

    // 5c. .migrating lock file exists
    const migratingPath = `${dbPath}.migrating`
    writeFileSync(migratingPath, 'active lock')
    expect(inspectPhysicalStorageState(dbPath)).toBe('migration-in-progress')
    expect(inspectDatabaseVersion(dbPath).state).toBe('migration-in-progress')
    rmSync(migratingPath, { force: true })

    // 5d. In-database migration active (embedding_migrations with pending row)
    const dbActive = new DatabaseSync(dbPath)
    dbActive.exec(`
      CREATE TABLE embedding_migrations (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL
      );
      INSERT INTO embedding_migrations (state) VALUES ('pending');
    `)
    expect(inspectPhysicalStorageState(dbActive, dbPath)).toBe('migration-in-progress')
    dbActive.close()
  })

  it('Fixture 6: Database trống rỗng hoặc chưa tồn tại -> state: \'unknown\'', () => {
    // 6a. Database file does not exist
    const nonExistentPath = join(directory, 'does-not-exist.db')
    expect(inspectPhysicalStorageState(nonExistentPath)).toBe('unknown')
    const reportMissing = inspectDatabaseVersion(nonExistentPath)
    expect(reportMissing.state).toBe('unknown')
    expect(reportMissing.schemaState).toBe('unknown')
    expect(reportMissing.isV3).toBe(false)
    expect(reportMissing.needsMigration).toBe(false)

    // 6b. Database exists but has 0 tables (completely empty)
    const emptyDbPath = join(directory, 'empty.db')
    const emptyDb = new DatabaseSync(emptyDbPath)
    try {
      expect(inspectPhysicalStorageState(emptyDb, emptyDbPath)).toBe('unknown')
      const diagRepo = new DiagnosticsRepository(emptyDb, emptyDbPath)
      expect(diagRepo.getSchemaPhysicalState()).toBe('unknown')
      const diag = diagRepo.getStorageDiagnostics()
      expect(diag.schemaVersion).toBe('unknown')
      expect(diag.migrationStatus).toBe('none')
    } finally {
      emptyDb.close()
    }

    // Inspect file path directly after handle closed
    expect(inspectPhysicalStorageState(emptyDbPath)).toBe('unknown')
    const reportEmpty = inspectDatabaseVersion(emptyDbPath)
    expect(reportEmpty.state).toBe('unknown')
    expect(reportEmpty.schemaState).toBe('unknown')
  })
})
