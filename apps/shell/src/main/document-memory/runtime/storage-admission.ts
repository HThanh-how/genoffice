import {
  DEFAULT_STORAGE_BUDGET,
  HARD_LIMIT_RATIO,
} from '../storage-budget'

export type AdmissionJobType =
  | 'lexical'
  | 'chunks'
  | 'ocr'
  | 'render'
  | 'passage-embed'
  | 'ann-build'
  | 'backup'
  | 'migration'
  | 'query-embed'
  // Legacy aliases for backward compatibility:
  | 'extract'
  | 'embed'

export type AdmissionType = AdmissionJobType

export type AdmissionRejectionReason =
  | 'hard-limit-exceeded'
  | 'soft-limit-throttled'
  | 'quota-exhausted'
  | 'reservation-exceeded'
  | 'budget-zero'
  | 'disk-space-insufficient'
  | 'accounting-unknown'
  | 'duplicate-reservation-conflict'
  | 'invalid-parameters'
  | 'reservation-not-found'

export interface AdmissionDecision {
  admitted: boolean
  reason: 'ok' | AdmissionRejectionReason
  currentBytes: number
  reservedBytes: number
  budgetBytes: number
  projectedBytes: number
  projectedUsageRatio: number
  error?: string
  bypassed?: boolean
  remainingBytes?: number
}

export interface ActiveReservation {
  id: string
  type: AdmissionType
  bytes: number
  timestamp: number
  expiresAt: number
  ownerId?: string
  jobId?: string
  holdUntilJobEnds?: boolean
  isAlive?: () => boolean
  metadata?: Record<string, unknown>
}

export interface StorageAdmissionSnapshot {
  activeReservations: ActiveReservation[]
  totalReservedBytes: number
  reservedByType: Record<string, number>
  activeCount: number
}

export interface CanAdmitOptions {
  headroomBytes?: number
  freeDiskBytes?: number
  accountingDegraded?: boolean
  metadata?: Record<string, unknown>
  ownerId?: string
  jobId?: string
  holdUntilJobEnds?: boolean
  isAlive?: () => boolean
  strictQuota?: boolean
  bypassQuota?: boolean
}

export interface CanAdmitParams {
  type: AdmissionType
  estimatedBytes: number
  currentUsageBytes: number
  budgetBytes?: number
  options?: CanAdmitOptions
}

export interface ReserveParams extends CanAdmitParams {
  reservationId: string
  ttlMs?: number
  ownerId?: string
  jobId?: string
  holdUntilJobEnds?: boolean
  isAlive?: () => boolean
}

export interface CheckedResizeParams {
  reservationId: string
  newBytes: number
  currentUsageBytes: number
  budgetBytes?: number
  ttlMs?: number
  options?: CanAdmitOptions
}

export interface ResizeDecision extends AdmissionDecision {
  resized: boolean
  reservationId: string
  previousBytes: number
  newBytes: number
}

export type CheckedResizeDecision = ResizeDecision

export interface AdmissionDiagnostic {
  type: 'liveness-error' | 'reconcile-error' | 'resize-error'
  message: string
  reservationId?: string
  timestamp: number
}

export interface LeaseLifecycleStatus {
  valid: boolean
  shouldReclaim: boolean
  reason: string
  error?: unknown
}

export const DEFAULT_RESERVATION_TTL_MS = 60_000 // 1 minute auto-expire safety

function isSafeNonNegativeInteger(val: unknown): boolean {
  return typeof val === 'number' && Number.isFinite(val) && Number.isSafeInteger(val) && val >= 0
}

function isPositiveFinite(val: unknown): boolean {
  return typeof val === 'number' && Number.isFinite(val) && val > 0
}

/**
 * Enterprise Storage Admission Controller for Document Memory V3.
 *
 * Central gatekeeper for storage reservations across jobs:
 * - Validates strict finite, safe integer, non-negative bounds (rejects NaN/Infinity/negative/fractions).
 * - Projects usage = physical totalManagedBytes + active reservations + headroom, without double-counting.
 * - Supports living job leases (holdUntilJobEnds, isAlive check) preventing premature purging of active writers >60s.
 * - Live writers never expire simply because TTL elapsed; dead writers are reclaimed immediately.
 * - Liveness checking errors fail closed, preserving reservations and capturing diagnostic evidence.
 * - Held jobs without explicit liveness are preserved until job completion explicitly releases them.
 * - Supports lease renewal (renew/update), orphan recovery (recoverOrphans), and batch write reconciliation (reconcile).
 * - Enforces atomic checked resize for active reservations with full admission re-projection.
 * - Enforces quota on new backup creation by default; rejects if backup does not fit unless explicitly bypassed.
 * - Allows in-memory query embeddings ('query-embed') without persistence to pass unconditionally.
 * - Distinguishes quota exhausted vs disk space insufficient vs accounting unknown.
 *
 * Grace zone: `budgetBytes` is the CAP the projection is checked against (HARD_LIMIT_RATIO x budgetBytes).
 * Callers that protect physical growth (content, metadata, embeddings, OCR, ANN) pass
 * `hardCapBytes(budget)` = max x (1 + overshootRatio), so every concurrent reservation is summed (sync, in one
 * tick) and checked against the hard cap, never against the soft quota; backups keep the soft quota.
 */
export class StorageAdmissionController {
  private readonly reservations = new Map<string, ActiveReservation>()
  private readonly diagnostics: AdmissionDiagnostic[] = []

  /**
   * Unified lifecycle validity evaluator for admission reservations.
   * Evaluates whether a reservation remains active or should be evicted/reclaimed:
   * - Registered writer liveness check takes precedence: live writers are preserved regardless of TTL.
   * - Dead writers (isAlive() === false or isOwnerAlive() === false) are reclaimed immediately.
   * - Errors thrown during liveness checking fail-closed: lease is preserved and diagnostic is recorded.
   * - Jobs held until completion without liveness proof are preserved; no arbitrary 1h timeout.
   * - Standard TTL reservations expire when now >= expiresAt.
   */
  private evaluateLease(
    r: ActiveReservation,
    now: number = Date.now(),
    isOwnerAlive?: (ownerId: string) => boolean,
  ): LeaseLifecycleStatus {
    // 1. Owner-level liveness check if checker provided and ownerId exists
    if (isOwnerAlive && r.ownerId) {
      try {
        if (!isOwnerAlive(r.ownerId)) {
          return { valid: false, shouldReclaim: true, reason: 'owner-dead' }
        }
      } catch (err) {
        // Fail-closed: keep reservation on error, do not consider dead
        this.recordDiagnostic(
          'liveness-error',
          `isOwnerAlive check failed for owner '${r.ownerId}' on reservation '${r.id}': ${String(err)}`,
          r.id,
        )
      }
    }

    // 2. Writer process liveness check if predicate registered
    if (r.isAlive) {
      try {
        if (r.isAlive()) {
          // Writer is alive: lease is preserved regardless of TTL
          return { valid: true, shouldReclaim: false, reason: 'writer-alive' }
        } else {
          // Writer has died: reclaim orphan reservation immediately
          return { valid: false, shouldReclaim: true, reason: 'writer-dead' }
        }
      } catch (err) {
        // Fail-closed: preserve reservation on error, record diagnostic, do not treat as dead
        this.recordDiagnostic(
          'liveness-error',
          `isAlive predicate threw error for reservation '${r.id}': ${String(err)}`,
          r.id,
        )
        return { valid: true, shouldReclaim: false, reason: 'liveness-check-failed-fail-closed', error: err }
      }
    }

    // 3. Held until job ends (without liveness predicate):
    // Preserved until explicit job completion release. Do not purge arbitrarily after 1 hour.
    if (r.holdUntilJobEnds) {
      return { valid: true, shouldReclaim: false, reason: 'held-until-job-ends' }
    }

    // 4. Standard TTL expiration
    if (now >= r.expiresAt) {
      return { valid: false, shouldReclaim: true, reason: 'ttl-expired' }
    }

    return { valid: true, shouldReclaim: false, reason: 'ttl-active' }
  }

  private purgeExpired(now: number = Date.now()): void {
    for (const [id, r] of this.reservations.entries()) {
      const status = this.evaluateLease(r, now)
      if (status.shouldReclaim) {
        this.reservations.delete(id)
      }
    }
  }

  getReservedBytes(type?: AdmissionType): number {
    this.purgeExpired()
    let sum = 0
    for (const r of this.reservations.values()) {
      if (!type || r.type === type) {
        sum += r.bytes
      }
    }
    return sum
  }

  canAdmit(
    typeOrParams: AdmissionType | CanAdmitParams,
    estimatedBytesArg?: number,
    currentUsageBytesArg?: number,
    budgetBytesArg?: number,
    optionsArg?: CanAdmitOptions,
  ): AdmissionDecision {
    this.purgeExpired()

    let type: AdmissionType
    let estimatedBytes: number
    let currentUsageBytes: number
    let budgetBytes: number
    let options: CanAdmitOptions | undefined

    if (typeof typeOrParams === 'object') {
      type = typeOrParams.type
      estimatedBytes = typeOrParams.estimatedBytes
      currentUsageBytes = typeOrParams.currentUsageBytes
      budgetBytes = typeOrParams.budgetBytes ?? DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
      options = typeOrParams.options
    } else {
      type = typeOrParams
      estimatedBytes = estimatedBytesArg ?? 0
      currentUsageBytes = currentUsageBytesArg ?? 0
      budgetBytes = budgetBytesArg ?? DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
      options = optionsArg
    }

    const reservedBytes = this.getReservedBytes()

    // 1. Parameter validation: must be finite safe non-negative integers
    if (!isSafeNonNegativeInteger(estimatedBytes) || !isSafeNonNegativeInteger(currentUsageBytes)) {
      return {
        admitted: false,
        reason: 'invalid-parameters',
        currentBytes: typeof currentUsageBytes === 'number' && Number.isFinite(currentUsageBytes) ? Math.max(0, currentUsageBytes) : 0,
        reservedBytes,
        budgetBytes: typeof budgetBytes === 'number' && Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0,
        projectedBytes: 0,
        projectedUsageRatio: 1.0,
        error: 'estimatedBytes and currentUsageBytes must be finite, non-negative safe integers',
      }
    }

    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) {
      return {
        admitted: false,
        reason: 'invalid-parameters',
        currentBytes: currentUsageBytes,
        reservedBytes,
        budgetBytes: 0,
        projectedBytes: currentUsageBytes + estimatedBytes,
        projectedUsageRatio: 1.0,
        error: 'budgetBytes must be a positive finite number',
      }
    }

    if (budgetBytes === 0) {
      return {
        admitted: false,
        reason: 'budget-zero',
        currentBytes: currentUsageBytes,
        reservedBytes,
        budgetBytes: 0,
        projectedBytes: currentUsageBytes + estimatedBytes,
        projectedUsageRatio: 1.0,
        error: 'Storage budget is zero',
      }
    }

    // 2. Accounting unknown/degraded state check
    if (options?.accountingDegraded === true) {
      return {
        admitted: false,
        reason: 'accounting-unknown',
        currentBytes: currentUsageBytes,
        reservedBytes,
        budgetBytes,
        projectedBytes: currentUsageBytes + reservedBytes + estimatedBytes,
        projectedUsageRatio: (currentUsageBytes + reservedBytes + estimatedBytes) / budgetBytes,
        error: 'Storage accounting is in an unknown/degraded state due to I/O or permission errors',
      }
    }

    // 3. Physical disk space check
    const headroom = options?.headroomBytes ?? 0
    if (options?.freeDiskBytes !== undefined) {
      if (options.freeDiskBytes < estimatedBytes + headroom) {
        return {
          admitted: false,
          reason: 'disk-space-insufficient',
          currentBytes: currentUsageBytes,
          reservedBytes,
          budgetBytes,
          projectedBytes: currentUsageBytes + reservedBytes + estimatedBytes,
          projectedUsageRatio: (currentUsageBytes + reservedBytes + estimatedBytes) / budgetBytes,
          error: `Insufficient disk space: required ${estimatedBytes + headroom} bytes, available ${options.freeDiskBytes} bytes`,
        }
      }
    }

    // 4. Query embeddings without persistence: NEVER blocked
    if (type === 'query-embed') {
      return {
        admitted: true,
        reason: 'ok',
        currentBytes: currentUsageBytes,
        reservedBytes,
        budgetBytes,
        projectedBytes: currentUsageBytes + reservedBytes,
        projectedUsageRatio: budgetBytes > 0 ? (currentUsageBytes + reservedBytes) / budgetBytes : 0,
      }
    }

    // 5. Backups: Protected for rollback, but NEW creation must enforce quota by default.
    // strictQuota option does not silently bypass when omitted; explicit bypass requires strictQuota: false or bypassQuota: true.
    if (type === 'backup') {
      const projectedBytes = currentUsageBytes + reservedBytes + estimatedBytes + headroom
      const projectedRatio = budgetBytes > 0 ? projectedBytes / budgetBytes : 1.0
      const isExplicitBypass = options?.strictQuota === false || options?.bypassQuota === true

      if (!isExplicitBypass && projectedRatio > HARD_LIMIT_RATIO) {
        return {
          admitted: false,
          reason: 'quota-exhausted',
          currentBytes: currentUsageBytes,
          reservedBytes,
          budgetBytes,
          projectedBytes,
          projectedUsageRatio: projectedRatio,
          remainingBytes: Math.max(0, budgetBytes - (currentUsageBytes + reservedBytes + headroom)),
          error: `Backup rejected: projected bytes ${projectedBytes} exceeds storage quota ${budgetBytes}`,
        }
      }

      return {
        admitted: true,
        reason: 'ok',
        currentBytes: currentUsageBytes,
        reservedBytes,
        budgetBytes,
        projectedBytes,
        projectedUsageRatio: projectedRatio,
        bypassed: isExplicitBypass && projectedRatio > HARD_LIMIT_RATIO,
        remainingBytes: Math.max(0, budgetBytes - projectedBytes),
      }
    }

    // 6. Projected database usage calculation
    const projectedBytes = currentUsageBytes + reservedBytes + estimatedBytes + headroom
    const projectedRatio = projectedBytes / budgetBytes

    // Embeddings strictly halt when projected ratio reaches HARD_LIMIT_RATIO (100%)
    if (type === 'embed' || type === 'passage-embed') {
      if (projectedRatio >= HARD_LIMIT_RATIO) {
        return {
          admitted: false,
          reason: 'hard-limit-exceeded',
          currentBytes: currentUsageBytes,
          reservedBytes,
          budgetBytes,
          projectedBytes,
          projectedUsageRatio: projectedRatio,
          remainingBytes: Math.max(0, budgetBytes - (currentUsageBytes + reservedBytes + headroom)),
          error: `Passage embeddings rejected: projected quota ratio ${(projectedRatio * 100).toFixed(1)}% reaches hard limit`,
        }
      }
    }

    // Other indexing operations (lexical, chunks, ocr, render, ann-build) check against budget capacity
    if (projectedRatio > HARD_LIMIT_RATIO) {
      return {
        admitted: false,
        reason: 'quota-exhausted',
        currentBytes: currentUsageBytes,
        reservedBytes,
        budgetBytes,
        projectedBytes,
        projectedUsageRatio: projectedRatio,
        remainingBytes: Math.max(0, budgetBytes - (currentUsageBytes + reservedBytes + headroom)),
        error: `Storage quota exhausted: projected bytes ${projectedBytes} exceeds budget ${budgetBytes}`,
      }
    }

    return {
      admitted: true,
      reason: 'ok',
      currentBytes: currentUsageBytes,
      reservedBytes,
      budgetBytes,
      projectedBytes,
      projectedUsageRatio: projectedRatio,
      remainingBytes: Math.max(0, budgetBytes - projectedBytes),
    }
  }

  reserve(
    reservationIdOrParams: string | ReserveParams,
    typeArg?: AdmissionType,
    estimatedBytesArg?: number,
    currentUsageBytesArg?: number,
    budgetBytesArg?: number,
    ttlMsArg?: number,
    optionsArg?: CanAdmitOptions,
  ): AdmissionDecision & { reservationId?: string } {
    let reservationId: string
    let type: AdmissionType
    let estimatedBytes: number
    let currentUsageBytes: number
    let budgetBytes: number
    let ttlMs: number
    let options: CanAdmitOptions | undefined

    if (typeof reservationIdOrParams === 'object') {
      reservationId = reservationIdOrParams.reservationId
      type = reservationIdOrParams.type
      estimatedBytes = reservationIdOrParams.estimatedBytes
      currentUsageBytes = reservationIdOrParams.currentUsageBytes
      budgetBytes = reservationIdOrParams.budgetBytes ?? DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
      ttlMs = reservationIdOrParams.ttlMs ?? DEFAULT_RESERVATION_TTL_MS
      options = reservationIdOrParams.options ?? {
        ownerId: reservationIdOrParams.ownerId,
        jobId: reservationIdOrParams.jobId,
        holdUntilJobEnds: reservationIdOrParams.holdUntilJobEnds,
        isAlive: reservationIdOrParams.isAlive,
      }
      if (reservationIdOrParams.ownerId && !options.ownerId) options.ownerId = reservationIdOrParams.ownerId
      if (reservationIdOrParams.jobId && !options.jobId) options.jobId = reservationIdOrParams.jobId
      if (reservationIdOrParams.holdUntilJobEnds !== undefined && options.holdUntilJobEnds === undefined) {
        options.holdUntilJobEnds = reservationIdOrParams.holdUntilJobEnds
      }
      if (reservationIdOrParams.isAlive !== undefined && options.isAlive === undefined) {
        options.isAlive = reservationIdOrParams.isAlive
      }
    } else {
      reservationId = reservationIdOrParams
      type = typeArg!
      estimatedBytes = estimatedBytesArg ?? 0
      currentUsageBytes = currentUsageBytesArg ?? 0
      budgetBytes = budgetBytesArg ?? DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
      ttlMs = ttlMsArg ?? DEFAULT_RESERVATION_TTL_MS
      options = optionsArg
    }

    if (!reservationId || typeof reservationId !== 'string') {
      return {
        admitted: false,
        reason: 'invalid-parameters',
        currentBytes: currentUsageBytes,
        reservedBytes: this.getReservedBytes(),
        budgetBytes,
        projectedBytes: currentUsageBytes + estimatedBytes,
        projectedUsageRatio: 1.0,
        error: 'reservationId must be a non-empty string',
      }
    }

    if (!isPositiveFinite(ttlMs)) {
      return {
        admitted: false,
        reason: 'invalid-parameters',
        currentBytes: currentUsageBytes,
        reservedBytes: this.getReservedBytes(),
        budgetBytes,
        projectedBytes: currentUsageBytes + estimatedBytes,
        projectedUsageRatio: 1.0,
        error: 'ttlMs must be a positive finite number',
      }
    }

    this.purgeExpired()

    // Duplicate reservation ID handling: idempotent if same payload, reject if conflict
    const existing = this.reservations.get(reservationId)
    if (existing) {
      if (existing.type === type && existing.bytes === estimatedBytes) {
        // Idempotent renewal with same payload
        const now = Date.now()
        existing.expiresAt = now + ttlMs
        if (options?.holdUntilJobEnds !== undefined) existing.holdUntilJobEnds = options.holdUntilJobEnds
        if (options?.isAlive !== undefined) existing.isAlive = options.isAlive
        if (options?.ownerId !== undefined) existing.ownerId = options.ownerId
        return {
          admitted: true,
          reason: 'ok',
          currentBytes: currentUsageBytes,
          reservedBytes: this.getReservedBytes(),
          budgetBytes,
          projectedBytes: currentUsageBytes + this.getReservedBytes(),
          projectedUsageRatio: (currentUsageBytes + this.getReservedBytes()) / budgetBytes,
          reservationId,
        }
      }
      return {
        admitted: false,
        reason: 'duplicate-reservation-conflict',
        currentBytes: currentUsageBytes,
        reservedBytes: this.getReservedBytes(),
        budgetBytes,
        projectedBytes: currentUsageBytes + this.getReservedBytes() + estimatedBytes,
        projectedUsageRatio: (currentUsageBytes + this.getReservedBytes() + estimatedBytes) / budgetBytes,
        error: `Reservation ID '${reservationId}' is already active with a conflicting payload`,
      }
    }

    const decision = this.canAdmit(type, estimatedBytes, currentUsageBytes, budgetBytes, options)
    if (!decision.admitted) {
      return decision
    }

    // Ephemeral query embeddings do not retain persistent storage reservations
    if (type !== 'query-embed' && estimatedBytes > 0) {
      const now = Date.now()
      this.reservations.set(reservationId, {
        id: reservationId,
        type,
        bytes: estimatedBytes,
        timestamp: now,
        expiresAt: now + ttlMs,
        ownerId: options?.ownerId ?? options?.jobId,
        jobId: options?.jobId,
        holdUntilJobEnds: options?.holdUntilJobEnds ?? false,
        isAlive: options?.isAlive,
        metadata: options?.metadata,
      })
    }

    return {
      ...decision,
      reservationId,
    }
  }

  /**
   * Atomic checked resize for an active reservation.
   * - Atomically validates and projects new remaining bytes against physical storage, budget, headroom, disk space, and accounting state.
   * - Excludes the reservation's own existing bytes when projecting, while including all other active leases.
   * - On denial, strictly preserves existing reservation bytes intact without silent corruption.
   * - Strict validation: invalid NaN, fractional, or negative values reject with an explicit decision.
   */
  checkedResize(
    paramsOrId: string | CheckedResizeParams,
    newBytesArg?: number,
    currentUsageBytesArg?: number,
    budgetBytesArg?: number,
    optionsOrTtlArg?: number | CanAdmitOptions,
    optionsArg?: CanAdmitOptions,
  ): ResizeDecision {
    this.purgeExpired()

    let reservationId: string
    let newBytes: number
    let currentUsageBytes: number
    let budgetBytes: number
    let ttlMs: number | undefined
    let options: CanAdmitOptions | undefined

    if (typeof paramsOrId === 'object') {
      reservationId = paramsOrId.reservationId
      newBytes = paramsOrId.newBytes
      currentUsageBytes = paramsOrId.currentUsageBytes
      budgetBytes = paramsOrId.budgetBytes ?? DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
      ttlMs = paramsOrId.ttlMs
      options = paramsOrId.options
    } else {
      reservationId = paramsOrId
      newBytes = newBytesArg ?? 0
      currentUsageBytes = currentUsageBytesArg ?? 0
      budgetBytes = budgetBytesArg ?? DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
      if (typeof optionsOrTtlArg === 'number') {
        ttlMs = optionsOrTtlArg
        options = optionsArg
      } else {
        options = optionsOrTtlArg
      }
    }

    const currentTotalReserved = this.getReservedBytes()

    // 1. Validate reservation ID
    if (!reservationId || typeof reservationId !== 'string') {
      return {
        admitted: false,
        resized: false,
        reason: 'invalid-parameters',
        reservationId: reservationId ?? '',
        previousBytes: 0,
        newBytes: typeof newBytes === 'number' && Number.isFinite(newBytes) ? Math.max(0, newBytes) : 0,
        currentBytes: isSafeNonNegativeInteger(currentUsageBytes) ? currentUsageBytes : 0,
        reservedBytes: currentTotalReserved,
        budgetBytes: typeof budgetBytes === 'number' && Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0,
        projectedBytes: 0,
        projectedUsageRatio: 1.0,
        error: 'reservationId must be a non-empty string',
      }
    }

    // 2. Check reservation existence and lifecycle validity
    const existing = this.reservations.get(reservationId)
    if (!existing) {
      return {
        admitted: false,
        resized: false,
        reason: 'reservation-not-found',
        reservationId,
        previousBytes: 0,
        newBytes: typeof newBytes === 'number' && Number.isFinite(newBytes) ? Math.max(0, newBytes) : 0,
        currentBytes: isSafeNonNegativeInteger(currentUsageBytes) ? currentUsageBytes : 0,
        reservedBytes: currentTotalReserved,
        budgetBytes: typeof budgetBytes === 'number' && Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0,
        projectedBytes: 0,
        projectedUsageRatio: 1.0,
        error: `Reservation '${reservationId}' not found`,
      }
    }

    const now = Date.now()
    const lifecycle = this.evaluateLease(existing, now)
    if (lifecycle.shouldReclaim) {
      this.reservations.delete(reservationId)
      return {
        admitted: false,
        resized: false,
        reason: 'reservation-not-found',
        reservationId,
        previousBytes: existing.bytes,
        newBytes: typeof newBytes === 'number' && Number.isFinite(newBytes) ? Math.max(0, newBytes) : 0,
        currentBytes: isSafeNonNegativeInteger(currentUsageBytes) ? currentUsageBytes : 0,
        reservedBytes: this.getReservedBytes(),
        budgetBytes: typeof budgetBytes === 'number' && Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0,
        projectedBytes: 0,
        projectedUsageRatio: 1.0,
        error: `Reservation '${reservationId}' is no longer active (${lifecycle.reason})`,
      }
    }

    const previousBytes = existing.bytes

    // 3. Strict parameter validation: newBytes, currentUsageBytes, budgetBytes, ttlMs
    if (!isSafeNonNegativeInteger(newBytes)) {
      return {
        admitted: false,
        resized: false,
        reason: 'invalid-parameters',
        reservationId,
        previousBytes,
        newBytes: 0,
        currentBytes: isSafeNonNegativeInteger(currentUsageBytes) ? currentUsageBytes : 0,
        reservedBytes: currentTotalReserved,
        budgetBytes: typeof budgetBytes === 'number' && Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0,
        projectedBytes: 0,
        projectedUsageRatio: 1.0,
        error: 'newBytes must be a finite, non-negative safe integer',
      }
    }

    if (!isSafeNonNegativeInteger(currentUsageBytes)) {
      return {
        admitted: false,
        resized: false,
        reason: 'invalid-parameters',
        reservationId,
        previousBytes,
        newBytes,
        currentBytes: 0,
        reservedBytes: currentTotalReserved,
        budgetBytes: typeof budgetBytes === 'number' && Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0,
        projectedBytes: 0,
        projectedUsageRatio: 1.0,
        error: 'currentUsageBytes must be a finite, non-negative safe integer',
      }
    }

    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) {
      return {
        admitted: false,
        resized: false,
        reason: 'invalid-parameters',
        reservationId,
        previousBytes,
        newBytes,
        currentBytes: currentUsageBytes,
        reservedBytes: currentTotalReserved,
        budgetBytes: 0,
        projectedBytes: currentUsageBytes + newBytes,
        projectedUsageRatio: 1.0,
        error: 'budgetBytes must be a positive finite number',
      }
    }

    if (budgetBytes === 0) {
      return {
        admitted: false,
        resized: false,
        reason: 'budget-zero',
        reservationId,
        previousBytes,
        newBytes,
        currentBytes: currentUsageBytes,
        reservedBytes: currentTotalReserved,
        budgetBytes: 0,
        projectedBytes: currentUsageBytes + newBytes,
        projectedUsageRatio: 1.0,
        error: 'Storage budget is zero',
      }
    }

    if (ttlMs !== undefined && !isPositiveFinite(ttlMs)) {
      return {
        admitted: false,
        resized: false,
        reason: 'invalid-parameters',
        reservationId,
        previousBytes,
        newBytes,
        currentBytes: currentUsageBytes,
        reservedBytes: currentTotalReserved,
        budgetBytes,
        projectedBytes: currentUsageBytes + newBytes,
        projectedUsageRatio: 1.0,
        error: 'ttlMs must be a positive finite number when provided',
      }
    }

    // 4. Usage projection excluding own old reservation, including all other leases
    const otherReservedBytes = Math.max(0, currentTotalReserved - existing.bytes)
    const headroom = options?.headroomBytes ?? 0
    const projectedBytes = currentUsageBytes + otherReservedBytes + newBytes + headroom
    const projectedUsageRatio = budgetBytes > 0 ? projectedBytes / budgetBytes : 1.0

    // 5. Accounting degraded check
    if (options?.accountingDegraded === true) {
      return {
        admitted: false,
        resized: false,
        reason: 'accounting-unknown',
        reservationId,
        previousBytes,
        newBytes,
        currentBytes: currentUsageBytes,
        reservedBytes: currentTotalReserved,
        budgetBytes,
        projectedBytes,
        projectedUsageRatio,
        error: 'Storage accounting is in an unknown/degraded state due to I/O or permission errors',
      }
    }

    // 6. Free disk space check: must satisfy remaining unwritten reservation + headroom
    if (options?.freeDiskBytes !== undefined) {
      if (options.freeDiskBytes < newBytes + headroom) {
        return {
          admitted: false,
          resized: false,
          reason: 'disk-space-insufficient',
          reservationId,
          previousBytes,
          newBytes,
          currentBytes: currentUsageBytes,
          reservedBytes: currentTotalReserved,
          budgetBytes,
          projectedBytes,
          projectedUsageRatio,
          error: `Insufficient disk space: required ${newBytes + headroom} bytes, available ${options.freeDiskBytes} bytes`,
        }
      }
    }

    // 7. Type-specific admission quotas
    if (existing.type === 'query-embed') {
      // Query embeds are ephemeral without persistent storage
      existing.bytes = 0
      return {
        admitted: true,
        resized: true,
        reason: 'ok',
        reservationId,
        previousBytes,
        newBytes: 0,
        currentBytes: currentUsageBytes,
        reservedBytes: otherReservedBytes,
        budgetBytes,
        projectedBytes: currentUsageBytes + otherReservedBytes,
        projectedUsageRatio: budgetBytes > 0 ? (currentUsageBytes + otherReservedBytes) / budgetBytes : 0,
      }
    }

    if (existing.type === 'backup') {
      const isExplicitBypass = options?.strictQuota === false || options?.bypassQuota === true
      if (!isExplicitBypass && projectedUsageRatio > HARD_LIMIT_RATIO) {
        return {
          admitted: false,
          resized: false,
          reason: 'quota-exhausted',
          reservationId,
          previousBytes,
          newBytes,
          currentBytes: currentUsageBytes,
          reservedBytes: currentTotalReserved,
          budgetBytes,
          projectedBytes,
          projectedUsageRatio,
          remainingBytes: Math.max(0, budgetBytes - (currentUsageBytes + otherReservedBytes + headroom)),
          error: `Backup resize rejected: projected bytes ${projectedBytes} exceeds storage quota ${budgetBytes}`,
        }
      }
    } else if (existing.type === 'embed' || existing.type === 'passage-embed') {
      if (projectedUsageRatio >= HARD_LIMIT_RATIO) {
        return {
          admitted: false,
          resized: false,
          reason: 'hard-limit-exceeded',
          reservationId,
          previousBytes,
          newBytes,
          currentBytes: currentUsageBytes,
          reservedBytes: currentTotalReserved,
          budgetBytes,
          projectedBytes,
          projectedUsageRatio,
          remainingBytes: Math.max(0, budgetBytes - (currentUsageBytes + otherReservedBytes + headroom)),
          error: `Passage embeddings resize rejected: projected quota ratio ${(projectedUsageRatio * 100).toFixed(1)}% reaches hard limit`,
        }
      }
    } else {
      if (projectedUsageRatio > HARD_LIMIT_RATIO) {
        return {
          admitted: false,
          resized: false,
          reason: 'quota-exhausted',
          reservationId,
          previousBytes,
          newBytes,
          currentBytes: currentUsageBytes,
          reservedBytes: currentTotalReserved,
          budgetBytes,
          projectedBytes,
          projectedUsageRatio,
          remainingBytes: Math.max(0, budgetBytes - (currentUsageBytes + otherReservedBytes + headroom)),
          error: `Storage quota exhausted: projected bytes ${projectedBytes} exceeds budget ${budgetBytes}`,
        }
      }
    }

    // 8. Atomic mutation of the reservation
    existing.bytes = newBytes
    if (ttlMs !== undefined) {
      existing.expiresAt = now + ttlMs
    }

    if (newBytes === 0) {
      this.reservations.delete(reservationId)
    }

    const newTotalReserved = otherReservedBytes + newBytes

    return {
      admitted: true,
      resized: true,
      reason: 'ok',
      reservationId,
      previousBytes,
      newBytes,
      currentBytes: currentUsageBytes,
      reservedBytes: newTotalReserved,
      budgetBytes,
      projectedBytes,
      projectedUsageRatio,
      remainingBytes: Math.max(0, budgetBytes - projectedBytes),
    }
  }

  resizeReservation(
    paramsOrId: string | CheckedResizeParams,
    newBytesArg?: number,
    currentUsageBytesArg?: number,
    budgetBytesArg?: number,
    optionsOrTtlArg?: number | CanAdmitOptions,
    optionsArg?: CanAdmitOptions,
  ): ResizeDecision {
    return this.checkedResize(
      paramsOrId as any,
      newBytesArg as any,
      currentUsageBytesArg as any,
      budgetBytesArg as any,
      optionsOrTtlArg as any,
      optionsArg as any,
    )
  }

  resize(
    paramsOrId: string | CheckedResizeParams,
    newBytesArg?: number,
    currentUsageBytesArg?: number,
    budgetBytesArg?: number,
    optionsOrTtlArg?: number | CanAdmitOptions,
    optionsArg?: CanAdmitOptions,
  ): ResizeDecision {
    return this.checkedResize(
      paramsOrId as any,
      newBytesArg as any,
      currentUsageBytesArg as any,
      budgetBytesArg as any,
      optionsOrTtlArg as any,
      optionsArg as any,
    )
  }

  /**
   * Reconciles reservation bytes after batch writes to prevent double-counting
   * between physical on-disk usage and active reservations.
   */
  reconcile(
    reservationId: string,
    options: {
      materializedBytes?: number
      remainingBytes?: number
      extendTtlMs?: number
    },
  ): boolean {
    const existing = this.reservations.get(reservationId)
    if (!existing) return false

    const now = Date.now()
    const lifecycle = this.evaluateLease(existing, now)
    if (lifecycle.shouldReclaim) {
      this.reservations.delete(reservationId)
      return false
    }

    if (options.remainingBytes !== undefined) {
      if (!isSafeNonNegativeInteger(options.remainingBytes)) {
        return false
      }
      existing.bytes = options.remainingBytes
    } else if (options.materializedBytes !== undefined) {
      if (!isSafeNonNegativeInteger(options.materializedBytes)) {
        return false
      }
      existing.bytes = Math.max(0, existing.bytes - options.materializedBytes)
    }

    if (options.extendTtlMs !== undefined) {
      if (!isPositiveFinite(options.extendTtlMs)) {
        return false
      }
      existing.expiresAt = now + options.extendTtlMs
    }

    if (existing.bytes === 0) {
      this.reservations.delete(reservationId)
    }

    return true
  }

  /**
   * Extends the TTL lease of an active reservation.
   */
  renew(reservationId: string, extensionTtlMs: number = DEFAULT_RESERVATION_TTL_MS): boolean {
    const existing = this.reservations.get(reservationId)
    if (!existing) return false

    if (!isPositiveFinite(extensionTtlMs)) {
      return false
    }

    const now = Date.now()
    const lifecycle = this.evaluateLease(existing, now)
    if (lifecycle.shouldReclaim) {
      this.reservations.delete(reservationId)
      return false
    }

    existing.expiresAt = now + Math.max(1_000, extensionTtlMs)
    return true
  }

  /**
   * Updates reservation parameters.
   * Note: For quota-checked resizing, prefer checkedResize().
   */
  update(reservationId: string, options: { bytes?: number; ttlMs?: number }): boolean {
    const existing = this.reservations.get(reservationId)
    if (!existing) return false

    const now = Date.now()
    const lifecycle = this.evaluateLease(existing, now)
    if (lifecycle.shouldReclaim) {
      this.reservations.delete(reservationId)
      return false
    }

    if (options.bytes !== undefined) {
      if (!isSafeNonNegativeInteger(options.bytes)) {
        return false
      }
      existing.bytes = options.bytes
    }
    if (options.ttlMs !== undefined) {
      if (!isPositiveFinite(options.ttlMs)) {
        return false
      }
      existing.expiresAt = now + options.ttlMs
    }

    if (existing.bytes === 0) {
      this.reservations.delete(reservationId)
    }

    return true
  }

  /**
   * Attaches an active writer liveness predicate to an active reservation.
   * Prevents premature lease eviction while the underlying writer process is alive.
   */
  attachLiveness(reservationId: string, isAlive: () => boolean): boolean {
    const existing = this.reservations.get(reservationId)
    if (!existing) return false
    existing.isAlive = isAlive
    return true
  }

  /**
   * Reclaims orphaned reservations whose owners/writers have crashed or exited.
   */
  recoverOrphans(isOwnerAlive?: (ownerId: string) => boolean): string[] {
    const reclaimed: string[] = []
    const now = Date.now()
    for (const [id, r] of this.reservations.entries()) {
      const lifecycle = this.evaluateLease(r, now, isOwnerAlive)
      if (lifecycle.shouldReclaim) {
        this.reservations.delete(id)
        reclaimed.push(id)
      }
    }
    return reclaimed
  }

  release(reservationId: string): boolean {
    return this.reservations.delete(reservationId)
  }

  clear(): void {
    this.reservations.clear()
    this.diagnostics.length = 0
  }

  listReservations(): ActiveReservation[] {
    this.purgeExpired()
    return Array.from(this.reservations.values())
  }

  snapshot(): StorageAdmissionSnapshot {
    this.purgeExpired()
    const active = Array.from(this.reservations.values())
    let totalReservedBytes = 0
    const reservedByType: Record<string, number> = {}

    for (const r of active) {
      totalReservedBytes += r.bytes
      reservedByType[r.type] = (reservedByType[r.type] ?? 0) + r.bytes
    }

    return {
      activeReservations: active,
      totalReservedBytes,
      reservedByType,
      activeCount: active.length,
    }
  }

  getDiagnostics(): AdmissionDiagnostic[] {
    return [...this.diagnostics]
  }

  clearDiagnostics(): void {
    this.diagnostics.length = 0
  }

  private recordDiagnostic(
    type: AdmissionDiagnostic['type'],
    message: string,
    reservationId?: string,
  ): void {
    this.diagnostics.push({
      type,
      message,
      reservationId,
      timestamp: Date.now(),
    })
    if (this.diagnostics.length > 500) {
      this.diagnostics.splice(0, this.diagnostics.length - 500)
    }
  }
}

/**
 * Safely releases an admission reservation only if it matches the exact owner token.
 * Prevents releasing unowned or third-party leases when tasks recycle or cancel.
 */
export function safeReleaseExactOwnerReservation(
  admission: StorageAdmissionController,
  reservationId: string,
  ownerToken?: string,
): boolean {
  if (!reservationId || !ownerToken) return false
  const cur = admission.listReservations().find((r) => r.id === reservationId)
  if (cur && cur.ownerId === ownerToken) {
    return admission.release(reservationId)
  }
  return false
}

