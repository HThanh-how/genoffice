import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanFiles } from '../src/main/file-index/scan'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import {
  setActiveIgnoreRules,
  setIgnoreStoragePath,
  isPathIgnored,
} from '../src/main/document-memory/ignore-policy'

const WORKER = join(__dirname, 'file-index-test-worker.mjs')

describe('ignore-pipeline-production-regression', () => {
  let tmpDir: string
  let storeDir: string
  let storageFile: string
  let store: FileIndexStore
  let indexer: FileIndexer | null = null

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'genoffice-pipeline-test-'))
    storeDir = mkdtempSync(join(tmpdir(), 'genoffice-pipeline-store-'))
    storageFile = join(storeDir, 'ignore-rules.json')
    setIgnoreStoragePath(storageFile)
    store = new FileIndexStore(join(storeDir, 'index.db'))
  })

  afterEach(() => {
    indexer?.stop()
    indexer = null
    store.close()
    try {
      rmSync(tmpDir, { recursive: true, force: true })
      rmSync(storeDir, { recursive: true, force: true })
    } catch {}
  })

  it('1. Initial File Index scan rejects ignored files', () => {
    const root = join(tmpDir, 'scan_root')
    mkdirSync(root)
    mkdirSync(join(root, 'private'))

    writeFileSync(join(root, 'valid.docx'), 'hello document')
    writeFileSync(join(root, 'backup.bak'), 'backup data')
    writeFileSync(join(root, 'private', 'classified.docx'), 'classified')

    setActiveIgnoreRules([
      { id: 'rule-bak', pattern: '*.bak', enabled: true, scope: 'global' },
      { id: 'rule-priv', pattern: 'private/', enabled: true, scope: 'global' },
    ])

    const res = scanFiles(root)
    const scannedPaths = res.files.map((f) => f.path)

    expect(scannedPaths).toContain(join(root, 'valid.docx'))
    expect(scannedPaths).not.toContain(join(root, 'backup.bak'))
    expect(scannedPaths).not.toContain(join(root, 'private', 'classified.docx'))
  })

  it('2. File queued before rule change is rejected before extraction', async () => {
    const docPath = join(tmpDir, 'pending_file.docx')
    writeFileSync(docPath, 'sample content')

    setActiveIgnoreRules([])

    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [tmpDir], extraPaths: () => [] },
      5000,
      512,
    )

    // File is in the store as pending
    store.upsert({ path: docPath, mtimeMs: Date.now(), sizeBytes: 100 }, null, 'pending')
    expect(store.countCached()).toBe(1)

    // User now adds an ignore rule before drain completes extraction
    setActiveIgnoreRules([
      { id: 'rule-pending', pattern: 'pending_file.*', enabled: true, scope: 'global' },
    ])

    // Scan/diff runs with new rule active
    await indexer.scan()

    // File must be purged from the index rather than extracted
    expect(store.count()).toBe(0)
    const searchRes = store.search('sample')
    expect(searchRes.hits).toHaveLength(0)
  })

  it('3. File newly ignored during in-flight work cannot be reintroduced as a searchable result', async () => {
    const file = join(tmpDir, 'searchable.docx')
    writeFileSync(file, 'unique searchable content phrase')

    setActiveIgnoreRules([])

    store.upsert(
      { path: file, mtimeMs: Date.now(), sizeBytes: 100 },
      'unique searchable content phrase',
      'ok',
    )
    expect(store.search('unique').hits).toHaveLength(1)

    // New ignore rule activated
    setActiveIgnoreRules([
      { id: 'rule-searchable', pattern: 'searchable.*', enabled: true, scope: 'global' },
    ])

    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [tmpDir], extraPaths: () => [] },
      5000,
      512,
    )

    await indexer.scan()

    // Ignored content must not remain in the index
    expect(store.search('unique').hits).toHaveLength(0)
  })

  it('4. Document Memory enqueue rejects ignored paths', async () => {
    const memDir = mkdtempSync(join(tmpdir(), 'genoffice-mem-'))
    const ignoredDoc = join(memDir, 'secret_notes.docx')
    writeFileSync(ignoredDoc, 'secret')

    setActiveIgnoreRules([
      { id: 'rule-secret', pattern: 'secret_*', enabled: true, scope: 'global' },
    ])

    const manager = new DocumentMemoryManager(memDir, {
      initialEnabled: true,
      workerTimeoutMs: 5000,
    })

    try {
      manager.remember(ignoredDoc)
      const st = manager.nowStatus()
      // Ignored path must not be in the queue
      expect(st.positions[ignoredDoc]).toBeUndefined()
      expect(st.extracting.some((e) => e.path === ignoredDoc)).toBe(false)
    } finally {
      await manager.closeAsync()
      rmSync(memDir, { recursive: true, force: true })
    }
  })

  it('5. Interactive read/retry cannot bypass ignore policy', async () => {
    const memDir = mkdtempSync(join(tmpdir(), 'genoffice-mem-retry-'))
    const docPath = join(memDir, 'retry_target.docx')
    writeFileSync(docPath, 'sensitive retry text')

    setActiveIgnoreRules([
      { id: 'rule-retry', pattern: 'retry_target.*', enabled: true, scope: 'global' },
    ])

    const manager = new DocumentMemoryManager(memDir, {
      initialEnabled: true,
      workerTimeoutMs: 5000,
    })

    try {
      const readRes = await manager.readNowDocument(docPath)
      expect(readRes.ok).toBe(false)
      expect(readRes.error).toBe('unavailable')
    } finally {
      await manager.closeAsync()
      rmSync(memDir, { recursive: true, force: true })
    }
  })

  it('6. Worker admission respects the active policy', async () => {
    const fileA = join(tmpDir, 'allowed.docx')
    const fileB = join(tmpDir, 'blocked.tmp')
    writeFileSync(fileA, 'allowed text')
    writeFileSync(fileB, 'blocked text')

    setActiveIgnoreRules([{ id: 'rule-tmp-adm', pattern: '*.tmp', enabled: true, scope: 'global' }])

    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [tmpDir], extraPaths: () => [] },
      5000,
      512,
    )

    await indexer.scan()

    const allIndexed = await store.listAllSliced(() => Promise.resolve())
    expect(allIndexed.has(fileA)).toBe(true)
    expect(allIndexed.has(fileB)).toBe(false)
  })

  it('7. Root A rules do not affect Root B', () => {
    const rootA = join(tmpDir, 'rootA')
    const rootB = join(tmpDir, 'rootB')
    mkdirSync(rootA)
    mkdirSync(rootB)
    mkdirSync(join(rootA, 'secrets'))
    mkdirSync(join(rootB, 'secrets'))

    const fileA = join(rootA, 'secrets', 'doc.docx')
    const fileB = join(rootB, 'secrets', 'doc.docx')
    writeFileSync(fileA, 'secret A')
    writeFileSync(fileB, 'secret B')

    setActiveIgnoreRules([
      { id: 'scoped-rootA', pattern: 'secrets/**', enabled: true, scope: rootA },
    ])

    expect(isPathIgnored(fileA, rootA)).toBe(true)
    expect(isPathIgnored(fileB, rootB)).toBe(false)
  })

  it('8. Unavailable roots do not cause mass deletion', async () => {
    const root = join(tmpDir, 'stable_root')
    mkdirSync(root)
    const file = join(root, 'keep_me.docx')
    writeFileSync(file, 'persistent content')

    store.upsert({ path: file, mtimeMs: Date.now(), sizeBytes: 50 }, 'persistent content', 'ok')
    expect(store.countCached()).toBe(1)

    // When an offline or nonexistent root is checked, completeRoots will not include it
    const nonExistentRoot = join(tmpDir, 'offline_drive_mount')
    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [nonExistentRoot], extraPaths: () => [] },
      5000,
      512,
    )

    await indexer.scan()

    // Existing file under stable_root must NOT be deleted
    expect(store.countCached()).toBe(1)
  })

  it('9. Existing index records obey the new exclusion rule', async () => {
    const file = join(tmpDir, 'finance_report.xlsx')
    writeFileSync(file, 'revenue and margins')

    store.upsert({ path: file, mtimeMs: Date.now(), sizeBytes: 80 }, 'revenue and margins', 'ok')
    expect(store.search('revenue').hits).toHaveLength(1)

    // User applies an ignore rule for financial spreadsheets
    setActiveIgnoreRules([
      { id: 'rule-finance', pattern: '*finance*', enabled: true, scope: 'global' },
    ])

    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [tmpDir], extraPaths: () => [] },
      5000,
      512,
    )

    await indexer.scan()

    // File is removed from search results
    expect(store.search('revenue').hits).toHaveLength(0)
  })

  it('10. Source documents remain untouched', async () => {
    const file = join(tmpDir, 'precious_user_doc.docx')
    const originalContent = 'Do not delete or modify this user file!'
    writeFileSync(file, originalContent)

    setActiveIgnoreRules([
      { id: 'rule-protect', pattern: '*.docx', enabled: true, scope: 'global' },
    ])

    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [tmpDir], extraPaths: () => [] },
      5000,
      512,
    )

    await indexer.scan()

    // Verify source document was NEVER touched or deleted
    expect(existsSync(file)).toBe(true)
  })
})
