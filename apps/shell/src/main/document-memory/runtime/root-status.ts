import { pathUnderRoot, rootAvailability } from '../root-availability'
import type { IndexIssueSummary } from '../issue-reader'
import type { StatusAggregates } from './status-aggregates'

/** Counts come from the existing reader thread; reaching this UI path performs no disk I/O. */
export function withOfflineSources(
  summary: IndexIssueSummary,
  aggregates?: Pick<StatusAggregates, 'folder'>,
  scope = '*',
): IndexIssueSummary {
  const offline = rootAvailability.snapshot().filter((state) => !state.online)
  const offlineRoots = offline
    .filter(
      (state) =>
        !offline.some(
          (parent) => parent.root !== state.root && pathUnderRoot(parent.root, state.root),
        ) &&
        (scope === '*' || pathUnderRoot(scope, state.root) || pathUnderRoot(state.root, scope)),
    )
    .map((state) => {
      const counts = aggregates?.folder(state.root)
      return {
        root: state.root,
        since: state.offlineSince!,
        waiting:
          (counts?.pendingFiles ?? 0) + (counts?.emptyFiles ?? 0) + (counts?.errorFiles ?? 0),
      }
    })
  return { ...summary, offlineRoots }
}
