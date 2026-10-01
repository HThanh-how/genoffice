/**
 * Short-lived cache for the "Document index" popup's progress payload.
 *
 * The payload is built from aggregate SQL over the document/chunk tables, which on a
 * large store (hundreds of thousands of chunks) costs tens to hundreds of milliseconds and
 * runs on the main process. The popup polls it, and several windows may poll at once, so
 * the work is bounded two ways:
 *
 *  - the result is reused for a TTL that scales with how long the last computation took
 *    (about ten times its duration, clamped to 1-5 s), which caps the main-process duty
 *    cycle spent on progress at roughly 10 % however slow the database is;
 *  - a change in the cheap, in-memory `key` (folder, scan state, scan error count) forces
 *    an immediate recompute so state transitions are never stale.
 */
export interface ActivityCache<T> {
  get(key: string, compute: () => T): T
  invalidate(): void
}

export function createActivityCache<T>(
  options: { minTtlMs?: number; maxTtlMs?: number; dutyFactor?: number; now?: () => number } = {},
): ActivityCache<T> {
  const minTtl = options.minTtlMs ?? 1000
  const maxTtl = options.maxTtlMs ?? 5000
  const factor = options.dutyFactor ?? 10
  const now = options.now ?? (() => performance.now())
  let entry: { key: string; value: T; expiresAt: number } | null = null
  return {
    get(key, compute) {
      const t = now()
      if (entry && entry.key === key && t < entry.expiresAt) return entry.value
      const started = now()
      const value = compute()
      const finished = now()
      const ttl = Math.min(maxTtl, Math.max(minTtl, (finished - started) * factor))
      entry = { key, value, expiresAt: finished + ttl }
      return value
    },
    invalidate() {
      entry = null
    },
  }
}
