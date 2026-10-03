import type { IndexingEffectiveState } from '../../shared/fork/indexing-mode'
import type { ResolvedPolicy } from './indexing-policy'

/**
 * In-process hand-off between the power/idle monitor (producer) and the index-process
 * launcher and the document-memory manager (consumers). Holds only the latest policy.
 */

export interface PublishedPolicy extends ResolvedPolicy {
  onBattery: boolean
}

type Listener = (next: PublishedPolicy, previous: PublishedPolicy | null) => void

let current: PublishedPolicy | null = null
const listeners = new Set<Listener>()

export function currentIndexingPolicy(): PublishedPolicy | null {
  return current
}

/** True while the policy asks the background job not to take new work. */
export function isIndexingPaused(): boolean {
  return current?.paused === true
}

export function samePolicy(a: PublishedPolicy | null, b: PublishedPolicy | null): boolean {
  return (
    !!a &&
    !!b &&
    a.paused === b.paused &&
    a.pauseReason === b.pauseReason &&
    a.threads === b.threads &&
    a.cpuShare === b.cpuShare &&
    a.priority === b.priority &&
    a.tier === b.tier &&
    a.onBattery === b.onBattery &&
    a.batteryBand === b.batteryBand
  )
}

/** Returns true when the policy actually changed (listeners ran). */
export function publishIndexingPolicy(next: PublishedPolicy): boolean {
  if (samePolicy(current, next)) return false
  const previous = current
  current = next
  for (const listener of [...listeners]) {
    try {
      listener(next, previous)
    } catch {
      // A consumer must never break the monitor.
    }
  }
  return true
}

export function subscribeIndexingPolicy(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function effectiveStateOf(policy: PublishedPolicy | null): IndexingEffectiveState | null {
  if (!policy) return null
  return {
    tier: policy.tier,
    paused: policy.paused,
    ...(policy.pauseReason ? { pauseReason: policy.pauseReason } : {}),
    threads: policy.threads,
    cpuShare: policy.cpuShare,
    onBattery: policy.onBattery,
  }
}

/** Test seam. */
export function resetIndexingPolicyBus(): void {
  current = null
  listeners.clear()
}
