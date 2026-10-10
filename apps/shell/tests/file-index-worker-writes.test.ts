import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'
import { applyExtracted, handleWriterRequest } from '../src/main/file-index/worker-ops'
import { resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import writerWorker from './helpers/file-index-writer-worker?modulePath'

let dir: string
let storeDir: string
let dbPath: string
let store: FileIndexStore
let indexer: FileIndexer | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-fi-writes-'))
  storeDir = mkdtempSync(join(tmpdir(), 'genoffice-fi-writes-db-'))
  dbPath = join(storeDir, 'index.db')
  mkdirSync(join(dir, 'good'))
  writeFileSync(join(dir, 'good', 'notes.md'), 'searchable body about flamingos')
  writeFileSync(join(dir, 'good', 'other.txt'), 'second document about lemurs')
  mkdirSync(join(dir, 'hang'))
  writeFileSync(join(dir, 'hang', 'poison.pdf'), 'unparseable')
  store = new FileIndexStore(dbPath)
})
afterEach(() => {
  vi.restoreAllMocks()
  indexer?.stop()
  indexer = null
  resetIndexingPolicyBus()
  store.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
  try {
    rmSync(storeDir, { recursive: true, force: true })
  } catch {}
})

const workerIndexer = (timeoutMs = 600) =>
  new FileIndexer(
    store,
    writerWorker,
    { roots: () => [dir], extraPaths: () => [] },
    timeoutMs,
    undefined,
    dbPath,
  )

describe('FileIndexer with the worker thread owning the writes', () => {
  it('indexes a folder without the main thread writing a row (names, text and removals all go through the worker)', async () => {
    const mainUpsert = vi.spyOn(store, 'upsert')
    const mainPending = vi.spyOn(store, 'upsertPendingBatch')
    const mainRemove = vi.spyOn(store, 'remove')
    indexer = workerIndexer()
    await indexer.scan()
    await vi.waitFor(
      () => expect(store.listAll().get(join(dir, 'good', 'notes.md'))?.status).toBe('ok'),
      { timeout: 5_000 },
    )
    await vi.waitFor(
      () => expect(store.listAll().get(join(dir, 'hang', 'poison.pdf'))?.status).toBe('error'),
      { timeout: 8_000 },
    )
    expect(store.search('flamingos').hits.map((h) => h.path)).toContain(
      join(dir, 'good', 'notes.md'),
    )
    expect(store.search('lemurs').hits.map((h) => h.path)).toContain(join(dir, 'good', 'other.txt'))
    // a file deleted from disk leaves the index through the worker too
    unlinkSync(join(dir, 'good', 'other.txt'))
    await indexer.scan()
    await vi.waitFor(
      () => expect(store.listAll().has(join(dir, 'good', 'other.txt'))).toBe(false),
      { timeout: 5_000 },
    )
    expect(mainUpsert).not.toHaveBeenCalled()
    expect(mainPending).not.toHaveBeenCalled()
    expect(mainRemove).not.toHaveBeenCalled()
  }, 30_000)

  it('reads a scan that arrives in several slices', async () => {
    for (let i = 0; i < 25; i++)
      writeFileSync(join(dir, 'good', `extra-${i}.txt`), `extra body number ${i}`)
    indexer = workerIndexer()
    await indexer.scan()
    expect(store.listAll().size).toBe(28) // 25 + notes + other + poison, names first
    await vi.waitFor(() => expect(store.search('number').total).toBe(25), { timeout: 10_000 })
  }, 30_000)

  it('keeps a cached body when a refresh of a changed file fails', async () => {
    const notes = join(dir, 'good', 'notes.md')
    const first = statSync(notes)
    store.upsert(
      { path: notes, mtimeMs: first.mtimeMs, sizeBytes: first.size },
      'old cached flamingos text',
      'ok',
    )
    // the file changes, and the refresh request never answers
    const poison = join(dir, 'good', 'poison-refresh.md')
    writeFileSync(poison, 'v1')
    const st = statSync(poison)
    store.upsert(
      { path: poison, mtimeMs: st.mtimeMs - 1000, sizeBytes: st.size },
      'cached poison body',
      'ok',
    )
    indexer = workerIndexer(300)
    await indexer.scan()
    await vi.waitFor(() => expect(indexer!.progress().pending).toBe(0), { timeout: 10_000 })
    await new Promise((r) => setTimeout(r, 300))
    expect(store.search('cached poison').hits.map((h) => h.path)).toContain(poison)
  }, 30_000)
})

describe('worker-side write operations', () => {
  it('applies a parse result exactly like the main-thread apply did, and survives a corrupt row', async () => {
    const f = { path: join(dir, 'a.txt'), mtimeMs: 1, sizeBytes: 3 }
    applyExtracted(store, f, { kind: 'text', text: 'alpha beta' }, false)
    expect(store.listAll().get(f.path)?.status).toBe('ok')
    applyExtracted(store, f, { kind: 'error', error: 'x' }, true) // preserve: the cached body stays
    expect(store.listAll().get(f.path)?.status).toBe('ok')
    applyExtracted(store, f, { kind: 'error', error: 'x' }, false)
    expect(store.listAll().get(f.path)?.status).toBe('error')
    applyExtracted(store, f, { kind: 'name-only' }, false)
    expect(store.listAll().get(f.path)?.status).toBe('name-only')
    const broken = {
      ...store,
      upsert: () => {
        throw new Error('disk full')
      },
    } as unknown as FileIndexStore
    const reply = await handleWriterRequest(
      broken,
      { id: 5, type: 'index-error', file: f, preserve: false, error: 'x' },
      async () => ({ kind: 'name-only' }),
    )
    expect(reply).toMatchObject({ id: 5, type: 'written', error: 'disk full' })
  })

  it('a batch of new names is one transaction and a repeated name replaces its row', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: join(dir, `n${i}.txt`),
      mtimeMs: i,
      sizeBytes: i,
    }))
    store.upsertPendingBatch(files)
    store.upsertPendingBatch(files.slice(0, 5))
    expect(store.count()).toBe(50)
    expect(store.search('n7').hits.map((h) => h.path)).toContain(files[7]!.path)
  })

  it('lists a big index in pages and counts it at most once per interval', async () => {
    const files = Array.from({ length: 5000 }, (_, i) => ({
      path: join(dir, `f${i}.txt`),
      mtimeMs: i,
      sizeBytes: i,
    }))
    store.upsertPendingBatch(files)
    let yields = 0
    const sliced = await store.listAllSliced(async () => void yields++, 1000)
    expect(sliced.size).toBe(5000)
    expect(yields).toBe(5)
    expect([...sliced.keys()].sort()).toEqual([...store.listAll().keys()].sort())
    const count = vi.spyOn(store, 'count')
    store.countCached(60_000)
    store.countCached(60_000)
    expect(count).toHaveBeenCalledTimes(1)
  })
})
