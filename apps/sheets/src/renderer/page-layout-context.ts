import type { WorkbookOperation } from '@genoffice/xlsx-gateway/domain/workbook-dsl'
import type { ApplyOutcome } from '@genoffice/xlsx-gateway/domain/workbook.types'
import type { LazyWorkbookState, UniverRuntime } from './univer-state'

/** The App refs/state the page-layout actions need; built fresh per call. */
export interface PageLayoutContext {
  univerRef: { readonly current: UniverRuntime | null }
  /// The App's live ref (not a snapshot): loadVisibleRange's staleness
  /// guards compare against `.current` after awaits.
  lazyWorkbookRef: { current: LazyWorkbookState | null }
  setMessage: (message: string) => void
  setPendingEdits: (count: number) => void
  /// Re-renders the Page Break Preview overlay when page geometry changed.
  refreshPageBreakPreview?: () => void
  /// Re-queues the floating visuals' install so a print right after load
  /// (headless export) finds their frames; optional for callers without visuals.
  requestVisualInstall?: () => void
  /// Page-setup edits run as set_page_setup ops through the shared executor.
  runOps: (
    ops: readonly WorkbookOperation[],
    successMessage?: string | null,
  ) => Promise<ApplyOutcome>
}
