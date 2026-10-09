import type { StorageBudgetWorkerResult } from '../../src/main/document-memory/worker-types'

interface BudgetRequestLike {
  id?: number
  type?: string
  configVersion?: number
  budget?: { maxDatabaseBytes?: number }
}

/**
 * Exact-version ACK that a real worker returns for `set-storage-budget`.
 * Fake workers must answer the startup handshake with this, otherwise the manager's
 * budget coordinator never becomes write-ready and every metadata write is (correctly) refused.
 * Returns null for any other request type so callers can fall through to their own handling.
 */
export function storageBudgetAckReply(
  message: BudgetRequestLike,
): { id: number | undefined; result: StorageBudgetWorkerResult } | null {
  if (message.type !== 'set-storage-budget') return null
  const version = message.configVersion ?? 0
  return {
    id: message.id,
    result: {
      ok: true,
      appliedVersion: version,
      desiredVersion: version,
      appliedBudgetBytes: message.budget?.maxDatabaseBytes,
    },
  }
}

interface WriteGateLike {
  budgetCoord?: { isWriteReady(): boolean }
  syncAdmissionCoord?: { isReady(): boolean }
}

/**
 * Resolves once the manager's startup budget handshake has been ACKed and the sync-metadata guard
 * is ready. Tests that write through `manager.store` right after construction must await this,
 * because the guard (correctly) refuses writes until the worker confirms the budget.
 */
export async function waitForManagerWriteReady(manager: unknown, timeoutMs = 3000): Promise<void> {
  const gate = manager as WriteGateLike
  const started = Date.now()
  while (!(gate.budgetCoord?.isWriteReady() && gate.syncAdmissionCoord?.isReady())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for manager write readiness')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Harmless reply of an idle worker to the storage-compaction lane ('run-retention' | 'free-space' | 'optimize-fts' |
 * 'redundancy-analyze' | 'cancel-compaction'): "nothing to do". Fake workers that should keep the maintenance cycle quiet
 * answer with it (together with storageBudgetAckReply); null for every other request type.
 */
export function compactionNoopReply(message: { id?: number; type?: string; runId?: string; epoch?: number; neededBytes?: number; urgency?: string }): { id: number | undefined; result: unknown } | null {
  const base = { runId: message.runId, epoch: message.epoch, status: 'not-needed', durationMs: 0 }
  switch (message.type) {
    case 'run-retention':
      return {
        id: message.id,
        result: {
          ...base, kind: 'run-retention', urgency: message.urgency ?? 'none', report: null, bytesBefore: 0, bytesAfter: 0, belowSoftQuota: false,
          release: { vectorDocuments: 0, vectorChunks: 0, skeletonDocuments: 0, skeletonEstimatedBytes: 0 }, affectedAnnSpaces: [], annRequests: [],
        },
      }
    case 'free-space':
      return {
        id: message.id,
        result: { ...base, kind: 'free-space', displacement: null, agedStage: null, neededBytes: message.neededBytes ?? 0, freedBytes: 0, usedBefore: 0, usedAfter: 0, fitsHardCap: false, affectedAnnSpaces: [], annRequests: [] },
      }
    case 'optimize-fts':
      return { id: message.id, result: { ...base, kind: 'optimize-fts', result: null } }
    case 'redundancy-analyze':
      return { id: message.id, result: { ...base, kind: 'redundancy-analyze', complete: true, documentsAnalyzed: 0 } }
    case 'cancel-compaction':
      return { id: message.id, result: { cancelled: false } }
    default:
      return null
  }
}
