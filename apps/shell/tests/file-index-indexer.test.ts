import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'
import { publishIndexingPolicy, resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import { resolvePolicy } from '../src/main/fork/indexing-policy'

const statFault = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) =>
      String(args[0]) === statFault.path
        ? Promise.reject(Object.assign(new Error('drive unavailable'), { code: 'EIO' }))
        : actual.stat(...args),
  }
})

// the worker double never answers the extraction for poison.pdf, so these tests
// only pass once a wedged request fails on timeout and the queue moves on to
// the files behind it
const WORKER = join(__dirname, 'file-index-test-worker.mjs')

let dir: string
let storeDir: string
let store: FileIndexStore
let indexer: FileIndexer | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-indexer-'))
  storeDir = mkdtempSync(join(tmpdir(), 'genoffice-indexer-db-'))
  mkdirSync(join(dir, 'hang'))
  writeFileSync(join(dir, 'hang', 'poison.pdf'), 'unparseable')
  mkdirSync(join(dir, 'good'))
  writeFileSync(join(dir, 'good', 'notes.md'), 'searchable body text')
  store = new FileIndexStore(join(storeDir, 'index.db'))
})
afterEach(() => {
  vi.restoreAllMocks()
  statFault.path = ''
  indexer?.stop()
  indexer = null
  resetIndexingPolicyBus()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

const indexerWithShortTimeout = () =>
  new FileIndexer(store, WORKER, { roots: () => [dir], extraPaths: () => [] }, 400)

const notesPath = () => join(dir, 'good', 'notes.md')
const poisonPath = () => join(dir, 'hang', 'poison.pdf')

describe('FileIndexer wedged-worker recovery', () => {
  it('publishes file names while power policy pauses content work, then resumes parsing', async () => {
    const input = {
      mode: 'balanced' as const,
      cores: 8,
      freeMemMB: 8000,
      onBattery: false,
      locked: false,
      userIdleSeconds: 0,
      pauseOnBattery: true,
    }
    publishIndexingPolicy({ ...resolvePolicy({ ...input, userPaused: true }), onBattery: false })
    indexer = indexerWithShortTimeout()
    await indexer.scan()
    expect(store.search('notes').hits.map((hit) => hit.path)).toContain(notesPath())
    expect(store.listAll().get(notesPath())?.status).toBe('pending')
    publishIndexingPolicy({ ...resolvePolicy(input), onBattery: false })
    await vi.waitFor(() => expect(store.listAll().get(notesPath())?.status).toBe('ok'))
  })

  it('makes names searchable before a stalled content extractor answers', async () => {
    indexer = indexerWithShortTimeout()
    await indexer.scan()
    expect(store.search('poison').hits.map((hit) => hit.path)).toContain(poisonPath())
    expect(store.search('notes').hits.map((hit) => hit.path)).toContain(notesPath())
    expect(store.listAll().get(poisonPath())?.status).toBe('pending')
  })

  it('resumes persisted metadata-only pending entries rather than skipping their content', async () => {
    const path = notesPath()
    const metadata = statSync(path)
    store.upsert({ path, mtimeMs: metadata.mtimeMs, sizeBytes: metadata.size }, null, 'pending')
    indexer = indexerWithShortTimeout()
    await indexer.scan()
    await vi.waitFor(() => expect(store.listAll().get(path)?.status).toBe('ok'))
    expect(store.search('body').hits.map((hit) => hit.path)).toContain(path)
  })

  it('fails a hung extraction on timeout and keeps indexing the rest of the queue', async () => {
    indexer = indexerWithShortTimeout()
    const started = Date.now()
    await indexer.scan()
    await vi.waitFor(
      () => {
        expect(store.listAll().get(poisonPath())?.status).toBe('error')
      },
      { timeout: 5_000, interval: 25 },
    )
    const settleMs = Date.now() - started
    expect(store.listAll().get(notesPath())?.status).toBe('ok')
    expect(indexer.progress()).toMatchObject({ pending: 0, scanning: false })
    // the queue waited out the injected 400ms wedge, then finished
    expect(settleMs).toBeGreaterThanOrEqual(400)
    expect(settleMs).toBeLessThan(5_000)
    console.log('settle ms:', settleMs)
  })

  it('still runs scans and extractions after a timed-out request', async () => {
    indexer = indexerWithShortTimeout()
    await indexer.scan()
    await vi.waitFor(
      () => {
        expect(indexer!.progress().pending).toBe(0)
      },
      { timeout: 5_000, interval: 25 },
    )
    expect(store.listAll().get(notesPath())?.status).toBe('ok')
    // an unchanged error row is not re-queued; the rescan itself must not wedge
    await indexer.scan()
    await vi.waitFor(
      () => {
        expect(indexer!.progress()).toMatchObject({ pending: 0, scanning: false })
      },
      { timeout: 5_000, interval: 25 },
    )
    expect(store.listAll().get(notesPath())?.status).toBe('ok')
  })
})

describe('FileIndexer disconnected drive safety', () => {
  it('preserves an offline nested share even when its configured parent scans successfully', async () => {
    const root = join(dir, 'company')
    mkdirSync(root)
    const file = join(root, 'contract.txt')
    writeFileSync(file, 'cached nested share contract')
    const metadata = statSync(file)
    store.upsert(
      { path: file, mtimeMs: metadata.mtimeMs, sizeBytes: metadata.size },
      'cached nested share contract',
      'ok',
    )
    renameSync(root, join(storeDir, 'offline-share'))
    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [dir, root], extraPaths: () => [] },
      400,
    )
    await indexer.scan()
    expect(store.search('nested').hits.map((hit) => hit.path)).toContain(file)
  })

  it('keeps company file names and cached content offline, then refreshes after reconnecting', async () => {
    const root = join(dir, 'company')
    const parked = `${root}-offline`
    mkdirSync(root)
    const file = join(root, 'contract.txt')
    writeFileSync(file, 'cached contract alpha')
    const metadata = statSync(file)
    store.upsert(
      { path: file, mtimeMs: metadata.mtimeMs, sizeBytes: metadata.size },
      'cached contract alpha',
      'ok',
    )
    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [root, join(dir, 'good')], extraPaths: () => [] },
      400,
    )
    renameSync(root, parked)
    await indexer.scan()
    expect(store.search('contract').hits.map((hit) => hit.path)).toContain(file)
    expect(store.search('alpha').hits.map((hit) => hit.path)).toContain(file)
    await vi.waitFor(() => expect(store.listAll().get(notesPath())?.status).toBe('ok'))
    renameSync(parked, root)
    writeFileSync(file, 'updated contract beta version')
    await indexer.scan()
    await vi.waitFor(() => expect(store.search('beta').hits.map((hit) => hit.path)).toContain(file))
    expect(store.search('alpha').hits.map((hit) => hit.path)).not.toContain(file)
  })

  it('does not remove or wipe cached text on a generic async stat error', async () => {
    const file = notesPath()
    const metadata = statSync(file)
    store.upsert(
      { path: file, mtimeMs: metadata.mtimeMs, sizeBytes: metadata.size },
      'previous searchable company text',
      'ok',
    )
    writeFileSync(file, 'new company text after reconnect')
    statFault.path = file
    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [join(dir, 'good')], extraPaths: () => [] },
      400,
    )
    await indexer.scan()
    await vi.waitFor(() => expect(indexer!.progress().pending).toBe(0))
    expect(store.search('previous').hits.map((hit) => hit.path)).toContain(file)
    statFault.path = ''
    await indexer.scan()
    await vi.waitFor(() =>
      expect(store.search('reconnect').hits.map((hit) => hit.path)).toContain(file),
    )
  })

  it('still removes a file actually deleted from an accessible local folder', async () => {
    const file = notesPath()
    const metadata = statSync(file)
    store.upsert(
      { path: file, mtimeMs: metadata.mtimeMs, sizeBytes: metadata.size },
      'local deleted note',
      'ok',
    )
    unlinkSync(file)
    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [join(dir, 'good')], extraPaths: () => [] },
      400,
    )
    await indexer.scan()
    expect(store.listAll().has(file)).toBe(false)
  })
})
