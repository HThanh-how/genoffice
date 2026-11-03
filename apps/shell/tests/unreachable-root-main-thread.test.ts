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
    readdirSync: vi.fn(actual.readdirSync),
    accessSync: vi.fn(actual.accessSync),
    watch: vi.fn(actual.watch),
  }
})

import * as fs from 'node:fs'
import {
  clearGenOfficeIgnoreCache,
  getGenOfficeIgnoreFileData,
  readGenOfficeIgnoreDetailed,
  refreshGenOfficeIgnoreForRoot,
  writeGenOfficeIgnoreFile,
} from '../src/main/document-memory/ignore-policy'
import { RootAvailability, rootAvailability } from '../src/main/document-memory/root-availability'
import { FolderWatchManager } from '../src/main/document-memory/folder-watch'
import {
  PendingMetadataIntake,
  safeStat,
} from '../src/main/document-memory/runtime/pending-metadata-intake'
import { describeExtraRoot } from '../src/main/folder-roots'
import { FolderWatcher, listFolder } from '../src/main/folder-tree'
import { statPathEntriesAsync } from '../src/main/recent-files'

const syncCalls = () =>
  vi.mocked(fs.existsSync).mock.calls.length +
  vi.mocked(fs.statSync).mock.calls.length +
  vi.mocked(fs.readFileSync).mock.calls.length +
  vi.mocked(fs.readdirSync).mock.calls.length +
  vi.mocked(fs.accessSync).mock.calls.length
const resetCalls = () => {
  for (const fn of [fs.existsSync, fs.statSync, fs.readFileSync, fs.readdirSync, fs.accessSync])
    vi.mocked(fn).mockClear()
  vi.mocked(fs.watch).mockClear()
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-unreachable-'))
  writeFileSync(join(root, '.genofficeignore'), 'secret/**\n')
  clearGenOfficeIgnoreCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  rootAvailability.unregister(root)
  rmSync(root, { recursive: true, force: true })
})

/** a registered root whose probe never answers: the state a saved root is in right after launch */
function neverProbed(): void {
  vi.spyOn(rootAvailability, 'check').mockReturnValue(new Promise<boolean>(() => {}))
  rootAvailability.register(root)
}

/** register on the global instance, let its launch-time probe settle, then force a state */
async function registerThen(online: boolean): Promise<void> {
  rootAvailability.register(root)
  await rootAvailability.check(root)
  rootAvailability.observe(root, online)
}

describe('RootAvailability.syncIoVerdict', () => {
  const never = () => new Promise<boolean>(() => {})

  it('is ok for a path under no registered root and with no recorded state', () => {
    const roots = new RootAvailability(never)
    expect(roots.syncIoVerdict(join(root, 'a.docx'))).toBe('ok')
    expect(roots.shouldDeferSyncIo(join(root, 'a.docx'))).toBe(false)
  })

  it('is unverified for a registered root nobody has probed yet, and starts one probe', async () => {
    const probe = vi.fn(never)
    const roots = new RootAvailability(probe)
    roots.register(root)
    expect(roots.syncIoVerdict(join(root, 'a', 'b.docx'))).toBe('unverified')
    expect(roots.syncIoVerdict(root)).toBe('unverified')
    await tick(0)
    expect(probe).toHaveBeenCalledTimes(1) // shared, not one per call
  })

  it('probes saved roots as soon as they are registered when asked to', async () => {
    const probe = vi.fn(async () => true)
    const roots = new RootAvailability(probe, Date.now, 3000, true)
    roots.register(root)
    await tick(0)
    expect(probe).toHaveBeenCalledTimes(1)
    await tick(5)
    expect(roots.syncIoVerdict(root)).toBe('ok')
    roots.register(root) // already verified: no second probe
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('is offline after a failed probe and ok again only after a successful one', () => {
    const roots = new RootAvailability(never)
    roots.register(root)
    roots.observe(root, false)
    expect(roots.syncIoVerdict(join(root, 'a.docx'))).toBe('offline')
    roots.observe(root, true)
    expect(roots.syncIoVerdict(join(root, 'a.docx'))).toBe('ok')
  })

  it('re-probes an offline root at least every 5 minutes while it is being asked about, even in a long backoff', async () => {
    let clock = 1_000
    const probe = vi.fn(never)
    const roots = new RootAvailability(probe, () => clock)
    roots.register(root)
    for (let i = 0; i < 6; i++) roots.observe(root, false) // scheduled backoff is now 1 h
    expect(roots.snapshot()[0]!.nextProbeAt - clock).toBe(3_600_000)
    expect(roots.syncIoVerdict(root)).toBe('offline')
    await tick(0)
    expect(probe).not.toHaveBeenCalled() // too soon
    clock += 300_001
    expect(roots.syncIoVerdict(root)).toBe('offline') // still deferred while the probe is pending
    await tick(0)
    expect(probe).toHaveBeenCalledTimes(1) // forced, although the 1 h backoff has not elapsed
  })

  it('never touches the filesystem', () => {
    const roots = new RootAvailability(never)
    roots.register(root)
    resetCalls()
    roots.syncIoVerdict(root)
    expect(syncCalls()).toBe(0)
  })
})

describe('.genofficeignore on a root that is not reachable', () => {
  it('reads from disk normally for a path under no registered root', () => {
    const result = readGenOfficeIgnoreDetailed(root)
    expect(result.rules.map((r) => r.pattern)).toEqual(['secret/**'])
    expect(syncCalls()).toBeGreaterThan(0)
  })

  it('NEVER-PROBED root: no sync fs at all, cached rules or none (the launch-time case)', () => {
    readGenOfficeIgnoreDetailed(root) // last good read, from an earlier run of the cache
    neverProbed()
    resetCalls()
    expect(readGenOfficeIgnoreDetailed(root).rules.map((r) => r.pattern)).toEqual(['secret/**'])
    expect(refreshGenOfficeIgnoreForRoot(root)).toBe(false)
    expect(getGenOfficeIgnoreFileData(root).error).toBe('root-unavailable')
    expect(writeGenOfficeIgnoreFile(root, 'x').error).toBe('root-unavailable')
    expect(syncCalls()).toBe(0)
  })

  it('NEVER-PROBED root with nothing cached returns no rules without touching disk', () => {
    neverProbed()
    resetCalls()
    expect(readGenOfficeIgnoreDetailed(root).rules).toEqual([])
    expect(syncCalls()).toBe(0)
  })

  it('offline root serves cached rules without sync fs and reads again after recovery', async () => {
    readGenOfficeIgnoreDetailed(root)
    await registerThen(false)
    resetCalls()
    expect(readGenOfficeIgnoreDetailed(root).rules.map((r) => r.pattern)).toEqual(['secret/**'])
    expect(refreshGenOfficeIgnoreForRoot(root)).toBe(false)
    expect(syncCalls()).toBe(0)

    rootAvailability.observe(root, true)
    expect(readGenOfficeIgnoreDetailed(root).rules.map((r) => r.pattern)).toEqual(['secret/**'])
    expect(syncCalls()).toBeGreaterThan(0)
  })
})

describe('other main-thread readers on an unreachable root', () => {
  it('safeStat returns null with no sync stat while the root is unverified or offline', async () => {
    const file = join(root, 'a.docx')
    writeFileSync(file, 'x')
    expect(safeStat(file)).not.toBeNull() // unregistered: unchanged
    neverProbed()
    resetCalls()
    expect(safeStat(file)).toBeNull()
    vi.restoreAllMocks()
    await registerThen(false)
    resetCalls()
    expect(safeStat(file)).toBeNull()
    expect(syncCalls()).toBe(0)
  })

  it('a discovery on an unreachable root is deferred and kept, not dropped as missing', async () => {
    const file = join(root, 'a.docx')
    writeFileSync(file, 'x')
    await registerThen(false)
    const onDiscovered = vi.fn(() => ({ outcome: 'enrolled' as const }))
    const intake = new PendingMetadataIntake({
      isStopped: () => false,
      isEnabled: () => true,
      isWriteReady: () => true,
      isAccountingReady: () => true,
      isFreeDiskReady: () => true,
      onRemember: () => true,
      onDiscovered,
    } as never)
    resetCalls()
    expect(intake.enqueue(file, 'discovered').status).toBe('deferred')
    expect(syncCalls()).toBe(0)
    expect(intake.has(file)).toBe(true)

    await intake.triggerReplay()
    expect(intake.has(file)).toBe(true) // still waiting for the root
    expect(onDiscovered).not.toHaveBeenCalled()

    rootAvailability.observe(root, true)
    await intake.triggerReplay()
    expect(onDiscovered).toHaveBeenCalledTimes(1)
    expect(intake.has(file)).toBe(false)
  })

  it('listFolder and describeExtraRoot do not touch an unreachable folder', () => {
    neverProbed()
    resetCalls()
    expect(listFolder(root, new Set())).toMatchObject({ missing: true, folders: [], files: [] })
    expect(describeExtraRoot(root)).toMatchObject({ usable: false, readable: false })
    expect(syncCalls()).toBe(0)
  })

  it('FolderWatcher (folder tree) does not open fs.watch on an unreachable root', async () => {
    neverProbed()
    resetCalls()
    const watcher = new FolderWatcher(root, () => {})
    expect(watcher.active).toBe(false)
    expect(fs.watch).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    await registerThen(false)
    expect(new FolderWatcher(root, () => {}).active).toBe(false)
    expect(fs.watch).not.toHaveBeenCalled()
  })
})

describe('FolderWatchManager on a root that is not reachable', () => {
  function manager(watch: unknown) {
    return new FolderWatchManager(
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
  }
  const fakeWatch = () => vi.fn(() => Object.assign(new EventEmitter(), { close() {} }))

  it('NEVER-PROBED root: does not call fs.watch while the probe has not answered', async () => {
    neverProbed()
    const watch = fakeWatch()
    const m = manager(watch)
    try {
      await tick(80)
      expect(watch).not.toHaveBeenCalled()
    } finally {
      m.close()
    }
  })

  it('opens the watcher once the first probe finds the root reachable', async () => {
    const check = vi.spyOn(rootAvailability, 'check').mockImplementation(async (r: string) => {
      rootAvailability.observe(r, true)
      return true
    })
    rootAvailability.register(root)
    const watch = fakeWatch()
    const m = manager(watch)
    try {
      await tick(40)
      expect(check).toHaveBeenCalled()
      expect(watch).toHaveBeenCalledTimes(1)
    } finally {
      m.close()
    }
  })

  it('does not open while offline, then opens after the backoff once online', async () => {
    await registerThen(false)
    const watch = fakeWatch()
    const m = manager(watch)
    try {
      await tick(70)
      expect(watch).not.toHaveBeenCalled()
      rootAvailability.observe(root, true)
      await tick(70)
      expect(watch).toHaveBeenCalled()
    } finally {
      m.close()
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

  it('flags a failed stat as missing but NOT unavailable (the file is gone)', async () => {
    const [entry] = await statPathEntriesAsync(['/a/x.docx'], new Set(), {
      statImpl: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(entry).toMatchObject({ missing: true, mtimeMs: 0, sizeBytes: 0 })
    expect(entry!.unavailable).toBeUndefined()
  })

  it('default stat (real fs/promises, no injected impl) works for real files and missing ones', async () => {
    const file = join(root, 'real.docx')
    writeFileSync(file, 'hello')
    const [ok, gone] = await statPathEntriesAsync([file, join(root, 'nope.docx')], new Set())
    expect(ok).toMatchObject({ name: 'real.docx', sizeBytes: 5 })
    expect(ok!.missing).toBeUndefined()
    expect(gone).toMatchObject({ missing: true })
    expect(gone!.unavailable).toBeUndefined()
  })

  it('a stat that never answers is flagged unavailable, returns in the deadline, and probes the root', async () => {
    const check = vi.spyOn(rootAvailability, 'checkPath').mockResolvedValue(false)
    const started = Date.now()
    const [entry] = await statPathEntriesAsync(['G:\\a.docx'], new Set(), {
      timeoutMs: 60,
      statImpl: never,
    })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(entry).toMatchObject({ missing: true, unavailable: true })
    expect(check).toHaveBeenCalledWith('G:\\a.docx', true)
  })

  it('does not stat at all under an offline or unverified root (no threadpool thread spent)', async () => {
    const statImpl = vi.fn(never)
    neverProbed()
    const [unverified] = await statPathEntriesAsync([join(root, 'a.docx')], new Set(), {
      timeoutMs: 60,
      statImpl,
    })
    vi.restoreAllMocks()
    await registerThen(false)
    const [offline] = await statPathEntriesAsync([join(root, 'b.docx')], new Set(), {
      timeoutMs: 60,
      statImpl,
    })
    expect(statImpl).not.toHaveBeenCalled()
    expect(unverified).toMatchObject({ missing: true, unavailable: true })
    expect(offline).toMatchObject({ missing: true, unavailable: true })
  })

  it('never has more stats in flight than the concurrency cap, and hanging rows finish promptly', async () => {
    vi.spyOn(rootAvailability, 'checkPath').mockResolvedValue(false)
    let inFlight = 0
    let peak = 0
    const statImpl = () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      return never().finally(() => inFlight--)
    }
    const paths = Array.from({ length: 12 }, (_, i) => `G:\\f${i}.docx`)
    const started = Date.now()
    const entries = await statPathEntriesAsync(paths, new Set(), { timeoutMs: 40, statImpl })
    expect(entries).toHaveLength(12)
    expect(peak).toBeLessThanOrEqual(3)
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

  it('does not remember a failed (null) read', async () => {
    const { cachedUsageReader } = await import('../src/main/fork/agy-ocr-ipc')
    const read = vi.fn<() => Promise<{ n: number } | null>>().mockResolvedValueOnce(null)
    read.mockResolvedValueOnce({ n: 1 })
    const cached = cachedUsageReader(read, () => 0, 60_000)
    expect(await cached()).toBeNull()
    expect(await cached()).toEqual({ n: 1 })
    expect(read).toHaveBeenCalledTimes(2)
  })
})
