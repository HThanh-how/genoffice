import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Count the synchronous filesystem calls that block the Electron main thread on a dead share.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync),
  }
})

import * as fs from 'node:fs'
import {
  clearGenOfficeIgnoreCache,
  readGenOfficeIgnoreDetailed,
  refreshGenOfficeIgnoreForRoot,
} from '../src/main/document-memory/ignore-policy'
import { RootAvailability, rootAvailability } from '../src/main/document-memory/root-availability'
import { FolderWatchManager } from '../src/main/document-memory/folder-watch'
import { safeStat } from '../src/main/document-memory/runtime/pending-metadata-intake'
import { statPathEntriesAsync } from '../src/main/recent-files'

const syncCalls = () =>
  vi.mocked(fs.existsSync).mock.calls.length +
  vi.mocked(fs.statSync).mock.calls.length +
  vi.mocked(fs.readFileSync).mock.calls.length

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-unreachable-'))
  writeFileSync(join(root, '.genofficeignore'), 'secret/**\n')
  clearGenOfficeIgnoreCache()
})
afterEach(() => {
  rootAvailability.unregister(root)
  rootAvailability.observe(root, true)
  rootAvailability.unregister(root)
  rmSync(root, { recursive: true, force: true })
})

describe('RootAvailability.isKnownOffline', () => {
  it('is false for unknown roots and true only after an offline observation', () => {
    const roots = new RootAvailability()
    roots.register(root)
    expect(roots.isKnownOffline(join(root, 'a', 'b.docx'))).toBe(false)
    roots.observe(root, false)
    expect(roots.isKnownOffline(join(root, 'a', 'b.docx'))).toBe(true)
    expect(roots.isKnownOffline(root)).toBe(true)
    roots.observe(root, true)
    expect(roots.isKnownOffline(join(root, 'a', 'b.docx'))).toBe(false)
  })

  it('never probes or touches the filesystem', () => {
    const roots = new RootAvailability(() => {
      throw new Error('probe must not run')
    })
    roots.register(root)
    roots.observe(root, false)
    vi.mocked(fs.statSync).mockClear()
    expect(roots.isKnownOffline(root)).toBe(true)
    expect(fs.statSync).not.toHaveBeenCalled()
  })
})

describe('.genofficeignore on an unreachable root', () => {
  it('reads from disk normally while the root is online', () => {
    const result = readGenOfficeIgnoreDetailed(root)
    expect(result.rules.map((r) => r.pattern)).toEqual(['secret/**'])
    expect(syncCalls()).toBeGreaterThan(0)
  })

  it('serves the last good rules from memory and calls no sync fs when the root is offline', () => {
    readGenOfficeIgnoreDetailed(root) // last good read
    rootAvailability.register(root)
    rootAvailability.observe(root, false)
    vi.mocked(fs.existsSync).mockClear()
    vi.mocked(fs.statSync).mockClear()
    vi.mocked(fs.readFileSync).mockClear()

    const result = readGenOfficeIgnoreDetailed(root)

    expect(result.rules.map((r) => r.pattern)).toEqual(['secret/**'])
    expect(syncCalls()).toBe(0)
  })

  it('returns no rules, still without touching disk, when nothing was cached', () => {
    rootAvailability.register(root)
    rootAvailability.observe(root, false)
    vi.mocked(fs.existsSync).mockClear()
    expect(readGenOfficeIgnoreDetailed(root).rules).toEqual([])
    expect(syncCalls()).toBe(0)
  })

  it('refresh is a no-op without sync fs while offline, and works again after recovery', () => {
    rootAvailability.register(root)
    rootAvailability.observe(root, false)
    vi.mocked(fs.existsSync).mockClear()
    expect(refreshGenOfficeIgnoreForRoot(root)).toBe(false)
    expect(syncCalls()).toBe(0)

    rootAvailability.observe(root, true)
    expect(readGenOfficeIgnoreDetailed(root).rules.map((r) => r.pattern)).toEqual(['secret/**'])
    expect(syncCalls()).toBeGreaterThan(0)
  })
})

describe('safeStat on an unreachable root', () => {
  it('returns null immediately without a sync stat', () => {
    const file = join(root, 'a.docx')
    writeFileSync(file, 'x')
    rootAvailability.register(root)
    expect(safeStat(file)).not.toBeNull()
    rootAvailability.observe(root, false)
    vi.mocked(fs.statSync).mockClear()
    expect(safeStat(file)).toBeNull()
    expect(fs.statSync).not.toHaveBeenCalled()
  })
})

describe('FolderWatchManager on an unreachable root', () => {
  it('does not open fs.watch while offline, then opens it after the backoff once online', async () => {
    rootAvailability.register(root)
    rootAvailability.observe(root, false)
    const watch = vi.fn(() => Object.assign(new EventEmitter(), { close() {} }))
    const manager = new FolderWatchManager(
      {
        watchedRoots: () => [root],
        onRootsChanged: () => () => {},
        reconcile: async () => ({ ok: true }),
      } as never,
      {
        isEnabled: () => true,
        onEnabledChange: () => () => {},
        handleFileEvents: async () => {},
      } as never,
      {
        debounceMs: 10,
        maxWaitMs: 50,
        reconcileDelayMs: 60_000,
        dirReconcileDelayMs: 60_000,
        minReconcileGapMs: 0,
        retryBaseMs: 20,
        retryMaxMs: 20,
        watch: watch as never,
      },
    )
    try {
      await new Promise((r) => setTimeout(r, 70))
      expect(watch).not.toHaveBeenCalled()

      rootAvailability.observe(root, true)
      await new Promise((r) => setTimeout(r, 70))
      expect(watch).toHaveBeenCalled()
    } finally {
      manager.close()
    }
  })
})

describe('statPathEntriesAsync', () => {
  const never = () => new Promise<{ mtimeMs: number; size: number }>(() => {})

  it('returns real metadata for reachable files', async () => {
    const entries = await statPathEntriesAsync(['/a/x.docx'], new Set(['/a/x.docx']), {
      statImpl: async () => ({ mtimeMs: 5, size: 9 }),
    })
    expect(entries).toEqual([
      { path: '/a/x.docx', name: 'x.docx', ext: 'docx', mtimeMs: 5, sizeBytes: 9, starred: true },
    ])
  })

  it('flags failed stats as missing, like the sync version', async () => {
    const [entry] = await statPathEntriesAsync(['/a/x.docx'], new Set(), {
      statImpl: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(entry).toMatchObject({ missing: true, mtimeMs: 0, sizeBytes: 0 })
  })

  it('returns within the deadline when stat never resolves', async () => {
    const started = Date.now()
    const entries = await statPathEntriesAsync(['G:\\a.docx', 'G:\\b.docx'], new Set(), {
      timeoutMs: 60,
      statImpl: never,
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(entries.map((e) => e.missing)).toEqual([true, true])
  })

  it('does not let slow rows add up: 40 hanging stats finish in about one deadline', async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `G:\\f${i}.docx`)
    const started = Date.now()
    const entries = await statPathEntriesAsync(paths, new Set(), {
      timeoutMs: 100,
      statImpl: never,
    })
    expect(entries).toHaveLength(40)
    // 16 workers over 40 rows = 3 waves of the deadline, not 40
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('keeps row order when some stats are slower than others', async () => {
    const entries = await statPathEntriesAsync(['/a.docx', '/b.docx', '/c.docx'], new Set(), {
      statImpl: (p) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ mtimeMs: 1, size: 1 }), p === '/a.docx' ? 30 : 0),
        ),
    })
    expect(entries.map((e) => e.name)).toEqual(['a.docx', 'b.docx', 'c.docx'])
  })
})

describe('cachedUsageReader (OCR agy usage)', () => {
  it('spawns once per window, shares an in-flight call, then refreshes', async () => {
    const { cachedUsageReader } = await import('../src/main/fork/agy-ocr-ipc')
    let clock = 0
    const read = vi.fn(async () => ({ n: ++clock }))
    const cached = cachedUsageReader(read, () => clock * 1000, 60_000)
    const [a, b] = await Promise.all([cached(), cached()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(await cached()).toBe(a)
    expect(read).toHaveBeenCalledTimes(1)
    clock = 100 // 100 s later
    expect((await cached()).n).toBeGreaterThan(a.n)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
