import type { InferenceSession } from 'onnxruntime-node'
import { childFreeMemMB, createOrtSession } from '../../fork/embedding-ort'
import { createSessionKeeper, type SessionKeeper } from '../../fork/embedding-session'
import { workerPolicy } from '../../fork/indexing-worker-policy'
import type { EmbeddingProfile } from '../embedding-profiles'

/** Threads the indexing policy asks for, never above what the profile's tier is sized for. */
export function profileThreads(profile: Pick<EmbeddingProfile, 'maxThreads'>, policyThreads: number): number {
  return Math.max(1, Math.min(profile.maxThreads, Math.floor(policyThreads)))
}

/**
 * Session keeper for one profile: the same policy-driven thread resizing as
 * fork/embedding-ort.ts#createEmbeddingSessionKeeper, with the tier's thread cap, and the
 * resize disabled for profiles that must not hold two copies of the model.
 */
export async function createProfileSessionKeeper(
  modelPath: string,
  profile: EmbeddingProfile,
): Promise<SessionKeeper<InferenceSession>> {
  const threads = profileThreads(profile, workerPolicy.threads)
  const initial = await createOrtSession(modelPath, threads)
  if (!profile.resizableSession) {
    return {
      current: () => initial,
      threads: () => threads,
      align: () => Promise.resolve(),
      dispose: async () => {
        try {
          await initial.release()
        } catch {
          // The replaced session is garbage collected if releasing it fails.
        }
      },
    }
  }
  return createSessionKeeper(initial, threads, {
    desiredThreads: () => profileThreads(profile, workerPolicy.threads),
    create: (wanted) => createOrtSession(modelPath, wanted),
    release: (session) => session.release(),
    freeMemMB: () => childFreeMemMB(),
    // A second copy of the model must fit with this much to spare.
    minFreeMB: Math.max(workerPolicy.memoryTier === 'low' ? 1024 : 1500, profile.minFreeMemoryMB),
    memoryPressure: () => workerPolicy.memoryTier === 'low' && !workerPolicy.allowHeavyEmbedding,
  })
}
