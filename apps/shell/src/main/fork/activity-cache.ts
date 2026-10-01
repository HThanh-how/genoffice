/**
 * Stale-while-revalidate cache for the "Document index" popup's aggregate.
 *
 * The popup polls `getIndexingActivity`, and several windows may poll at once. A poll must cost
 * the (shared, single-threaded) main process next to nothing, so `get` never runs the
 * computation for a value it already holds: it returns the last value immediately and, when that
 * value is older than the TTL, schedules one refresh on a later event-loop turn (never inside the
 * caller's IPC handler). Only the very first read of a key has nothing to return and computes in
 * place. The TTL scales with the measured cost of the computation (about ten times its
 * duration, clamped), which bounds the duty cycle spent on refreshing at roughly 10 %.
 */
export interface SwrCache<T> {
  /** Last value for `key` at once; `compute` runs inline only when `key` has no value yet. */
  get(key: string, compute: () => T): T
  /** Mark the value stale and refresh it in the background as soon as possible. */
  invalidate(): void
}

export interface SwrCacheOptions {
  minTtlMs?: number
  maxTtlMs?: number
  dutyFactor?: number
  now?: () => number
  /** Run a refresh later, off the caller's stack (default: setImmediate). */
  schedule?: (run: () => void) => void
}

export function createSwrCache<T>(options: SwrCacheOptions = {}): SwrCache<T> {
  const minTtl = options.minTtlMs ?? 1000
  const maxTtl = options.maxTtlMs ?? 5000
  const factor = options.dutyFactor ?? 10
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? ((run) => void setImmediate(run))
  let entry: { key: string; value: T; expiresAt: number } | null = null
  let latest: { key: string; compute: () => T } | null = null
  let refreshing = false

  const compute = (key: string, run: () => T): T => {
    const started = now()
    const value = run()
    const finished = now()
    const ttl = Math.min(maxTtl, Math.max(minTtl, (finished - started) * factor))
    entry = { key, value, expiresAt: finished + ttl }
    return value
  }
  const refresh = (): void => {
    if (refreshing || !latest) return
    refreshing = true
    schedule(() => {
      const job = latest
      try {
        if (job) compute(job.key, job.compute)
      } catch {
        // Keep serving the previous value; the next poll tries again.
        if (entry) entry.expiresAt = now() + minTtl
      } finally {
        refreshing = false
      }
    })
  }

  return {
    get(key, run) {
      latest = { key, compute: run }
      if (!entry || entry.key !== key) return compute(key, run)
      if (now() >= entry.expiresAt) refresh()
      return entry.value
    },
    invalidate() {
      if (!entry) return
      entry.expiresAt = Number.NEGATIVE_INFINITY
      refresh()
    },
  }
}
