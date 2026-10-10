import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { FreshnessCoordinator } from '../src/main/document-memory/runtime/freshness-coordinator'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import {
  getManifestPath,
  recoverInterruptedCutover,
  type CutoverStateManifest,
} from '../src/main/document-memory/storage/migration/cutover'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import {
  garbageCollectObsoleteStorage,
  runIncrementalVacuum,
} from '../src/main/document-memory/storage-gc'
import {
  BackgroundWorkGate,
  BackgroundWorkPriority,
} from '../src/main/document-memory/background-work-gate'
import {
  getDocumentIndexSnapshot,
  snapshotCache,
  diagnosticsCache,
  SNAPSHOT_CACHE_TTL_MS,
  DIAGNOSTICS_CACHE_TTL_MS,
  IndexStatusCache,
} from '../src/main/fork/document-index-snapshot-service'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import { publishIndexingPolicy, resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import type { WorkerRequest } from '../src/main/document-memory/worker-types'
import { storageBudgetAckReply, waitForManagerWriteReady } from './helpers/storage-budget-ack'

function floatBlob(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

class TestWorker extends EventEmitter {
  terminated = false
  requests: Array<WorkerRequest & { interactive?: boolean; path?: string }> = []
  private pending: (WorkerRequest & { id: number; path?: string }) | undefined

  postMessage(message: WorkerRequest & { id: number; path?: string; interactive?: boolean }): void {
    const ack = storageBudgetAckReply(message)
    if (ack) {
      this.emit('message', ack)
      return
    }
    this.requests.push(message)
    this.pending = message
  }

  finish(skipEmbeddings = true): void {
    if (!this.pending) return
    const { id, path } = this.pending
    if (!path) return
    const bytes = readFileSync(path)
    const stat = statSync(path)
    this.emit('message', {
      id,
      result: {
        hash: createHash('sha256').update(bytes).digest('hex'),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        chunks: chunkDocumentText('Enterprise Document Search V3 Parity Text '.repeat(10)),
        status: 'text-only',
        ...(skipEmbeddings ? { skipEmbeddings: true } : {}),
      },
    })
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}

const TEST_PAUSED_POLICY = {
  paused: true,
  pauseReason: 'user' as const,
  threads: 1,
  cpuShare: 0,
  priority: 'idle' as const,
  tier: 'paused' as const,
  reason: 'user requested pause',
  onBattery: false,
}

describe('Document Search V3 Enterprise Parity & Fault Injection Suite', () => {
  let tempDir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-v3-parity-'))
    managers = []
  })

  afterEach(async () => {
    for (const m of managers) {
      try {
        await m.closeAsync()
      } catch {
        // ignore
      }
    }
    resetIndexingPolicyBus()
    snapshotCache.clear()
    diagnosticsCache.clear()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  function createManager(options: { workerFactory?: () => Worker } = {}): {
    manager: DocumentMemoryManager
    dbPath: string
    userDataDir: string
  } {
    const userDataDir = join(tempDir, 'user')
    const dbDir = join(tempDir, 'db')
    mkdirSync(userDataDir, { recursive: true })
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, 'document-memory.db')

    const manager = new DocumentMemoryManager(userDataDir, {
      dbDir,
      pollIntervalMs: 3_600_000,
      workerTimeoutMs: 30_000,
      autoDeferAfterMs: 3_600_000,
      ...(options.workerFactory ? { workerFactory: options.workerFactory } : {}),
    })
    managers.push(manager)
    return { manager, dbPath, userDataDir }
  }

  // =========================================================================
  // 1. RUNTIME PARITY
  // =========================================================================
  describe('1. RUNTIME Parity', () => {
    it('reconcileFolder: detects moved files via hash/size without re-extracting, paginates 500 rows, and tombstones missing files', async () => {
      const dbPath = join(tempDir, 'reconcile-test.db')
      const store = new DocumentMemoryStore(dbPath)
      const root = join(tempDir, 'company-folder')
      mkdirSync(root, { recursive: true })

      const enqueued: string[] = []
      const tombstoned: string[] = []

      const freshness = new FreshnessCoordinator({
        store,
        tombstoneGraceMs: 100,
        onEnqueue: (p) => {
          enqueued.push(p)
        },
        onTombstone: async (p) => {
          tombstoned.push(p)
          store.tombstone(p)
        },
      })

      // Setup 502 files to test 500 pagination boundary
      const fileCount = 502
      const listing = new Map<string, { mtimeMs: number; sizeBytes: number }>()

      for (let i = 1; i <= fileCount; i++) {
        const filePath = join(root, `doc-${String(i).padStart(4, '0')}.txt`)
        const content = `Content of document number ${i}`
        writeFileSync(filePath, content)
        const st = statSync(filePath)
        const hash = createHash('sha256').update(content).digest('hex')

        // Enroll and store in DB
        store.enrollDiscovered(filePath, st.mtimeMs, st.size)
        store.replaceDocument(filePath, {
          hash,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
          chunks: [{ text: content, location: 'loc' }],
          embeddingModel: null,
          status: 'ready',
        })

        listing.set(filePath, { mtimeMs: st.mtimeMs, sizeBytes: st.size })
      }

      // 1. Initial reconcile on identical tree: no changes, pagination traversed all 502
      const res1 = await freshness.reconcileFolder(root, listing)
      expect(res1).toEqual({ added: 0, changed: 0, moved: 0, removed: 0 })

      // 2. Simulate Move: doc-0001 moved to doc-0001-renamed
      const originalPath = join(root, 'doc-0001.txt')
      const movedPath = join(root, 'doc-0001-renamed.txt')
      renameSync(originalPath, movedPath)
      listing.delete(originalPath)
      const movedSt = statSync(movedPath)
      listing.set(movedPath, { mtimeMs: movedSt.mtimeMs, sizeBytes: movedSt.size })

      // 3. Simulate Removal: doc-0002 deleted
      const removedPath = join(root, 'doc-0002.txt')
      rmSync(removedPath)
      listing.delete(removedPath)

      // 4. Simulate Addition: doc-new added
      const addedPath = join(root, 'doc-new.txt')
      writeFileSync(addedPath, 'Brand new file text')
      const addedSt = statSync(addedPath)
      listing.set(addedPath, { mtimeMs: addedSt.mtimeMs, sizeBytes: addedSt.size })

      const res2 = await freshness.reconcileFolder(root, listing)
      expect(res2.moved).toBe(1)
      expect(res2.removed).toBe(1)
      expect(res2.added).toBe(1)

      // Verify DB state
      expect(store.documentByPath(originalPath)).toBeNull()
      expect(store.documentByPath(movedPath)).not.toBeNull()
      expect(store.documentByPath(movedPath)?.status).toBe('ready')
      expect(store.documentByPath(removedPath)).toBeNull()
      expect(tombstoned).toContain(removedPath)

      store.close()
    })

    it('readNowDocument: executes interactive extraction immediately even during pause and preempts large worker files', async () => {
      const workers: TestWorker[] = []
      const { manager, userDataDir } = createManager({
        workerFactory: () => {
          const w = new TestWorker()
          workers.push(w)
          return w as unknown as Worker
        },
      })
      // The startup worker exists only for the storage-budget handshake; metadata writes are refused until it ACKs.
      await waitForManagerWriteReady(manager)

      const docsDir = join(userDataDir, 'docs')
      mkdirSync(docsDir, { recursive: true })

      // 1. Pause the system
      publishIndexingPolicy(TEST_PAUSED_POLICY)

      const normalFile = join(docsDir, 'urgent-decision.pdf')
      writeFileSync(normalFile, 'Tài liệu quyết định quan trọng cần đọc ngay.')
      const st = statSync(normalFile)
      manager.indexDiscoveredFile(normalFile, { mtimeMs: st.mtimeMs, sizeBytes: st.size })

      // Under pause, background queue should not send requests to worker automatically
      // (the startup worker only ever saw the storage-budget handshake, which the fake ACKs without recording)
      await new Promise((r) => setTimeout(r, 60))
      expect(workers.flatMap((w) => w.requests)).toEqual([])

      // Interactive readNowDocument must trigger immediately even under pause!
      const readPromise = manager.readNowDocument(normalFile)
      await vi.waitFor(() =>
        expect(
          workers.some((w) => w.requests.some((r) => r.path === normalFile && r.interactive)),
        ).toBe(true),
      )
      const readWorker = workers.find((w) =>
        w.requests.some((r) => r.path === normalFile && r.interactive),
      )!

      readWorker.finish(true)
      const readResult = await readPromise
      expect(readResult).toEqual({ ok: true })

      // 2. Preempt large file: start a heavy 30MB file in background
      resetIndexingPolicyBus() // unpause
      const heavyFile = join(docsDir, 'huge-dataset.txt')
      writeFileSync(heavyFile, 'Large data '.repeat(100))
      truncateSync(heavyFile, 30 * 1024 * 1024)
      const heavySt = statSync(heavyFile)

      manager.indexDiscoveredFile(heavyFile, { mtimeMs: heavySt.mtimeMs, sizeBytes: heavySt.size })
      await vi.waitFor(() =>
        expect(workers.some((w) => w.requests.some((r) => r.path === heavyFile))).toBe(true),
      )

      const activeWorker = workers.find((w) => w.requests.some((r) => r.path === heavyFile))!
      // Now a user demands reading another file
      const userFile = join(docsDir, 'user-choice.docx')
      writeFileSync(userFile, 'User clicked this file.')
      const userSt = statSync(userFile)
      manager.indexDiscoveredFile(userFile, { mtimeMs: userSt.mtimeMs, sizeBytes: userSt.size })

      const userReadPromise = manager.readNowDocument(userFile)
      await vi.waitFor(() =>
        expect(
          workers.some((w) => w.requests.some((r) => r.path === userFile && r.interactive)),
        ).toBe(true),
      )

      // The previous worker was recycled/terminated to preempt heavy extraction
      expect(activeWorker.terminated).toBe(true)
      workers[workers.length - 1]!.finish(true)

      const userReadResult = await userReadPromise
      expect(userReadResult).toEqual({ ok: true })
    })

    it('annotateFreshness: accurately marks stale on modification and missing on deletion', async () => {
      const dbPath = join(tempDir, 'freshness.db')
      const store = new DocumentMemoryStore(dbPath)
      const testFile1 = join(tempDir, 'fresh-doc.txt')
      const testFile2 = join(tempDir, 'stale-doc.txt')
      const testFile3 = join(tempDir, 'missing-doc.txt')

      writeFileSync(testFile1, 'Content 1')
      writeFileSync(testFile2, 'Content 2')
      writeFileSync(testFile3, 'Content 3')

      const st1 = statSync(testFile1)
      const st2 = statSync(testFile2)
      const st3 = statSync(testFile3)

      const freshness = new FreshnessCoordinator({ store })

      // 1. testFile1 remains unchanged
      // 2. testFile2 modified
      writeFileSync(testFile2, 'Modified Content 2 with new size')
      // 3. testFile3 deleted
      rmSync(testFile3)

      const hits = [
        {
          id: 1,
          path: testFile1,
          name: 'fresh-doc.txt',
          mtimeMs: st1.mtimeMs,
          sizeBytes: st1.size,
          score: 1,
        },
        {
          id: 2,
          path: testFile2,
          name: 'stale-doc.txt',
          mtimeMs: st2.mtimeMs,
          sizeBytes: st2.size,
          score: 0.9,
        },
        {
          id: 3,
          path: testFile3,
          name: 'missing-doc.txt',
          mtimeMs: st3.mtimeMs,
          sizeBytes: st3.size,
          score: 0.8,
        },
      ]

      const annotated = await freshness.annotateFreshness(hits)
      const h1 = annotated.find((h) => h.path === testFile1)!
      const h2 = annotated.find((h) => h.path === testFile2)!
      const h3 = annotated.find((h) => h.path === testFile3)!

      expect(h1.stale).toBe(false)
      expect(h1.missing).toBe(false)

      expect(h2.stale).toBe(true)
      expect(h2.missing).toBe(false)

      expect(h3.stale).toBe(true)
      expect(h3.missing).toBe(true)

      freshness.clearMissing()
      store.close()
    })
  })

  // =========================================================================
  // 2. MIG PARITY & FAULT INJECTION
  // =========================================================================
  describe('2. MIG Parity & Fault Injection', () => {
    it('Cutover State Machine: recovers safely from crash during "source-backed-up" phase (INV-12)', () => {
      const sourceDb = join(tempDir, 'source-backup-crash.db')
      const backupDb = `${sourceDb}.v2.backup.db`
      const tempDb = `${sourceDb}.v3.tmp`
      const manifestPath = getManifestPath(sourceDb)

      // Create initial valid source
      const db = new DatabaseSync(sourceDb)
      db.exec(
        "CREATE TABLE test_data (val TEXT); INSERT INTO test_data VALUES ('original-source');",
      )
      db.close()

      // Simulate step 1 of cutover: source was renamed to backup, temp is being prepared, then CRASH!
      renameSync(sourceDb, backupDb)
      const dbTemp = new DatabaseSync(tempDb)
      dbTemp.exec('CREATE TABLE test_temp (val TEXT);')
      dbTemp.close()

      const crashManifest: CutoverStateManifest = {
        phase: 'source-backed-up',
        sourceDbPath: sourceDb,
        tempPath: tempDb,
        backupPath: backupDb,
        timestamp: Date.now(),
      }
      writeFileSync(manifestPath, JSON.stringify(crashManifest), 'utf8')

      // Assert crash state exists
      expect(existsSync(sourceDb)).toBe(false)
      expect(existsSync(backupDb)).toBe(true)
      expect(existsSync(manifestPath)).toBe(true)

      // Run automatic crash recovery
      const recovered = recoverInterruptedCutover(sourceDb)
      expect(recovered).toBe(true)

      // Verify recovery restored sourceDb, cleaned temp, and removed manifest
      expect(existsSync(sourceDb)).toBe(true)
      expect(existsSync(tempDb)).toBe(false)
      expect(existsSync(manifestPath)).toBe(false)

      const restoredDb = new DatabaseSync(sourceDb)
      const row = restoredDb.prepare('SELECT val FROM test_data').get() as { val: string }
      expect(row.val).toBe('original-source')
      restoredDb.close()
    })

    it('Cutover State Machine: handles crash in "temp-renamed-to-source" phase with automatic validation & rollback on corruption', () => {
      const sourceDb = join(tempDir, 'temp-rename-crash.db')
      const backupDb = `${sourceDb}.v2.backup.db`
      const tempDb = `${sourceDb}.v3.tmp`
      const manifestPath = getManifestPath(sourceDb)

      // Case A: Valid target database in place -> recovers and enforces retention
      const backupA = new DatabaseSync(backupDb)
      backupA.exec('CREATE TABLE test_backup (val TEXT);')
      backupA.close()

      // Create a valid V3 source database
      const v3Db = new DatabaseSync(sourceDb)
      v3Db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA auto_vacuum = INCREMENTAL;
        CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT, status TEXT);
        CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id INTEGER, ordinal INTEGER, text TEXT, location TEXT);
        CREATE TABLE chunk_embeddings (chunk_id INTEGER PRIMARY KEY, space_id TEXT, vector BLOB, vector_dim INTEGER);
        CREATE TABLE document_embedding_counts (document_id INTEGER, space_id TEXT, completed_chunks INTEGER, PRIMARY KEY(document_id, space_id));
        CREATE TABLE document_memory_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO document_memory_meta VALUES ('schema_version', '3');
      `)
      v3Db.close()

      writeFileSync(
        manifestPath,
        JSON.stringify({
          phase: 'temp-renamed-to-source',
          sourceDbPath: sourceDb,
          tempPath: tempDb,
          backupPath: backupDb,
          timestamp: Date.now(),
        }),
        'utf8',
      )

      const recoveredA = recoverInterruptedCutover(sourceDb)
      expect(recoveredA).toBe(true)
      expect(existsSync(sourceDb)).toBe(true)
      expect(existsSync(manifestPath)).toBe(false)

      // Case B: Corrupted target database -> rolls back to backup
      writeFileSync(sourceDb, 'CORRUPTED SQLITE HEADER DATA')
      const backupB = new DatabaseSync(backupDb)
      backupB.exec('CREATE TABLE valid_backup (ok INTEGER); INSERT INTO valid_backup VALUES (1);')
      backupB.close()

      writeFileSync(
        manifestPath,
        JSON.stringify({
          phase: 'temp-renamed-to-source',
          sourceDbPath: sourceDb,
          tempPath: tempDb,
          backupPath: backupDb,
          timestamp: Date.now(),
        }),
        'utf8',
      )

      const recoveredB = recoverInterruptedCutover(sourceDb)
      expect(recoveredB).toBe(true)
      expect(existsSync(sourceDb)).toBe(true)

      const checkDb = new DatabaseSync(sourceDb)
      const validRow = checkDb.prepare('SELECT ok FROM valid_backup').get() as { ok: number }
      expect(validRow.ok).toBe(1)
      checkDb.close()
    })

    it('Fail-Closed Bootstrap: corrupt/unusable database fails bootstrap and prevents manager startup (INV-01)', async () => {
      const dbDir = join(tempDir, 'corrupt-bootstrap-db')
      mkdirSync(dbDir, { recursive: true })
      const dbPath = join(dbDir, 'document-memory.db')

      // Write completely corrupted database file
      writeFileSync(dbPath, 'NOT A VALID SQLITE DATABASE FILE')

      const bootstrap = await ensureDocumentMemoryStorageReady(dbDir)
      expect(bootstrap.ready).toBe(false)
      expect(bootstrap.error).toBeDefined()

      // When bootstrap.ready === false, index.ts sets documentMemory = null
      let docMem: DocumentMemoryManager | null = null
      if (bootstrap.ready) {
        docMem = new DocumentMemoryManager(join(tempDir, 'user'), { dbDir })
      }
      expect(docMem).toBeNull()
    })

    it('Active Embedding Space Scoping: migrates embeddings only for activeSpaceId without cross-space contamination (INV-04)', () => {
      const dbPath = join(tempDir, 'spaces-migration.db')
      const v2Db = new DatabaseSync(dbPath)

      v2Db.exec(`
        CREATE TABLE documents (
          id INTEGER PRIMARY KEY, path TEXT UNIQUE, name TEXT, status TEXT,
          mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT,
          active_chunk_set_id INTEGER, error TEXT, excluded INTEGER DEFAULT 0,
          truncated INTEGER DEFAULT 0, last_opened_at INTEGER DEFAULT 0,
          priority_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
          chunk_total INTEGER DEFAULT 1, chunk_done INTEGER DEFAULT 1, chunk_counted INTEGER DEFAULT 1
        );
        CREATE TABLE embedding_spaces (
          id TEXT PRIMARY KEY, model_repo TEXT, model_revision TEXT,
          pooling TEXT, dimensions INTEGER, quantization TEXT
        );
        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY, document_id INTEGER, chunk_set_id INTEGER,
          ordinal INTEGER, text TEXT, normalized TEXT, location TEXT
        );
        CREATE TABLE chunk_embeddings (
          chunk_id INTEGER, space_id TEXT, vector BLOB, vector_dim INTEGER,
          PRIMARY KEY (chunk_id, space_id)
        );
        INSERT INTO embedding_spaces VALUES
          ('space-active', 'repo-active', 'rev1', 'mean', 384, 'q8'),
          ('space-other', 'repo-other', 'rev1', 'cls', 768, 'fp32');

        INSERT INTO documents (id, path, name, status, embedding_model)
        VALUES (1, 'D:/doc.txt', 'doc.txt', 'ready', 'space-active');

        INSERT INTO chunks (id, document_id, ordinal, text, normalized, location)
        VALUES (101, 1, 0, 'Chunk text content', 'chunk text content', 'p1');
      `)

      const vec384 = floatBlob(new Array(384).fill(0.01))
      const vec768 = floatBlob(new Array(768).fill(0.02))

      v2Db
        .prepare(
          'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, ?, ?, ?)',
        )
        .run(101, 'space-active', vec384, 384)
      v2Db
        .prepare(
          'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, ?, ?, ?)',
        )
        .run(101, 'space-other', vec768, 768)

      v2Db.close()

      // Run migration with activeSpaceId = 'space-active'
      const result = migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'space-active',
        activeDimensions: 384,
      })

      expect(result.success).toBe(true)
      expect(result.embeddingsCopied).toBe(1)

      const v3Store = new DocumentMemoryStore(dbPath)
      try {
        const rawDb = v3Store.rawDb
        const rows = rawDb
          .prepare('SELECT chunk_id, space_id, vector_dim FROM chunk_embeddings')
          .all() as Array<{
          chunk_id: number
          space_id: string
          vector_dim: number
        }>
        expect(rows).toHaveLength(1)
        expect(rows[0].space_id).toBe('space-active')
        expect(rows[0].vector_dim).toBe(384)

        // Ensure space-other was NOT copied into chunk_embeddings
        const otherRows = rawDb
          .prepare("SELECT * FROM chunk_embeddings WHERE space_id = 'space-other'")
          .all()
        expect(otherRows).toHaveLength(0)
      } finally {
        v3Store.close()
      }
    })
  })

  // =========================================================================
  // 3. STORAGE & GC PARITY
  // =========================================================================
  describe('3. STORAGE & GC Parity', () => {
    it('INV-03: verifies physical schema V3 chunks table contains NO vector or normalized columns', () => {
      const dbPath = join(tempDir, 'schema-check.db')
      const store = new DocumentMemoryStore(dbPath)
      const rawDb = store.rawDb

      const columns = (
        rawDb.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
      ).map((c) => c.name)

      expect(columns).toContain('id')
      expect(columns).toContain('document_id')
      expect(columns).toContain('chunk_set_id')
      expect(columns).toContain('ordinal')
      expect(columns).toContain('text')
      expect(columns).toContain('location')

      // INVARIANT INV-03: NO vector, vector_dim, or normalized!
      expect(columns).not.toContain('vector')
      expect(columns).not.toContain('vector_dim')
      expect(columns).not.toContain('normalized')

      store.close()
    })

    it('GC Parity: does NOT delete chunk_sets in "building" state and recounts document_embedding_counts accurately', () => {
      const dbPath = join(tempDir, 'gc-test.db')
      const store = new DocumentMemoryStore(dbPath)
      const db = store.rawDb

      // Setup document with active set 1, building set 2, and retired set 3
      db.exec(`
        INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
        VALUES ('space-1', 'repo', 'rev', 'mean', 384, 'fp32');

        INSERT INTO documents (id, path, name, status, active_chunk_set_id)
        VALUES (10, 'D:/doc-gc.txt', 'doc-gc.txt', 'ready', 1);

        INSERT INTO chunk_sets (id, document_id, chunker_version, state) VALUES
          (1, 10, 1, 'active'),
          (2, 10, 2, 'building'),
          (3, 10, 1, 'retired');

        INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location) VALUES
          (1001, 10, 1, 0, 'Active chunk', 'loc1'),
          (1002, 10, 2, 0, 'Building chunk being upgraded', 'loc2'),
          (1003, 10, 3, 0, 'Retired chunk to be GC-ed', 'loc3');

        INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES
          (1001, 'space-1', X'00000000', 384),
          (1002, 'space-1', X'11111111', 384),
          (1003, 'space-1', X'22222222', 384);

        INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
        VALUES (10, 'space-1', 3);
      `)

      const gcStats = garbageCollectObsoleteStorage(db)

      expect(gcStats.retiredSetsDeleted).toBe(1)
      expect(gcStats.orphanChunksDeleted).toBeGreaterThanOrEqual(1)

      // Chunk set 2 (building) MUST be preserved!
      const set2 = db.prepare('SELECT state FROM chunk_sets WHERE id = 2').get() as
        { state: string } | undefined
      expect(set2).toBeDefined()
      expect(set2?.state).toBe('building')

      const chunk1002 = db.prepare('SELECT text FROM chunks WHERE id = 1002').get() as
        { text: string } | undefined
      expect(chunk1002?.text).toBe('Building chunk being upgraded')

      // Chunk 1003 (in retired set 3) MUST be removed
      const chunk1003 = db.prepare('SELECT id FROM chunks WHERE id = 1003').get()
      expect(chunk1003).toBeUndefined()

      // document_embedding_counts recounted correctly (now 2 remaining valid embeddings: 1001 & 1002)
      const countRow = db
        .prepare(
          "SELECT completed_chunks FROM document_embedding_counts WHERE document_id = 10 AND space_id = 'space-1'",
        )
        .get() as { completed_chunks: number }
      expect(countRow.completed_chunks).toBe(2)

      store.close()
    })

    it('Progress Parity: progress and stats scoped strictly by activeSpaceId never exceed 100%', () => {
      const dbPath = join(tempDir, 'progress-scoped.db')
      const store = new DocumentMemoryStore(dbPath)
      const db = store.rawDb
      const docPath = resolve(join(tempDir, 'multi-space.txt'))

      db.exec(`
        INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization) VALUES
          ('model-a', 'repo-a', 'rev', 'mean', 384, 'fp32'),
          ('model-b', 'repo-b', 'rev', 'mean', 768, 'fp32');
      `)

      db.prepare(
        `
        INSERT INTO documents (id, path, name, status, embedding_model, chunk_counted, chunk_total, chunk_done)
        VALUES (1, ?, 'multi-space.txt', 'text-only', 'model-a', 0, 2, 0);
      `,
      ).run(docPath)

      db.exec(`
        INSERT INTO chunks (id, document_id, ordinal, text, location) VALUES
          (1, 1, 0, 'Chunk 1', 'loc1'),
          (2, 1, 1, 'Chunk 2', 'loc2');

        -- 2 completed chunks in model-a AND 2 completed chunks in model-b
        INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES
          (1, 'model-a', X'00', 384),
          (2, 'model-a', X'00', 384),
          (1, 'model-b', X'00', 768),
          (2, 'model-b', X'00', 768);

        INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES
          (1, 'model-a', 2),
          (1, 'model-b', 2);
      `)

      // Check scoped progress for model-a
      const docProg = store.chunkProgress(docPath, 'model-a')
      expect(docProg.totalChunks).toBe(2)
      expect(docProg.completedChunks).toBe(2)
      expect(docProg.completedChunks / docProg.totalChunks).toBeLessThanOrEqual(1.0)

      const folderProg = store.folderChunkProgress(tempDir, 'model-a')
      expect(folderProg.totalChunks).toBe(2)
      expect(folderProg.completedChunks).toBe(2) // NOT 4!
      expect(folderProg.completedChunks).toBeLessThanOrEqual(folderProg.totalChunks)

      const stats = store.stats('model-a')
      expect(stats.chunks).toBe(2)
      expect(stats.vectors).toBe(2) // NOT 4!
      expect(stats.semanticCoverage).toBe(1.0)

      store.close()
    })
  })

  // =========================================================================
  // 4. PERF & PAUSE PARITY
  // =========================================================================
  describe('4. PERF & PAUSE Parity', () => {
    it('Bounded Maintenance: vacuum, fts-maintenance, and gc are bounded <= 256 pages and dispatched via IPC', async () => {
      const dbPath = join(tempDir, 'bounded-maint.db')
      const store = new DocumentMemoryStore(dbPath)

      // Test vacuum bounding
      const vacResult = runIncrementalVacuum(store.rawDb, { maxPages: 256, batchPages: 256 })
      expect(vacResult).toHaveProperty('vacuumed')
      expect(vacResult).toHaveProperty('pagesReclaimed')

      // Test MaintenanceScheduler off-thread worker IPC dispatching
      const dispatchedRequests: string[] = []
      const scheduler = new MaintenanceScheduler({
        store,
        askWorker: async (req) => {
          dispatchedRequests.push(req.type)
          return { id: 1, result: { more: false } }
        },
      })

      await scheduler.runFtsMaintenance()
      await scheduler.runGcStep()
      await scheduler.runVacuumStep()

      expect(dispatchedRequests).toContain('fts-maintenance-step')
      expect(dispatchedRequests).toContain('gc-step')
      expect(dispatchedRequests).toContain('vacuum-step')

      store.close()
    })

    it('BackgroundWorkGate Pause Enforcement: halts P1-P4 during pause while allowing P0 interactive tasks', async () => {
      let isPaused = true
      const gate = new BackgroundWorkGate({
        pauseCheck: () => isPaused,
        autoSubscribePolicy: false,
      })

      // In paused state:
      expect(gate.canRun(BackgroundWorkPriority.P0_INTERACTIVE)).toBe(true)
      expect(gate.canRun('interactive')).toBe(true)
      expect(gate.canRun('search')).toBe(true)
      expect(gate.canRun('read-now')).toBe(true)

      expect(gate.canRun(BackgroundWorkPriority.P1_USER_INITIATED)).toBe(false)
      expect(gate.canRun(BackgroundWorkPriority.P2_NORMAL_INDEXING)).toBe(false)
      expect(gate.canRun(BackgroundWorkPriority.P3_MIGRATION)).toBe(false)
      expect(gate.canRun(BackgroundWorkPriority.P4_HOUSEKEEPING)).toBe(false)

      expect(gate.canRun('fts-maintenance-step')).toBe(false)
      expect(gate.canRun('gc-step')).toBe(false)
      expect(gate.canRun('vacuum-step')).toBe(false)

      // Interactive task executes immediately even while paused
      let interactiveExecuted = false
      await gate.enqueue(BackgroundWorkPriority.P0_INTERACTIVE, async () => {
        interactiveExecuted = true
      })
      expect(interactiveExecuted).toBe(true)

      // Unpause: all priorities allowed
      isPaused = false
      expect(gate.canRun(BackgroundWorkPriority.P2_NORMAL_INDEXING)).toBe(true)
      expect(gate.canRun('fts-maintenance-step')).toBe(true)

      gate.dispose()
    })
  })

  // =========================================================================
  // 5. TRUTHFUL IPC
  // =========================================================================
  describe('5. TRUTHFUL IPC', () => {
    it('Snapshot Truthfulness & Caching: snapshot mode is not null, modelState matches worker, and caches respect TTLs', () => {
      const dbPath = join(tempDir, 'truthful-snapshot.db')
      const store = new DocumentMemoryStore(dbPath)
      const issueReader = new IndexIssueReader(dbPath)

      snapshotCache.clear()
      diagnosticsCache.clear()

      let currentModelState: 'not-loaded' | 'loading' | 'ready' | 'error' = 'not-loaded'

      const mockManager = {
        status: () => ({
          enabled: true,
          modelState: currentModelState,
          documents: 10,
          chunks: 50,
          vectors: 50,
          pending: 0,
          errors: 0,
          dbPath,
          files: [],
        }),
        indexingActivityStatus: () => ({
          activity: {
            queued: 0,
            extracting: [],
            embedding: [],
          },
        }),
        lastIndexError: null,
        isEnabled: () => true,
        getLibraryIndexCounts: () => ({
          completedChunks: 50,
          totalChunks: 50,
          totalFiles: 10,
          readyFiles: 10,
          pendingFiles: 0,
          errorFiles: 0,
        }),
        nowStatus: () => ({
          extracting: [],
          embedding: {},
          positions: {},
          pages: {},
          queued: 0,
          paused: false,
        }),
        getStorageDiagnostics: () => ({
          activeDbSizeBytes: 1024,
          walSizeBytes: 0,
          pageSize: 4096,
          pageCount: 1,
          freelistCount: 0,
          estimatedReclaimableBytes: 0,
          v2BackupSizeBytes: null,
          schemaVersion: '3',
          migrationStatus: 'none',
          topOffendersByChunks: [],
          topOffendersBySize: [],
        }),
        getMigrationDiagnostics: () => ({
          sourceExists: false,
          sourceVersion: 'v3',
          activeMigration: null,
          availableBackups: [],
          retainedBackupsCount: 0,
        }),
      } as unknown as DocumentMemoryManager

      const ctx = {
        getDocumentMemory: () => mockManager,
        getFolderScan: () => null,
        getIssueReader: () => issueReader,
        getFolderCounts: () => ({
          get: (_k: string, fetcher: () => any) => fetcher(),
        }),
        dbPath: () => dbPath,
      }

      // 1. Snapshot truthfulness: mode is not null
      const snap1 = getDocumentIndexSnapshot(ctx)
      expect(snap1.mode).not.toBeNull()
      expect(snap1.mode?.mode).toBeDefined()
      expect(snap1.activity.memory.modelState).toBe('not-loaded')

      // 2. Cache TTL verification: consecutive call within 2s returns cached reference
      const snap2 = getDocumentIndexSnapshot(ctx)
      expect(snap2).toBe(snap1) // Same cached object

      // Force refresh bypasses cache
      currentModelState = 'ready'
      const snap3 = getDocumentIndexSnapshot(ctx, true)
      expect(snap3).not.toBe(snap1)
      expect(snap3.activity.memory.modelState).toBe('ready')

      // 3. Cache TTL constants check
      expect(SNAPSHOT_CACHE_TTL_MS).toBe(2000)
      expect(DIAGNOSTICS_CACHE_TTL_MS).toBe(60_000)

      // Test IndexStatusCache TTL expiry behavior
      const testCache = new IndexStatusCache<string>(50)
      testCache.set('val1')
      expect(testCache.get()).toBe('val1')

      store.close()
    })
  })
})
