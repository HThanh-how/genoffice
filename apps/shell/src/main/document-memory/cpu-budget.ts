import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { workerPolicy } from '../fork/indexing-worker-policy'

let sleeper: AbortController | null = null

/** Cut a running budget sleep short so interactive work does not wait for a cool-down. */
export function interruptBackgroundSleep(): void {
  sleeper?.abort()
}

/** Cool-down after `activeMs` of work so the duty cycle matches the policy share. */
export function coolDownMs(activeMs: number, share: number): number {
  // Uncapped (idle machine on AC): the task boundary is the only yield.
  if (share >= 0.999) return 0
  const safeShare = Math.max(0.05, share)
  return Math.min(2000, Math.max(10, Math.ceil(activeMs * (1 / safeShare - 1))))
}

/** Check whether heavy embedding models can run based on current worker policy or explicit tier */
export function canRunHeavyEmbedding(
  tier?: 'low' | 'normal' | 'high',
  onBattery?: boolean,
): boolean {
  if (tier !== undefined) {
    if (tier === 'low') return false
    if (onBattery) return false
    return true
  }
  return workerPolicy.allowHeavyEmbedding ?? false
}

/**
 * Limit sustained background work to the indexing policy's duty cycle. Without a policy
 * message the share stays at the historic ~35% of one logical CPU.
 */
export async function withBackgroundBudget<T>(work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    await backgroundCoolDown(Math.max(0, performance.now() - started))
  }
}

/** The cool-down half of withBackgroundBudget, for loops that account their own active time between yields. */
export async function backgroundCoolDown(activeMs: number): Promise<void> {
  const wait = coolDownMs(activeMs, workerPolicy.cpuShare)
  if (wait > 0) {
    const controller = new AbortController()
    sleeper = controller
    try {
      await sleep(wait, undefined, { signal: controller.signal })
    } catch {
      // Interrupted by interactive work.
    } finally {
      if (sleeper === controller) sleeper = null
    }
  }
}
