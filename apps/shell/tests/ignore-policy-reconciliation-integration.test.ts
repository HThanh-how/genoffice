import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderScanManager } from '../src/main/document-memory/folder-scan'
import { FolderWatchManager } from '../src/main/document-memory/folder-watch'
import {
  getActiveIgnoreRules,
  isPathIgnored,
  readGenOfficeIgnore,
  setActiveIgnoreRules,
  setIgnoreStoragePath,
  setKnownRootsResolver,
  type IgnoreRule,
} from '../src/main/document-memory/ignore-policy'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'
import { createIgnoreReconcileController } from '../src/main/fork/document-index-ignore-reconcile'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'

const TEST_WORKER = join(__dirname, 'file-index-test-worker.mjs')

class FakeFsWatcher extends EventEmitter {
  closed = false
  close() {
    this.closed = true
  }
}

describe('Ignore Policy Reconciliation Integration (Phase B)', () => {
  let tempDir: string
  let rootA: string
  let rootB: string
  let rulesPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-reconcile-int-'))
    rootA = join(tempDir, 'rootA')
    rootB = join(tempDir, 'rootB')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    rulesPath = join(tempDir, 'ignore-rules.json')
    setIgnoreStoragePath(rulesPath)
    setKnownRootsResolver(() => [rootA, rootB])
    setActiveIgnoreRules([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setKnownRootsResolver(null)
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('1. Saving a global rule reconciles all configured roots', async () => {
    const reconciled: string[] = []
    const controller = createIgnoreReconcileController({
      getFolderScan: () => ({
        folders: () => [{ root: rootA } as never, { root: rootB } as never],
        reconcile: async (root: string) => {
          reconciled.push(root)
          return { ok: true }
        },
      }),
      debounceMs: 15,
    })

    try {
      setActiveIgnoreRules([
        { id: 'g-1', pattern: '*.confidential.docx', enabled: true, scope: 'global' },
      ])
      await vi.waitFor(() => expect(reconciled.sort()).toEqual([rootA, rootB].sort()), {
        timeout: 2_000,
      })
    } finally {
      controller.dispose()
    }
  })

  it('2. Saving a root-scoped rule reconciles only the affected root', async () => {
    const reconciled: string[] = []
    const controller = createIgnoreReconcileController({
      getFolderScan: () => ({
        folders: () => [{ root: rootA } as never, { root: rootB } as never],
        reconcile: async (root: string) => {
          reconciled.push(root)
          return { ok: true }
        },
      }),
      debounceMs: 15,
    })

    try {
      setActiveIgnoreRules([
        { id: 'scoped-a', pattern: 'only-a-*.docx', enabled: true, scope: rootA },
      ])
      await vi.waitFor(() => expect(reconciled).toEqual([rootA]), { timeout: 2_000 })
      await new Promise((r) => setTimeout(r, 40))
      expect(reconciled).toEqual([rootA])
    } finally {
      controller.dispose()
    }
  })

  it('3. Saving multiple rules rapidly coalesces into a bounded pass', async () => {
    const reconciled: string[] = []
    let fileIndexRefreshCount = 0
    const controller = createIgnoreReconcileController({
      getFolderScan: () => ({
        folders: () => [{ root: rootA } as never, { root: rootB } as never],
        reconcile: async (root: string) => {
          reconciled.push(root)
          return { ok: true }
        },
      }),
      onRefreshFileIndex: () => {
        fileIndexRefreshCount++
      },
      debounceMs: 50,
    })

    try {
      for (let i = 1; i <= 5; i++) {
        setActiveIgnoreRules([
          { id: `rapid-${i}`, pattern: `*.rapid${i}`, enabled: true, scope: 'global' },
        ])
      }
      await vi.waitFor(() => expect(reconciled.length).toBe(2), { timeout: 2_000 })
      await new Promise((r) => setTimeout(r, 80))
      expect(reconciled.sort()).toEqual([rootA, rootB].sort())
      expect(fileIndexRefreshCount).toBe(1)
    } finally {
      controller.dispose()
    }
  })

  it('4. Busy FolderScanManager retries reconciliation after completion', async () => {
    let attempts = 0
    const controller = createIgnoreReconcileController({
      getFolderScan: () => ({
        folders: () => [{ root: rootA } as never],
        reconcile: async () => {
          attempts++
          if (attempts < 3) {
            return { ok: false, reason: 'busy' }
          }
          return { ok: true, files: 4 }
        },
      }),
      debounceMs: 10,
      retryBaseMs: 25,
      retryMaxMs: 100,
    })

    try {
      setActiveIgnoreRules([{ id: 'busy-rule', pattern: '*.busy', enabled: true, scope: rootA }])
      await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 2_000 })
      await new Promise((r) => setTimeout(r, 80))
      expect(attempts).toBe(3)
    } finally {
      controller.dispose()
    }
  })

  it('5. File Index refreshes when Ignore rules change', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      },
    }
    const refreshSpy = vi.fn()
    const reconcileSpy = vi.fn(async () => ({ ok: true }))

    const cleanup = registerDocumentIndexIpc({
      ipcMain: ipcMain as never,
      getDocumentMemory: () => null,
      getFolderScan: () =>
        ({
          folders: () => [{ root: rootA }],
          reconcile: reconcileSpy,
          status: () => ({ root: rootA }),
        }) as never,
      dbPath: () => join(tempDir, 'doc-mem.db'),
      onRefreshFileIndex: refreshSpy,
    })

    try {
      const saveRulesHandler = handlers.get(DOCUMENT_INDEX_CHANNELS.saveIgnoreRules)
      expect(saveRulesHandler).toBeDefined()

      const res = (await saveRulesHandler!({}, [
        { id: 'ipc-r1', pattern: '*.secret.md', enabled: true, scope: 'global' },
      ])) as { ok: boolean }
      expect(res.ok).toBe(true)

      await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalled(), { timeout: 2_000 })
      await vi.waitFor(() => expect(reconcileSpy).toHaveBeenCalledWith(rootA), { timeout: 2_000 })
    } finally {
      cleanup()
    }
  })

  it('6. Creating .genofficeignore triggers reconciliation for that root', async () => {
    const reconciles: string[] = []
    let emitWatchEvent: ((name: string | null) => void) | null = null

    const watcher = new FolderWatchManager(
      {
        watchedRoots: () => [rootA],
        onRootsChanged: () => () => {},
        reconcile: async (root) => {
          reconciles.push(root)
          return { ok: true }
        },
      },
      {
        isEnabled: () => true,
        onEnabledChange: () => () => {},
        handleFileEvents: async () => {},
      },
      {
        debounceMs: 20,
        dirReconcileDelayMs: 20,
        minReconcileGapMs: 300_000,
        watch: ((
          _root: string,
          _opts: unknown,
          listener: (type: string, name: string | null) => void,
        ) => {
          emitWatchEvent = (name) => listener('rename', name)
          return new FakeFsWatcher()
        }) as never,
      },
    )

    try {
      const targetDoc = join(rootA, 'roadmap.docx')
      writeFileSync(targetDoc, 'roadmap content')
      expect(isPathIgnored(targetDoc, rootA)).toBe(false)

      writeFileSync(join(rootA, '.genofficeignore'), 'roadmap.docx\n')
      emitWatchEvent!('.genofficeignore')

      await vi.waitFor(() => expect(reconciles).toEqual([rootA]), { timeout: 2_000 })
      expect(isPathIgnored(targetDoc, rootA)).toBe(true)
    } finally {
      watcher.close()
    }
  })

  it('7. Modifying .genofficeignore updates exclusions and triggers reconciliation', async () => {
    const reconciles: string[] = []
    let emitWatchEvent: ((name: string | null) => void) | null = null

    const dotIgnorePath = join(rootA, '.genofficeignore')
    writeFileSync(dotIgnorePath, 'roadmap.docx\n')
    const firstDoc = join(rootA, 'roadmap.docx')
    const secondDoc = join(rootA, 'notes.txt')
    writeFileSync(firstDoc, 'roadmap')
    writeFileSync(secondDoc, 'notes')
    expect(isPathIgnored(firstDoc, rootA)).toBe(true)
    expect(isPathIgnored(secondDoc, rootA)).toBe(false)

    const watcher = new FolderWatchManager(
      {
        watchedRoots: () => [rootA],
        onRootsChanged: () => () => {},
        reconcile: async (root) => {
          reconciles.push(root)
          return { ok: true }
        },
      },
      {
        isEnabled: () => true,
        onEnabledChange: () => () => {},
        handleFileEvents: async () => {},
      },
      {
        debounceMs: 20,
        dirReconcileDelayMs: 20,
        minReconcileGapMs: 300_000,
        watch: ((
          _root: string,
          _opts: unknown,
          listener: (type: string, name: string | null) => void,
        ) => {
          emitWatchEvent = (name) => listener('change', name)
          return new FakeFsWatcher()
        }) as never,
      },
    )

    try {
      writeFileSync(dotIgnorePath, 'notes.txt\n')
      emitWatchEvent!('.genofficeignore')

      await vi.waitFor(() => expect(reconciles).toEqual([rootA]), { timeout: 2_000 })
      expect(isPathIgnored(firstDoc, rootA)).toBe(false)
      expect(isPathIgnored(secondDoc, rootA)).toBe(true)
    } finally {
      watcher.close()
    }
  })

  it('8. Deleting .genofficeignore restores indexing eligibility and triggers reconciliation', async () => {
    const reconciles: string[] = []
    let emitWatchEvent: ((name: string | null) => void) | null = null

    const dotIgnorePath = join(rootA, '.genofficeignore')
    const doc = join(rootA, 'restored.docx')
    writeFileSync(doc, 'restored content')
    writeFileSync(dotIgnorePath, 'restored.docx\n')
    expect(isPathIgnored(doc, rootA)).toBe(true)

    const watcher = new FolderWatchManager(
      {
        watchedRoots: () => [rootA],
        onRootsChanged: () => () => {},
        reconcile: async (root) => {
          reconciles.push(root)
          return { ok: true }
        },
      },
      {
        isEnabled: () => true,
        onEnabledChange: () => () => {},
        handleFileEvents: async () => {},
      },
      {
        debounceMs: 20,
        dirReconcileDelayMs: 20,
        minReconcileGapMs: 300_000,
        watch: ((
          _root: string,
          _opts: unknown,
          listener: (type: string, name: string | null) => void,
        ) => {
          emitWatchEvent = (name) => listener('rename', name)
          return new FakeFsWatcher()
        }) as never,
      },
    )

    try {
      rmSync(dotIgnorePath)
      emitWatchEvent!('.genofficeignore')

      await vi.waitFor(() => expect(reconciles).toEqual([rootA]), { timeout: 2_000 })
      expect(readGenOfficeIgnore(rootA)).toEqual([])
      expect(isPathIgnored(doc, rootA)).toBe(false)
    } finally {
      watcher.close()
    }
  })

  it('9. Disabling a rule re-admits eligible files on reconciliation', async () => {
    const docPath = join(rootA, 're-admitted-disable.txt')
    writeFileSync(docPath, 'searchable re-admitted disable body')

    const dbPath = join(tempDir, 'file-index-disable.db')
    const store = new FileIndexStore(dbPath)
    const indexer = new FileIndexer(
      store,
      TEST_WORKER,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
    )

    try {
      const rule: IgnoreRule = {
        id: 'r-disable',
        pattern: 're-admitted-disable.txt',
        enabled: true,
        scope: 'global',
      }
      setActiveIgnoreRules([rule])
      await indexer.scan()
      expect(store.listAll().has(docPath)).toBe(false)

      setActiveIgnoreRules([{ ...rule, enabled: false }])
      await indexer.scan()
      await vi.waitFor(() => expect(store.listAll().get(docPath)?.status).toBe('ok'), {
        timeout: 5_000,
      })
    } finally {
      indexer.stop()
      store.close()
    }
  })

  it('10. Deleting a rule re-admits eligible files on reconciliation', async () => {
    const docPath = join(rootA, 're-admitted-delete.txt')
    writeFileSync(docPath, 'searchable re-admitted delete body')

    const dbPath = join(tempDir, 'file-index-delete.db')
    const store = new FileIndexStore(dbPath)
    const indexer = new FileIndexer(
      store,
      TEST_WORKER,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
    )

    try {
      setActiveIgnoreRules([
        { id: 'r-delete', pattern: 're-admitted-delete.txt', enabled: true, scope: 'global' },
      ])
      await indexer.scan()
      expect(store.listAll().has(docPath)).toBe(false)

      setActiveIgnoreRules([])
      await indexer.scan()
      await vi.waitFor(() => expect(store.listAll().get(docPath)?.status).toBe('ok'), {
        timeout: 5_000,
      })
    } finally {
      indexer.stop()
      store.close()
    }
  })

  it('11. Persistence failure does not trigger reconciliation or mutate active rules', async () => {
    const initialRules: IgnoreRule[] = [
      { id: 'valid-1', pattern: '*.tmp', enabled: true, scope: 'global' },
    ]
    expect(setActiveIgnoreRules(initialRules)).toBe(true)

    const blockingFile = join(tempDir, 'not-a-directory')
    writeFileSync(blockingFile, 'blocker')
    setIgnoreStoragePath(join(blockingFile, 'nested', 'ignore-rules.json'))

    const reconciled: string[] = []
    const controller = createIgnoreReconcileController({
      getFolderScan: () => ({
        folders: () => [{ root: rootA } as never],
        reconcile: async (root: string) => {
          reconciled.push(root)
          return { ok: true }
        },
      }),
      debounceMs: 10,
    })

    try {
      const ok = setActiveIgnoreRules([
        { id: 'unsaved', pattern: '*.docx', enabled: true, scope: 'global' },
      ])
      expect(ok).toBe(false)
      await new Promise((r) => setTimeout(r, 40))

      expect(getActiveIgnoreRules()).toEqual(initialRules)
      expect(reconciled).toHaveLength(0)
    } finally {
      controller.dispose()
      setIgnoreStoragePath(rulesPath)
    }
  })

  it('12. Unreadable/disconnected root during reconciliation does not delete existing index records', async () => {
    const indexedDoc = join(rootA, 'indexed-before-unplug.txt')
    writeFileSync(indexedDoc, 'persisted indexed body')

    const dbPath = join(tempDir, 'file-index-unplugged.db')
    const store = new FileIndexStore(dbPath)
    store.upsert({ path: indexedDoc, mtimeMs: 100, sizeBytes: 22 }, 'persisted indexed body', 'ok')

    const memDir = join(tempDir, 'doc-mem-unplugged')
    mkdirSync(memDir, { recursive: true })
    const manager = new DocumentMemoryManager(memDir, {
      initialEnabled: true,
      workerTimeoutMs: 5_000,
    })
    const scanner = new FolderScanManager(memDir, manager)

    try {
      const missingRoot = join(tempDir, 'unplugged-drive')
      const res = await scanner.reconcile(missingRoot)
      expect(res.ok).toBe(false)
      expect(store.listAll().get(indexedDoc)?.status).toBe('ok')
    } finally {
      scanner.close()
      manager.close()
      store.close()
    }
  })

  it('13. Existing user files on disk are never modified or deleted', async () => {
    const userDoc = join(rootA, 'user-original.txt')
    writeFileSync(userDoc, 'precious user document content')

    setActiveIgnoreRules([
      { id: 'r-preserve-disk', pattern: 'user-original.txt', enabled: true, scope: 'global' },
    ])

    const dbPath = join(tempDir, 'file-index-disk.db')
    const store = new FileIndexStore(dbPath)
    const indexer = new FileIndexer(
      store,
      TEST_WORKER,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
    )

    try {
      await indexer.scan()
      expect(existsSync(userDoc)).toBe(true)
      expect(readFileSync(userDoc, 'utf-8')).toBe('precious user document content')
    } finally {
      indexer.stop()
      store.close()
    }
  })

  it('14. Existing SQLite databases are never wiped or reset', async () => {
    const keepDoc = join(rootA, 'keep-record.txt')
    const dropDoc = join(rootA, 'drop-record.txt')
    writeFileSync(keepDoc, 'keep record body')
    writeFileSync(dropDoc, 'drop record body')

    const dbPath = join(tempDir, 'file-index-keep-db.db')
    const store = new FileIndexStore(dbPath)
    store.upsert({ path: keepDoc, mtimeMs: Date.now(), sizeBytes: 16 }, 'keep record body', 'ok')
    store.upsert({ path: dropDoc, mtimeMs: Date.now(), sizeBytes: 16 }, 'drop record body', 'ok')

    setActiveIgnoreRules([
      { id: 'r-drop-only', pattern: 'drop-record.txt', enabled: true, scope: 'global' },
    ])

    const indexer = new FileIndexer(
      store,
      TEST_WORKER,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
    )

    try {
      await indexer.scan()
      expect(existsSync(dbPath)).toBe(true)
      expect(store.listAll().get(keepDoc)?.status).toBe('ok')
      expect(store.listAll().has(dropDoc)).toBe(false)
    } finally {
      indexer.stop()
      store.close()
    }
  })

  it('15. Document Memory queued/in-flight work for newly ignored path is cancelled or rejected before commit', async () => {
    const secretDoc = join(rootA, 'queued-secret.docx')
    writeFileSync(secretDoc, 'confidential payload')

    const memDir = join(tempDir, 'doc-mem-queue-15')
    mkdirSync(memDir, { recursive: true })
    const manager = new DocumentMemoryManager(memDir, {
      initialEnabled: false,
      workerTimeoutMs: 5_000,
    })

    try {
      manager.remember(secretDoc)
      setActiveIgnoreRules([
        { id: 'r-q-sec', pattern: 'queued-secret.docx', enabled: true, scope: 'global' },
      ])

      manager.setEnabled(true)
      await new Promise((r) => setTimeout(r, 80))
      const status = manager.nowStatus()
      expect(status.positions[secretDoc]).toBeUndefined()
      expect(status.extracting.some((e) => e.path === secretDoc)).toBe(false)
    } finally {
      manager.close()
    }
  })

  it('16. Search and document-memory:read immediately respect updated rules even before background reconciliation finishes', async () => {
    const secretDoc = join(rootA, 'immediate-secret.docx')
    writeFileSync(secretDoc, 'immediate confidential payload')

    const memDir = join(tempDir, 'doc-mem-immediate-16')
    mkdirSync(memDir, { recursive: true })
    const manager = new DocumentMemoryManager(memDir, {
      initialEnabled: true,
      workerTimeoutMs: 5_000,
    })

    try {
      setActiveIgnoreRules([
        { id: 'r-imm-sec', pattern: 'immediate-secret.docx', enabled: true, scope: 'global' },
      ])

      const readRes = await manager.readNowDocument(secretDoc)
      expect(readRes.ok).toBe(false)
      expect(readRes.error).toBe('unavailable')

      const searchRes = await manager.search('confidential', 10)
      expect(searchRes.hits.filter((h) => h.path === secretDoc)).toHaveLength(0)
    } finally {
      manager.close()
    }
  })

  it('17. Atomic replacement, rename away/into place, nameless watcher event (null), and watcher catch-up recovery refresh .genofficeignore without indexing it as a document', async () => {
    const reconciles: string[] = []
    const indexedBatches: string[][] = []
    const fileIndexRefreshes: number[] = []
    let emitWatchEvent: ((name: string | null) => void) | null = null
    let currentWatcher: FakeFsWatcher | null = null

    const controller = createIgnoreReconcileController({
      getFolderScan: () => ({
        folders: () => [{ root: rootA } as never],
        reconcile: async (root) => {
          reconciles.push(`ctrl:${root}`)
          return { ok: true }
        },
      }),
      onRefreshFileIndex: () => {
        fileIndexRefreshes.push(Date.now())
      },
      debounceMs: 15,
    })

    const watcher = new FolderWatchManager(
      {
        watchedRoots: () => [rootA],
        onRootsChanged: () => () => {},
        reconcile: async (root) => {
          reconciles.push(`watch:${root}`)
          return { ok: true }
        },
      },
      {
        isEnabled: () => true,
        onEnabledChange: () => () => {},
        handleFileEvents: async (paths) => {
          indexedBatches.push(paths)
        },
      },
      {
        debounceMs: 15,
        dirReconcileDelayMs: 15,
        minReconcileGapMs: 10,
        retryBaseMs: 15,
        retryMaxMs: 30,
        watch: ((
          _root: string,
          _opts: unknown,
          listener: (type: string, name: string | null) => void,
        ) => {
          const w = new FakeFsWatcher()
          currentWatcher = w
          emitWatchEvent = (name) => listener('rename', name)
          return w
        }) as never,
      },
    )

    try {
      watcher.sync()
      const docA = join(rootA, 'alpha.docx')
      const docB = join(rootA, 'beta.docx')
      const docC = join(rootA, 'gamma.docx')
      writeFileSync(docA, 'alpha')
      writeFileSync(docB, 'beta')
      writeFileSync(docC, 'gamma')

      const dotIgnorePath = join(rootA, '.genofficeignore')
      const tmpIgnorePath = join(rootA, '.genofficeignore.tmp')
      const backupIgnorePath = join(rootA, '.genofficeignore.bak')

      // Case 4: Atomic replacement via temporary file rename over .genofficeignore
      writeFileSync(tmpIgnorePath, 'alpha.docx\n')
      renameSync(tmpIgnorePath, dotIgnorePath)
      emitWatchEvent!('.genofficeignore')

      await vi.waitFor(() => expect(isPathIgnored(docA, rootA)).toBe(true), { timeout: 2_000 })
      await vi.waitFor(() => expect(fileIndexRefreshes.length).toBeGreaterThanOrEqual(1), {
        timeout: 2_000,
      })

      // Case 5: Renamed away (.genofficeignore -> .genofficeignore.bak)
      renameSync(dotIgnorePath, backupIgnorePath)
      emitWatchEvent!('.genofficeignore')
      await vi.waitFor(() => expect(isPathIgnored(docA, rootA)).toBe(false), { timeout: 2_000 })

      // Case 6: Renamed into place (.genofficeignore.bak -> .genofficeignore)
      writeFileSync(backupIgnorePath, 'beta.docx\n')
      renameSync(backupIgnorePath, dotIgnorePath)
      emitWatchEvent!('.genofficeignore')
      await vi.waitFor(() => expect(isPathIgnored(docB, rootA)).toBe(true), { timeout: 2_000 })

      // Case 7: Watcher emits an event without a filename (name === null) after .genofficeignore changes
      const prevRefreshes = fileIndexRefreshes.length
      writeFileSync(dotIgnorePath, 'gamma.docx\n')
      emitWatchEvent!(null)
      await vi.waitFor(
        () => {
          expect(isPathIgnored(docC, rootA)).toBe(true)
          expect(isPathIgnored(docB, rootA)).toBe(false)
          expect(fileIndexRefreshes.length).toBeGreaterThan(prevRefreshes)
        },
        { timeout: 2_000 },
      )

      // Case 8 & 9: Watcher temporarily unavailable / error recovery (needsCatchUp)
      writeFileSync(dotIgnorePath, 'alpha.docx\nbeta.docx\n')
      currentWatcher!.emit('error', new Error('simulated mount glitch'))
      await vi.waitFor(
        () => {
          expect(isPathIgnored(docA, rootA)).toBe(true)
          expect(isPathIgnored(docB, rootA)).toBe(true)
          expect(isPathIgnored(docC, rootA)).toBe(false)
        },
        { timeout: 2_000 },
      )

      // .genofficeignore must never be passed as an indexable document
      expect(indexedBatches.flat().some((p) => p.endsWith('.genofficeignore'))).toBe(false)
    } finally {
      watcher.close()
      controller.dispose()
    }
  })

  it('18. Concurrent policy changes while reconcile(root) is in flight coalesce without duplicate concurrent scans', async () => {
    let activeForRootA = 0
    let maxConcurrentForRootA = 0
    let totalCallsForRootA = 0
    let releaseFirstCall: (() => void) | null = null

    const controller = createIgnoreReconcileController({
      getFolderScan: () => ({
        folders: () => [{ root: rootA } as never],
        reconcile: async () => {
          totalCallsForRootA++
          activeForRootA++
          if (activeForRootA > maxConcurrentForRootA) {
            maxConcurrentForRootA = activeForRootA
          }
          if (totalCallsForRootA === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstCall = resolve
            })
          }
          activeForRootA--
          return { ok: true }
        },
      }),
      debounceMs: 10,
    })

    try {
      setActiveIgnoreRules([{ id: 'c1', pattern: '*.one', enabled: true, scope: rootA }])
      await vi.waitFor(() => expect(totalCallsForRootA).toBe(1), { timeout: 2_000 })

      // Trigger multiple policy updates while the first reconcile(rootA) is still running
      setActiveIgnoreRules([{ id: 'c2', pattern: '*.two', enabled: true, scope: rootA }])
      setActiveIgnoreRules([{ id: 'c3', pattern: '*.three', enabled: true, scope: rootA }])
      await new Promise((r) => setTimeout(r, 40))
      expect(maxConcurrentForRootA).toBe(1)

      releaseFirstCall!()
      await vi.waitFor(() => expect(totalCallsForRootA).toBe(2), { timeout: 2_000 })
      expect(maxConcurrentForRootA).toBe(1)
    } finally {
      controller.dispose()
    }
  })
})
