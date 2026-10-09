/**
 * Lets the renderer's Stop button cancel a web search that is already running in the main process.
 * The `ai:web-search` IPC call carries no request id, but Stop always sends `ai:stream-cancel` from
 * the same window, so searches are tracked per window (any stable owner id) and cancelled together.
 */

export interface SearchAbortRegistry {
  /** Register a search of `owner`; call `end()` when it settles. */
  begin(owner: number): { signal: AbortSignal; end(): void }
  /** Abort every search still running for `owner`. */
  cancel(owner: number): void
}

export function createSearchAbortRegistry(): SearchAbortRegistry {
  const running = new Map<number, Set<AbortController>>()
  return {
    begin(owner) {
      const controller = new AbortController()
      let set = running.get(owner)
      if (!set) running.set(owner, (set = new Set()))
      set.add(controller)
      return {
        signal: controller.signal,
        end() {
          const current = running.get(owner)
          current?.delete(controller)
          if (current && current.size === 0) running.delete(owner)
        },
      }
    },
    cancel(owner) {
      const set = running.get(owner)
      if (!set) return
      running.delete(owner)
      for (const controller of set) controller.abort()
    },
  }
}
