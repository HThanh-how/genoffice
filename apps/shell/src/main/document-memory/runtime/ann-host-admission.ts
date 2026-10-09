import { dirname } from 'node:path'
import type { StorageAdmissionController } from './storage-admission'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import type { StorageBudgetCoordinator } from './storage-budget-coordinator'
import { type StorageBudgetSnapshot, contentWriteCapBytes, safeGetFileSize } from '../storage-budget'
import type { WorkerRequest, WorkerReply, AnnRebuildWorkerResult } from '../worker-types'
import { estimateAnnIndexBytes, getValidatedFreeDiskBytes } from './ann-write-budget'
import type { AnnPreauthorizedPermit } from '../ann-index'

export interface AnnHostPermit {
  token: string
  reservationId: string
  spaceId: string
  reservedBytes: number
  dimensions: number
  vectorCount: number
  targetGeneration: number
  configVersion: number
  expiresAt: number
}

export interface AnnHostAdmissionDecision {
  admitted: boolean
  reason: string
  permit?: AnnHostPermit
  error?: string
}

export interface DispatchAnnRebuildOptions {
  admission: StorageAdmissionController
  maintScheduler: MaintenanceScheduler
  budgetCoord: StorageBudgetCoordinator
  askWorker: (req: WorkerRequest, timeoutMs?: number) => Promise<WorkerReply | null>
  spaceId: string
  dimensions: number
  vectorCount: number
  targetGeneration?: number
  workerTimeoutMs?: number
  headroomBytes?: number
  isStopped?: () => boolean
}

export interface AnnRebuildExecutionResult {
  ok: boolean
  count: number
  error?: string
}

/**
 * Host-owned admission handshake for ANN write operations.
 * Coordinates reservations directly through the main StorageAdmissionController
 * (shared with content extraction and passage embeddings) to prevent concurrent
 * writers from exceeding hard quota limits.
 */
export class AnnHostAdmissionCoordinator {
  /**
   * Acquires a host reservation permit in the central StorageAdmissionController.
   * Strictly enforces fresh accounting snapshot (fail-closed if stale or degraded),
   * validates vector bounds, and attaches unique owner tokens to prevent cross-job lease overwrite.
   */
  static acquireHostPermit(params: {
    admission: StorageAdmissionController
    maintScheduler: MaintenanceScheduler
    budgetCoord: StorageBudgetCoordinator
    spaceId: string
    dimensions: number
    vectorCount: number
    targetGeneration?: number
    ttlMs?: number
    freeDiskBytes?: number | null
    headroomBytes?: number
    freshSnapshot?: StorageBudgetSnapshot
    isStopped?: () => boolean
  }): AnnHostAdmissionDecision {
    const {
      admission,
      maintScheduler,
      budgetCoord,
      spaceId,
      dimensions,
      vectorCount,
      targetGeneration = 1,
      ttlMs = 120_000,
      freeDiskBytes,
      headroomBytes = 0,
      freshSnapshot,
      isStopped,
    } = params

    if (isStopped && isStopped()) {
      return { admitted: false, reason: 'stopped', error: 'Document memory is stopped' }
    }

    if (!budgetCoord.isWriteReady()) {
      return {
        admitted: false,
        reason: 'budget-pending',
        error: 'Storage quota config pending worker confirmation',
      }
    }

    if (!maintScheduler.canAcceptExpensiveWork()) {
      return {
        admitted: false,
        reason: 'scheduler-busy',
        error: 'Maintenance scheduler cannot accept expensive work',
      }
    }

    const snapshot = freshSnapshot ?? maintScheduler.getStorageBudgetSnapshot()

    // BEH-INV: Fail-closed if accounting measurement snapshot is not fresh or degraded
    if (snapshot.measurementStatus !== 'fresh' || snapshot.isDegraded) {
      return {
        admitted: false,
        reason: 'measurement-not-fresh',
        error: 'Storage accounting measurement is not fresh or degraded; ANN host admission denied fail-closed',
      }
    }

    const estBytes = estimateAnnIndexBytes(vectorCount, dimensions)
    if (estBytes <= 0) {
      return {
        admitted: false,
        reason: 'invalid-parameters',
        error: 'Invalid vector count, dimensions, or integer overflow in byte estimation',
      }
    }

    if (freeDiskBytes !== undefined) {
      if (
        freeDiskBytes === null ||
        !Number.isFinite(freeDiskBytes) ||
        !Number.isSafeInteger(freeDiskBytes) ||
        freeDiskBytes < 0 ||
        freeDiskBytes < estBytes + headroomBytes
      ) {
        return {
          admitted: false,
          reason: 'disk-space-insufficient',
          error: 'Insufficient free disk space for ANN host admission',
        }
      }
    }

    const now = Date.now()
    const token = `ann-host:${spaceId}:${now}:${Math.random().toString(36).slice(2)}`
    // Unique reservation ID per token prevents concurrent operations on the same space from overwriting each other
    const reservationId = `ann:${spaceId}:${token}`

    const isAlive = () => {
      if (isStopped && isStopped()) return false
      return true
    }

    const dec = admission.reserve(
      reservationId,
      'ann-build',
      estBytes,
      snapshot.totalManagedBytes ?? snapshot.databaseBytes,
      contentWriteCapBytes(maintScheduler.budget), // grace zone: ANN builds reserve against the HARD cap
      ttlMs,
      {
        isAlive,
        holdUntilJobEnds: true,
        accountingDegraded: snapshot.isDegraded,
        ownerId: token,
        headroomBytes,
        freeDiskBytes: freeDiskBytes ?? undefined,
      },
    )

    if (!dec.admitted) {
      return {
        admitted: false,
        reason: dec.reason ?? 'quota-denied',
        error: dec.error ?? 'Storage admission controller denied ANN write quota',
      }
    }

    return {
      admitted: true,
      reason: 'ok',
      permit: {
        token,
        reservationId,
        spaceId,
        reservedBytes: estBytes,
        dimensions,
        vectorCount,
        targetGeneration,
        configVersion: snapshot.configVersion ?? 0,
        expiresAt: now + ttlMs,
      },
    }
  }

  /**
   * Safely releases an ANN host reservation verifying exact ownership token.
   * Does NOT allow releasing if ownerId is missing.
   */
  static releaseHostPermit(
    admission: StorageAdmissionController,
    permit: AnnHostPermit,
  ): boolean {
    const cur = admission.listReservations().find((r) => r.id === permit.reservationId)
    if (cur && cur.ownerId === permit.token) {
      return admission.release(permit.reservationId)
    }
    return false
  }

  /**
   * Coordinates the complete host-worker ANN rebuild lifecycle:
   * 1. Awaits fresh measurement and validates disk/headroom before acquiring host permit.
   * 2. Acquires unique host reservation in central admission controller.
   * 3. Binds typed preauthorized permit and dispatches to worker.
   * 4. Rechecks isStopped and write readiness after reply (fail-closed on config shrink).
   * 5. Awaits fresh measurement before releasing lease to eliminate physical undercount.
   * 6. Releases host reservation with exact token in finally block.
   */
  static async dispatchAnnRebuild(
    options: DispatchAnnRebuildOptions,
  ): Promise<AnnRebuildExecutionResult> {
    const {
      admission,
      maintScheduler,
      budgetCoord,
      askWorker,
      spaceId,
      dimensions,
      vectorCount,
      targetGeneration = 1,
      workerTimeoutMs = 60_000,
      headroomBytes = 0,
      isStopped,
    } = options

    if (isStopped && isStopped()) {
      return { ok: false, count: 0, error: 'Document memory is stopped' }
    }

    // 1. Dispatch awaits fresh measurement first
    let freshSnapshot: StorageBudgetSnapshot
    try {
      freshSnapshot = await maintScheduler.refreshAccountingAsync()
    } catch (err) {
      return {
        ok: false,
        count: 0,
        error: `Storage accounting refresh failed before ANN rebuild: ${String(err)}`,
      }
    }

    if (freshSnapshot.measurementStatus !== 'fresh' || freshSnapshot.isDegraded) {
      return {
        ok: false,
        count: 0,
        error: 'Storage accounting measurement is not fresh or degraded; ANN rebuild dispatch denied fail-closed',
      }
    }

    // 2. Validate physical disk space and headroom
    const freeDiskBytes = await getValidatedFreeDiskBytes(dirname(maintScheduler.store.dbPath))
    if (
      freeDiskBytes === null ||
      !Number.isFinite(freeDiskBytes) ||
      !Number.isSafeInteger(freeDiskBytes) ||
      freeDiskBytes < 0
    ) {
      return {
        ok: false,
        count: 0,
        error: 'Free disk space unknown or invalid; ANN rebuild dispatch denied fail-closed',
      }
    }

    const estBytes = estimateAnnIndexBytes(vectorCount, dimensions)
    if (estBytes <= 0) {
      return {
        ok: false,
        count: 0,
        error: 'Invalid vector count, dimensions, or integer overflow in byte estimation',
      }
    }

    if (freeDiskBytes < estBytes + headroomBytes) {
      return {
        ok: false,
        count: 0,
        error: `Insufficient disk space: required ${estBytes + headroomBytes} bytes, available ${freeDiskBytes} bytes`,
      }
    }

    const hostDecision = AnnHostAdmissionCoordinator.acquireHostPermit({
      admission,
      maintScheduler,
      budgetCoord,
      spaceId,
      dimensions,
      vectorCount,
      targetGeneration,
      freeDiskBytes,
      headroomBytes,
      freshSnapshot,
      isStopped,
    })

    if (!hostDecision.admitted || !hostDecision.permit) {
      return {
        ok: false,
        count: 0,
        error: hostDecision.error ?? 'Host admission denied ANN rebuild',
      }
    }

    const permit = hostDecision.permit
    const hostPermit: AnnPreauthorizedPermit = {
      id: permit.reservationId,
      ownerToken: permit.token,
      expiresAt: permit.expiresAt,
      reservedBytes: permit.reservedBytes,
      measurementValid: true,
      budgetBytes: contentWriteCapBytes(maintScheduler.budget), // permit.budgetBytes = HARD cap (matches rebuildAnnIndex)
      dimensions,
      vectorCount,
      generation: targetGeneration,
      configVersion: permit.configVersion,
    }

    let postSnap: StorageBudgetSnapshot | null = null
    let measurementError: string | null = null

    try {
      const reply = await askWorker(
        {
          type: 'ann-rebuild',
          spaceId,
          embeddingSpaceId: spaceId,
          hostPermit,
        },
        workerTimeoutMs,
      )

      // Post-reply check: do not ignore isStopped after reply await
      if (isStopped && isStopped()) {
        return {
          ok: false,
          count: 0,
          error: 'Document memory was stopped after ANN worker reply',
        }
      }

      // Post-reply check: if quota shrank or write gate closed while worker was running, fail closed
      if (!budgetCoord.isWriteReady()) {
        return {
          ok: false,
          count: 0,
          error: 'Storage quota config pending or closed after ANN worker reply',
        }
      }

      if (!reply || !('result' in reply)) {
        const errorMsg =
          reply && 'error' in reply && typeof reply.error === 'string'
            ? reply.error
            : 'ANN rebuild worker timed out or returned empty reply'
        return { ok: false, count: 0, error: errorMsg }
      }

      const res = reply.result
      if (
        typeof res === 'object' &&
        res !== null &&
        'ok' in res &&
        (res as { ok: unknown }).ok === true
      ) {
        const rebuildRes = res as AnnRebuildWorkerResult

        // BEH-INV: Await fresh measurement BEFORE lease release to prevent physical undercount
        try {
          postSnap = await maintScheduler.refreshAccountingAsync()
        } catch (err) {
          measurementError = String(err)
        }

        const isMeasurementFresh =
          postSnap !== null &&
          postSnap.measurementStatus === 'fresh' &&
          postSnap.isDegraded === false

        if (!isMeasurementFresh) {
          return {
            ok: false,
            count: 0,
            error: `Post-rebuild physical storage measurement failed or degraded: ${measurementError ?? (postSnap?.measurementStatus ?? 'unknown')}`,
          }
        }

        return { ok: true, count: typeof rebuildRes.count === 'number' ? rebuildRes.count : vectorCount }
      }

      const errMsg =
        typeof res === 'object' &&
        res !== null &&
        'error' in res &&
        typeof (res as { error: unknown }).error === 'string'
          ? (res as { error: string }).error
          : 'Worker failed to rebuild ANN index'
      return {
        ok: false,
        count: 0,
        error: errMsg,
      }
    } finally {
      // Unified fresh measurement before lease release across all terminal paths (success, error, timeout)
      if (postSnap === null) {
        try {
          postSnap = await maintScheduler.refreshAccountingAsync()
        } catch (err) {
          measurementError = String(err)
        }
      }

      const isMeasurementFresh =
        postSnap !== null &&
        postSnap.measurementStatus === 'fresh' &&
        postSnap.isDegraded === false

      if (!isMeasurementFresh) {
        // Invalidate write readiness and snapshot via contract maintScheduler
        const lastReport = maintScheduler.getLastAccountingReport()
        const dbPath = maintScheduler.store.dbPath
        const activeDbSizeBytes = safeGetFileSize(dbPath)
        const walSizeBytes = safeGetFileSize(`${dbPath}-wal`)
        const shmSizeBytes = safeGetFileSize(`${dbPath}-shm`)
        const physicalDbBytes = activeDbSizeBytes + walSizeBytes + shmSizeBytes

        maintScheduler.checkStorageBudget({
          ...(lastReport ?? {
            databaseBytes: physicalDbBytes,
            dbSizeBytes: activeDbSizeBytes,
            walSizeBytes,
            shmSizeBytes,
            sidecarSizeBytes: 0,
            annSizeBytes: 0,
            ocrSizeBytes: 0,
            tempSizeBytes: 0,
            backupSizeBytes: 0,
            protectedBytes: 0,
            totalManagedBytes: physicalDbBytes,
            totalTrackedBytes: physicalDbBytes,
            reclaimableBytes: 0,
            reusableFreelistBytes: 0,
            modelWeightsBytes: 0,
            breakdown: {
              activeDbBytes: activeDbSizeBytes,
              walBytes: walSizeBytes,
              shmBytes: shmSizeBytes,
              backupBytes: 0,
              protectedBackupBytes: 0,
              annBytes: 0,
              ocrExternalBytes: 0,
              tempBytes: 0,
              reusableFreelistBytes: 0,
              modelWeightsBytes: 0,
            },
            annFiles: [],
            backupFiles: [],
            tempFiles: [],
            ocrFiles: [],
            measurementErrors: [{ path: 'ann-rebuild-measurement', error: measurementError ?? 'Measurement stale or degraded' }],
          }),
          isDegraded: true,
          timestamp: lastReport?.timestamp ?? Date.now(),
          lastAttemptTimestamp: Date.now(),
          measurementErrors: [
            ...(lastReport?.measurementErrors ?? []),
            { path: 'ann-rebuild-measurement', error: measurementError ?? 'Measurement stale or degraded after rebuild' },
          ],
        })
      }

      AnnHostAdmissionCoordinator.releaseHostPermit(admission, permit)
    }
  }

  /**
   * Releases all host-owned ANN reservations upon worker recycling or shutdown.
   */
  static cancelOwnedPermits(admission: StorageAdmissionController): void {
    for (const r of admission.listReservations()) {
      if (r.id.startsWith('ann:') || r.id.startsWith('ann-write:') || r.id.startsWith('ann-build:')) {
        admission.release(r.id)
      }
    }
  }
}
