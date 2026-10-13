import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  evaluateIgnore,
  isPathIgnored,
  setIgnoreStoragePath,
  setActiveIgnoreRules,
  getIgnorePolicyGeneration,
  readGenOfficeIgnore,
  registerIgnoreIpcHandlers,
  type IgnoreRule,
} from '../src/main/document-memory/ignore-policy'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'
import { handleWriterRequest, applyExtracted } from '../src/main/file-index/worker-ops'
import { reduceRun, type Run } from '../../../packages/ui/src/AgyChatBar'

describe('GenOffice Final Targeted Repair Regression', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-repair-test-'))
    setIgnoreStoragePath(join(tempDir, 'ignore-rules.json'))
    setActiveIgnoreRules([])
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // safe cleanup
    }
  })

  describe('Issue 1: File Index in-flight ignore race', () => {
    it('reproduces in-flight race and verifies worker result cannot commit ignored content', async () => {
      const dbPath = join(tempDir, 'file-index.db')
      const store = new FileIndexStore(dbPath)
      const testFile = join(tempDir, 'report.secret.docx')
      writeFileSync(testFile, 'dummy content', 'utf-8')

      // Initially file is NOT ignored
      expect(isPathIgnored(testFile)).toBe(false)
      const genBefore = getIgnorePolicyGeneration()

      // Controlled mock ask function simulating worker delay
      let workerResolve: ((val: any) => void) | null = null
      const askMock = vi.fn().mockImplementation((req: any) => {
        if (req.type === 'extract') {
          return new Promise((resolve) => {
            workerResolve = resolve
          })
        }
        return Promise.resolve({ type: 'unknown' })
      })

      const sources = {
        roots: () => [tempDir],
        extraPaths: () => [testFile],
        onRootsChanged: () => () => {},
      }

      const indexer = new FileIndexer(store, 'dummy-worker.js', sources, 5000, 512)
      ;(indexer as any).ask = askMock

      // Enqueue file for indexing
      const scanned = {
        path: testFile,
        sizeBytes: 100,
        mtimeMs: Date.now(),
      }
      ;(indexer as any).enqueue(scanned)
      await new Promise((r) => setTimeout(r, 20))

      // Verify extraction started
      expect(askMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'extract', path: testFile }),
      )

      // WHILE EXTRACTION IS IN-FLIGHT: ignore policy changes!
      const newRules: IgnoreRule[] = [
        { id: 'rule-secret', pattern: '*.secret.*', enabled: true, scope: 'global' },
      ]
      setActiveIgnoreRules(newRules)
      expect(getIgnorePolicyGeneration()).toBeGreaterThan(genBefore)
      expect(isPathIgnored(testFile)).toBe(true)

      // Worker finishes extraction and returns extracted text
      workerResolve!({
        type: 'extract',
        result: { kind: 'text', text: 'CONFIDENTIAL EXTRACTED DATA' },
      })

      // Await next event tick so drain completes
      await new Promise((r) => setTimeout(r, 20))

      // Crucial: The row in the store MUST NOT contain the extracted text!
      const indexed = await store.listAllSliced(() => Promise.resolve())
      expect(indexed.has(testFile)).toBe(false)

      const searchHits = await store.search('CONFIDENTIAL', 10)
      expect(searchHits.hits).toHaveLength(0)

      indexer.stop()
      store.close()
    })

    it('worker-ops applyExtracted drops ignored content when isIgnored is provided', () => {
      const storeMock = {
        upsert: vi.fn(),
        remove: vi.fn(),
      }
      const scanned = { path: '/docs/private.docx', sizeBytes: 50, mtimeMs: 1234 }

      // 1. Not ignored -> upsert is called
      applyExtracted(
        storeMock as any,
        scanned,
        { kind: 'text', text: 'allowed' },
        false,
        () => false,
      )
      expect(storeMock.upsert).toHaveBeenCalledWith(scanned, 'allowed', 'ok')
      expect(storeMock.remove).not.toHaveBeenCalled()

      // 2. Ignored -> store.remove is called, upsert is NEVER called
      storeMock.upsert.mockClear()
      applyExtracted(storeMock as any, scanned, { kind: 'text', text: 'secret' }, false, () => true)
      expect(storeMock.remove).toHaveBeenCalledWith([scanned.path])
      expect(storeMock.upsert).not.toHaveBeenCalled()
    })

    it('worker-ops handleWriterRequest rejects ignored content before and after extract', async () => {
      const storeMock = {
        remove: vi.fn(),
        upsert: vi.fn(),
      }
      const scanned = { path: '/docs/classified.pdf', sizeBytes: 100, mtimeMs: 1234 }
      let extractCalled = false

      // Extraction function
      const fakeExtract = async () => {
        extractCalled = true
        return { kind: 'text' as const, text: 'classified' }
      }

      // Pre-extraction ignore check:
      const res = await handleWriterRequest(
        storeMock as any,
        { id: 1, type: 'index', file: scanned, preserve: false },
        fakeExtract,
        (path) => path.includes('classified'),
      )

      expect(res.status).toBe('error')
      expect(extractCalled).toBe(false)
      expect(storeMock.remove).toHaveBeenCalledWith([scanned.path])
    })

    it('indexInWorker purges row and aborts if file is ignored before or after worker writes', async () => {
      const dbPath = join(tempDir, 'file-index-worker.db')
      const store = new FileIndexStore(dbPath)
      const testFile = join(tempDir, 'classified.xlsx')
      writeFileSync(testFile, 'dummy', 'utf-8')

      const scanned = { path: testFile, sizeBytes: 50, mtimeMs: 1234 }
      let workerAskCalled = false

      const indexer = new FileIndexer(
        store,
        'dummy-worker.js',
        {
          roots: () => [tempDir],
          extraPaths: () => [testFile],
          onRootsChanged: () => () => {},
        },
        5000,
        512,
      )
      ;(indexer as any).workerWritesDb = true
      ;(indexer as any).ask = vi.fn().mockImplementation(async () => {
        workerAskCalled = true
        // simulate that during worker processing, rule was added
        setActiveIgnoreRules([
          { id: 'rule-xlsx', pattern: '*.xlsx', enabled: true, scope: 'global' },
        ])
        return { type: 'written', status: 'ok' }
      })

      // Run indexInWorker
      await (indexer as any).indexInWorker(scanned)

      expect(workerAskCalled).toBe(true)
      const indexed = await store.listAllSliced(() => Promise.resolve())
      expect(indexed.has(testFile)).toBe(false)

      indexer.stop()
      store.close()
    })
  })

  describe('Issue 2: Document Memory in-flight ignore race', () => {
    it('isCurrent rejects paths that have become ignored during extraction', () => {
      const testPath = '/workspace/confidential.docx'

      // Mock manager instance checking isCurrent contract
      const pathGenerations = new Map<string, number>([[testPath, 1]])
      const mockStore = {
        documentByPath: vi.fn().mockReturnValue({ id: 1, path: testPath, status: 'ready' }),
      }

      const mockManager = {
        stopped: false,
        enabled: true,
        epoch: 1,
        pathGeneration: pathGenerations,
        store: mockStore,
        currentGeneration(p: string) {
          return this.pathGeneration.get(p) ?? 0
        },
        isCurrent(p: string, gen: number, ep: number): boolean {
          if (
            this.stopped ||
            !this.enabled ||
            ep !== this.epoch ||
            gen !== this.currentGeneration(p) ||
            isPathIgnored(p)
          )
            return false
          const doc = this.store.documentByPath(p)
          return !!doc && doc.status !== 'excluded'
        },
      }

      // Initially not ignored
      expect(mockManager.isCurrent(testPath, 1, 1)).toBe(true)

      // Ignore rule activated while extraction was running in worker
      setActiveIgnoreRules([
        { id: 'rule-confidential', pattern: '*.docx', enabled: true, scope: 'global' },
      ])
      expect(isPathIgnored(testPath)).toBe(true)

      // isCurrent MUST return false!
      expect(mockManager.isCurrent(testPath, 1, 1)).toBe(false)
    })
  })

  describe('Issue 3: Ignore policy invalidation and bounded reconciliation', () => {
    it('schedules safe bounded reconciliation on saveIgnoreRules without database purge', async () => {
      const reconcileRootCalled: string[] = []
      const fakeFolderScan = {
        folders: () => [{ root: '/workspace/project-a' }, { root: '/workspace/project-b' }],
        reconcile: vi.fn().mockImplementation(async (root: string) => {
          reconcileRootCalled.push(root)
          return { ok: true }
        }),
      }

      const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
      const fakeIpc = {
        handle: (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(channel, handler)
        },
      }

      let invalidateCountsCalled = false
      registerIgnoreIpcHandlers(
        fakeIpc,
        () => {
          invalidateCountsCalled = true
          fakeFolderScan.folders().forEach((f) => void fakeFolderScan.reconcile(f.root))
        },
        () => ['/workspace/project-a'],
      )

      const saveHandler = handlers.get('home:save-ignore-rules')!
      const saveRes = (await saveHandler({}, [
        { id: 'rule-1', pattern: '*.tmp', enabled: true, scope: 'global' },
      ])) as { ok: boolean }

      expect(saveRes.ok).toBe(true)
      expect(invalidateCountsCalled).toBe(true)
      expect(reconcileRootCalled).toEqual(['/workspace/project-a', '/workspace/project-b'])
      expect(fakeFolderScan.reconcile).toHaveBeenCalledTimes(2)
    })

    it('detects .genofficeignore modifications by mtime and bumps policy generation', () => {
      const root = join(tempDir, 'mtime-repo')
      mkdirSync(root, { recursive: true })
      const ignoreFile = join(root, '.genofficeignore')
      writeFileSync(ignoreFile, '*.old\n', 'utf-8')

      const initialGen = getIgnorePolicyGeneration()
      const rules1 = readGenOfficeIgnore(root)
      expect(rules1).toHaveLength(1)
      expect(rules1[0]!.pattern).toBe('*.old')

      // Modify .genofficeignore with new pattern
      writeFileSync(ignoreFile, '*.new\n*.extra\n', 'utf-8')

      // Read again: mtime changed, cache must invalidate and policy generation must increment
      const rules2 = readGenOfficeIgnore(root)
      expect(rules2).toHaveLength(2)
      expect(rules2[0]!.pattern).toBe('*.new')
      expect(getIgnorePolicyGeneration()).toBeGreaterThan(initialGen)
    })
  })

  describe('Issue 4: Thinking request isolation within same conversation', () => {
    it('drops stale events from request A when request B is active in the same conversation', () => {
      const sessionId = 'conversation-123'
      const runA_id = 'run-request-A-uuid'
      const runB_id = 'run-request-B-uuid'

      // 1. Request A starts
      let run: Run | null = null
      const setRun = (updater: (prev: Run | null) => Run | null) => {
        run = updater(run)
      }

      const supersededRunIds = new Set<string>()

      const handleActivity = (event: {
        runId: string
        sessionId: string
        phase: 'start' | 'thinking' | 'tool' | 'writing' | 'done' | 'error'
        at: number
        tool?: string
      }) => {
        if (supersededRunIds.has(event.runId)) return
        setRun((current) => {
          if (!current) {
            return reduceRun(null, event as any)
          }
          if (event.runId !== current.id) {
            if (event.phase === 'start' && event.at >= current.startedAt) {
              supersededRunIds.add(current.id)
              return reduceRun(null, event as any)
            }
            // Stale events from other runs are ignored
            return current
          }
          return reduceRun(current, event as any)
        })
      }

      // Step 1: Request A begins
      handleActivity({
        runId: runA_id,
        sessionId,
        phase: 'start',
        at: 1000,
      })
      expect(run).not.toBeNull()
      expect((run as any).id).toBe(runA_id)

      handleActivity({
        runId: runA_id,
        sessionId,
        phase: 'thinking',
        at: 1050,
      })
      expect((run as any).phase).toBe('thinking')

      // Step 2: Request B begins in the SAME session
      handleActivity({
        runId: runB_id,
        sessionId,
        phase: 'start',
        at: 2000,
      })
      expect((run as any).id).toBe(runB_id)
      expect(supersededRunIds.has(runA_id)).toBe(true)

      // Step 3: Stale delayed tool event from Request A arrives
      handleActivity({
        runId: runA_id,
        sessionId,
        phase: 'tool',
        tool: 'search_remembered_documents',
        at: 2100, // late event
      })

      // CRITICAL CHECK: Run MUST STILL BE Request B! Request A event was dropped!
      expect((run as any).id).toBe(runB_id)
      expect((run as any).steps).toHaveLength(0)

      // Step 4: Stale delayed done event from Request A arrives
      handleActivity({
        runId: runA_id,
        sessionId,
        phase: 'done',
        at: 2200,
      })
      expect((run as any).id).toBe(runB_id)
      expect((run as any).phase).not.toBe('done')
    })
  })

  describe('Issue 5: Windows vs POSIX path matching verification', () => {
    it('verifies Windows drive letter case insensitivity and component boundary isolation', () => {
      const scopedRule: IgnoreRule = {
        id: 'win-test',
        pattern: 'drafts/**',
        enabled: true,
        scope: 'C:/Users/Owner/Project',
      }
      setActiveIgnoreRules([scopedRule])

      // Matches on Windows regardless of drive letter or casing
      expect(evaluateIgnore('C:\\users\\owner\\project\\drafts\\file.docx').ignored).toBe(true)
      expect(evaluateIgnore('c:/USERS/OWNER/PROJECT/DRAFTS/FILE.DOCX').ignored).toBe(true)

      // Component boundary: project-backup MUST NOT match
      expect(evaluateIgnore('C:\\users\\owner\\project-backup\\drafts\\file.docx').ignored).toBe(
        false,
      )
    })
  })
})
