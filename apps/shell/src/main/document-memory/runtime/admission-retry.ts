export const ADMISSION_RETRY_BASE_MS = 2_000
export const ADMISSION_RETRY_MAX_MS = 30_000

export interface AdmissionRetryOptions {
  /** Re-measure storage accounting (a transient denial is usually a stale / unknown / degraded measurement); true = the new measurement is fresh and valid. */
  refresh: () => Promise<boolean>
  /** Re-queue incomplete work and drain. Runs after the refresh, never while stopped. */
  resume: () => void
  isActive: () => boolean
  baseMs?: number
  maxMs?: number
}

/**
 * Bounded-backoff retry of work that a TRANSIENT admission gate refused (accounting unknown / degraded / stale, free disk
 * unverifiable, quota momentarily exhausted). Without it a refused queue only restarted at the next 60 s poll.
 *
 * - single timer: any number of `request()` calls while one is armed collapse into it (never a retry storm);
 * - the delay doubles per consecutive refusal up to `maxMs` and resets on `succeeded()`, or when an accounting-related
 *   refusal was answered by a fresh measurement (progress was made; never a busy loop - a refusal that is not about
 *   accounting, e.g. a full quota, keeps backing off);
 * - each attempt first re-measures accounting (single-flight in the accounting runner), then resumes the drain, so a
 *   fresh measurement is what lets the same admission gates (quota, hard cap, lease owner, epoch) pass - none is bypassed.
 */
export class AdmissionRetry {
  private timer: NodeJS.Timeout | null = null
  private attempt = 0
  private disposed = false
  private accountingRelated = false
  private readonly baseMs: number
  private readonly maxMs: number

  constructor(private readonly options: AdmissionRetryOptions) {
    this.baseMs = options.baseMs ?? ADMISSION_RETRY_BASE_MS
    this.maxMs = options.maxMs ?? ADMISSION_RETRY_MAX_MS
  }

  isArmed(): boolean {
    return this.timer !== null
  }

  nextDelayMs(): number {
    return Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.attempt, 16))
  }

  request(accountingRelated = true): void {
    if (this.disposed || !this.options.isActive()) return
    this.accountingRelated = this.accountingRelated || accountingRelated
    if (this.timer) return
    const delay = this.nextDelayMs()
    this.attempt++
    this.timer = setTimeout(() => void this.fire(), delay)
    this.timer.unref?.()
  }

  /** Work was admitted again: the next refusal starts from the short delay. */
  succeeded(): void {
    this.attempt = 0
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async fire(): Promise<void> {
    this.timer = null
    if (this.disposed || !this.options.isActive()) return
    let fresh = false
    try {
      fresh = await this.options.refresh()
    } catch {
      // a failed measurement just keeps the gates closed; the next attempt measures again
    }
    if (this.disposed || !this.options.isActive()) return
    if (fresh && this.accountingRelated) this.attempt = 0
    this.accountingRelated = false
    this.options.resume()
  }
}
