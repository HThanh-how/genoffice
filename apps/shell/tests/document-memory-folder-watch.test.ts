import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderScanManager, isIndexablePath } from '../src/main/document-memory/folder-scan'
import {
  FolderWatchManager,
  type FolderEventSink,
  type WatchedFolders,
} from '../src/main/document-memory/folder-watch'

class FakeWatcher extends EventEmitter {
  closed = false
  close() {
    this.closed = true
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-folder-watch-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function harness(roots: string[]) {
  const watchers = new Map<
    string,
    { watcher: FakeWatcher; emit: (name: string | null) => void }[]
  >()
  const batches: string[][] = []
  const reconciles: string[] = []
  let reconcileResult: { ok: boolean; reason?: string } = { ok: true }
  let enabled = true
  let failOpen = false
  const enabledListeners = new Set<() => void>()
  const rootListeners = new Set<() => void>()
  const folders: WatchedFolders = {
    watchedRoots: () => roots,
    onRootsChanged: (listener) => {
      rootListeners.add(listener)
      return () => rootListeners.delete(listener)
    },
    reconcile: async (root) => {
      reconciles.push(root)
      return reconcileResult
    },
  }
  const sink: FolderEventSink = {
    isEnabled: () => enabled,
    onEnabledChange: (listener) => {
      enabledListeners.add(listener)
      return () => enabledListeners.delete(listener)
    },
    handleFileEvents: async (paths) => {
      batches.push(paths)
    },
  }
  const manager = new FolderWatchManager(folders, sink, {
    debounceMs: 25,
    maxWaitMs: 200,
    reconcileDelayMs: 5_000,
    dirReconcileDelayMs: 30,
    minReconcileGapMs: 0,
    retryBaseMs: 20,
    retryMaxMs: 40,
    watch: ((
      root: string,
      _options: unknown,
      listener: (type: string, name: string | null) => void,
    ) => {
      if (failOpen) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const watcher = new FakeWatcher()
      const list = watchers.get(root) ?? []
      list.push({ watcher, emit: (name) => listener('rename', name) })
      watchers.set(root, list)
      return watcher
    }) as never,
  })
  return {
    manager,
    batches,
    reconciles,
    watchers,
    setEnabled(value: boolean) {
      enabled = value
      for (const listener of enabledListeners) listener()
    },
    setFailOpen(value: boolean) {
      failOpen = value
    },
    setReconcileResult(value: { ok: boolean; reason?: string }) {
      reconcileResult = value
    },
    changeRoots(next: string[]) {
      roots = next
      for (const listener of rootListeners) listener()
    },
  }
}

describe('FolderWatchManager', () => {
  it('coalesces bursts, filters unsupported and temporary files, and ignores generated folders', async () => {
    const root = join(dir, 'docs')
    const h = harness([root])
    const [first] = h.watchers.get(root)!
    first!.emit('report.docx')
    first!.emit('report.docx')
    first!.emit(join('sub', 'notes.md'))
    first!.emit('~$report.docx')
    first!.emit('download.pdf.crdownload')
    first!.emit('scratch.tmp')
    first!.emit('photo.png')
    first!.emit(join('node_modules', 'pkg', 'readme.md'))
    first!.emit(join('.git', 'config.txt'))
    await wait(120)
    expect(h.batches).toHaveLength(1)
    expect([...h.batches[0]!].sort()).toEqual(
      [join(root, 'report.docx'), join(root, 'sub', 'notes.md')].sort(),
    )
    h.manager.close()
  })

  it('requests a throttled reconcile for folder-level events', async () => {
    const root = join(dir, 'docs')
    const h = harness([root])
    const [first] = h.watchers.get(root)!
    first!.emit('Renamed folder')
    first!.emit('Renamed folder')
    first!.emit(null)
    await wait(100)
    expect(h.reconciles).toEqual([root])
    h.manager.close()
  })

  it('stops watching while memory is paused and resumes when re-enabled', async () => {
    const root = join(dir, 'docs')
    const h = harness([root])
    const [first] = h.watchers.get(root)!
    h.setEnabled(false)
    expect(first!.watcher.closed).toBe(true)
    expect(h.manager.watchedRoots()).toEqual([])
    first!.emit('late.docx')
    await wait(80)
    expect(h.batches).toHaveLength(0)
    h.setEnabled(true)
    expect(h.watchers.get(root)).toHaveLength(2)
    h.manager.close()
  })

  it('survives an unavailable root with backoff and recovers when it returns', async () => {
    const root = join(dir, 'unplugged')
    const h = harness([])
    h.setFailOpen(true)
    h.changeRoots([root])
    expect(h.watchers.get(root)).toBeUndefined()
    await wait(60)
    h.setFailOpen(false)
    await wait(120)
    expect(h.watchers.get(root)).toHaveLength(1)
    // Coming back after an outage re-checks the root for missed changes.
    await wait(80)
    expect(h.reconciles).toContain(root)
    h.manager.close()
  })

  it('reopens a silent watcher after unavailable reconcile and catches up when the mount returns', async () => {
    const root = join(dir, 'silent-outage')
    const h = harness([root])
    const [first] = h.watchers.get(root)!

    // Simulate a mounted drive going offline without fs.watch emitting an error.
    h.setReconcileResult({ ok: false, reason: 'unavailable' })
    await h.manager.reconcileAll()
    expect(first!.watcher.closed).toBe(true)
    expect(h.reconciles).toEqual([root])

    // It comes back before the bounded watcher retry. Opening the watcher must trigger a catch-up.
    h.setReconcileResult({ ok: true })
    await wait(100)
    expect(h.watchers.get(root)).toHaveLength(2)
    expect(h.reconciles).toEqual([root, root])
    h.manager.close()
  })

  it('reopens a watcher after an error event and never throws', async () => {
    const root = join(dir, 'docs')
    const h = harness([root])
    const [first] = h.watchers.get(root)!
    first!.watcher.emit('error', new Error('EPERM'))
    expect(first!.watcher.closed).toBe(true)
    await wait(80)
    expect(h.watchers.get(root)).toHaveLength(2)
    h.manager.close()
  })

  it('closes watchers and drops pending work on close', async () => {
    const root = join(dir, 'docs')
    const h = harness([root])
    const [first] = h.watchers.get(root)!
    first!.emit('x.docx')
    h.manager.close()
    expect(first!.watcher.closed).toBe(true)
    await wait(80)
    expect(h.batches).toHaveLength(0)
  })

  it('stops watching a root when its scan job is stopped', () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    const h = harness([a, b])
    h.changeRoots([a])
    expect(h.manager.watchedRoots()).toEqual([a])
    expect(h.watchers.get(b)![0]!.watcher.closed).toBe(true)
    h.manager.close()
  })
})

describe('isIndexablePath', () => {
  it('matches scanner rules', () => {
    const root = join(dir, 'r')
    expect(isIndexablePath(root, join(root, 'a', 'b.xlsx'))).toBe(true)
    expect(isIndexablePath(root, join(root, 'build', 'b.xlsx'))).toBe(false)
    expect(isIndexablePath(root, join(root, '.hidden', 'b.xlsx'))).toBe(false)
    expect(isIndexablePath(root, join(root, '~$b.xlsx'))).toBe(false)
    expect(isIndexablePath(root, join(root, 'b.xlsx.partial'))).toBe(false)
    expect(isIndexablePath(root, join(root, 'b.zip'))).toBe(false)
  })
})

describe('FolderScanManager.reconcile', () => {
  it('re-walks a completed root by metadata only and keeps the scan counters', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'a.md'), 'a')
    writeFileSync(join(root, 'nested', 'b.txt'), 'bb')
    writeFileSync(join(root, 'skip.zip'), 'zip')
    const seen: Array<Map<string, { mtimeMs: number; sizeBytes: number }>> = []
    const scanner = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: () => true,
      reconcileFolder: async (_root, files) => {
        seen.push(files)
      },
    })
    try {
      scanner.start(root)
      for (let i = 0; i < 300 && scanner.status().running; i++) await wait(10)
      const before = scanner.status()
      expect(before.state).toBe('complete')
      expect(scanner.watchedRoots()).toEqual([root])

      writeFileSync(join(root, 'c.docx'), 'ccc')
      const outcome = await scanner.reconcile(root)
      expect(outcome).toMatchObject({ ok: true, files: 3 })
      expect([...seen[0]!.keys()].map((p) => p.slice(root.length + 1)).sort()).toEqual(
        ['a.md', 'c.docx', join('nested', 'b.txt')].sort(),
      )
      const after = scanner.status()
      expect(after.discovered).toBe(before.discovered)
      expect(after.enrolled).toBe(before.enrolled)
      expect(after.state).toBe('complete')
      expect(after.reconciledAt).toBeGreaterThan(0)

      rmSync(root, { recursive: true, force: true })
      expect(await scanner.reconcile(root)).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(seen).toHaveLength(1)
    } finally {
      scanner.close()
    }
  })

  it('forgets every folder when the index is cleared', () => {
    let cleared = () => undefined as void
    const scanner = new FolderScanManager(join(dir, 'state2'), {
      indexDiscoveredFile: () => true,
      onCleared: (listener) => {
        cleared = listener
        return () => undefined
      },
    })
    const root = join(dir, 'c')
    mkdirSync(root)
    scanner.start(root)
    expect(scanner.watchedRoots()).toEqual([root])
    cleared()
    expect(scanner.watchedRoots()).toEqual([])
    scanner.close()
  })
})
