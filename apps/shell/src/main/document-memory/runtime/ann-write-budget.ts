import { statfs } from 'node:fs/promises'
import { HARD_LIMIT_RATIO } from '../storage-budget'

export const ANN_HEADER_OVERHEAD_BYTES = 4096
export const ANN_KEY_BYTES = 8
export const ANN_GRAPH_EDGE_OVERHEAD_PER_VECTOR = 128
export const ANN_SERIALIZED_SAFETY_MULTIPLIER = 1.5
export const ANN_CONSERVATIVE_HEADROOM_BYTES = 10 * 1024 * 1024 // 10 MB conservative headroom
export const ANN_DEFAULT_PERMIT_TTL_MS = 120_000 // 2 minutes

export interface AnnWritePermit {
  id: string
  spaceId: string
  ownerToken?: string
  reservedBytes: number
  dimensions: number
  vectorCount: number
  createdAt: number
  expiresAt: number
  measurementValid: boolean
  budgetBytes: number
  configVersion?: number
  generation?: number
  indexPath?: string
  isWriting?: boolean
}

/**
 * Grace zone note: `budgetBytes` handed to checkAnnWriteAdmission / acquirePermit / recheckPermit is the CAP the
 * projection is compared against. Callers pass hardCapBytes(budget) (soft quota + overshoot), so an ANN rebuild
 * may use the overshoot room but is refused as soon as projected usage would exceed the hard cap.
 */
export interface AnnAdmissionCheckParams {
  spaceId: string
  vectorCount: number
  dimensions: number
  currentUsageBytes: number
  budgetBytes: number
  freeDiskBytes?: number | null
  accountingDegraded?: boolean
  otherReservedBytes?: number
  headroomBytes?: number
}

export type AnnAdmissionRejectionReason =
  | 'quota-exhausted'
  | 'disk-space-insufficient'
  | 'accounting-unknown'
  | 'budget-zero'
  | 'invalid-parameters'
  | 'cancelled'
  | 'closed'
  | 'lease-active'

export interface AnnAdmissionDecision {
  admitted: boolean
  reason: 'ok' | AnnAdmissionRejectionReason
  estimatedBytes: number
  currentUsageBytes: number
  projectedBytes: number
  budgetBytes: number
  projectedUsageRatio: number
  remainingBytes: number
  error?: string
}

/**
 * Calculates conservative serialized on-disk byte footprint for an ANN index.
 * Strictly verifies safe integer non-negative values and prevents arithmetic overflow.
 * Returns -1 on invalid dimensions, invalid vector count, or safe integer overflow.
 */
export function estimateAnnIndexBytes(vectorCount: number, dimensions: number): number {
  if (
    !Number.isFinite(vectorCount) ||
    !Number.isSafeInteger(vectorCount) ||
    vectorCount < 0 ||
    !Number.isFinite(dimensions) ||
    !Number.isSafeInteger(dimensions) ||
    dimensions <= 0
  ) {
    return -1
  }
  if (vectorCount === 0) return ANN_HEADER_OVERHEAD_BYTES

  const maxSafeCountForDim = Math.floor(Number.MAX_SAFE_INTEGER / (dimensions * 4))
  if (vectorCount > maxSafeCountForDim) {
    return -1
  }

  const rawVectorBytes = vectorCount * dimensions * 4
  const edgeAndKeyOverhead = ANN_KEY_BYTES + ANN_GRAPH_EDGE_OVERHEAD_PER_VECTOR
  const maxSafeCountForGraph = Math.floor(Number.MAX_SAFE_INTEGER / edgeAndKeyOverhead)
  if (vectorCount > maxSafeCountForGraph) {
    return -1
  }

  const graphAndKeyBytes = vectorCount * edgeAndKeyOverhead
  if (rawVectorBytes + graphAndKeyBytes > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    return -1
  }

  const baseEstimate =
    ANN_HEADER_OVERHEAD_BYTES +
    Math.ceil((rawVectorBytes + graphAndKeyBytes) * ANN_SERIALIZED_SAFETY_MULTIPLIER)

  return Number.isSafeInteger(baseEstimate) && baseEstimate > 0 ? baseEstimate : -1
}

/**
 * Asynchronously checks and validates available disk space via statfs.
 * Strictly verifies safe non-negative integer product; returns null on unreadable or unsafe bounds.
 */
export async function getValidatedFreeDiskBytes(dirPath: string): Promise<number | null> {
  try {
    const stat = await statfs(dirPath)
    const bavail = Number(stat.bavail)
    const bsize = Number(stat.bsize)
    if (
      Number.isSafeInteger(bavail) &&
      Number.isSafeInteger(bsize) &&
      bavail >= 0 &&
      bsize > 0
    ) {
      const product = bavail * bsize
      if (Number.isSafeInteger(product) && product >= 0) {
        return product
      }
    }
  } catch {
    // Non-fatal if statfs unsupported on target filesystem
  }
  return null
}

/**
 * Checks physical admission for an ANN write before temporary file creation or atomic save.
 * Validates parameters, refuses degraded accounting states (fail-closed), checks free disk space,
 * and projects total usage against live storage budget.
 */
export function checkAnnWriteAdmission(params: AnnAdmissionCheckParams): AnnAdmissionDecision {
  const {
    vectorCount,
    dimensions,
    currentUsageBytes,
    budgetBytes,
    freeDiskBytes,
    accountingDegraded,
    otherReservedBytes,
    headroomBytes,
  } = params

  const estimatedBytes = estimateAnnIndexBytes(vectorCount, dimensions)

  // 1. Parameter and overflow validation
  if (estimatedBytes < 0) {
    return {
      admitted: false,
      reason: 'invalid-parameters',
      estimatedBytes: 0,
      currentUsageBytes: Number.isFinite(currentUsageBytes) && currentUsageBytes >= 0 ? currentUsageBytes : 0,
      projectedBytes: 0,
      budgetBytes: Number.isFinite(budgetBytes) && budgetBytes >= 0 ? budgetBytes : 0,
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'vectorCount and dimensions must be finite non-negative safe integers and must not overflow',
    }
  }

  if (
    !Number.isFinite(currentUsageBytes) ||
    !Number.isSafeInteger(currentUsageBytes) ||
    currentUsageBytes < 0 ||
    !Number.isFinite(budgetBytes) ||
    !Number.isSafeInteger(budgetBytes) ||
    budgetBytes < 0
  ) {
    return {
      admitted: false,
      reason: 'invalid-parameters',
      estimatedBytes,
      currentUsageBytes: Math.max(0, currentUsageBytes || 0),
      projectedBytes: 0,
      budgetBytes: Math.max(0, budgetBytes || 0),
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'currentUsageBytes and budgetBytes must be finite, non-negative safe integer numbers',
    }
  }

  if (
    headroomBytes !== undefined &&
    (!Number.isFinite(headroomBytes) || !Number.isSafeInteger(headroomBytes) || headroomBytes < 0)
  ) {
    return {
      admitted: false,
      reason: 'invalid-parameters',
      estimatedBytes,
      currentUsageBytes,
      projectedBytes: 0,
      budgetBytes,
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'headroomBytes must be a finite, non-negative safe integer',
    }
  }

  if (
    otherReservedBytes !== undefined &&
    (!Number.isFinite(otherReservedBytes) || !Number.isSafeInteger(otherReservedBytes) || otherReservedBytes < 0)
  ) {
    return {
      admitted: false,
      reason: 'invalid-parameters',
      estimatedBytes,
      currentUsageBytes,
      projectedBytes: 0,
      budgetBytes,
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'otherReservedBytes must be a finite, non-negative safe integer',
    }
  }

  const effectiveHeadroom = headroomBytes ?? ANN_CONSERVATIVE_HEADROOM_BYTES
  const effectiveOtherReserved = otherReservedBytes ?? 0

  if (budgetBytes === 0) {
    return {
      admitted: false,
      reason: 'budget-zero',
      estimatedBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedBytes,
      budgetBytes: 0,
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'Storage budget is zero',
    }
  }

  // 2. Accounting degraded check (fail-closed)
  if (accountingDegraded === true) {
    return {
      admitted: false,
      reason: 'accounting-unknown',
      estimatedBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedBytes,
      budgetBytes,
      projectedUsageRatio: (currentUsageBytes + estimatedBytes) / budgetBytes,
      remainingBytes: 0,
      error: 'Storage accounting is in an unknown or degraded state due to I/O or permission errors',
    }
  }

  // 3. Physical disk space check (strict finite non-negative safe integer; null/undefined denied fail-closed)
  if (
    freeDiskBytes === null ||
    freeDiskBytes === undefined ||
    !Number.isFinite(freeDiskBytes) ||
    !Number.isSafeInteger(freeDiskBytes) ||
    freeDiskBytes < 0
  ) {
    return {
      admitted: false,
      reason: 'disk-space-insufficient',
      estimatedBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedBytes,
      budgetBytes,
      projectedUsageRatio: budgetBytes > 0 ? (currentUsageBytes + estimatedBytes) / budgetBytes : 1.0,
      remainingBytes: 0,
      error: 'Free disk space is unknown, null, or invalid safe integer; physical write denied fail-closed',
    }
  }

  if (freeDiskBytes < estimatedBytes + effectiveHeadroom) {
    return {
      admitted: false,
      reason: 'disk-space-insufficient',
      estimatedBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedBytes,
      budgetBytes,
      projectedUsageRatio: (currentUsageBytes + estimatedBytes) / budgetBytes,
      remainingBytes: 0,
      error: `Insufficient free disk space: required ${estimatedBytes + effectiveHeadroom} bytes, available ${freeDiskBytes} bytes`,
    }
  }

  // 4. Projected quota check:
  // Projects: physical usage (including old ANN index currently counted) + temporary new bytes + other active leases + headroom
  const projectedBytes = currentUsageBytes + estimatedBytes + effectiveOtherReserved + effectiveHeadroom
  const projectedUsageRatio = projectedBytes / budgetBytes

  if (projectedUsageRatio > HARD_LIMIT_RATIO) {
    return {
      admitted: false,
      reason: 'quota-exhausted',
      estimatedBytes,
      currentUsageBytes,
      projectedBytes,
      budgetBytes,
      projectedUsageRatio,
      remainingBytes: Math.max(
        0,
        budgetBytes - (currentUsageBytes + effectiveOtherReserved + effectiveHeadroom),
      ),
      error: `Storage quota exceeded: projected ${projectedBytes} bytes exceeds budget ${budgetBytes} bytes`,
    }
  }

  return {
    admitted: true,
    reason: 'ok',
    estimatedBytes,
    currentUsageBytes,
    projectedBytes,
    budgetBytes,
    projectedUsageRatio,
    remainingBytes: Math.max(0, budgetBytes - projectedBytes),
  }
}

/**
 * In-process admission guard for ANN index writes.
 * Coordinates local reservations, enforces fail-closed preauthorizations, and rechecks
 * live configuration right before physical atomic saves.
 */
export class AnnWriteAdmissionGuard {
  private readonly activePermits = new Map<string, AnnWritePermit>()

  acquirePermit(params: {
    spaceId: string
    vectorCount: number
    dimensions: number
    currentUsageBytes: number
    budgetBytes: number
    freeDiskBytes?: number | null
    accountingDegraded?: boolean
    configVersion?: number
    ttlMs?: number
    ownerToken?: string
    indexPath?: string
    generation?: number
  }): AnnAdmissionDecision & { permit?: AnnWritePermit } {
    const {
      spaceId,
      vectorCount,
      dimensions,
      currentUsageBytes,
      budgetBytes,
      freeDiskBytes,
      accountingDegraded,
      configVersion,
      ttlMs = ANN_DEFAULT_PERMIT_TTL_MS,
      ownerToken,
      indexPath,
      generation,
    } = params

    this.purgeExpired()

    // Concurrency check: prevent silent overwrite of an existing live lease for the same space
    const existing = this.activePermits.get(spaceId)
    if (existing && (existing.isWriting || Date.now() < existing.expiresAt)) {
      if (!ownerToken || existing.ownerToken !== ownerToken) {
        return {
          admitted: false,
          reason: 'lease-active',
          estimatedBytes: existing.reservedBytes,
          currentUsageBytes: Math.max(0, currentUsageBytes || 0),
          projectedBytes: Math.max(0, currentUsageBytes || 0) + existing.reservedBytes,
          budgetBytes: Math.max(0, budgetBytes || 0),
          projectedUsageRatio: budgetBytes > 0 ? (currentUsageBytes + existing.reservedBytes) / budgetBytes : 1.0,
          remainingBytes: 0,
          error: `Another active write lease already exists for space '${spaceId}'`,
        }
      }
    }

    const otherReservedBytes = this.getTotalReservedBytes(spaceId)
    const decision = checkAnnWriteAdmission({
      spaceId,
      vectorCount,
      dimensions,
      currentUsageBytes,
      budgetBytes,
      freeDiskBytes,
      accountingDegraded,
      otherReservedBytes,
    })

    if (!decision.admitted) {
      return decision
    }

    const now = Date.now()
    const token = ownerToken ?? `owner-${now}-${Math.random().toString(36).slice(2)}`
    const permit: AnnWritePermit = {
      id: `ann-write:${spaceId}:${token}:${now}`,
      spaceId,
      ownerToken: token,
      reservedBytes: decision.estimatedBytes,
      dimensions,
      vectorCount,
      createdAt: now,
      expiresAt: now + ttlMs,
      measurementValid: !accountingDegraded,
      budgetBytes,
      configVersion,
      generation,
      indexPath,
      isWriting: false,
    }

    this.activePermits.set(spaceId, permit)
    return {
      ...decision,
      permit,
    }
  }

  getPermit(spaceId: string): AnnWritePermit | null {
    this.purgeExpired()
    return this.activePermits.get(spaceId) ?? null
  }

  consumePermit(spaceId: string, ownerToken?: string): AnnWritePermit | null {
    this.purgeExpired()
    const permit = this.activePermits.get(spaceId) ?? null
    if (permit) {
      if (ownerToken && permit.ownerToken && permit.ownerToken !== ownerToken) {
        return null
      }
      this.activePermits.delete(spaceId)
    }
    return permit
  }

  releasePermit(spaceId: string, ownerToken?: string): boolean {
    const permit = this.activePermits.get(spaceId)
    if (!permit) return false
    if (ownerToken && permit.ownerToken && permit.ownerToken !== ownerToken) {
      return false
    }
    return this.activePermits.delete(spaceId)
  }

  markWriting(spaceId: string, isWriting = true): boolean {
    const permit = this.activePermits.get(spaceId)
    if (!permit) return false
    permit.isWriting = isWriting
    return true
  }

  recheckPermit(spaceId: string, currentBudgetBytes: number, currentUsageBytes: number): boolean {
    if (
      !Number.isFinite(currentBudgetBytes) ||
      !Number.isSafeInteger(currentBudgetBytes) ||
      currentBudgetBytes <= 0 ||
      !Number.isFinite(currentUsageBytes) ||
      !Number.isSafeInteger(currentUsageBytes) ||
      currentUsageBytes < 0
    ) {
      return false
    }

    const permit = this.getPermit(spaceId)
    if (!permit) return false

    const now = Date.now()
    if (!permit.isWriting && now >= permit.expiresAt) return false

    const otherReservedBytes = this.getTotalReservedBytes(spaceId)
    const projectedBytes =
      currentUsageBytes + permit.reservedBytes + otherReservedBytes + ANN_CONSERVATIVE_HEADROOM_BYTES
    if (projectedBytes / currentBudgetBytes > HARD_LIMIT_RATIO) {
      return false
    }

    return true
  }

  getTotalReservedBytes(excludeSpaceId?: string): number {
    this.purgeExpired()
    let sum = 0
    for (const [sId, p] of this.activePermits.entries()) {
      if (!excludeSpaceId || sId !== excludeSpaceId) {
        sum += p.reservedBytes
      }
    }
    return sum
  }

  clear(): void {
    this.activePermits.clear()
  }

  private purgeExpired(now: number = Date.now()): void {
    for (const [sId, p] of this.activePermits.entries()) {
      // Do not purge live permit while writer is actively writing
      if (p.isWriting) {
        continue
      }
      if (now >= p.expiresAt) {
        this.activePermits.delete(sId)
      }
    }
  }
}
