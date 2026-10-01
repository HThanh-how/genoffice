import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

/**
 * Cooperative yielding for loops on Electron's main thread: the returned function gives the
 * event loop a turn only once `budgetMs` of work has accumulated since the last turn, so a
 * cheap iteration costs nothing and an expensive one cannot stack up into a long stall
 * (a fixed "every N items" count cannot tell the two apart).
 */
export function createYielder(budgetMs = 5): () => Promise<void> {
  let since = performance.now()
  return async () => {
    if (performance.now() - since < budgetMs) return
    await yieldToEventLoop()
    since = performance.now()
  }
}
