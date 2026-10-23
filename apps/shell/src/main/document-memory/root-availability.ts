import { resolve, relative, isAbsolute, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { volumeRootOf } from './volume-root'

const PROBE_PATH_DEADLINE_MS = 3000

/** Native path probe cache for coalescing concurrent filesystem stat calls on the same target */
export const nativePathProbes = new Map<string, Promise<boolean>>()

// A dead SMB stat may outlive its deadline. Keep it in flight in a worker, never
// replace it with another stat of the same root just because the caller timed out.
let probeWorker: Worker | undefined
const replies = new Map<string, (online: boolean) => void>()
function statRoot(path: string): Promise<boolean> {
  if (!probeWorker) {
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      const { stat } = require('node:fs/promises');
      parentPort.on('message', path => {
        stat(path).then(s => s.isDirectory(), error => ['EACCES', 'EPERM'].includes(error.code))
          .then(online => parentPort.postMessage({ path, online }));
      });
    `,
      { eval: true },
    )
    probeWorker = worker
    worker.on('message', ({ path, online }: { path: string; online: boolean }) => {
      replies.get(path)?.(online)
      replies.delete(path)
      if (!replies.size) worker.unref()
    })
    const failed = () => {
      if (probeWorker !== worker) return
      probeWorker = undefined
      for (const done of replies.values()) done(false)
      replies.clear()
    }
    worker.on('error', failed)
    worker.on('exit', failed)
    worker.unref()
  }
  return new Promise((resolve) => {
    replies.set(path, resolve)
    probeWorker!.ref()
    probeWorker!.postMessage(path)
  })
}

export function getOrCreateNativePathProbe(targetPath: string): Promise<boolean> {
  const path = resolve(targetPath)
  const existing = nativePathProbes.get(path)
  if (existing) {
    return existing
  }
  const nativeProbe: Promise<boolean> = statRoot(path).finally(() => {
    if (nativePathProbes.get(path) === nativeProbe) {
      nativePathProbes.delete(path)
    }
  })
  nativePathProbes.set(path, nativeProbe)
  return nativeProbe
}

export interface RootState {
  root: string
  online: boolean
  offlineSince: number | null
  lastProbeAt: number
  nextProbeAt: number
  failures: number
}

export function pathUnderRoot(root: string, path: string): boolean {
  const child = relative(root, path)
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
}

const OFFLINE_BACKOFF = [60_000, 300_000, 900_000, 3_600_000]
const ONLINE_TTL = 5 * 60_000

/** One state per indexed root (or drive/share/mount). Driven by existing idle ticks. */
export class RootAvailability {
  private readonly states = new Map<string, RootState>()
  private readonly roots = new Set<string>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly recovered = new Set<(root: string) => void>()
  private readonly errorProbes = new Map<string, number>()
  private lastImmediate = -Infinity

  constructor(
    private readonly probe = getOrCreateNativePathProbe,
    private readonly now = Date.now,
    private readonly timeoutMs = PROBE_PATH_DEADLINE_MS,
  ) {}

  register(root: string): void {
    this.roots.add(resolve(root))
  }
  unregister(root: string): void {
    this.roots.delete(resolve(root))
    this.states.delete(resolve(root))
  }
  configuredRoots(): string[] {
    return [...this.roots]
  }
  rootOf(path: string): string {
    return (
      [...this.roots]
        .filter((root) => pathUnderRoot(root, path))
        .sort((a, b) => b.length - a.length)[0] ?? volumeRootOf(path)
    )
  }
  snapshot(): RootState[] {
    return [...this.states.values()].map((state) => ({ ...state }))
  }
  onRecovered(listener: (root: string) => void): () => void {
    this.recovered.add(listener)
    return () => {
      this.recovered.delete(listener)
    }
  }
  observe(root: string, online: boolean): void {
    root = resolve(root)
    const previous = this.states.get(root)
    const now = this.now()
    const failures = online ? 0 : (previous?.failures ?? 0) + 1
    this.states.set(root, {
      root,
      online,
      offlineSince: online ? null : (previous?.offlineSince ?? now),
      lastProbeAt: now,
      failures,
      nextProbeAt: now + (online ? ONLINE_TTL : OFFLINE_BACKOFF[Math.min(failures - 1, 3)]!),
    })
    if (online && previous && !previous.online)
      for (const listener of this.recovered) listener(root)
  }
  checkPath(path: string, force = false): Promise<boolean> {
    return this.check(this.rootOf(path), force)
  }
  /** Short confirmation window for destructive reconciliation, shared by the entire batch. */
  confirmPath(path: string): Promise<boolean> {
    const root = this.rootOf(path)
    const recent = this.states.get(resolve(root))
    if (recent && !recent.online) return this.check(root)
    return this.check(root, !recent || this.now() - recent.lastProbeAt > 5_000)
  }
  /** Recheck once on the first I/O error, then share that verdict across failing files. */
  checkAfterError(root: string): Promise<boolean> {
    root = resolve(root)
    const state = this.states.get(root)
    if (state && !state.online) return this.check(root)
    if (this.now() - (this.errorProbes.get(root) ?? -Infinity) < 5_000) return this.check(root)
    this.errorProbes.set(root, this.now())
    return this.check(root, true)
  }
  /** Synchronous selection guard: unknown/expired roots wait for a single bounded probe. */
  selectable(path: string): boolean {
    const root = this.rootOf(path)
    const state = this.states.get(resolve(root))
    if (!state || this.now() >= state.nextProbeAt) {
      void this.check(root)
      return false
    }
    return state.online
  }
  check(root: string, force = false): Promise<boolean> {
    root = resolve(root)
    const pending = this.pending.get(root)
    if (pending) return pending
    const state = this.states.get(root)
    if (!force && state && this.now() < state.nextProbeAt) return Promise.resolve(state.online)
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const native = Promise.resolve()
      .then(() => this.probe(root))
      .catch(() => false)
    // pending is retained until native completion, even after the deadline.
    const bounded = Promise.race([
      native,
      new Promise<false>((done) => {
        timer = setTimeout(() => {
          timedOut = true
          probeWorker?.unref()
          done(false)
        }, this.timeoutMs)
        timer.unref?.()
      }),
    ]).then((online) => {
      this.observe(root, online)
      return online
    })
    this.pending.set(root, bounded)
    void native.then((online) => {
      if (timer) clearTimeout(timer)
      this.pending.delete(root)
      if (timedOut) this.observe(root, online)
    })
    return bounded
  }
  async probeDue(force = false): Promise<void> {
    if (force) {
      if (this.now() - this.lastImmediate < 5_000) return
      this.lastImmediate = this.now()
    }
    await Promise.all(
      [...new Set([...this.roots, ...this.states.keys()])].map((root) => this.check(root, force)),
    )
  }
}

export const rootAvailability = new RootAvailability()

/**
 * Asynchronously probes whether targetPath exists and is a directory.
 * Bounded by deadlineMs (default: 3000ms) to never freeze the Electron main thread.
 * Coalesces concurrent in-flight probes on the same resolved path using nativePathProbes to avoid I/O stampede.
 * Caller deadline timeout does NOT evict native probe from cache.
 */
export function probePathAvailable(
  targetPath: string,
  deadlineMs: number = PROBE_PATH_DEADLINE_MS,
): Promise<boolean> {
  const path = resolve(targetPath)
  const nativeProbe = getOrCreateNativePathProbe(path)

  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<false>((resolvePromise) => {
    timer = setTimeout(() => {
      probeWorker?.unref()
      resolvePromise(false)
    }, deadlineMs)
    timer.unref?.()
  })

  return Promise.race([nativeProbe, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
