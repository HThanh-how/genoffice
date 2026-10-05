import { freemem } from 'node:os'
import { InferenceSession } from 'onnxruntime-node'
import { createSessionKeeper, type SessionKeeper } from './embedding-session'
import { workerPolicy } from './indexing-worker-policy'

/** onnxruntime session options for the embedding model at a given intra-op thread count. */
export function ortSessionOptions(threads: number): InferenceSession.SessionOptions {
  return {
    executionProviders: ['cpu'],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    // Idle pool threads sleep instead of spinning: same throughput, a fraction of the CPU time.
    extra: { session: { intra_op: { allow_spinning: '0' } } },
  }
}

export function createOrtSession(modelPath: string, threads: number): Promise<InferenceSession> {
  return InferenceSession.create(modelPath, ortSessionOptions(threads))
}

/**
 * Memory the child can still use. On macOS os.freemem() leaves out reclaimable cache and sits
 * far below what is really available, so the guard defers to the main process (which pauses
 * indexing on low memory using Electron's own figure) instead of blocking every rebuild.
 */
export function childFreeMemMB(
  platform: NodeJS.Platform = process.platform,
  free: () => number = freemem,
): number {
  return platform === 'darwin' ? Number.POSITIVE_INFINITY : free() / (1024 * 1024)
}

/** First session at the policy's current thread count, plus the between-batch resizer. */
export async function createEmbeddingSessionKeeper(
  modelPath: string,
): Promise<SessionKeeper<InferenceSession>> {
  const threads = workerPolicy.threads
  const initial = await createOrtSession(modelPath, threads)
  return createSessionKeeper(initial, threads, {
    desiredThreads: () => workerPolicy.threads,
    create: (wanted) => createOrtSession(modelPath, wanted),
    release: (session) => session.release(),
    freeMemMB: () => childFreeMemMB(),
    minFreeMB: workerPolicy.memoryTier === 'low' ? 1024 : 1500,
    memoryPressure: () => workerPolicy.memoryTier === 'low' && !workerPolicy.allowHeavyEmbedding,
  })
}
