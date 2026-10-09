import { resolve } from 'node:path'
import type { DocumentMemoryStore } from '../store'
import type { FreshnessCoordinator } from './freshness-coordinator'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import { PendingMetadataIntake, safeStat } from './pending-metadata-intake'
import type { SyncMetadataAdmissionCoordinator } from './sync-metadata-admission'

/**
 * Manager wiring of the pending-metadata intake (remember / discovered intents parked until the budget handshake,
 * fresh accounting and free-disk checks allow the write). Extracted from DocumentMemoryManager unchanged so the
 * manager stays inside its architecture LOC limit; every collaborator is read lazily because the intake is
 * constructed before the coordinators it calls.
 */
export interface PendingIntakeWiringDeps {
  store: DocumentMemoryStore
  isWriteReady: () => boolean
  getMaintScheduler: () => MaintenanceScheduler | undefined
  getSyncAdmission: () => SyncMetadataAdmissionCoordinator | undefined
  getFreshness: () => FreshnessCoordinator
  isStopped: () => boolean
  isEnabled: () => boolean
  enqueue: (path: string, prioritize?: boolean) => void
  setLastError: (error: string | undefined) => void
}

export function createPendingIntake(d: PendingIntakeWiringDeps): PendingMetadataIntake {
  return new PendingMetadataIntake({
    isWriteReady: d.isWriteReady,
    isAccountingReady: () => {
      const s = d.getMaintScheduler()?.getStorageBudgetSnapshot()
      return Boolean(s && !s.isDegraded && s.measurementStatus === 'fresh' && s.limitState !== 'full')
    },
    isFreeDiskReady: () => Boolean(d.getSyncAdmission()?.canWriteProjection({ id: 0, name: '', path: '' }, 1024)),
    refreshAccountingAsync: () => {
      const m = d.getMaintScheduler()
      return m ? m.refreshAccountingAsync() : Promise.resolve(null)
    },
    isStopped: d.isStopped,
    isEnabled: d.isEnabled,
    onRemember: (p) => {
      if (d.store.documentByPath(p)?.status === 'excluded') return { outcome: 'excluded' }
      const ok = d.store.remember(p)
      if (ok) {
        d.enqueue(resolve(p), true)
        return { outcome: 'admitted' }
      }
      return { outcome: 'denied', reason: d.getSyncAdmission()?.getLastRejectionReason() }
    },
    onDiscovered: (p, meta) => {
      const cur = meta ?? safeStat(p)
      const ext = cur ? d.store.documentByPath(p) : null
      if (ext?.status === 'excluded') return { outcome: 'excluded' }
      if (ext && cur && ext.mtimeMs === cur.mtimeMs && ext.sizeBytes === cur.sizeBytes) return { outcome: 'unchanged' }
      const ok = d.getFreshness().indexDiscoveredFile(p, meta)
      if (ok) return { outcome: 'enrolled' }
      const after = d.store.documentByPath(p)
      if (after && cur && after.mtimeMs === cur.mtimeMs && after.sizeBytes === cur.sizeBytes) return { outcome: 'unchanged' }
      return { outcome: 'denied', reason: d.getSyncAdmission()?.getLastRejectionReason() }
    },
    onLastError: d.setLastError,
  })
}
