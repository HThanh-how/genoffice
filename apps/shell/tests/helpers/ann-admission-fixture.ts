import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type AnnPreauthorizedPermit,
  type AnnRebuildOptions,
} from '../../src/main/document-memory/ann-index'
import {
  ANN_DEFAULT_PERMIT_TTL_MS,
  estimateAnnIndexBytes,
  getValidatedFreeDiskBytes,
} from '../../src/main/document-memory/runtime/ann-write-budget'
import { StorageAdmissionController } from '../../src/main/document-memory/runtime/storage-admission'
import {
  DEFAULT_STORAGE_BUDGET,
  contentWriteCapBytes,
  type DocumentIndexStorageBudget,
} from '../../src/main/document-memory/storage-budget'

export interface AnnAdmissionFixtureOptions {
  directory?: string
  budget?: DocumentIndexStorageBudget
  configVersion?: number
}

export interface AcquirePermitParams {
  indexPath: string
  vectorCount: number
  dimensions: number
  generation?: number
  budgetBytes?: number
  configVersion?: number
  ttlMs?: number
  ownerToken?: string
  freeDiskBytes?: number | null
}

export interface AcquireSavePermitParams {
  indexPath: string
  dimensions: number
  vectorCount?: number
  generation?: number
  budgetBytes?: number
  configVersion?: number
  ttlMs?: number
  ownerToken?: string
  freeDiskBytes?: number | null
}

export interface AcquireHostPermitParams {
  dimensions: number
  vectorCount: number
  targetGeneration?: number
  budgetBytes?: number
  configVersion?: number
  ttlMs?: number
  ownerToken?: string
  freeDiskBytes?: number | null
  indexPath?: string
}

export interface RebuildHookOverrides {
  failBeforeSave?: boolean
  failBeforeRename?: boolean
  unknownDisk?: boolean
  injectCorruptTemp?: boolean
}

/**
 * Reusable typed test fixture for ANN write admission testing.
 * Uses an owned real StorageAdmissionController with physical tempdir disk measurements
 * to enforce the strict write contract without fake/truthy bypasses.
 */
export class AnnAdmissionTestFixture {
  readonly admission: StorageAdmissionController
  readonly defaultBudget: DocumentIndexStorageBudget
  readonly configVersion: number
  readonly directory?: string

  private readonly ownedReservations = new Map<string, { ownerToken: string; reservationId: string }>()

  constructor(options?: AnnAdmissionFixtureOptions) {
    this.admission = new StorageAdmissionController()
    this.defaultBudget = options?.budget ?? DEFAULT_STORAGE_BUDGET
    this.configVersion = options?.configVersion ?? (this.defaultBudget.version ?? 0)
    this.directory = options?.directory
  }

  /**
   * Reads real validated free disk bytes via statfs.
   */
  async getFreeDiskBytes(dirPath?: string): Promise<number | null> {
    const targetDir = dirPath ?? this.directory ?? process.cwd()
    return getValidatedFreeDiskBytes(targetDir)
  }

  /**
   * Calculates conservative prospective footprint for atomic rebuilds,
   * accounting for coexistence of the existing index file on disk plus the new temp index.
   */
  calculateProspectiveFootprint(
    vectorCount: number,
    dimensions: number,
    existingIndexPath?: string,
  ): number {
    const estNewBytes = estimateAnnIndexBytes(vectorCount, dimensions)
    if (estNewBytes <= 0) return -1

    let existingBytes = 0
    if (existingIndexPath && existsSync(existingIndexPath)) {
      try {
        existingBytes = statSync(existingIndexPath).size
      } catch {
        existingBytes = 0
      }
    }

    return estNewBytes + existingBytes
  }

  /**
   * Acquires a valid preauthorized permit from the real StorageAdmissionController
   * with full physical parameters, unexpired TTL, and exact owner token.
   * Accurately factors in old+temp file coexistence during rebuilds.
   */
  async acquirePermit(params: AcquirePermitParams): Promise<AnnPreauthorizedPermit> {
    const now = Date.now()
    const ttlMs = params.ttlMs ?? ANN_DEFAULT_PERMIT_TTL_MS
    const ownerToken = params.ownerToken ?? `owner-${now}-${Math.random().toString(36).slice(2)}`
    const reservationId = `ann-res:${ownerToken}:${now}`
    // permit.budgetBytes protects physical growth = the HARD cap (soft quota + grace overshoot), as the real host builds it
    const budgetBytes = params.budgetBytes ?? contentWriteCapBytes(this.defaultBudget)
    const configVersion = params.configVersion ?? this.configVersion

    const estBytes = estimateAnnIndexBytes(params.vectorCount, params.dimensions)
    if (estBytes <= 0) {
      throw new Error(`Invalid dimensions (${params.dimensions}) or vector count (${params.vectorCount}) for byte estimation`)
    }

    let existingBytes = 0
    if (params.indexPath && existsSync(params.indexPath)) {
      try {
        existingBytes = statSync(params.indexPath).size
      } catch {
        existingBytes = 0
      }
    }

    const targetDir = dirname(params.indexPath)
    let freeDiskBytes: number | null
    if (params.freeDiskBytes !== undefined) {
      freeDiskBytes = params.freeDiskBytes
    } else {
      freeDiskBytes = await this.getFreeDiskBytes(targetDir)
    }

    const decision = this.admission.reserve(
      reservationId,
      'ann-build',
      estBytes,
      existingBytes, // current physical usage (old+temp coexistence)
      budgetBytes,
      ttlMs,
      {
        ownerId: ownerToken,
        holdUntilJobEnds: true,
        freeDiskBytes: freeDiskBytes ?? undefined,
        headroomBytes: 0,
      },
    )

    if (!decision.admitted) {
      throw new Error(
        `StorageAdmissionController denied permit: ${decision.reason} (${decision.error ?? 'no error details'})`,
      )
    }

    this.ownedReservations.set(reservationId, { ownerToken, reservationId })

    const permit: AnnPreauthorizedPermit = {
      id: reservationId,
      ownerToken,
      expiresAt: now + ttlMs,
      reservedBytes: estBytes,
      measurementValid: true,
      budgetBytes,
      dimensions: params.dimensions,
      vectorCount: params.vectorCount,
      generation: params.generation,
      indexPath: params.indexPath,
      configVersion,
    }

    return permit
  }

  /**
   * Acquires a permit for atomic save operations.
   */
  async acquireSavePermit(params: AcquireSavePermitParams): Promise<AnnPreauthorizedPermit> {
    const count = params.vectorCount ?? 1
    return this.acquirePermit({
      ...params,
      vectorCount: count,
    })
  }

  /**
   * Acquires a permit for atomic rebuild operations.
   */
  async acquireRebuildPermit(params: AcquirePermitParams): Promise<AnnPreauthorizedPermit> {
    return this.acquirePermit(params)
  }

  /**
   * Acquires a host permit coordinated for DocumentMemoryStore.rebuildAnnIndex().
   */
  async acquireHostPermit(
    spaceId: string,
    params: AcquireHostPermitParams,
  ): Promise<AnnPreauthorizedPermit> {
    const now = Date.now()
    const ttlMs = params.ttlMs ?? ANN_DEFAULT_PERMIT_TTL_MS
    const ownerToken = params.ownerToken ?? `ann-host:${spaceId}:${now}:${Math.random().toString(36).slice(2)}`
    const reservationId = `ann:${spaceId}:${ownerToken}`
    // permit.budgetBytes protects physical growth = the HARD cap (soft quota + grace overshoot), as the real host builds it
    const budgetBytes = params.budgetBytes ?? contentWriteCapBytes(this.defaultBudget)
    const configVersion = params.configVersion ?? this.configVersion
    const targetGeneration = params.targetGeneration ?? 1

    const estBytes = estimateAnnIndexBytes(params.vectorCount, params.dimensions)
    if (estBytes <= 0) {
      throw new Error(`Invalid dimensions (${params.dimensions}) or vector count (${params.vectorCount}) for host byte estimation`)
    }

    let freeDiskBytes: number | null
    if (params.freeDiskBytes !== undefined) {
      freeDiskBytes = params.freeDiskBytes
    } else {
      freeDiskBytes = await this.getFreeDiskBytes()
    }

    const decision = this.admission.reserve(
      reservationId,
      'ann-build',
      estBytes,
      0,
      budgetBytes,
      ttlMs,
      {
        ownerId: ownerToken,
        holdUntilJobEnds: true,
        freeDiskBytes: freeDiskBytes ?? undefined,
        headroomBytes: 0,
      },
    )

    if (!decision.admitted) {
      throw new Error(
        `StorageAdmissionController denied host permit: ${decision.reason} (${decision.error ?? 'no error details'})`,
      )
    }

    this.ownedReservations.set(reservationId, { ownerToken, reservationId })

    const hostPermit: AnnPreauthorizedPermit = {
      id: reservationId,
      ownerToken,
      expiresAt: now + ttlMs,
      reservedBytes: estBytes,
      measurementValid: true,
      budgetBytes,
      dimensions: params.dimensions,
      vectorCount: params.vectorCount,
      generation: targetGeneration,
      configVersion,
      indexPath: params.indexPath,
    }

    return hostPermit
  }

  /**
   * Creates typed beforeSaveHook and beforeRenameHook for rebuildAtomic.
   * Validates free disk, reserved size limits, and owner liveness.
   */
  createRebuildHooks(
    permit: AnnPreauthorizedPermit,
    overrides?: RebuildHookOverrides,
  ): Pick<AnnRebuildOptions, 'beforeSaveHook' | 'beforeRenameHook'> {
    const beforeSaveHook = async (
      tempPath: string,
      p: AnnPreauthorizedPermit,
    ): Promise<boolean> => {
      if (overrides?.failBeforeSave) return false

      if (overrides?.unknownDisk) {
        // Unknown or degraded disk space denies fail-closed
        return false
      }

      const free = await getValidatedFreeDiskBytes(dirname(tempPath))
      if (free === null || free < (p.reservedBytes ?? 0)) {
        return false
      }

      if (p.expiresAt && Date.now() >= p.expiresAt) {
        return false
      }

      return true
    }

    const beforeRenameHook = async (
      _tempPath: string,
      p: AnnPreauthorizedPermit,
      actualBytes: number,
    ): Promise<boolean> => {
      if (overrides?.failBeforeRename) return false

      if (actualBytes <= 0) return false
      if (p.reservedBytes !== undefined && actualBytes > p.reservedBytes) {
        return false
      }

      if (p.expiresAt && Date.now() >= p.expiresAt) {
        return false
      }

      return true
    }

    return { beforeSaveHook, beforeRenameHook }
  }

  /**
   * Creates a typed rebuildAdmissionHook for USearchIndex constructor options,
   * mirroring MaintenanceRepository.checkAdmissionForRebuild.
   */
  createRebuildAdmissionHook(overrides?: { unknownDisk?: boolean }): (
    indexPath: string,
    vectorCount: number,
    dimensions: number,
  ) => Promise<{ admitted: boolean; reason?: string }> {
    return async (indexPath: string, vectorCount: number, dimensions: number) => {
      if (overrides?.unknownDisk) {
        return { admitted: false, reason: 'disk-space-insufficient' }
      }
      const dir = dirname(indexPath)
      const free = await getValidatedFreeDiskBytes(dir)
      if (free === null) {
        return { admitted: false, reason: 'disk-space-insufficient' }
      }
      const est = estimateAnnIndexBytes(vectorCount, dimensions)
      if (est <= 0 || free < est) {
        return { admitted: false, reason: 'disk-space-insufficient' }
      }
      return { admitted: true, reason: 'ok' }
    }
  }

  /**
   * Creates an unadmitted empty forged permit `{}` to test rejection.
   */
  createForgedPermit(): AnnPreauthorizedPermit {
    return {} as unknown as AnnPreauthorizedPermit
  }

  /**
   * Creates an expired permit to test TTL expiration rejection.
   */
  createExpiredPermit(permit: AnnPreauthorizedPermit): AnnPreauthorizedPermit {
    return {
      ...permit,
      expiresAt: Date.now() - 5000,
    }
  }

  /**
   * Creates an under-reserved permit where reservedBytes is lower than actual size.
   */
  createInsufficientPermit(permit: AnnPreauthorizedPermit, bytes = 10): AnnPreauthorizedPermit {
    return {
      ...permit,
      reservedBytes: bytes,
    }
  }

  /**
   * Creates a permit with mismatched dimensions to test validation rejection.
   */
  createMismatchedDimensionsPermit(
    permit: AnnPreauthorizedPermit,
    dimensions = 999,
  ): AnnPreauthorizedPermit {
    return {
      ...permit,
      dimensions,
    }
  }

  /**
   * Creates a permit with mismatched indexPath to test isolation.
   */
  createMismatchedPathPermit(
    permit: AnnPreauthorizedPermit,
    indexPath = '/wrong/isolated/test.usearch',
  ): AnnPreauthorizedPermit {
    return {
      ...permit,
      indexPath,
    }
  }

  /**
   * Creates a permit with mismatched generation to test fence rejection.
   */
  createMismatchedGenerationPermit(
    permit: AnnPreauthorizedPermit,
    generation = 9999,
  ): AnnPreauthorizedPermit {
    return {
      ...permit,
      generation,
    }
  }

  /**
   * Creates a permit with invalid accounting measurement status.
   */
  createDegradedAccountingPermit(permit: AnnPreauthorizedPermit): AnnPreauthorizedPermit {
    return {
      ...permit,
      measurementValid: false,
    }
  }

  /**
   * Releases a specific reservation verifying exact ownerId token.
   */
  releasePermit(reservationIdOrPermit: string | AnnPreauthorizedPermit): boolean {
    const resId =
      typeof reservationIdOrPermit === 'string'
        ? reservationIdOrPermit
        : reservationIdOrPermit.id
    if (!resId) return false

    const item = this.ownedReservations.get(resId)
    if (!item) return false

    const released = this.admission.release(item.reservationId)
    this.ownedReservations.delete(resId)
    return released
  }

  /**
   * Releases all reservations owned by this test fixture.
   */
  cleanup(): void {
    for (const [resId, item] of this.ownedReservations.entries()) {
      try {
        this.admission.release(item.reservationId)
      } catch {
        // ignore cleanup error
      }
      this.ownedReservations.delete(resId)
    }
  }
}
