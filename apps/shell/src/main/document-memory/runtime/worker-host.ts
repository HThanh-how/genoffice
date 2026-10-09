import { mkdirSync } from 'node:fs'
import type { Worker } from 'node:worker_threads'
import { safeError } from '../issues'
import type { WorkerReply, WorkerRequest } from '../worker-types'

export interface WorkerHostDeps {
  factory: (script: string, env: Record<string, string>) => Worker
  script: () => string
  cacheDir: () => string
  /** environment of a freshly started index process (profile, database, storage budget and its version) */
  env: () => Record<string, unknown>
  isStopped: () => boolean
  defaultTimeoutMs: () => number
  isWriteReady: () => boolean
  /** the storage hand-shake with a live worker that has not confirmed its limits yet */
  recover: () => void
  spawned: () => void
  recycled: (reason: string) => void
  /** reservations the dead worker held (extract / embed / ocr / worker / ann) */
  releaseReservations: () => void
  onModel: (message: Extract<WorkerReply, { type: 'model' }>) => void
  /** the process failed or was replaced: why */
  onFailure: (error: string, fatal: boolean) => void
}

/**
 * The index process and the requests in flight to it. One request = one reply (or a timeout that answers null); a replaced
 * or dead process answers every request still waiting with its reason, so nothing waits on a worker that no longer exists.
 */
export class WorkerHost {
  private worker: Worker | null = null
  private nextRequestId = 1
  private readonly waiting = new Map<
    number,
    { resolve: (reply: WorkerReply | null) => void; timer: NodeJS.Timeout }
  >()

  constructor(private readonly deps: WorkerHostDeps) {}

  get isUp(): boolean {
    return this.worker !== null
  }

  get inFlight(): number {
    return this.waiting.size
  }

  private failWaiting(reason: string): void {
    for (const [id, pending] of this.waiting) {
      clearTimeout(pending.timer)
      pending.resolve({ id, error: reason })
      this.waiting.delete(id)
    }
  }

  /** Stops the process for good (the manager is closing). */
  terminate(): void {
    const worker = this.worker
    this.worker = null
    if (worker && typeof (worker as { terminate?: unknown }).terminate === 'function')
      void worker.terminate()
  }

  recycle(reason: string): void {
    const worker = this.worker
    if (!worker) return
    this.worker = null
    this.deps.onFailure(reason, false)
    this.deps.releaseReservations()
    this.deps.recycled(reason)
    if (typeof (worker as { terminate?: unknown }).terminate === 'function') void worker.terminate()
    this.failWaiting(reason)
  }

  ask(
    request: WorkerRequest,
    timeoutMs: number = this.deps.defaultTimeoutMs(),
    recycleOnTimeout = false,
  ): Promise<WorkerReply | null> {
    if (this.deps.isStopped()) return Promise.resolve(null)
    const id = this.nextRequestId++
    return new Promise((resolveReply) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolveReply(null)
        if (recycleOnTimeout && !this.deps.isStopped())
          this.recycle('Indexing stalled and was restarted.')
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolveReply, timer })
      try {
        this.ensure().postMessage({ ...request, id })
      } catch (error) {
        clearTimeout(timer)
        this.waiting.delete(id)
        resolveReply({ id, error: safeError(error) })
      }
    })
  }

  ensure(): Worker {
    if (this.worker) {
      if (!this.deps.isWriteReady()) this.deps.recover()
      return this.worker
    }
    mkdirSync(this.deps.cacheDir(), { recursive: true })
    const worker = this.deps.factory(this.deps.script(), this.deps.env() as Record<string, string>)
    worker.on('message', (msg: WorkerReply) => {
      if (this.worker !== worker) return
      if ('type' in msg && msg.type === 'model') {
        this.deps.onModel(msg)
        return
      }
      if (!('id' in msg)) return
      const pending = this.waiting.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.waiting.delete(msg.id)
      pending.resolve(msg)
      if ('error' in msg && msg.restartRequired === true) this.recycle(msg.error)
    })
    const fail = (error: string): void => {
      if (this.worker !== worker) return
      this.worker = null
      this.deps.onFailure(error, true)
      this.deps.releaseReservations()
      this.deps.recycled(error)
      this.failWaiting(error)
    }
    worker.on('error', (e) => fail(safeError(e)))
    worker.on('exit', () => {
      if (!this.deps.isStopped() && this.worker === worker)
        fail('Document memory worker exited unexpectedly.')
    })
    this.worker = worker
    this.deps.spawned()
    return worker
  }
}
