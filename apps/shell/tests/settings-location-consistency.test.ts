import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock external/worker dependencies for isolated shell runtime tests
vi.mock('@genoffice/file-parse', () => ({}))
vi.mock('onnxruntime-node', () => ({ InferenceSession: {} }))
vi.mock('@huggingface/tokenizers', () => ({}))
vi.mock('usearch', () => ({}))
vi.mock('@genoffice/agent-core', () => ({}))
vi.mock('@genoffice/ai-provider', () => ({}))
vi.mock('@genoffice/ai-provider/agy-ocr', () => ({}))

import {
  EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
} from '../src/main/document-memory/embedding-profiles'
import {
  EMBEDDING_SETTINGS_FILENAME,
  writeActiveEmbeddingConfig,
} from '../src/main/document-memory/storage/embedding-settings'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'

function floatBlob(floats: number[]): Uint8Array {
  const f32 = new Float32Array(floats)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

function setupV2DatabaseFixture(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      mtime_ms REAL,
      size_bytes INTEGER,
      hash TEXT,
      embedding_model TEXT,
      active_chunk_set_id INTEGER,
      error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER NOT NULL DEFAULT 0,
      priority_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      chunk_total INTEGER NOT NULL DEFAULT 0,
      chunk_done INTEGER NOT NULL DEFAULT 0,
      chunk_counted INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE embedding_spaces (
      id TEXT PRIMARY KEY,
      model_repo TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      pooling TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      quantization TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE chunk_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunker_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_set_id INTEGER REFERENCES chunk_sets(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      normalized TEXT NOT NULL,
      location TEXT NOT NULL,
      vector BLOB,
      vector_dim INTEGER
    );

    CREATE TABLE chunk_embeddings (
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      vector_dim INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (chunk_id, space_id)
    );
  `)

  // Register both spaces in V2 catalog
  const insertSpace = db.prepare(`
    INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insertSpace.run(
    EMBEDDING_PROFILES.standard.embeddingId,
    EMBEDDING_PROFILES.standard.repo,
    EMBEDDING_PROFILES.standard.revision,
    EMBEDDING_PROFILES.standard.pooling,
    EMBEDDING_PROFILES.standard.dimensions,
    'q8',
  )
  insertSpace.run(
    EMBEDDING_PROFILES.high.embeddingId,
    EMBEDDING_PROFILES.high.repo,
    EMBEDDING_PROFILES.high.revision,
    EMBEDDING_PROFILES.high.pooling,
    EMBEDDING_PROFILES.high.dimensions,
    'q8',
  )

  // Document 1
  db.prepare(
    `
    INSERT INTO documents (id, path, name, status, last_opened_at, active_chunk_set_id, embedding_model, chunk_total, chunk_done)
    VALUES (1, 'D:/test-docs/financial-report.docx', 'financial-report.docx', 'ready', 1700000000, 1, ?, 1, 1)
  `,
  ).run(EMBEDDING_PROFILES.standard.embeddingId)

  db.prepare(
    `
    INSERT INTO chunk_sets (id, document_id, chunker_version, state)
    VALUES (1, 1, 1, 'active')
  `,
  ).run()

  db.prepare(
    `
    INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location)
    VALUES (101, 1, 1, 0, 'Quarterly financial report summary passage', 'quarterly financial report summary passage', 'page 1')
  `,
  ).run()

  const standardVec = floatBlob(new Array(320).fill(0.123))
  const highVec = floatBlob(new Array(512).fill(0.456))

  const insertChunkEmbedding = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
    VALUES (?, ?, ?, ?)
  `)
  insertChunkEmbedding.run(101, EMBEDDING_PROFILES.standard.embeddingId, standardVec, 320)
  insertChunkEmbedding.run(101, EMBEDDING_PROFILES.high.embeddingId, highVec, 512)

  db.close()
}

function getDatabaseTargetSpace(dbPath: string): {
  embeddingModel: string | null
  chunkEmbeddingSpace: string | null
  countsSpace: string | null
} {
  const db = new DatabaseSync(dbPath)
  try {
    const docRow = db.prepare('SELECT embedding_model FROM documents WHERE id = 1').get() as any
    const chunkRow = db.prepare('SELECT space_id FROM chunk_embeddings LIMIT 1').get() as any
    const countRow = db
      .prepare('SELECT space_id FROM document_embedding_counts LIMIT 1')
      .get() as any
    return {
      embeddingModel: docRow?.embedding_model ?? null,
      chunkEmbeddingSpace: chunkRow?.space_id ?? null,
      countsSpace: countRow?.space_id ?? null,
    }
  } finally {
    db.close()
  }
}

describe('Settings Location Consistency Test Suite (QA-SETTINGS)', () => {
  let rootDir: string
  let settingsDir: string
  let dbDir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'genoffice-qa-setloc-'))
    // Explicitly isolated directories imitating separate mounts:
    // settings: C:\profile\GenOffice
    // database: D:\SearchIndex
    settingsDir = join(rootDir, 'profile', 'GenOffice')
    dbDir = join(rootDir, 'SearchIndex')
    mkdirSync(settingsDir, { recursive: true })
    mkdirSync(dbDir, { recursive: true })
    managers = []
  })

  afterEach(() => {
    for (const m of managers) {
      try {
        m.close()
      } catch {
        // ignore errors during teardown
      }
    }
    rmSync(rootDir, { recursive: true, force: true })
  })

  function createManager(
    optionsUserDataDir = settingsDir,
    optionsDbDir = dbDir,
  ): DocumentMemoryManager {
    const m = new DocumentMemoryManager(optionsUserDataDir, {
      dbDir: optionsDbDir,
      initialEnabled: false,
    })
    managers.push(m)
    return m
  }

  it('SETLOC-01 High in userData + DB custom dir → bootstrap target High', async () => {
    // 1. userData contains High profile configuration
    writeActiveEmbeddingConfig(settingsDir, 'high')

    // 2. Custom database directory contains V2 database
    const dbPath = join(dbDir, 'document-memory.db')
    setupV2DatabaseFixture(dbPath)

    // 3. Storage bootstrap with separated settingsDir and dbDir
    const bootstrapResult = await ensureDocumentMemoryStorageReady(dbDir, {
      settingsDir,
    })

    expect(bootstrapResult.ready).toBe(true)
    expect(bootstrapResult.migrated).toBe(true)

    // 4. Verify migrated V3 database targeted the High embedding space
    const target = getDatabaseTargetSpace(dbPath)
    expect(target.embeddingModel).toBe(EMBEDDING_PROFILES.high.embeddingId)
    expect(target.chunkEmbeddingSpace).toBe(EMBEDDING_PROFILES.high.embeddingId)
    expect(target.countsSpace).toBe(EMBEDDING_PROFILES.high.embeddingId)
  })

  it('SETLOC-02 same boot → Manager current profile High', async () => {
    // 1. Same boot scenario: userData contains High profile configuration
    writeActiveEmbeddingConfig(settingsDir, 'high')

    // 2. Custom database directory contains V2 database
    const dbPath = join(dbDir, 'document-memory.db')
    setupV2DatabaseFixture(dbPath)

    // 3. Bootstrap executed
    const bootstrapResult = await ensureDocumentMemoryStorageReady(dbDir, {
      settingsDir,
    })
    expect(bootstrapResult.ready).toBe(true)

    // 4. Manager instance started with same userDataDir and custom dbDir
    const mgr = createManager()
    expect(mgr.embeddingSettings().profile).toBe('high')
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.high.embeddingId,
    )
  })

  it('SETLOC-03 Standard → bootstrap + manager both Standard', async () => {
    // 1. userData contains Standard profile configuration
    writeActiveEmbeddingConfig(settingsDir, 'standard')

    // 2. Custom database directory contains V2 database
    const dbPath = join(dbDir, 'document-memory.db')
    setupV2DatabaseFixture(dbPath)

    // 3. Storage bootstrap
    const bootstrapResult = await ensureDocumentMemoryStorageReady(dbDir, {
      settingsDir,
    })
    expect(bootstrapResult.ready).toBe(true)
    expect(bootstrapResult.migrated).toBe(true)

    // 4. Verify bootstrap migrated to Standard embedding space
    const target = getDatabaseTargetSpace(dbPath)
    expect(target.embeddingModel).toBe(EMBEDDING_PROFILES.standard.embeddingId)
    expect(target.chunkEmbeddingSpace).toBe(EMBEDDING_PROFILES.standard.embeddingId)
    expect(target.countsSpace).toBe(EMBEDDING_PROFILES.standard.embeddingId)

    // 5. Manager instance also resolves to Standard
    const mgr = createManager()
    expect(mgr.embeddingSettings().profile).toBe('standard')
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.standard.embeddingId,
    )
  })

  it('SETLOC-04 no profile → both same default', async () => {
    // 1. userData has no profile setting file at all
    // 2. Custom database directory contains V2 database
    const dbPath = join(dbDir, 'document-memory.db')
    setupV2DatabaseFixture(dbPath)

    // 3. Storage bootstrap with missing profile file
    const bootstrapResult = await ensureDocumentMemoryStorageReady(dbDir, {
      settingsDir,
    })
    expect(bootstrapResult.ready).toBe(true)
    expect(bootstrapResult.migrated).toBe(true)

    // 4. Both should fallback to DEFAULT_EMBEDDING_PROFILE (standard)
    const target = getDatabaseTargetSpace(dbPath)
    expect(target.embeddingModel).toBe(EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE].embeddingId)
    expect(target.chunkEmbeddingSpace).toBe(
      EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE].embeddingId,
    )
    expect(target.countsSpace).toBe(EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE].embeddingId)

    // 5. Manager instance also defaults to standard
    const mgr = createManager()
    expect(mgr.embeddingSettings().profile).toBe(DEFAULT_EMBEDDING_PROFILE)
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE].embeddingId,
    )
  })

  it('SETLOC-05 custom DB parent contains conflicting file → MUST NOT override userData setting', async () => {
    // 1. userData contains High profile configuration
    writeActiveEmbeddingConfig(settingsDir, 'high')

    // 2. Custom DB is nested in a parent directory that contains a conflicting settings file (standard)
    const dbParentDir = join(rootDir, 'ExternalMount')
    const nestedDbDir = join(dbParentDir, 'SearchIndex')
    mkdirSync(nestedDbDir, { recursive: true })

    // Conflicting file placed in DB parent directory
    const conflictingFilePath = join(dbParentDir, EMBEDDING_SETTINGS_FILENAME)
    writeFileSync(conflictingFilePath, JSON.stringify({ profile: 'standard' }, null, 2), 'utf8')

    // Setup V2 database inside nestedDbDir
    const dbPath = join(nestedDbDir, 'document-memory.db')
    setupV2DatabaseFixture(dbPath)

    // 3. Storage bootstrap must prioritize settingsDir over any parent dir of dbDir
    const bootstrapResult = await ensureDocumentMemoryStorageReady(nestedDbDir, {
      settingsDir,
    })
    expect(bootstrapResult.ready).toBe(true)
    expect(bootstrapResult.migrated).toBe(true)

    // 4. Conflicting parent file MUST NOT override userData setting: DB target remains High
    const target = getDatabaseTargetSpace(dbPath)
    expect(target.embeddingModel).toBe(EMBEDDING_PROFILES.high.embeddingId)
    expect(target.chunkEmbeddingSpace).toBe(EMBEDDING_PROFILES.high.embeddingId)
    expect(target.countsSpace).toBe(EMBEDDING_PROFILES.high.embeddingId)

    // 5. Manager instance also MUST NOT be overridden by DB parent file: Manager remains High
    const mgr = createManager(settingsDir, nestedDbDir)
    expect(mgr.embeddingSettings().profile).toBe('high')
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.high.embeddingId,
    )
  })
})
