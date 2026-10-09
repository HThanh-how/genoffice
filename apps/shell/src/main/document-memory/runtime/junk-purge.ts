import type { DocumentMemoryStore } from '../store'
import { isJunkFileName } from '../scan-policy'
import type { WorkerReply, WorkerRequest } from '../worker-types'

const FLAG_KEY = 'junk_purge_v1'
/** Work per slice inside the worker; each slice commits on its own, so another connection never waits longer than this. */
export const JUNK_PURGE_STEP_MS = 25
/** Pause between slices: the purge yields the database and the worker to indexing and search. */
export const JUNK_PURGE_GAP_MS = 10
const RETRY_MS = 60_000
const MAX_FAILURES = 5

export interface JunkPurgeStepResult {
  removed: number
  scanned: number
  done: boolean
}

/** Whether the one-time purge already ran to the end (one primary-key probe). */
export function junkPurgeDone(store: Pick<DocumentMemoryStore, 'rawDb'>): boolean {
  return Boolean(store.rawDb.prepare('SELECT 1 FROM document_memory_meta WHERE key = ?').get(FLAG_KEY))
}

/**
 * One slice of the one-time cleanup of temp/backup/OS-junk files that were indexed before the scan policy learned to skip
 * them. Runs inside the indexing worker (its own process): deleting a document removes its chunks, full-text rows and
 * vectors, which on a large index takes minutes in total and must never run on Electron's main thread. Only touches rows
 * the user never opened; source files are never touched.
 */
export function runJunkPurgeStep(store: DocumentMemoryStore): JunkPurgeStepResult {
  return store.purgeDiscoveredByNameStep(isJunkFileName, { maxMs: JUNK_PURGE_STEP_MS, flagKey: FLAG_KEY })
}

export interface JunkPurgeDeps {
  store: Pick<DocumentMemoryStore, 'rawDb'>
  ask: (request: WorkerRequest, timeoutMs: number) => Promise<WorkerReply | null>
  isActive: () => boolean
  isPaused?: () => boolean
  /** Rows were deleted by the worker: the owner invalidates what it caches in memory (ANN). */
  onRemoved?: () => void
  stepGapMs?: number
  retryMs?: number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
}

function isStepResult(value: unknown): value is JunkPurgeStepResult {
  return !!value && typeof value === 'object' && typeof (value as JunkPurgeStepResult).done === 'boolean'
}

/**
 * Drives the purge from the main thread without doing any of its work: one request per slice to the worker, a pause
 * between slices, resumable (the worker keeps the cursor in the database). Returns a cancel function.
 */
export function startJunkPurge(deps: JunkPurgeDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  let cancelled = false
  let failures = 0
  const later = (ms: number): void => {
    setTimer(() => void tick(), ms).unref?.()
  }
  const tick = async (): Promise<void> => {
    if (cancelled || !deps.isActive()) return
    try {
      if (junkPurgeDone(deps.store)) return
    } catch {
      return
    }
    if (deps.isPaused?.()) return later(deps.retryMs ?? RETRY_MS)
    const reply = await deps.ask({ type: 'junk-purge-step' }, 30_000)
    if (cancelled || !deps.isActive()) return
    const result = reply && 'result' in reply ? (reply.result as unknown) : null
    if (!isStepResult(result)) {
      if (++failures >= MAX_FAILURES) return // retried at the next start
      return later(deps.retryMs ?? RETRY_MS)
    }
    failures = 0
    if (result.removed > 0) deps.onRemoved?.()
    if (!result.done) later(deps.stepGapMs ?? JUNK_PURGE_GAP_MS)
  }
  later(0)
  return () => {
    cancelled = true
  }
}
