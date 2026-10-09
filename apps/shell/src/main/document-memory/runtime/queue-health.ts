import type { IndexingBlockReason } from '../../../shared/fork/document-index-api'

/** What the manager knows about its queue at one moment; plain values only, so the verdict below is a pure function of them. */
export interface QueueProbe {
  /** files waiting for reading plus files waiting for vectors */
  waiting: number
  line: number
  textOnlyInLine: number
  vectorLine: number
  vectorWait: number
  extracting: boolean
  extractingForSeconds: number
  inFlightAsks: number
  embedding: boolean
  /** something in the line can be read right now */
  extractable: boolean
  writeReady: boolean
  accountingOk: boolean
  admissionRetryArmed: boolean
  vectorRetryPending: boolean
  model: string
  workerUp: boolean
  lastError: string | undefined
  /** a policy pause (battery, locked screen, low memory, the user), already shown as "paused" */
  pausedBy: string | undefined
}

/**
 * Why the line is not moving, for the status the Index screen shows. Undefined while it is moving, while nothing waits, and
 * while a policy pause already says why.
 */
export function blockedReasonOf(p: QueueProbe): IndexingBlockReason | undefined {
  if (p.pausedBy !== undefined || p.waiting === 0) return undefined
  if (!p.writeReady) return 'storage-starting'
  if (p.model === 'blocked' || p.model === 'error') return 'model-unavailable'
  if (p.extracting || p.embedding) return undefined
  if (p.admissionRetryArmed || !p.accountingOk) return 'storage-checking'
  if (p.vectorRetryPending) return 'embedding-retry'
  return p.extractable || p.vectorLine > 0 ? 'stalled' : undefined
}

/** A queue that makes no progress is written to the log at most this often per reason. */
export const STALL_LOG_INTERVAL_MS = 10 * 60_000

/**
 * Called once a poll. Work is waiting and nothing has been read or embedded since the previous poll, twice in a row: one line
 * (aggregate numbers and the reason, no file names) says why, so a queue that is idle but not empty is never silent.
 */
export class QueueWatchdog {
  private lastProgress = 0
  private idlePolls = 0
  private lastLogAt = 0
  private lastKey = ''

  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  observe(
    progress: number,
    probe: QueueProbe,
    pausedBy: string | undefined,
    reason: IndexingBlockReason | undefined,
  ): void {
    const progressed = progress !== this.lastProgress
    this.lastProgress = progress
    if (progressed || probe.waiting === 0) {
      this.idlePolls = 0
      return
    }
    // the first poll after a start always finds nothing done yet: a stall is two in a row
    if (++this.idlePolls < 2) return
    const why =
      pausedBy !== undefined
        ? `paused:${pausedBy}`
        : (reason ?? (probe.extracting || probe.embedding ? 'working-slowly' : 'unknown'))
    const now = this.now()
    if (why === this.lastKey && now - this.lastLogAt < STALL_LOG_INTERVAL_MS) return
    this.lastKey = why
    this.lastLogAt = now
    const error = (probe.lastError ?? 'none')
      .replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+/g, '<path>')
      .slice(0, 160)
    this.write(
      `queue not advancing: reason=${why} waiting=${probe.waiting} line=${probe.line} textOnlyInLine=${probe.textOnlyInLine} vectorLine=${probe.vectorLine} vectorWait=${probe.vectorWait} ` +
        `extracting=${probe.extracting}(${probe.extractingForSeconds}s) inFlightAsks=${probe.inFlightAsks} embedding=${probe.embedding} writeReady=${probe.writeReady} accountingOk=${probe.accountingOk} ` +
        `admissionRetryArmed=${probe.admissionRetryArmed} vectorRetryPending=${probe.vectorRetryPending} model=${probe.model} worker=${probe.workerUp ? 'up' : 'down'} lastError=${error}`,
    )
  }
}
