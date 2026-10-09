import { contentWriteCapBytes } from '../storage-budget'
import type { AdmissionDecision, StorageAdmissionController } from './storage-admission'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import type { ImportanceClass } from './value-density'

/**
 * Extraction lease of the drain loop (`extract:<path>` in the central admission controller), with admission by
 * displacement: a lease refused for QUOTA never refuses a new file outright. While usage is at/over the soft quota the
 * scheduler first frees the shortfall from the lowest value content (in the indexing worker), then the same
 * reservation is retried exactly once. Only a still-impossible lease (hard cap, nothing evictable) is refused.
 */
export async function reserveExtractionLease(params: {
  admission: StorageAdmissionController
  maintScheduler: MaintenanceScheduler
  reserveId: string
  estBytes: number
  extractToken: string
  isAlive: () => boolean
  importance?: ImportanceClass
}): Promise<AdmissionDecision> {
  const { admission, maintScheduler, reserveId, estBytes, extractToken, isAlive, importance } = params
  const attempt = (): AdmissionDecision => {
    const snap = maintScheduler.checkStorageBudget()
    return admission.reserve(
      reserveId,
      'extract',
      estBytes,
      snap.totalManagedBytes ?? snap.databaseBytes,
      contentWriteCapBytes(maintScheduler.budget),
      60_000,
      { isAlive, holdUntilJobEnds: true, accountingDegraded: snap.isDegraded, ownerId: extractToken },
    )
  }
  const first = attempt()
  if (first.admitted || (first.reason !== 'quota-exhausted' && first.reason !== 'hard-limit-exceeded')) return first
  if (typeof maintScheduler.makeRoom !== 'function') return first
  const shortfall = Math.max(1, Math.ceil(first.projectedBytes - first.budgetBytes))
  const room = await maintScheduler.makeRoom({ admissionDenied: true, neededBytes: shortfall, importance, reason: 'content' })
  return room.retry && isAlive() ? attempt() : first
}
