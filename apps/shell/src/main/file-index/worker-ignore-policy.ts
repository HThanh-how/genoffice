import {
  applyIgnorePolicySnapshot,
  applyIgnorePolicySnapshotDetailed,
  getIgnorePolicyGeneration,
  getIgnorePolicySnapshot,
  getLocalIgnoreCacheRevision,
  isPathIgnored,
  type IgnorePolicySnapshot,
  type SnapshotApplyStatus,
} from '../document-memory/ignore-policy'

export {
  applyIgnorePolicySnapshot,
  applyIgnorePolicySnapshotDetailed,
  getIgnorePolicyGeneration,
  getIgnorePolicySnapshot,
  getLocalIgnoreCacheRevision,
  isPathIgnored,
  type IgnorePolicySnapshot,
  type SnapshotApplyStatus,
}

export type IgnorePolicyAckStatus = SnapshotApplyStatus | 'startup-failed'

export interface IgnorePolicyWorkerMessage {
  id?: number
  type: 'ignore-policy'
  snapshot: IgnorePolicySnapshot
}

export interface IgnorePolicyAckResponse {
  id?: number
  type: 'ignore-policy-ack'
  version: number
  applied: boolean
  status?: IgnorePolicyAckStatus
}

export function isIgnorePolicyMessage(message: unknown): message is IgnorePolicyWorkerMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'ignore-policy'
  )
}

export function isIgnorePolicyAckMessage(message: unknown): message is IgnorePolicyAckResponse {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'ignore-policy-ack' &&
    typeof (message as { version?: unknown }).version === 'number' &&
    typeof (message as { applied?: unknown }).applied === 'boolean'
  )
}

/**
 * Safely validates and applies an Ignore-policy message in the worker replica.
 * Malformed or stale snapshots fail closed without throwing or writing to disk.
 */
export function applyWorkerIgnorePolicyMessage(message: unknown): IgnorePolicyAckResponse {
  const id =
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { id?: unknown }).id === 'number'
      ? (message as { id: number }).id
      : undefined
  const snapshot =
    typeof message === 'object' && message !== null
      ? (message as { snapshot?: unknown }).snapshot
      : undefined
  const outcome = applyIgnorePolicySnapshotDetailed(snapshot)
  return {
    ...(id !== undefined ? { id } : {}),
    type: 'ignore-policy-ack',
    version: outcome.version,
    applied: outcome.applied,
    status: outcome.status,
  }
}

/**
 * Applies the initial Ignore-policy snapshot passed via `workerData` when a worker starts.
 */
export function applyWorkerDataIgnorePolicy(workerData: unknown): IgnorePolicyAckResponse | null {
  if (typeof workerData !== 'object' || workerData === null) return null
  const snapshot = (workerData as { ignorePolicy?: unknown }).ignorePolicy
  if (snapshot === undefined) return null
  const outcome = applyIgnorePolicySnapshotDetailed(snapshot)
  return {
    type: 'ignore-policy-ack',
    version: outcome.version,
    applied: outcome.applied,
    status: outcome.applied ? outcome.status : 'startup-failed',
  }
}

/**
 * Applies an inline `ignorePolicy` snapshot attached to a worker request before execution.
 */
export function applyRequestIgnorePolicy(request: unknown): boolean {
  if (typeof request !== 'object' || request === null) return false
  const snapshot = (request as { ignorePolicy?: unknown }).ignorePolicy
  if (snapshot === undefined) return false
  return applyIgnorePolicySnapshotDetailed(snapshot).applied
}
