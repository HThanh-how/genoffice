import type { AnnRebuildRequest } from './ann-rebuild-after-compaction'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import { inferDocumentImportance } from '../document-importance'

/**
 * Glue between the worker-run compaction lane (MaintenanceScheduler / CompactionDriver) and the manager's own
 * machinery. It is the only place that knows what to do with a compaction result on the main thread:
 *   - released vectors / skeletons          -> poll() re-queues them (they were cleared from the eviction marker);
 *   - ANN rebuilds scheduled by the worker  -> the existing admission-guarded triggerAnnSync, one space at a time;
 *   - a refused new document (hard cap)     -> admission by displacement, then replay the parked intake;
 *   - a refused embedding reservation       -> displacement, caller retries once.
 */
export interface CompactionWiringDeps {
  getScheduler: () => MaintenanceScheduler | undefined
  triggerAnnSync: (spaceId: string) => Promise<unknown>
  poll: () => Promise<void> | void
  replayIntake: () => Promise<unknown> | void
  isActive: () => boolean
  importanceOf: (path: string) => 'important' | 'normal' | 'low' | undefined
}

export interface CompactionWiring {
  onReleased: () => void
  onAnnRebuildRequests: (requests: AnnRebuildRequest[]) => Promise<void>
  onSyncQuotaPressure: (info: { neededBytes: number; doc?: { name: string; path: string } }) => void
  embeddingMakeRoom: (neededBytes: number, path: string) => Promise<boolean>
}

export function createCompactionWiring(d: CompactionWiringDeps): CompactionWiring {
  return {
    onReleased: () => {
      if (d.isActive()) void d.poll()
    },
    onAnnRebuildRequests: async (requests) => {
      const seen = new Set<string>()
      for (const r of requests) {
        if (!d.isActive() || seen.has(r.spaceId)) continue
        seen.add(r.spaceId)
        try {
          await d.triggerAnnSync(r.spaceId)
        } catch {
          // fail closed: the dirty generation stays, the next compaction cycle schedules it again
        }
      }
    },
    onSyncQuotaPressure: ({ neededBytes, doc }) => {
      const scheduler = d.getScheduler()
      if (!scheduler || !d.isActive()) return
      // a document that is not in the index yet is rated like indexing will rate it (name / path inference)
      const importance = doc
        ? (d.importanceOf(doc.path) ?? (inferDocumentImportance({ name: doc.name, path: doc.path }).suggestion === 'important' ? 'important' : 'normal'))
        : 'normal'
      void scheduler
        .makeRoom({ neededBytes, importance, reason: 'metadata' })
        .then((out) => {
          if (out.retry && d.isActive()) void d.replayIntake()
        })
        .catch(() => undefined)
    },
    embeddingMakeRoom: async (neededBytes, path) => {
      const scheduler = d.getScheduler()
      if (!scheduler || !d.isActive()) return false
      const out = await scheduler.makeRoom({ neededBytes, importance: d.importanceOf(path), reason: 'embedding' })
      return out.retry
    },
  }
}
