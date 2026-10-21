import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IGNORE_RULES,
  applyIgnorePolicySnapshot,
  getIgnorePolicyGeneration,
  getIgnorePolicySnapshot,
  isPathIgnored,
  setActiveIgnoreRules,
  setIgnoreStoragePath,
  setKnownRootsResolver,
  type IgnoreRule,
} from '../src/main/document-memory/ignore-policy'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'
import {
  applyWorkerIgnorePolicyMessage,
  type IgnorePolicyAckResponse,
} from '../src/main/file-index/worker-ignore-policy'
import { applyExtracted, handleWriterRequest } from '../src/main/file-index/worker-ops'
import { resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'

describe('Worker Ignore Policy Integration (Real Worker & Production Ops)', () => {
  let workerBundleDir: string
  let extractWorkerPath: string
  let rootA: string
  let rootB: string
  let storeDir: string
  let dbPath: string
  let rulesFile: string
  let store: FileIndexStore
  let indexer: FileIndexer | null = null
  let rawWorker: Worker | null = null

  beforeAll(async () => {
    workerBundleDir = mkdtempSync(join(tmpdir(), 'genoffice-extract-worker-bundle-'))
    extractWorkerPath = join(workerBundleDir, 'extract-worker.cjs')
    await build({
      entryPoints: [resolve(__dirname, '../src/main/file-index/extract-worker.ts')],
      outfile: extractWorkerPath,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      logLevel: 'error',
      plugins: [
        {
          name: 'stub-electron',
          setup(b) {
            b.onResolve({ filter: /^electron$/ }, () => ({
              path: 'electron-stub',
              namespace: 'stub',
            }))
            b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              contents:
                'module.exports = { app: { isPackaged: false, getPath: () => "" }, ipcMain: { handle: () => {}, on: () => {} } };',
              loader: 'js',
            }))
          },
        },
      ],
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node:sqlite'],
      define: { 'import.meta': '__genofficeWorkerImportMeta' },
      banner: {
        js: 'const __genofficeWorkerImportMeta = { url: require("node:url").pathToFileURL(__filename).href, filename: __filename, dirname: __dirname };',
      },
      tsconfig: resolve(__dirname, '../tsconfig.json'),
    })
  })

  afterAll(() => {
    try {
      rmSync(workerBundleDir, { recursive: true, force: true })
    } catch {}
  })

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'genoffice-worker-ig-rootA-'))
    rootB = mkdtempSync(join(tmpdir(), 'genoffice-worker-ig-rootB-'))
    storeDir = mkdtempSync(join(tmpdir(), 'genoffice-worker-ig-store-'))
    dbPath = join(storeDir, 'file-index.db')
    rulesFile = join(storeDir, 'ignore-rules.json')
    setIgnoreStoragePath(rulesFile)
    setKnownRootsResolver(() => [rootA, rootB])
    setActiveIgnoreRules([])
    store = new FileIndexStore(dbPath)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    indexer?.stop()
    indexer = null
    if (rawWorker) {
      await rawWorker.terminate()
      rawWorker = null
    }
    resetIndexingPolicyBus()
    setKnownRootsResolver(null)
    store.close()
    try {
      rmSync(rootA, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(rootB, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(storeDir, { recursive: true, force: true })
    } catch {}
  })

  it('1. Worker startup receives initial Ignore rules', async () => {
    const initialRules: IgnoreRule[] = [
      { id: 'r-init', pattern: '*.secret.txt', enabled: true, scope: 'global' },
    ]
    setActiveIgnoreRules(initialRules)

    writeFileSync(join(rootA, 'allowed.txt'), 'visible content alpha')
    writeFileSync(join(rootA, 'hidden.secret.txt'), 'secret content beta')

    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
      dbPath,
    )

    await indexer.scan()
    await vi.waitFor(
      () => expect(store.listAll().get(join(rootA, 'allowed.txt'))?.status).toBe('ok'),
      { timeout: 5_000 },
    )
    expect(store.listAll().has(join(rootA, 'hidden.secret.txt'))).toBe(false)
  }, 20_000)

  it('2. Worker applies updated Ignore rules sent from main', async () => {
    setActiveIgnoreRules([{ id: 'r-1', pattern: '*.tmp', enabled: true, scope: 'global' }])
    const initialGen = getIgnorePolicyGeneration()

    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
      dbPath,
    )

    const firstAck = await indexer.syncWorkerIgnorePolicy()
    expect(firstAck.applied).toBe(true)
    expect(firstAck.version).toBe(initialGen)

    setActiveIgnoreRules([
      { id: 'r-1', pattern: '*.tmp', enabled: true, scope: 'global' },
      { id: 'r-2', pattern: 'draft-*.txt', enabled: true, scope: 'global' },
    ])
    const updatedGen = getIgnorePolicyGeneration()
    expect(updatedGen).toBeGreaterThan(initialGen)

    const secondAck = await indexer.syncWorkerIgnorePolicy()
    expect(secondAck.type).toBe('ignore-policy-ack')
    expect(secondAck.applied).toBe(true)
    expect(secondAck.version).toBe(updatedGen)
  }, 20_000)

  it('3. Worker scan excludes newly ignored paths', async () => {
    const keepFile = join(rootA, 'keep.md')
    const dropFile = join(rootA, 'classified-notes.md')
    writeFileSync(keepFile, 'public release notes')
    writeFileSync(dropFile, 'classified internal roadmap')

    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
      dbPath,
    )

    await indexer.scan()
    await vi.waitFor(() => expect(store.listAll().get(dropFile)?.status).toBe('ok'), {
      timeout: 5_000,
    })

    setActiveIgnoreRules([
      { id: 'r-classified', pattern: 'classified-*', enabled: true, scope: 'global' },
    ])
    const ack = await indexer.syncWorkerIgnorePolicy()
    expect(ack.applied).toBe(true)

    await indexer.scan()
    expect(store.listAll().has(keepFile)).toBe(true)
    expect(store.listAll().has(dropFile)).toBe(false)
    expect(store.search('classified').hits).toHaveLength(0)
  }, 20_000)

  it('4. Worker pending batch skips ignored paths', async () => {
    const allowed = { path: join(rootA, 'ok.txt'), mtimeMs: 100, sizeBytes: 12 }
    const ignored = { path: join(rootA, 'blocked.secret.txt'), mtimeMs: 100, sizeBytes: 12 }

    store.upsert(ignored, 'stale secret body', 'ok')
    expect(store.listAll().has(ignored.path)).toBe(true)

    setActiveIgnoreRules([{ id: 'r-sec', pattern: '*.secret.txt', enabled: true, scope: 'global' }])

    const res = await handleWriterRequest(
      store,
      {
        id: 10,
        type: 'pending',
        files: [allowed, ignored],
        ignorePolicy: getIgnorePolicySnapshot([rootA]),
      },
      async () => ({ kind: 'text', text: 'unused' }),
    )

    expect(res).toEqual({ id: 10, type: 'written' })
    expect(store.listAll().get(allowed.path)?.status).toBe('pending')
    expect(store.listAll().has(ignored.path)).toBe(false)
  })

  it('5. Worker pre-extraction check rejects ignored path without running extraction', async () => {
    const blocked = { path: join(rootA, 'skip-me.txt'), mtimeMs: 200, sizeBytes: 25 }
    store.upsert(blocked, 'previous content', 'ok')

    setActiveIgnoreRules([{ id: 'r-skip', pattern: 'skip-me.txt', enabled: true, scope: 'global' }])

    const extractSpy = vi.fn(async () => ({ kind: 'text' as const, text: 'extracted' }))
    const res = await handleWriterRequest(
      store,
      {
        id: 11,
        type: 'index',
        file: blocked,
        preserve: true,
        ignorePolicy: getIgnorePolicySnapshot([rootA]),
      },
      extractSpy,
    )

    expect(extractSpy).not.toHaveBeenCalled()
    expect(res.status).toBe('error')
    expect(store.listAll().has(blocked.path)).toBe(false)
  })

  it('6. Worker post-extraction check rejects path ignored while extraction is in flight', async () => {
    const inFlightFile = { path: join(rootA, 'inflight.txt'), mtimeMs: 300, sizeBytes: 40 }
    store.upsert(inFlightFile, 'old indexed text', 'ok')

    let resolveExtraction: ((value: { kind: 'text'; text: string }) => void) | null = null
    const slowExtract = vi.fn(
      () =>
        new Promise<{ kind: 'text'; text: string }>((resolve) => {
          resolveExtraction = resolve
        }),
    )

    const indexPromise = handleWriterRequest(
      store,
      {
        id: 12,
        type: 'index',
        file: inFlightFile,
        preserve: true,
        ignorePolicy: getIgnorePolicySnapshot([rootA]),
      },
      slowExtract,
    )

    await vi.waitFor(() => expect(slowExtract).toHaveBeenCalledTimes(1))

    setActiveIgnoreRules([
      { id: 'r-inflight', pattern: 'inflight.txt', enabled: true, scope: 'global' },
    ])

    resolveExtraction!({ kind: 'text', text: 'confidential new body' })
    const res = await indexPromise

    expect(res.status).toBe('error')
    expect(store.listAll().has(inFlightFile.path)).toBe(false)
    expect(store.search('confidential').hits).toHaveLength(0)
  })

  it('7. Worker never writes ok, name-only or error row for ignored path', async () => {
    const ignoredFile = { path: join(rootA, 'never-write.txt'), mtimeMs: 400, sizeBytes: 50 }
    setActiveIgnoreRules([
      { id: 'r-never', pattern: 'never-write.txt', enabled: true, scope: 'global' },
    ])

    const statusOk = applyExtracted(store, ignoredFile, { kind: 'text', text: 'secret' }, false)
    expect(statusOk).toBeUndefined()
    expect(store.listAll().has(ignoredFile.path)).toBe(false)

    const statusNameOnly = applyExtracted(store, ignoredFile, { kind: 'name-only' }, false)
    expect(statusNameOnly).toBeUndefined()
    expect(store.listAll().has(ignoredFile.path)).toBe(false)

    const statusErr = applyExtracted(
      store,
      ignoredFile,
      { kind: 'error', error: 'parse failed' },
      false,
    )
    expect(statusErr).toBeUndefined()
    expect(store.listAll().has(ignoredFile.path)).toBe(false)

    await handleWriterRequest(
      store,
      {
        id: 13,
        type: 'index-error',
        file: ignoredFile,
        preserve: false,
        error: 'worker timed out',
      },
      async () => ({ kind: 'name-only' }),
    )
    expect(store.listAll().has(ignoredFile.path)).toBe(false)
  })

  it('8. Worker removes stale row when path becomes ignored', async () => {
    const staleFile = { path: join(rootA, 'stale-record.txt'), mtimeMs: 500, sizeBytes: 60 }
    store.upsert(staleFile, 'previously indexed sensitive text', 'ok')
    expect(store.search('sensitive').hits).toHaveLength(1)

    setActiveIgnoreRules([
      { id: 'r-stale', pattern: 'stale-record.txt', enabled: true, scope: 'global' },
    ])

    await handleWriterRequest(
      store,
      {
        id: 14,
        type: 'index',
        file: staleFile,
        preserve: true,
        ignorePolicy: getIgnorePolicySnapshot([rootA]),
      },
      async () => ({ kind: 'text', text: 'updated sensitive text' }),
    )

    expect(store.listAll().has(staleFile.path)).toBe(false)
    expect(store.search('sensitive').hits).toHaveLength(0)
  })

  it('9. Worker restart receives latest Ignore policy', async () => {
    writeFileSync(join(rootA, 'public.txt'), 'public document body')
    writeFileSync(join(rootA, 'later-ignored.txt'), 'should be excluded after recycle')

    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [rootA], extraPaths: () => [] },
      5_000,
      512,
      dbPath,
    )

    await indexer.scan()
    await vi.waitFor(
      () => expect(store.listAll().get(join(rootA, 'later-ignored.txt'))?.status).toBe('ok'),
      { timeout: 5_000 },
    )

    ;(indexer as unknown as { recycleWorker: () => void }).recycleWorker()
    setActiveIgnoreRules([
      { id: 'r-later', pattern: 'later-ignored.txt', enabled: true, scope: 'global' },
    ])

    await indexer.scan()
    expect(store.listAll().has(join(rootA, 'public.txt'))).toBe(true)
    expect(store.listAll().has(join(rootA, 'later-ignored.txt'))).toBe(false)
  }, 20_000)

  it('10. Root-scoped rule works inside worker', async () => {
    const fileInA = join(rootA, 'scoped-only.txt')
    const fileInB = join(rootB, 'scoped-only.txt')
    writeFileSync(fileInA, 'content in root A')
    writeFileSync(fileInB, 'content in root B')

    setActiveIgnoreRules([
      {
        id: 'r-rootA',
        pattern: 'scoped-only.txt',
        enabled: true,
        scope: rootA,
      },
    ])

    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [rootA, rootB], extraPaths: () => [] },
      5_000,
      512,
      dbPath,
    )

    await indexer.scan()
    await vi.waitFor(() => expect(store.listAll().get(fileInB)?.status).toBe('ok'), {
      timeout: 5_000,
    })

    expect(store.listAll().has(fileInA)).toBe(false)
    expect(store.listAll().has(fileInB)).toBe(true)
  }, 20_000)

  it('11. .genofficeignore works inside worker', async () => {
    const allowedInB = join(rootB, 'allowed-in-b.txt')
    const dotIgnoredInB = join(rootB, 'local-ignore.txt')
    writeFileSync(allowedInB, 'allowed in root B')
    writeFileSync(dotIgnoredInB, 'excluded by dotfile in root B')
    writeFileSync(join(rootB, '.genofficeignore'), 'local-ignore.txt\n')

    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [rootB], extraPaths: () => [] },
      5_000,
      512,
      dbPath,
    )

    await indexer.scan()
    await vi.waitFor(() => expect(store.listAll().get(allowedInB)?.status).toBe('ok'), {
      timeout: 5_000,
    })

    expect(store.listAll().has(allowedInB)).toBe(true)
    expect(store.listAll().has(dotIgnoredInB)).toBe(false)
  }, 20_000)

  it('12. Worker never writes to ignore-rules.json', () => {
    const workerRulesPath = join(storeDir, 'worker-must-not-write.json')
    setIgnoreStoragePath(workerRulesPath)

    const applied = applyIgnorePolicySnapshot({
      version: 500,
      rules: [{ id: 'v500', pattern: '*.v500', enabled: true, scope: 'global' }],
      roots: [rootA],
    })
    expect(applied).toBe(true)
    expect(getIgnorePolicyGeneration()).toBe(500)
    expect(isPathIgnored(join(rootA, 'doc.v500'))).toBe(true)
    expect(existsSync(workerRulesPath)).toBe(false)
    expect(() => readFileSync(workerRulesPath)).toThrow()
  })

  it('13. Outdated policy version cannot overwrite newer worker policy', () => {
    applyIgnorePolicySnapshot({
      version: 600,
      rules: [{ id: 'v600', pattern: '*.v600', enabled: true, scope: 'global' }],
      roots: [rootA],
    })
    expect(getIgnorePolicyGeneration()).toBe(600)

    const appliedStale = applyIgnorePolicySnapshot({
      version: 599,
      rules: [],
      roots: [rootA],
    })
    expect(appliedStale).toBe(false)
    expect(getIgnorePolicyGeneration()).toBe(600)
    expect(isPathIgnored(join(rootA, 'doc.v600'))).toBe(true)
  })

  it('14. Malformed policy message fails closed without crashing worker', async () => {
    applyIgnorePolicySnapshot({
      version: 700,
      rules: [{ id: 'v700', pattern: '*.v700', enabled: true, scope: 'global' }],
      roots: [rootA],
    })

    const badAck = applyWorkerIgnorePolicyMessage({
      id: 77,
      type: 'ignore-policy',
      snapshot: { version: 'not-a-number', rules: null },
    })
    expect(badAck).toEqual({
      id: 77,
      type: 'ignore-policy-ack',
      version: 700,
      applied: false,
      status: 'rejected-invalid',
    })
    expect(isPathIgnored(join(rootA, 'doc.v700'))).toBe(true)

    rawWorker = new Worker(extractWorkerPath, {
      workerData: {
        dbPath,
        ignorePolicy: getIgnorePolicySnapshot([rootA]),
      },
    })

    const sendAndWaitAck = (payload: unknown): Promise<IgnorePolicyAckResponse> =>
      new Promise((resolve) => {
        const onMsg = (msg: IgnorePolicyAckResponse) => {
          if (msg.type === 'ignore-policy-ack' && msg.id === (payload as { id?: number }).id) {
            rawWorker?.off('message', onMsg)
            resolve(msg)
          }
        }
        rawWorker!.on('message', onMsg)
        rawWorker!.postMessage(payload)
      })

    const malformedWorkerAck = await sendAndWaitAck({
      id: 88,
      type: 'ignore-policy',
      snapshot: { version: -5, rules: 'corrupted' },
    })
    expect(malformedWorkerAck.applied).toBe(false)
    expect(malformedWorkerAck.version).toBe(700)

    const validWorkerAck = await sendAndWaitAck({
      id: 89,
      type: 'ignore-policy',
      snapshot: {
        version: 701,
        rules: [{ id: 'v701', pattern: '*.v701', enabled: true, scope: 'global' }],
        roots: [rootA],
      },
    })
    expect(validWorkerAck.applied).toBe(true)
    expect(validWorkerAck.version).toBe(701)
  }, 20_000)

  it('15. Disabling default rule-private (private/) in main synchronizes to real worker and makes private/report.docx discoverable on subsequent scan', async () => {
    const publicDir = join(rootA, 'public')
    const privateDir = join(rootA, 'private')
    mkdirSync(publicDir, { recursive: true })
    mkdirSync(privateDir, { recursive: true })
    const pubDoc = join(publicDir, 'report.txt')
    const privDoc = join(privateDir, 'report.txt')
    writeFileSync(pubDoc, 'public report body')
    writeFileSync(privDoc, 'private report body')

    setActiveIgnoreRules(DEFAULT_IGNORE_RULES.map((r) => ({ ...r })))

    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [rootA], extraPaths: () => [] },
      15_000,
      512,
      dbPath,
    )

    await indexer.scan()
    await vi.waitFor(() => expect(store.listAll().get(pubDoc)?.status).toBe('ok'), {
      timeout: 5_000,
    })
    expect(store.listAll().has(privDoc)).toBe(false)

    // Disable only the configurable rule-private rule in main
    setActiveIgnoreRules(
      DEFAULT_IGNORE_RULES.map((r) =>
        r.id === 'rule-private' ? { ...r, enabled: false } : { ...r },
      ),
    )

    await indexer.scan()
    await vi.waitFor(() => expect(store.listAll().get(privDoc)?.status).toBe('ok'), {
      timeout: 5_000,
    })
    expect(store.listAll().get(pubDoc)?.status).toBe('ok')
    expect(store.search('private report').hits.some((h) => h.path === privDoc)).toBe(true)
  }, 20_000)

  it('16. Real extract-worker entry point supplies isIgnored to handleWriterRequest, refuses/retires ignored files, and leaves original disk files untouched', async () => {
    const targetDoc = join(rootA, 'real-worker-writer-target.txt')
    const originalContent = 'real worker writer body content'
    writeFileSync(targetDoc, originalContent)

    setActiveIgnoreRules([])

    rawWorker = new Worker(extractWorkerPath, {
      workerData: {
        dbPath,
        ignorePolicy: getIgnorePolicySnapshot([rootA]),
      },
    })

    const callWorker = <T>(payload: Record<string, unknown>): Promise<T> =>
      new Promise((resolve) => {
        const id = payload.id as number
        const onMsg = (msg: { id?: number } & T) => {
          if (msg.id === id) {
            rawWorker?.off('message', onMsg)
            resolve(msg)
          }
        }
        rawWorker!.on('message', onMsg)
        rawWorker!.postMessage(payload)
      })

    // 1. Index allowed file via real worker writer protocol
    const stat = statSync(targetDoc)
    const firstRes = await callWorker<{
      id: number
      type: string
      status?: string
    }>({
      id: 201,
      type: 'index',
      file: { path: targetDoc, mtimeMs: stat.mtimeMs, sizeBytes: stat.size },
      preserve: false,
    })
    expect(firstRes.type).toBe('written')
    expect(firstRes.status).toBe('text')
    expect(store.listAll().get(targetDoc)?.status).toBe('ok')

    // 2. Activate ignore rule in main and push snapshot to real worker
    setActiveIgnoreRules([
      {
        id: 'r-real-writer',
        pattern: 'real-worker-writer-target.txt',
        enabled: true,
        scope: 'global',
      },
    ])
    const ack = await callWorker<IgnorePolicyAckResponse>({
      id: 202,
      type: 'ignore-policy',
      snapshot: getIgnorePolicySnapshot([rootA]),
    })
    expect(ack.applied).toBe(true)

    // 3. Send writer request for now-ignored file -> real worker entry point supplies isPathIgnored,
    // skips extraction, and removes stale SQLite row without touching original disk file
    const secondRes = await callWorker<{
      id: number
      type: string
      status?: string
    }>({
      id: 203,
      type: 'index',
      file: { path: targetDoc, mtimeMs: stat.mtimeMs + 1, sizeBytes: stat.size },
      preserve: false,
    })
    expect(secondRes.type).toBe('written')
    expect(secondRes.status).toBe('error')
    expect(store.listAll().has(targetDoc)).toBe(false)
    expect(existsSync(targetDoc)).toBe(true)
    expect(readFileSync(targetDoc, 'utf-8')).toBe(originalContent)
  }, 20_000)

  it('17. Offline/unavailable root does not trigger mass deletion of existing indexed records', async () => {
    const existingDoc = join(rootA, 'persisted-offline.txt')
    writeFileSync(existingDoc, 'persisted offline content')
    const stat = statSync(existingDoc)
    store.upsert(
      { path: existingDoc, mtimeMs: stat.mtimeMs, sizeBytes: stat.size },
      'persisted offline content',
      'ok',
    )

    const missingRoot = join(storeDir, 'disconnected-volume-root')
    indexer = new FileIndexer(
      store,
      extractWorkerPath,
      { roots: () => [missingRoot], extraPaths: () => [] },
      15_000,
      512,
      dbPath,
    )

    await indexer.scan()
    expect(store.listAll().get(existingDoc)?.status).toBe('ok')
  }, 20_000)

  it('18. CPU policy messaging continues to work alongside ignore-policy synchronization in real worker', async () => {
    const allowedDoc = join(rootA, 'cpu-policy-allowed.txt')
    const ignoredDoc = join(rootA, 'cpu-policy-ignored.txt')
    writeFileSync(allowedDoc, 'cpu policy allowed text')
    writeFileSync(ignoredDoc, 'cpu policy ignored text')

    setActiveIgnoreRules([
      { id: 'r-cpu-ign', pattern: 'cpu-policy-ignored.txt', enabled: true, scope: 'global' },
    ])

    rawWorker = new Worker(extractWorkerPath, {
      workerData: {
        dbPath,
        ignorePolicy: getIgnorePolicySnapshot([rootA]),
      },
    })

    rawWorker.postMessage({ type: 'policy', threads: 1, cpuShare: 0.5 })

    const parts: { path: string }[] = []
    const scanRes = await new Promise<{
      id: number
      type: string
      files: { path: string }[]
      complete: boolean
    }>((resolve) => {
      const onMsg = (msg: {
        id?: number
        type: string
        files?: { path: string }[]
        complete?: boolean
      }) => {
        if (msg.id === 301 && msg.type === 'scan-part' && msg.files) {
          parts.push(...msg.files)
        }
        if (msg.id === 301 && msg.type === 'scan') {
          rawWorker?.off('message', onMsg)
          resolve(msg as never)
        }
      }
      rawWorker!.on('message', onMsg)
      rawWorker!.postMessage({ id: 301, type: 'scan', root: rootA })
    })

    expect(scanRes.complete).toBe(true)
    expect(parts.map((f) => f.path)).toEqual([allowedDoc])
  }, 20_000)
})
