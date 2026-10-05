import { constants } from 'node:os'
import type { ResolvedPolicy } from './indexing-policy'
import {
  currentIndexingPolicy,
  subscribeIndexingPolicy,
  type PublishedPolicy,
} from './indexing-policy-bus'
import type { PolicyMessage } from './indexing-worker-policy'

export interface ChildControl {
  pid: number | undefined
  /** false once the IPC channel is gone */
  connected: () => boolean
  send: (message: PolicyMessage) => void
  setPriority: (pid: number, priority: number) => void
  platform?: NodeJS.Platform
}

/**
 * OS priority for the index process. Windows can move freely between classes. POSIX only lets an
 * unprivileged process raise its nice value, never lower it again, so there the child stays at
 * the (below-normal) level it started with instead of being stranded at the idle level.
 */
export function osPriorityFor(
  wanted: ResolvedPolicy['priority'],
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform === 'win32' && wanted === 'idle') return constants.priority.PRIORITY_LOW
  return constants.priority.PRIORITY_BELOW_NORMAL
}

/**
 * Pushes the current and every later indexing policy to one index process: a `policy` message
 * for the worker (threads, duty cycle) and an OS priority change. Returns a detach function.
 * Never throws: a child that is gone or a platform that refuses the priority change is ignored.
 */
export function attachChildToPolicy(child: ChildControl): () => void {
  let lastPriority: number | null = null
  const apply = (policy: PublishedPolicy): void => {
    try {
      if (child.connected())
        child.send({
          type: 'policy',
          threads: policy.threads,
          cpuShare: policy.cpuShare,
          memoryTier: policy.memoryTier,
          maxBatchTokens: policy.maxBatchTokens,
          allowHeavyEmbedding: policy.allowHeavyEmbedding,
        })
    } catch {
      // The child exited; the manager restarts it and the next attach pushes the policy again.
    }
    const priority = osPriorityFor(policy.priority, child.platform)
    if (priority === lastPriority || !child.pid) return
    try {
      child.setPriority(child.pid, priority)
      lastPriority = priority
    } catch {
      // Duty-cycle limits still apply where process priority changes are unavailable.
    }
  }
  const unsubscribe = subscribeIndexingPolicy((next) => apply(next))
  const initial = currentIndexingPolicy()
  if (initial) apply(initial)
  return unsubscribe
}
