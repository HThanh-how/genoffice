import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'
import {
  beginIgnoreRootSnapshot,
  bumpIgnorePolicyGeneration,
  clearGenOfficeIgnoreCache,
  isPathIgnored,
  setKnownRootsResolver,
} from '../src/main/document-memory/ignore-policy'

const WORKER = join(__dirname, 'file-index-scan-part-worker.mjs')

let root: string
let storeDir: string
let store: FileIndexStore
let indexer: FileIndexer | null
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-parts-'))
  storeDir = mkdtempSync(join(tmpdir(), 'genoffice-parts-db-'))
  store = new FileIndexStore(join(storeDir, 'index.db'))
})
afterEach(() => {
  indexer?.stop()
  indexer = null
  store.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

describe('FileIndexer scan slices', () => {
  it('indexes every file of large scan-part slices without holding the event loop', async () => {
    indexer = new FileIndexer(store, WORKER, { roots: () => [root], extraPaths: () => [] }, 20_000)
    const gaps: number[] = []
    let last = performance.now()
    const timer = setInterval(() => {
      gaps.push(performance.now() - last)
      last = performance.now()
    }, 3)
    await indexer.scan()
    await new Promise((resolve) => setTimeout(resolve, 30))
    clearInterval(timer)
    expect(store.listAll().size).toBe(12_000) // same result as the unsliced loop
    expect(gaps.length).toBeGreaterThan(20) // the loop was given turns while slices were absorbed
    // Load-tolerant: a single gap can be stretched by the OS scheduler or GC on a busy machine, so
    // judge the typical turn (p95) tightly and the worst one only against a generous ceiling.
    const sorted = [...gaps].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    expect(p95).toBeLessThan(250)
    expect(Math.max(...gaps)).toBeLessThan(1_500)
  }, 60_000)

  it('does not queue a redundant scan when refreshIfStale fires during the first scan', async () => {
    indexer = new FileIndexer(store, WORKER, { roots: () => [root], extraPaths: () => [] }, 20_000)
    const running = indexer.scan()
    indexer.refreshIfStale(0)
    expect((indexer as unknown as { scanRequested: boolean }).scanRequested).toBe(false)
    await running
  }, 60_000)

  it('does not wait on an offline root (the worker would never answer it)', async () => {
    const offline = join(tmpdir(), 'genoffice-offline-does-not-exist-' + Date.now())
    indexer = new FileIndexer(
      store,
      WORKER,
      { roots: () => [offline], extraPaths: () => [] },
      60_000,
    )
    const t0 = Date.now()
    await indexer.scan()
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(store.listAll().size).toBe(0)
  }, 60_000)
})

describe('ignore root snapshot', () => {
  it('shares .genofficeignore for a scan, and rule changes inside the app still apply', () => {
    mkdirSync(join(root, 'sub'))
    setKnownRootsResolver(() => [root])
    clearGenOfficeIgnoreCache()
    const end = beginIgnoreRootSnapshot()
    try {
      expect(isPathIgnored(join(root, 'a.txt'), root)).toBe(false)
      writeFileSync(join(root, '.genofficeignore'), '*.txt\n')
      // inside the snapshot the root file is not re-read per turn
      expect(isPathIgnored(join(root, 'b.txt'), root)).toBe(false)
      // a rule/generation change invalidates it at once
      bumpIgnorePolicyGeneration()
      expect(isPathIgnored(join(root, 'c.txt'), root)).toBe(true)
    } finally {
      end()
    }
    writeFileSync(join(root, '.genofficeignore'), '*.md\n')
    bumpIgnorePolicyGeneration()
    expect(isPathIgnored(join(root, 'd.txt'), root)).toBe(false)
    expect(isPathIgnored(join(root, 'd.md'), root)).toBe(true)
    clearGenOfficeIgnoreCache()
  })
})
