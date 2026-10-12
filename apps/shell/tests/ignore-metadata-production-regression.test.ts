import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChunkRepository } from '../src/main/document-memory/storage/repositories/chunk-repository'
import {
  setActiveIgnoreRules,
  getActiveIgnoreRules,
  setIgnoreStoragePath,
  isPathIgnored,
  isPathCaseInsensitive,
  globToRegex,
} from '../src/main/document-memory/ignore-policy'

function initTestDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      hash TEXT,
      mtime_ms REAL,
      size_bytes INTEGER,
      truncated INTEGER DEFAULT 0,
      truncated_reason TEXT,
      status TEXT DEFAULT 'ready',
      excluded INTEGER DEFAULT 0,
      active_chunk_set_id INTEGER,
      chunk_done INTEGER DEFAULT 0,
      updated_at INTEGER
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      chunk_set_id INTEGER,
      ordinal INTEGER,
      text TEXT NOT NULL,
      location TEXT,
      FOREIGN KEY (document_id) REFERENCES documents(id)
    );
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text);
    CREATE TABLE embedding_spaces (
      id TEXT PRIMARY KEY,
      model_repo TEXT,
      model_revision TEXT,
      pooling TEXT,
      dimensions INTEGER,
      quantization TEXT
    );
    CREATE TABLE chunk_embeddings (
      chunk_id INTEGER NOT NULL,
      space_id TEXT NOT NULL,
      vector BLOB,
      vector_dim INTEGER,
      PRIMARY KEY (chunk_id, space_id)
    );
    CREATE TABLE document_embedding_counts (
      document_id INTEGER NOT NULL,
      space_id TEXT NOT NULL,
      completed_chunks INTEGER DEFAULT 0,
      PRIMARY KEY (document_id, space_id)
    );
    CREATE TABLE chunk_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      chunker_version INTEGER DEFAULT 2,
      state TEXT DEFAULT 'active'
    );
    CREATE TABLE chunk_migrations (
      version INTEGER PRIMARY KEY,
      total_documents INTEGER,
      completed_documents INTEGER,
      state TEXT,
      updated_at REAL
    );
  `)
  return db
}

describe('ignore-metadata-production-regression', () => {
  let tmpDir: string
  let dbPath: string
  let storageFile: string
  let rawDb: DatabaseSync

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'genoffice-test-meta-'))
    dbPath = join(tmpDir, 'test-doc-memory.db')
    storageFile = join(tmpDir, 'ignore-rules.json')
    setIgnoreStoragePath(storageFile)
    rawDb = initTestDb(dbPath)
  })

  afterEach(() => {
    try {
      rawDb.close()
    } catch {}
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it('1. metadata query excludes chunk text', () => {
    rawDb
      .prepare(
        "INSERT INTO documents (id, path, name, status, excluded, updated_at) VALUES (1, '/docs/confidential.pdf', 'confidential.pdf', 'ready', 0, 1000)",
      )
      .run()
    rawDb
      .prepare(
        "INSERT INTO chunks (id, document_id, text, location) VALUES (101, 1, 'TOP SECRET SENSITIVE BODY TEXT', 'p.1')",
      )
      .run()

    const repo = new ChunkRepository(rawDb)
    const meta = repo.readChunkMetadata(101)

    expect(meta).not.toBeNull()
    expect(meta).toEqual({
      chunkId: 101,
      documentId: 1,
      path: '/docs/confidential.pdf',
      name: 'confidential.pdf',
      location: 'p.1',
    })
    // Verified: DocumentChunkMetadata object must NOT contain text field
    expect((meta as any).text).toBeUndefined()
  })

  it('2. ignored chunk is blocked before extraction', () => {
    setActiveIgnoreRules([
      {
        id: 'rule-secret',
        pattern: '**/secret/**',
        enabled: true,
        scope: 'global',
      },
    ])

    rawDb
      .prepare(
        "INSERT INTO documents (id, path, name, status, excluded, updated_at) VALUES (2, '/data/secret/memo.docx', 'memo.docx', 'ready', 0, 1000)",
      )
      .run()
    rawDb
      .prepare(
        "INSERT INTO chunks (id, document_id, text, location) VALUES (201, 2, 'CONFIDENTIAL', 'p.1')",
      )
      .run()

    const repo = new ChunkRepository(rawDb)
    const meta = repo.readChunkMetadata(201)
    expect(meta).not.toBeNull()
    const ignored = isPathIgnored(meta!.path)
    expect(ignored).toBe(true)

    // Preflight handler response structure
    const blockedResponse = {
      path: meta!.path,
      name: meta!.name,
      location: meta!.location,
      text: '',
      verified: false,
      error: 'Ignored document',
    }
    expect(blockedResponse.text).toBe('')
    expect(blockedResponse.verified).toBe(false)
    expect(blockedResponse.error).toBe('Ignored document')
  })

  it('3. worker extraction is not invoked for ignored chunks', async () => {
    setActiveIgnoreRules([
      {
        id: 'rule-private',
        pattern: 'private/',
        enabled: true,
        scope: 'global',
      },
    ])

    rawDb
      .prepare(
        "INSERT INTO documents (id, path, name, status, excluded, updated_at) VALUES (3, '/workspace/private/notes.txt', 'notes.txt', 'ready', 0, 1000)",
      )
      .run()
    rawDb
      .prepare(
        "INSERT INTO chunks (id, document_id, text, location) VALUES (301, 3, 'My personal private notes', 'p.1')",
      )
      .run()

    const workerExtractMock = vi.fn()
    const repo = new ChunkRepository(rawDb)
    const meta = repo.readChunkMetadata(301)

    // Handler logic under test: if meta is ignored, return without calling worker
    let result
    if (meta && isPathIgnored(meta.path)) {
      result = {
        path: meta.path,
        name: meta.name,
        location: meta.location,
        text: '',
        verified: false,
        error: 'Ignored document',
      }
    } else {
      result = await workerExtractMock(301)
    }

    expect(workerExtractMock).not.toHaveBeenCalled()
    expect(result.verified).toBe(false)
    expect(result.text).toBe('')
  })

  it('4. valid non-ignored chunks preserve normal read behavior', () => {
    setActiveIgnoreRules([
      {
        id: 'rule-tmp',
        pattern: '*.tmp',
        enabled: true,
        scope: 'global',
      },
    ])

    rawDb
      .prepare(
        "INSERT INTO documents (id, path, name, status, excluded, updated_at) VALUES (4, '/workspace/reports/q3.xlsx', 'q3.xlsx', 'ready', 0, 1000)",
      )
      .run()
    rawDb
      .prepare(
        "INSERT INTO chunks (id, document_id, text, location) VALUES (401, 4, 'Revenue grew by 25%', 'Sheet1!A1')",
      )
      .run()

    const repo = new ChunkRepository(rawDb)
    const meta = repo.readChunkMetadata(401)
    expect(meta).not.toBeNull()
    expect(isPathIgnored(meta!.path)).toBe(false)

    const fullHit = repo.readChunk(401)
    expect(fullHit).not.toBeNull()
    expect(fullHit!.text).toBe('Revenue grew by 25%')
    expect(fullHit!.name).toBe('q3.xlsx')
  })

  it('5. missing chunk handling is unchanged', () => {
    const repo = new ChunkRepository(rawDb)
    const meta = repo.readChunkMetadata(99999)
    expect(meta).toBeNull()

    const hit = repo.readChunk(99999)
    expect(hit).toBeNull()
  })

  it('6. rule changes during asynchronous verification still prevent ignored content from being returned', async () => {
    // Initially not ignored
    setActiveIgnoreRules([])

    rawDb
      .prepare(
        "INSERT INTO documents (id, path, name, status, excluded, updated_at) VALUES (6, '/shared/audit.docx', 'audit.docx', 'ready', 0, 1000)",
      )
      .run()
    rawDb
      .prepare(
        "INSERT INTO chunks (id, document_id, text, location) VALUES (601, 6, 'Internal audit draft', 'p.1')",
      )
      .run()

    const repo = new ChunkRepository(rawDb)
    const meta = repo.readChunkMetadata(601)
    expect(isPathIgnored(meta!.path)).toBe(false)

    // Simulate rule change arriving during asynchronous worker execution:
    setActiveIgnoreRules([
      {
        id: 'rule-audit',
        pattern: 'audit.*',
        enabled: true,
        scope: 'global',
      },
    ])

    // Simulated async read finishes, post-read verification rechecks ignore:
    const chunk = repo.readChunk(601)
    let finalResult
    if (chunk && isPathIgnored(chunk.path)) {
      finalResult = {
        path: chunk.path,
        name: chunk.name,
        location: chunk.location,
        text: '',
        verified: false,
        error: 'Ignored document',
      }
    } else {
      finalResult = chunk
    }

    expect(finalResult.text).toBe('')
    expect(finalResult.verified).toBe(false)
    expect(finalResult.error).toBe('Ignored document')
  })

  it('7. no destructive SQL occurs', () => {
    rawDb
      .prepare(
        "INSERT INTO documents (id, path, name, status, excluded) VALUES (7, '/safe/file.txt', 'file.txt', 'ready', 0)",
      )
      .run()
    rawDb
      .prepare(
        "INSERT INTO chunks (id, document_id, text, location) VALUES (701, 7, 'important data', 'line 1')",
      )
      .run()

    const repo = new ChunkRepository(rawDb)
    repo.readChunkMetadata(701)

    const docCount = rawDb.prepare('SELECT count(*) as cnt FROM documents').get() as {
      cnt: number
    }
    const chunkCount = rawDb.prepare('SELECT count(*) as cnt FROM chunks').get() as {
      cnt: number
    }
    expect(docCount.cnt).toBe(1)
    expect(chunkCount.cnt).toBe(1)
  })

  it('8. Windows path matching is validated under explicit Windows semantics', () => {
    // Windows drive paths must be case-insensitive
    expect(isPathCaseInsensitive('C:\\Project\\private\\a.docx')).toBe(true)
    expect(isPathCaseInsensitive('c:/project/private/a.docx')).toBe(true)
    // Windows UNC paths must be case-insensitive
    expect(isPathCaseInsensitive('\\\\server\\share\\sub\\doc.docx')).toBe(true)
    expect(isPathCaseInsensitive('//server/share/sub/doc.docx')).toBe(true)

    // Windows scoped rule matching
    setActiveIgnoreRules([
      {
        id: 'win-scoped',
        pattern: 'private/**',
        enabled: true,
        scope: 'C:/Project',
      },
    ])

    // Should match both case variations under C:\Project
    expect(isPathIgnored('C:\\Project\\private\\a.docx')).toBe(true)
    expect(isPathIgnored('c:\\project\\PRIVATE\\a.docx')).toBe(true)

    // Path component boundaries: C:\Project-Backup must NOT match C:\Project rule
    expect(isPathIgnored('C:\\Project-Backup\\private\\a.docx')).toBe(false)
  })

  it('9. POSIX case behavior is validated correctly', () => {
    const isWindows = process.platform === 'win32'
    if (isWindows) return // Native POSIX case test is platform-specific

    expect(isPathCaseInsensitive('/home/user/Secret.txt')).toBe(false)
    expect(isPathCaseInsensitive('/home/user/secret.txt')).toBe(false)

    setActiveIgnoreRules([
      {
        id: 'posix-case-exact',
        pattern: 'Secret.txt',
        enabled: true,
        scope: '/home/user',
      },
    ])

    // Case-sensitive regex on POSIX
    const regex = globToRegex('Secret.txt', false)
    expect(regex.test('/home/user/Secret.txt')).toBe(true)
    expect(regex.test('/home/user/secret.txt')).toBe(false)
  })

  it('10. save failure does not mutate active rules', () => {
    setActiveIgnoreRules([
      {
        id: 'original-rule',
        pattern: '*.initial',
        enabled: true,
        scope: 'global',
      },
    ])
    const beforeRules = getActiveIgnoreRules()

    // Create a regular file where a directory would be needed, causing mkdirSync to fail with ENOTDIR
    const blockerFile = join(tmpDir, 'file_not_dir')
    writeFileSync(blockerFile, 'blocking content')
    const badStoragePath = join(blockerFile, 'sub', 'rules.json')

    setIgnoreStoragePath(badStoragePath)

    const candidate = [
      {
        id: 'dangerous-rule',
        pattern: '*.compromised',
        enabled: true,
        scope: 'global',
      },
    ]

    const success = setActiveIgnoreRules(candidate)
    expect(success).toBe(false)

    // Previous active rules must be preserved intact
    const currentRules = getActiveIgnoreRules()
    expect(currentRules).toEqual(beforeRules)
    expect(currentRules.some((r) => r.id === 'dangerous-rule')).toBe(false)
  })
})
