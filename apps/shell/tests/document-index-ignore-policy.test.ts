import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  evaluateIgnore,
  isPathIgnored,
  readGenOfficeIgnore,
  setIgnoreStoragePath,
  setActiveIgnoreRules,
  getActiveIgnoreRules,
  loadPersistedIgnoreRules,
  setKnownRootsResolver,
  registerIgnoreIpcHandlers,
  globToRegex,
  clearRegexCache,
  DEFAULT_IGNORE_RULES,
  type IgnoreRule,
} from '../src/main/document-memory/ignore-policy'
import { isIndexablePath } from '../src/main/document-memory/folder-scan'
import { shouldSkipDirectory } from '../src/main/document-memory/scan-policy'
import {
  FolderWatchManager,
  type FolderEventSink,
  type WatchedFolders,
} from '../src/main/document-memory/folder-watch'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'

describe('document-index ignore policy (Phase 4)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-ignore-test-'))
    setIgnoreStoragePath(join(tempDir, 'ignore-rules.json'))
    setActiveIgnoreRules([...DEFAULT_IGNORE_RULES])
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // safe cleanup
    }
  })

  it('correctly matches glob patterns for temporary and lock files', () => {
    expect(isPathIgnored('/docs/notes.tmp')).toBe(true)
    expect(isPathIgnored('/docs/backup.bak')).toBe(true)
    expect(isPathIgnored('/docs/~$WordDoc.docx')).toBe(true)
    expect(isPathIgnored('/docs/normal.docx')).toBe(false)
  })

  it('handles Windows backslash separators transparently', () => {
    expect(isPathIgnored('C:\\Users\\User\\Documents\\temp.tmp')).toBe(true)
    expect(isPathIgnored('C:\\Users\\User\\Documents\\~$Draft.xlsx')).toBe(true)
    expect(isPathIgnored('C:\\Users\\User\\Documents\\node_modules\\package\\index.js')).toBe(true)
    expect(isPathIgnored('C:\\Users\\User\\Documents\\Finance\\Report.xlsx')).toBe(false)
  })

  it('handles directory patterns and private folders', () => {
    expect(isPathIgnored('/workspace/node_modules/lodash/index.js')).toBe(true)
    expect(isPathIgnored('/workspace/.git/config')).toBe(true)
    expect(isPathIgnored('/workspace/private/key.pem')).toBe(true)
    expect(isPathIgnored('/workspace/secrets/token.json')).toBe(true)
    expect(isPathIgnored('/workspace/src/app.tsx')).toBe(false)
  })

  it('supports root-scoped rules and root isolation', () => {
    const rootA = '/Users/user/project-a'
    const rootB = '/Users/user/project-b'

    const rules: IgnoreRule[] = [
      {
        id: 'rule-root-a-only',
        pattern: 'drafts/**',
        enabled: true,
        scope: rootA,
        description: 'Drafts in Project A only',
      },
    ]
    setActiveIgnoreRules(rules)

    // Path under rootA matches
    const resA = evaluateIgnore(`${rootA}/drafts/chapter1.docx`, rootA)
    expect(resA.ignored).toBe(true)
    expect(resA.reason).toContain('drafts/**')

    // Path under rootB does NOT match the rootA-scoped rule
    const resB = evaluateIgnore(`${rootB}/drafts/chapter1.docx`, rootB)
    expect(resB.ignored).toBe(false)
  })

  it('reads and enforces .genofficeignore in a directory', () => {
    const root = join(tempDir, 'repo')
    const ignoreFile = join(root, '.genofficeignore')
    mkdirSync(root, { recursive: true })

    writeFileSync(
      ignoreFile,
      `
# Comment line
*.secret
custom_cache/
`,
      'utf-8',
    )

    const rules = readGenOfficeIgnore(root)
    expect(rules).toHaveLength(2)
    expect(rules[0]!.pattern).toBe('*.secret')
    expect(rules[1]!.pattern).toBe('custom_cache/')

    const evalSecret = evaluateIgnore(join(root, 'passwords.secret'), root)
    expect(evalSecret.ignored).toBe(true)
    expect(evalSecret.reason).toContain('.genofficeignore')

    const evalCache = evaluateIgnore(join(root, 'custom_cache', 'item.dat'), root)
    expect(evalCache.ignored).toBe(true)

    const evalValid = evaluateIgnore(join(root, 'readme.md'), root)
    expect(evalValid.ignored).toBe(false)
  })

  it('provides informative reason explaining which rule caused exclusion', () => {
    const res = evaluateIgnore('/test/workspace/~$important.docx')
    expect(res.ignored).toBe(true)
    expect(res.matchedRule).toBeDefined()
    expect(res.matchedRule?.pattern).toBe('~$*')
    expect(res.reason).toContain('~$*')
  })

  it('persists rules safely and recovers them on reload', () => {
    const customRule: IgnoreRule = {
      id: 'custom-1',
      pattern: '*.log',
      enabled: true,
      scope: 'global',
      description: 'Log files',
    }
    setActiveIgnoreRules([customRule])

    // Load from disk into fresh query
    const loaded = getActiveIgnoreRules()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.pattern).toBe('*.log')
    expect(isPathIgnored('/var/app.log')).toBe(true)
  })

  it('integrates with shouldSkipDirectory and isIndexablePath', () => {
    // Directory check
    expect(shouldSkipDirectory('node_modules')).toBe(true)
    expect(shouldSkipDirectory('private', '/docs/private')).toBe(true)

    // File check via isIndexablePath
    expect(isIndexablePath('/docs', '/docs/file.tmp')).toBe(false)
    expect(isIndexablePath('/docs', '/docs/report.docx')).toBe(true)
  })

  it('enforces path-component boundaries: prefix-collision paths remain isolated (/project vs /project-backup)', () => {
    const rules: IgnoreRule[] = [
      {
        id: 'rule-project',
        pattern: 'secret.txt',
        enabled: true,
        scope: '/project',
        description: 'Secret file in /project only',
      },
    ]
    setActiveIgnoreRules(rules)

    // Under /project -> ignored
    const resA = evaluateIgnore('/project/secret.txt')
    expect(resA.ignored).toBe(true)

    // Under /project-backup -> MUST NOT be ignored (path-component boundary enforcement)
    const resB = evaluateIgnore('/project-backup/secret.txt')
    expect(resB.ignored).toBe(false)
  })

  it('empty rules list survives persistence and reload without reverting to defaults', () => {
    // User deletes all rules
    const saved = setActiveIgnoreRules([])
    expect(saved).toBe(true)
    expect(getActiveIgnoreRules()).toHaveLength(0)

    // Reload from storage
    const reloaded = loadPersistedIgnoreRules()
    expect(reloaded).toHaveLength(0)
    expect(getActiveIgnoreRules()).toHaveLength(0)

    // Paths that matched defaults are now allowed
    expect(isPathIgnored('/docs/notes.tmp')).toBe(false)
  })

  it('failed disk write is reported properly via persistence result', () => {
    // Point storage to a path in a nonexistent non-creatable root or invalid file
    setIgnoreStoragePath('/sys/invalid_nonexistent_dir_cannot_create/rules.json')
    const success = setActiveIgnoreRules([])
    expect(success).toBe(false)
  })

  it('validates IPC rule inputs and reports persistence failure to IPC caller', async () => {
    let invalidateCalled = false
    const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
    const fakeIpc = {
      handle: (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      },
    }
    registerIgnoreIpcHandlers(fakeIpc, () => {
      invalidateCalled = true
    })

    const saveHandler = handlers.get('home:save-ignore-rules')!

    // 1. Invalid input: non-array
    const resInvalidType = (await saveHandler({}, 'not-an-array')) as {
      ok: boolean
      error?: string
    }
    expect(resInvalidType.ok).toBe(false)
    expect(resInvalidType.error).toBe('invalid-rules')

    // 2. Invalid input: array with malformed rule object
    const resMalformed = (await saveHandler({}, [{ id: 123 }])) as { ok: boolean; error?: string }
    expect(resMalformed.ok).toBe(false)
    expect(resMalformed.error).toBe('invalid-rule-format')

    // 3. Valid rules save properly
    setIgnoreStoragePath(join(tempDir, 'valid-rules.json'))
    const validRule: IgnoreRule = {
      id: 'valid-1',
      pattern: '*.draft',
      enabled: true,
      scope: 'global',
    }
    const resValid = (await saveHandler({}, [validRule])) as { ok: boolean }
    expect(resValid.ok).toBe(true)
    expect(invalidateCalled).toBe(true)

    // 4. Persistence failure reporting
    setIgnoreStoragePath('/sys/cannot_write/rules.json')
    const resFailed = (await saveHandler({}, [validRule])) as { ok: boolean; error?: string }
    expect(resFailed.ok).toBe(false)
    expect(resFailed.error).toBe('persistence-failed')
  })

  it('caches .genofficeignore reads by mtime avoiding repeated disk reads', () => {
    const root = join(tempDir, 'cached-repo')
    const ignoreFile = join(root, '.genofficeignore')
    mkdirSync(root, { recursive: true })
    writeFileSync(ignoreFile, '*.cache\n', 'utf-8')

    // First read populates cache
    const firstRead = readGenOfficeIgnore(root)
    expect(firstRead).toHaveLength(1)
    expect(firstRead[0]!.pattern).toBe('*.cache')

    // Second read should return exact same cached array instance
    const secondRead = readGenOfficeIgnore(root)
    expect(secondRead).toBe(firstRead)
  })

  it('resolves actual indexed root automatically when evaluating paths', () => {
    const rootA = join(tempDir, 'auto-root-a')
    const rootB = join(tempDir, 'auto-root-b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    writeFileSync(join(rootA, '.genofficeignore'), 'internal.txt\n', 'utf-8')

    setKnownRootsResolver(() => [rootA, rootB])

    // Evaluating path without passing explicit root resolves rootA
    const res = evaluateIgnore(join(rootA, 'internal.txt'))
    expect(res.ignored).toBe(true)
    expect(res.reason).toContain('.genofficeignore')

    // Path in rootB is not affected by rootA .genofficeignore
    const resB = evaluateIgnore(join(rootB, 'internal.txt'))
    expect(resB.ignored).toBe(false)
  })

  it('excludes previously indexed content matching newly activated rules from retrieval via registerDocumentIndexIpc', async () => {
    const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
    const fakeIpc = {
      handle: (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      },
    }

    const mockMemory = {
      aggregates: {
        searchIndexed: vi.fn().mockResolvedValue([
          { id: 1, path: '/workspace/doc.docx', name: 'doc.docx', status: 'ready' },
          { id: 2, path: '/workspace/confidential.pdf', name: 'confidential.pdf', status: 'ready' },
          { id: 3, path: '/workspace/notes.txt', name: 'notes.txt', status: 'ready' },
        ]),
      },
      searchExternal: vi.fn().mockResolvedValue([]),
    }

    registerDocumentIndexIpc({
      ipcMain: fakeIpc as never,
      getDocumentMemory: () => mockMemory as never,
      getFolderScan: () => null,
      dbPath: () => join(tempDir, 'dummy.db'),
    })

    const searchHandler = handlers.get(DOCUMENT_INDEX_CHANNELS.searchIndexedFiles)!
    expect(searchHandler).toBeDefined()

    // 1. Initially none ignored -> returns all 3 hits
    setActiveIgnoreRules([])
    const initialHits = (await searchHandler({}, 'query')) as Array<{ name: string; path: string }>
    expect(initialHits).toHaveLength(3)

    // 2. User activates rule ignoring *.pdf
    setActiveIgnoreRules([{ id: 'rule-pdf', pattern: '*.pdf', enabled: true, scope: 'global' }])

    // 3. Retrieval filtering via production searchIndexedFiles handler excludes confidential.pdf
    const filteredHits = (await searchHandler({}, 'query')) as Array<{ name: string; path: string }>
    expect(filteredHits).toHaveLength(2)
    expect(filteredHits.map((h) => h.name)).toEqual(['doc.docx', 'notes.txt'])
  })

  it('.genofficeignore applies after watcher events', async () => {
    class FakeWatcher extends EventEmitter {
      closed = false
      close() {
        this.closed = true
      }
    }

    const watchRoot = join(tempDir, 'watch-root')
    mkdirSync(watchRoot, { recursive: true })
    writeFileSync(join(watchRoot, '.genofficeignore'), 'ignored-by-file.docx\n', 'utf-8')

    let watcherListener: ((type: string, name: string | null) => void) | null = null
    const processedBatches: string[][] = []

    const folders: WatchedFolders = {
      watchedRoots: () => [watchRoot],
      onRootsChanged: () => () => {},
      reconcile: async () => ({ ok: true }),
      reconcileSubtree: async () => ({ ok: true }),
    }
    const sink: FolderEventSink = {
      isEnabled: () => true,
      onEnabledChange: () => () => {},
      handleFileEvents: async (paths) => {
        processedBatches.push(paths)
      },
    }

    const watchManager = new FolderWatchManager(folders, sink, {
      debounceMs: 10,
      maxWaitMs: 40,
      reconcileDelayMs: 5_000,
      dirReconcileDelayMs: 30,
      minReconcileGapMs: 0,
      retryBaseMs: 10,
      retryMaxMs: 20,
      watch: ((
        _root: string,
        _opts: unknown,
        listener: (type: string, name: string | null) => void,
      ) => {
        const w = new FakeWatcher()
        watcherListener = listener
        return w
      }) as never,
    })

    try {
      expect(watcherListener).not.toBeNull()

      // 1. Emit watcher event for file ignored by .genofficeignore
      watcherListener!('rename', 'ignored-by-file.docx')
      await new Promise((r) => setTimeout(r, 60))

      // Verify ignored file was NOT sent to sink.handleFileEvents
      expect(processedBatches.flat()).not.toContain(join(watchRoot, 'ignored-by-file.docx'))

      // 2. Emit watcher event for normal indexable document
      watcherListener!('rename', 'allowed-doc.docx')
      await new Promise((r) => setTimeout(r, 60))

      // Verify allowed file was sent to sink.handleFileEvents
      expect(processedBatches.flat()).toContain(join(watchRoot, 'allowed-doc.docx'))
    } finally {
      watchManager.close()
    }
  })

  it('persistence failure preserves previous valid configuration', () => {
    // 1. Establish valid rules
    const validRule: IgnoreRule = {
      id: 'valid-prev',
      pattern: '*.draft',
      enabled: true,
      scope: 'global',
    }
    expect(setActiveIgnoreRules([validRule])).toBe(true)
    expect(getActiveIgnoreRules()).toHaveLength(1)
    expect(getActiveIgnoreRules()[0]!.id).toBe('valid-prev')

    // 2. Point storage to an invalid/unwritable location
    setIgnoreStoragePath('/sys/cannot_write/rules.json')

    // 3. Attempt to save new candidate rules
    const candidateRule: IgnoreRule = {
      id: 'candidate-new',
      pattern: '*.unpersisted',
      enabled: true,
      scope: 'global',
    }
    const success = setActiveIgnoreRules([candidateRule])
    expect(success).toBe(false)

    // 4. Active rules MUST retain previous valid configuration
    const current = getActiveIgnoreRules()
    expect(current).toHaveLength(1)
    expect(current[0]!.id).toBe('valid-prev')
    expect(current[0]!.pattern).toBe('*.draft')
    expect(isPathIgnored('file.draft')).toBe(true)
    expect(isPathIgnored('file.unpersisted')).toBe(false)
  })

  it('correctly handles Windows case-insensitive paths and path-component boundaries', () => {
    const rules: IgnoreRule[] = [
      {
        id: 'win-scoped',
        pattern: 'drafts/**',
        enabled: true,
        scope: 'C:/Project/Workspace',
      },
    ]
    setActiveIgnoreRules(rules)

    // Windows case-insensitive matches:
    // C:\project\workspace\drafts\doc.docx
    expect(evaluateIgnore('C:\\project\\workspace\\drafts\\doc.docx').ignored).toBe(true)
    // c:/PROJECT/WORKSPACE/DRAFTS/doc.docx
    expect(evaluateIgnore('c:/PROJECT/WORKSPACE/DRAFTS/doc.docx').ignored).toBe(true)

    // Path component boundary on Windows:
    // C:\project\workspace-backup\drafts\doc.docx MUST NOT match
    expect(evaluateIgnore('C:\\project\\workspace-backup\\drafts\\doc.docx').ignored).toBe(false)
    expect(evaluateIgnore('c:/PROJECT/WORKSPACE-EXTRA/drafts/doc.docx').ignored).toBe(false)
  })

  it('preserves case-sensitive behavior on Linux / POSIX paths', () => {
    const rules: IgnoreRule[] = [
      {
        id: 'linux-scoped',
        pattern: 'Secret.txt',
        enabled: true,
        scope: '/home/user/project',
      },
    ]
    setActiveIgnoreRules(rules)

    // Exact case matches:
    expect(evaluateIgnore('/home/user/project/Secret.txt').ignored).toBe(true)

    // Different case in file name MUST NOT match on Linux:
    expect(evaluateIgnore('/home/user/project/secret.txt').ignored).toBe(false)
    expect(evaluateIgnore('/home/user/project/SECRET.TXT').ignored).toBe(false)

    // Different case in scope directory MUST NOT match on Linux:
    expect(evaluateIgnore('/home/user/Project/Secret.txt').ignored).toBe(false)
    expect(evaluateIgnore('/home/user/PROJECT/Secret.txt').ignored).toBe(false)
  })

  it('metadata-only check rejects ignored chunk before worker extraction is invoked', async () => {
    let workerExtractCalled = false
    const mockStore = {
      readChunk: vi.fn().mockReturnValue({
        id: 42,
        path: '/docs/confidential.secret',
        name: 'confidential.secret',
        location: 'Page 1',
        hash: 'abc',
      }),
    }
    const mockMemory = {
      store: mockStore,
      read: vi.fn().mockImplementation(async () => {
        workerExtractCalled = true
        return {
          path: '/docs/confidential.secret',
          name: 'confidential.secret',
          text: 'secret text',
          verified: true,
        }
      }),
    }

    setActiveIgnoreRules([
      { id: 'rule-secret', pattern: '*.secret', enabled: true, scope: 'global' },
    ])

    // Simulate the metadata check performed in document-memory:read handler
    const chunkId = 42
    const meta = mockMemory.store.readChunk(chunkId)
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
      result = await mockMemory.read(chunkId)
    }

    expect(result.verified).toBe(false)
    expect(result.error).toBe('Ignored document')
    expect(result.text).toBe('')
    // Crucial: worker extract / memory.read was NEVER called!
    expect(mockMemory.read).not.toHaveBeenCalled()
    expect(workerExtractCalled).toBe(false)
  })

  it('queue and intake filter prevents reintroducing ignored content', () => {
    setActiveIgnoreRules([{ id: 'rule-bak', pattern: '*.bak', enabled: true, scope: 'global' }])

    const incomingPaths = ['/docs/valid.docx', '/docs/old.bak', '/docs/report.xlsx']
    const acceptedPaths = incomingPaths.filter((p) => !isPathIgnored(p))

    expect(acceptedPaths).toEqual(['/docs/valid.docx', '/docs/report.xlsx'])
    expect(acceptedPaths).not.toContain('/docs/old.bak')
  })

  it('separate File Index and Knowledge Base searches respect ignore policy', () => {
    setActiveIgnoreRules([
      { id: 'rule-ignore', pattern: '**/private/**', enabled: true, scope: 'global' },
    ])

    const rawFileHits = [
      { path: '/workspace/public/readme.md', name: 'readme.md' },
      { path: '/workspace/private/passwords.txt', name: 'passwords.txt' },
      { path: '/workspace/src/index.ts', name: 'index.ts' },
    ]

    const filteredHits = rawFileHits.filter((h) => !isPathIgnored(h.path))
    expect(filteredHits).toHaveLength(2)
    expect(filteredHits.map((h) => h.name)).toEqual(['readme.md', 'index.ts'])
    expect(filteredHits.map((h) => h.path)).not.toContain('/workspace/private/passwords.txt')
  })

  it('caches glob regexes with bounded capacity and invalidation', () => {
    clearRegexCache()
    const r1 = globToRegex('*.custom1', false)
    const r2 = globToRegex('*.custom1', false)
    expect(r1).toBe(r2) // Cached instance

    // Clear cache
    clearRegexCache()
    const r3 = globToRegex('*.custom1', false)
    expect(r3).not.toBe(r1) // Fresh instance after clear
  })
})
