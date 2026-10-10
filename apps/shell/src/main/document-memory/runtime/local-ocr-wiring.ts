/**
 * Glue between the document-memory manager and the local "light index" OCR pass (local-ocr/).
 *
 *  - one shared `LocalOcrEngineRegistry` (the Tesseract engine's CPU-heavy image preparation is sent to
 *    the index worker as an `ocr-prepare` request; Apple Vision already runs in its own helper process
 *    and Tesseract.js recognises in a worker thread, so the main thread only reads files and writes rows);
 *  - the cloud host (`createOcrHost`) with `localFirst` = "a local engine is on and can run right now";
 *  - `LocalOcrRunner`, driven by the OCR scheduler tick: sequential batches of `LocalOcrJob.runOnce`,
 *    single-flight, epoch-safe, stopped at once by pause / disable / close.
 *
 * Every write goes through `host.savePages` (= `persistOcrPagesGated`: storage admission, budget, accounting),
 * every render through `host.render` (= the index worker's `ocr-render`).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { LocalOcrSettings } from '../../../shared/fork/agy-ocr'
import { currentIndexingPolicy } from '../../fork/indexing-policy-bus'
import type { OcrJobHost } from '../agy-ocr-job'
import { isIndexingPaused, onIndexingPolicyChange } from '../background-work-gate'
import { coolDownMs } from '../cpu-budget'
import {
  LocalOcrJob,
  type LocalOcrEvent,
  type LocalOcrGate,
  type LocalOcrRunSummary,
} from '../local-ocr/local-ocr-job'
import { LocalOcrEngineRegistry } from '../local-ocr/registry'
import { TesseractEngine, TESSERACT_ENGINE_ID } from '../local-ocr/tesseract-engine'
import { createOcrHost, type OcrHostInput } from '../ocr-host'

/** Files read per `runOnce` batch, and batches per tick (a tick is a sequence of batches, never parallel). */
export const LOCAL_OCR_BATCH_FILES = 25
export const LOCAL_OCR_MAX_BATCHES_PER_TICK = 40
/** How long the index worker may take to prepare one image before the engine falls back to the original bytes. */
const PREPARE_TIMEOUT_MS = 60_000

type WorkerAsk = (
  request: { type: 'ocr-prepare'; bytes: Uint8Array; dpi: number },
  timeoutMs?: number,
) => Promise<unknown>

export interface LocalOcrWiringDeps {
  /** the cloud host's inputs (store, admission, scheduler, budget, worker `ask`, reindex ...) */
  hostInput: OcrHostInput
  db: DatabaseSync
  ask: WorkerAsk
  settings(): LocalOcrSettings
  /** idle / AC / battery policy (the same evaluateOcrGate the cloud reader uses) */
  gate(): LocalOcrGate
  /** document memory is enabled and not stopped */
  isActive(): boolean
  /** bumped whenever work in flight must be discarded (disable, close) */
  epoch(): number
  /** storage is not full and no compaction run is in flight */
  canWork(): boolean
  registry?: LocalOcrEngineRegistry
  coolDown?(activeMs: number, signal: AbortSignal): Promise<void>
  totalRamMB?(): number
  log?(event: LocalOcrEvent): void
}

export interface LocalOcrWiring {
  host: OcrJobHost
  registry: LocalOcrEngineRegistry
  runner: LocalOcrRunner
  dispose(): Promise<void>
}

export class LocalOcrRunner {
  private running: Promise<LocalOcrRunSummary | null> | null = null
  private abort: AbortController | null = null

  constructor(
    private readonly deps: LocalOcrWiringDeps,
    private readonly host: OcrJobHost,
    private readonly registry: LocalOcrEngineRegistry,
  ) {}

  get isRunning(): boolean {
    return this.running !== null
  }

  /** Stop the batch in flight (pause, disable, close): the next page boundary ends it, a sleeping cool-down wakes. */
  cancel(): void {
    this.abort?.abort()
  }

  /** One scheduler tick. Single-flight: a tick that finds the previous one still running returns null at once. */
  tick(): Promise<LocalOcrRunSummary | null> {
    if (this.running) return Promise.resolve(null)
    const settings = this.deps.settings()
    if (!settings.enabled || !this.deps.isActive() || isIndexingPaused())
      return Promise.resolve(null)
    // no engine fits the free RAM / has its resources: do not even look at the queue, try again next tick
    if (!this.registry.select(settings.engine)) return Promise.resolve(null)
    const run = this.run().finally(() => {
      if (this.running === run) this.running = null
    })
    this.running = run
    return run
  }

  private async run(): Promise<LocalOcrRunSummary | null> {
    const epoch = this.deps.epoch()
    const abort = new AbortController()
    this.abort = abort
    const unsubscribe = onIndexingPolicyChange((policy) => {
      if (policy.paused) abort.abort()
    })
    const total: LocalOcrRunSummary = { files: 0, pages: 0, escalated: 0, failed: 0, skipped: 0 }
    try {
      for (let batch = 0; batch < LOCAL_OCR_MAX_BATCHES_PER_TICK; batch++) {
        if (abort.signal.aborted || !this.deps.isActive() || this.deps.epoch() !== epoch) break
        const summary = await this.job(epoch, abort.signal).runOnce({
          maxFiles: LOCAL_OCR_BATCH_FILES,
          signal: abort.signal,
        })
        total.files += summary.files
        total.pages += summary.pages
        total.escalated += summary.escalated
        total.failed += summary.failed
        total.skipped += summary.skipped
        if (summary.stoppedBecause) {
          total.stoppedBecause = summary.stoppedBecause
          break
        }
        // nothing read, marked or failed in this batch: the queue is empty (or only stale entries remain)
        if (summary.pages + summary.failed + summary.skipped === 0) break
      }
      return total
    } finally {
      unsubscribe()
      if (this.abort === abort) this.abort = null
    }
  }

  private job(epoch: number, signal: AbortSignal): LocalOcrJob {
    const d = this.deps
    const settings = d.settings.bind(d)
    return new LocalOcrJob({
      db: d.db,
      settings,
      registry: this.registry,
      render: (path, request) => this.host.render(path, request),
      savePages: (path, meta, pages) => this.host.savePages(path, meta, pages),
      reindex: (path) => this.host.reindex(path),
      gate: () => {
        if (!d.isActive() || d.epoch() !== epoch) return { ok: false, reason: 'stopped' }
        if (isIndexingPaused()) return { ok: false, reason: 'indexing-paused' }
        if (!d.canWork()) return { ok: false, reason: 'storage-busy' }
        return d.gate()
      },
      coolDown: (activeMs) =>
        d.coolDown ? d.coolDown(activeMs, signal) : policyCoolDown(activeMs, signal),
      isStopped: () => !d.isActive() || d.epoch() !== epoch,
      ...(d.totalRamMB ? { totalRamMB: d.totalRamMB } : {}),
      ...(d.log ? { log: d.log } : {}),
    })
  }
}

/**
 * The duty cycle in the MAIN process. cpu-budget.ts's `backgroundCoolDown` reads the index process's
 * policy object, which the main process never receives, so it would always use the 35% default; here the
 * published indexing policy's share is used, and a pause wakes the sleep.
 */
async function policyCoolDown(activeMs: number, signal: AbortSignal): Promise<void> {
  const wait = coolDownMs(activeMs, currentIndexingPolicy()?.cpuShare ?? 0.35)
  if (wait <= 0 || signal.aborted) return
  try {
    await sleep(wait, undefined, { signal })
  } catch {
    // aborted: the job's next guard stops the run
  }
}

export function createLocalOcrWiring(deps: LocalOcrWiringDeps): LocalOcrWiring {
  const registry =
    deps.registry ??
    new LocalOcrEngineRegistry({
      factories: {
        [TESSERACT_ENGINE_ID]: () =>
          new TesseractEngine({
            // decode / shrink / flatten run in the index worker, not on the UI thread
            prepare: async (bytes, dpi) => {
              const reply = (await deps.ask(
                { type: 'ocr-prepare', bytes, dpi },
                PREPARE_TIMEOUT_MS,
              )) as { result?: unknown; error?: string } | null
              if (reply && typeof reply === 'object' && 'error' in reply && reply.error) {
                throw new Error(reply.error)
              }
              return reply?.result instanceof Uint8Array ? reply.result : null
            },
          }),
      },
    })
  const host = createOcrHost({
    ...deps.hostInput,
    // the cloud reader waits for the local pass only while a local engine can actually run
    localFirst: () => deps.settings().enabled && registry.select(deps.settings().engine) !== null,
  })
  const runner = new LocalOcrRunner(deps, host, registry)
  return {
    host,
    registry,
    runner,
    dispose: async () => {
      runner.cancel()
      await registry.disposeAll()
    },
  }
}
