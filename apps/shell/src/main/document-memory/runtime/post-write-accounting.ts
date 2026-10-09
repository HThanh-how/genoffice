import type { StorageBudgetSnapshot } from '../storage-budget'
import type { StorageAdmissionController } from './storage-admission'
import { safeReleaseExactOwnerReservation } from './storage-admission'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import { safeError } from '../issues'

export interface PostWriteAccountingParams {
  maintScheduler?: MaintenanceScheduler
  refreshUsage?: () => Promise<StorageBudgetSnapshot | null>
  admission?: StorageAdmissionController
  reservationId?: string
  ownerToken?: string
  invalidateAccounting?: (reason: string) => void
  context: string
  writeSuccess?: boolean
  isStopped?: () => boolean
}

export interface PostWriteAccountingResult {
  fresh: boolean
  snapshot: StorageBudgetSnapshot | null
  error?: string
  released: boolean
}

/**
 * Re-exports the exact owner lease release helper for compatibility.
 */
export function safeReleaseExactOwnerLease(
  admission: StorageAdmissionController,
  reservationId: string,
  ownerToken?: string,
): boolean {
  return safeReleaseExactOwnerReservation(admission, reservationId, ownerToken)
}

/**
 * Unified typed post-write accounting for all terminal paths that perform writes
 * (content write, embedding write, ANN rebuild, projection backfill).
 *
 * Guarantees:
 * 1. Fresh physical measurement before release.
 * 2. Unknown, degraded, or failed measurement invalidates the scheduler's last
 *    accounting snapshot and closes gates until the next successful measurement.
 *    Does NOT pretend previous was fresh and does NOT fake total0.
 * 3. Exact lease owner release to prevent charged lease leaks while protecting concurrent tasks.
 */
export async function executePostWriteAccounting(
  params: PostWriteAccountingParams,
): Promise<PostWriteAccountingResult> {
  const {
    maintScheduler,
    refreshUsage,
    admission,
    reservationId,
    ownerToken,
    context,
    isStopped,
    invalidateAccounting,
  } = params

  let freshSnap: StorageBudgetSnapshot | null = null
  let measurementError: string | undefined

  if (isStopped && isStopped()) {
    // Stopped/cancelled: safely release lease if owner matches
    let released = false
    if (admission && reservationId && ownerToken) {
      released = safeReleaseExactOwnerReservation(admission, reservationId, ownerToken)
    }
    return {
      fresh: false,
      snapshot: null,
      error: `Post-write accounting skipped: stopped in ${context}`,
      released,
    }
  }

  // 1. Fresh measurement BEFORE release
  try {
    if (maintScheduler) {
      freshSnap = await maintScheduler.refreshAccountingAsync()
    } else if (refreshUsage) {
      freshSnap = await refreshUsage()
    }
  } catch (err) {
    measurementError = safeError(err)
  }

  const isMeasurementFresh =
    freshSnap !== null &&
    freshSnap.measurementStatus === 'fresh' &&
    freshSnap.isDegraded === false

  // 2. Unknown/degraded/failure invalidates scheduler last accounting snapshot/gate
  if (!isMeasurementFresh) {
    const reason =
      measurementError ??
      (freshSnap?.measurementStatus === 'unknown'
        ? 'Measurement status is unknown'
        : freshSnap?.isDegraded
          ? 'Measurement is degraded'
          : 'Storage accounting refresh returned null')

    if (!isStopped?.() && maintScheduler) {
      maintScheduler.invalidateAccounting(`${context}: ${reason}`)
    } else if (!isStopped?.()) {
      invalidateAccounting?.(`${context}: ${reason}`)
    }
  }

  // 3. Exact lease owner release (avoid charged lease leak)
  let released = false
  if (admission && reservationId && ownerToken) {
    released = safeReleaseExactOwnerReservation(admission, reservationId, ownerToken)
  }

  return {
    fresh: isMeasurementFresh,
    snapshot: freshSnap,
    error: isMeasurementFresh ? undefined : measurementError,
    released,
  }
}
