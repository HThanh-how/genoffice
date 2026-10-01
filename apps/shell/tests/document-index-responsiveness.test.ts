import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSwrCache } from '../src/main/fork/activity-cache'
import { startLoopMonitor } from '../src/main/fork/loop-monitor'
import { createYielder } from '../src/main/document-memory/yield-budget'
import { foldFolderProgress } from '../src/main/document-memory/folder-progress'
import { FolderScanManager } from '../src/main/document-memory/folder-scan'

describe('createSwrCache', () => {
  function fixture() {
    let now = 0
    const queue: Array<() => void> = []
    const cache = createSwrCache<number>({
      now: () => now,
      schedule: (run) => queue.push(run),
    })
    return {
      cache,
      advance: (ms: number) => (now += ms),
      flush: () => queue.splice(0).forEach((run) => run()),
      pending: () => queue.length,
    }
  }

  it('computes inline only for the first read of a key, then serves the cached value', () => {
    const { cache, pending } = fixture()
    const compute = vi.fn(() => 1)
    expect(cache.get('root', compute)).toBe(1)
    expect(cache.get('root', compute)).toBe(1)
    expect(cache.get('root', compute)).toBe(1)
    expect(compute).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(0)
  })

  it('returns the stale value at once and refreshes later, off the caller', () => {
    const { cache, advance, flush, pending } = fixture()
    let value = 1
    const compute = vi.fn(() => value)
    cache.get('root', compute)
    value = 2
    advance(1500)
    expect(cache.get('root', compute)).toBe(1) // stale, instant
    expect(compute).toHaveBeenCalledTimes(1) // nothing slow ran inside the call
    expect(pending()).toBe(1)
    cache.get('root', compute) // further polls do not queue more refreshes
    expect(pending()).toBe(1)
    flush()
    expect(compute).toHaveBeenCalledTimes(2)
    expect(cache.get('root', compute)).toBe(2)
  })

  it('refreshes immediately in the background after invalidate()', () => {
    const { cache, flush, pending } = fixture()
    let value = 1
    const compute = () => value
    cache.get('root', compute)
    value = 7
    cache.invalidate()
    expect(cache.get('root', compute)).toBe(1)
    expect(pending()).toBe(1)
    flush()
    expect(cache.get('root', compute)).toBe(7)
  })

  it('computes inline when the key changes (a different folder has no value yet)', () => {
    const { cache } = fixture()
    cache.get('a', () => 1)
    expect(cache.get('b', () => 2)).toBe(2)
    expect(cache.get('b', () => 3)).toBe(2)
  })

  it('keeps serving the previous value when a refresh fails', () => {
    const { cache, advance, flush } = fixture()
    cache.get('root', () => 1)
    advance(2000)
    cache.get('root', () => {
      throw new Error('database is locked')
    })
    expect(() => flush()).not.toThrow()
    expect(cache.get('root', () => 1)).toBe(1)
  })

  it('scales the time-to-live with the cost of the computation', () => {
    let now = 0
    const queue: Array<() => void> = []
    const cache = createSwrCache<number>({
      now: () => now,
      schedule: (run) => queue.push(run),
    })
    cache.get('root', () => {
      now += 300 // a slow computation
      return 1
    })
    now += 2000 // would be stale for a cheap one (1 s ttl) but not for a 3 s ttl
    cache.get('root', () => 2)
    expect(queue).toHaveLength(0)
    now += 1500
    cache.get('root', () => 2)
    expect(queue).toHaveLength(1)
  })
})

describe('foldFolderProgress', () => {
  const counts = {
    totalFiles: 10,
    readyFiles: 7,
    pendingFiles: 2,
    errorFiles: 1,
    emptyFiles: 1,
    completedChunks: 30,
    totalChunks: 40,
    partialFileProgress: 8.5,
    truncatedFiles: 2,
  }
  it('derives the percent from live scan state without touching the counts', () => {
    expect(foldFolderProgress(counts, false, 0).percent).toBeNull()
    expect(foldFolderProgress(counts, true, 0).percent).toBe(85)
    const nearlyDone = { ...counts, partialFileProgress: 10 }
    expect(foldFolderProgress(nearlyDone, true, 0).percent).toBe(99) // pending files cap at 99
    expect(
      foldFolderProgress({ ...nearlyDone, pendingFiles: 0, errorFiles: 0 }, true, 0).percent,
    ).toBe(100)
    expect(
      foldFolderProgress({ ...nearlyDone, pendingFiles: 0, errorFiles: 0 }, true, 2).percent,
    ).toBe(99)
    expect(foldFolderProgress({ ...counts, totalFiles: 0 }, true, 0).percent).toBe(100)
    expect(foldFolderProgress({ ...counts, totalFiles: 0 }, true, 3).percent).toBe(99)
    expect(foldFolderProgress(counts, true, 0)).toMatchObject({
      totalFiles: 10,
      truncatedFiles: 2,
      emptyFiles: 1,
      completedChunks: 30,
      totalChunks: 40,
    })
  })
})

describe('createYielder', () => {
  it('only gives the event loop a turn after the work budget is used up', async () => {
    const maybeYield = createYielder(30)
    let turns = 0
    const tick = setInterval(() => turns++, 0)
    for (let i = 0; i < 5; i++) await maybeYield() // cheap iterations never yield
    expect(turns).toBe(0)
    const until = performance.now() + 40
    while (performance.now() < until);
    await maybeYield() // over budget: yields
    await new Promise((resolve) => setTimeout(resolve, 5))
    clearInterval(tick)
    expect(turns).toBeGreaterThan(0)
  })
})

describe('startLoopMonitor', () => {
  afterEach(() => {
    delete process.env.GENOFFICE_DEBUG_LOOP
    vi.useRealTimers()
  })
  it('does nothing unless GENOFFICE_DEBUG_LOOP=1', () => {
    delete process.env.GENOFFICE_DEBUG_LOOP
    expect(startLoopMonitor(() => undefined)).toBeNull()
    process.env.GENOFFICE_DEBUG_LOOP = '0'
    expect(startLoopMonitor(() => undefined)).toBeNull()
  })
  it('logs p50 / p99 / max every ten seconds when enabled', () => {
    vi.useFakeTimers()
    process.env.GENOFFICE_DEBUG_LOOP = '1'
    const log = vi.fn()
    const stop = startLoopMonitor(log)
    expect(stop).toBeTypeOf('function')
    vi.advanceTimersByTime(9_999)
    expect(log).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toMatch(/\[loop-monitor\].*p50=.*p99=.*max=/)
    stop!()
    vi.advanceTimersByTime(30_000)
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('folder scan manifest writes', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-scan-save-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Counts manifest rewrites, so a loaded machine that scans slowly can cross the throttle
  // interval; retry rather than weaken the assertion.
  it(
    'are throttled while a scan walks many directories but always end complete',
    { retry: 2 },
    async () => {
      const root = join(dir, 'tree')
      for (let i = 0; i < 40; i++) {
        mkdirSync(join(root, `dir-${i}`), { recursive: true })
        writeFileSync(join(root, `dir-${i}`, 'note.md'), 'x')
      }
      const manifest = join(dir, 'user', 'document-memory-folders.json')
      let writes = 0
      const scanner = new FolderScanManager(join(dir, 'user'), {
        indexDiscoveredFile: () => {
          // count manifest rewrites seen from the filesystem side as the scan progresses
          try {
            const state = JSON.parse(readFileSync(manifest, 'utf8')) as {
              jobs: Array<{ discovered: number }>
            }
            writes = Math.max(writes, state.jobs[0]?.discovered ?? 0)
          } catch {
            // not written yet
          }
          return true
        },
      })
      scanner.start(root)
      const started = Date.now()
      while (scanner.status().running) {
        if (Date.now() - started > 5000) throw new Error('scan did not finish')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const finished = JSON.parse(readFileSync(manifest, 'utf8')) as {
        jobs: Array<{ state: string; discovered: number }>
      }
      expect(finished.jobs[0]).toMatchObject({ state: 'complete', discovered: 40 })
      // before throttling, the file was rewritten after every directory, so each file's callback
      // saw the previous directory's count; now the counters in the file lag by up to the interval.
      expect(writes).toBeLessThan(39)
      scanner.close()
    },
  )

  it('flushes pending counters when the scanner closes', async () => {
    const root = join(dir, 'tree')
    mkdirSync(join(root, 'a'), { recursive: true })
    writeFileSync(join(root, 'a', 'note.md'), 'x')
    const user = join(dir, 'user')
    const scanner = new FolderScanManager(user, { indexDiscoveredFile: () => true })
    scanner.start(root)
    scanner.stop()
    scanner.close()
    const saved = JSON.parse(readFileSync(join(user, 'document-memory-folders.json'), 'utf8')) as {
      jobs: Array<{ root: string; state: string }>
    }
    expect(saved.jobs[0]?.root).toBe(root)
  })
})
