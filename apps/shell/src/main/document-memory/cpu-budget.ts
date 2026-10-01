import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

/** Limit sustained background work to roughly 35% of one logical CPU. */
export async function withBackgroundBudget<T>(work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    const activeMs = Math.max(0, performance.now() - started)
    await sleep(Math.min(2000, Math.max(10, Math.ceil(activeMs * (1 / 0.35 - 1)))))
  }
}
