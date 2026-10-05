/**
 * Keeps one embedding session sized to the indexing policy's thread count. The session is only
 * re-created between batches, the old one stays in use until the new one is ready, and the
 * swap is skipped (not retried in a loop) when memory is tight or the change is too recent.
 */

export interface SessionKeeperDeps<S> {
  /** Thread count the policy wants right now. */
  desiredThreads: () => number
  create: (threads: number) => Promise<S>
  release: (session: S) => Promise<void> | void
  freeMemMB: () => number
  memoryPressure?: () => boolean
  now?: () => number
  /** Minimum gap between two rebuilds (a rebuild loads the model again). */
  minIntervalMs?: number
  /** A second copy of the model must fit with this much memory to spare. */
  minFreeMB?: number
}

export const SESSION_REBUILD_MIN_INTERVAL_MS = 30_000
export const SESSION_REBUILD_MIN_FREE_MB = 1500

export interface SessionKeeper<S> {
  current(): S
  threads(): number
  /** Call between batches; resolves when the session is (or stays) the right size. */
  align(): Promise<void>
  dispose(): Promise<void>
}

export function createSessionKeeper<S>(
  initial: S,
  initialThreads: number,
  deps: SessionKeeperDeps<S>,
): SessionKeeper<S> {
  const now = deps.now ?? Date.now
  const minInterval = deps.minIntervalMs ?? SESSION_REBUILD_MIN_INTERVAL_MS
  const minFree = deps.minFreeMB ?? SESSION_REBUILD_MIN_FREE_MB
  let session = initial
  let threads = initialThreads
  let lastAttempt = now()
  let rebuilding = false
  let failedAt = -Infinity
  return {
    current: () => session,
    threads: () => threads,
    async align() {
      if (deps.memoryPressure?.()) return
      const wanted = deps.desiredThreads()
      if (wanted === threads || rebuilding) return
      if (now() - failedAt < minInterval) return
      // Ramping down (the user became active) is never delayed; ramping up is rate limited.
      if (wanted > threads && now() - lastAttempt < minInterval) return
      if (deps.freeMemMB() < minFree) return
      rebuilding = true
      lastAttempt = now()
      try {
        const next = await deps.create(wanted)
        const old = session
        session = next
        threads = wanted
        try {
          await deps.release(old)
        } catch {
          // The replaced session is garbage collected if releasing it fails.
        }
      } catch {
        // Keep the working session; retry after the back-off.
        failedAt = now()
      } finally {
        rebuilding = false
      }
    },
    async dispose() {
      const old = session
      try {
        await deps.release(old)
      } catch {
        // process exit remains final fallback
      }
    },
  }
}
