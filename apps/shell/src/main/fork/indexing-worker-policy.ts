/**
 * Child-side (index process) view of the indexing policy. The main process pushes a `policy`
 * message whenever the effective policy changes; cpu-budget.ts reads `cpuShare` and
 * embeddings.ts reads `threads` between batches. Defaults match the pre-policy behaviour.
 */

export interface WorkerPolicy {
  threads: number
  /** duty cycle 0..1; >= 1 means uncapped */
  cpuShare: number
  memoryTier?: 'low' | 'normal' | 'high'
  maxBatchTokens?: number
  allowHeavyEmbedding?: boolean
}

export interface PolicyMessage extends WorkerPolicy {
  type: 'policy'
}

export const MAX_WORKER_THREADS = 16
const MIN_SHARE = 0.05

export const workerPolicy: WorkerPolicy = {
  threads: 1,
  cpuShare: 0.35,
}

export function isPolicyMessage(message: unknown): message is PolicyMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    (message as { type?: unknown }).type === 'policy' &&
    !('id' in message)
  )
}

/** Applies a (possibly malformed) policy message; invalid fields are ignored. */
export function applyPolicyMessage(message: PolicyMessage): void {
  const { threads, cpuShare, memoryTier, maxBatchTokens, allowHeavyEmbedding } = message
  if (typeof threads === 'number' && Number.isFinite(threads))
    workerPolicy.threads = Math.max(1, Math.min(MAX_WORKER_THREADS, Math.floor(threads)))
  if (typeof cpuShare === 'number' && Number.isFinite(cpuShare))
    workerPolicy.cpuShare = Math.max(MIN_SHARE, Math.min(1, cpuShare))
  if (memoryTier === 'low' || memoryTier === 'normal' || memoryTier === 'high') {
    workerPolicy.memoryTier = memoryTier
  }
  if (typeof maxBatchTokens === 'number' && Number.isFinite(maxBatchTokens) && maxBatchTokens > 0) {
    workerPolicy.maxBatchTokens = Math.floor(maxBatchTokens)
  }
  if (typeof allowHeavyEmbedding === 'boolean') {
    workerPolicy.allowHeavyEmbedding = allowHeavyEmbedding
  }
}

/** Test seam. */
export function resetWorkerPolicy(): void {
  workerPolicy.threads = 1
  workerPolicy.cpuShare = 0.35
  delete workerPolicy.memoryTier
  delete workerPolicy.maxBatchTokens
  delete workerPolicy.allowHeavyEmbedding
}
