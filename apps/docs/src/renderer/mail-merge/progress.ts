/**
 * The export job's lifecycle, kept separate from the runner so the progress
 * dialog and the session agree on one definition of "finished".
 *
 * Counting `done >= total` is not enough: a job that throws before the first
 * recipient is processed has done=0, failed=1 and cancelled=false, and the
 * dialog would keep saying "exporting" forever.
 */
import type { MailMergeExportProgress, MailMergeExportStatus } from './types'

export function initialProgress(total: number): MailMergeExportProgress {
  return {
    total,
    done: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    current: '',
    errors: [],
    cancelled: false,
    status: 'running',
  }
}

/** A job that died outside the recipient loop: terminal, with the reason recorded. */
export function applyJobFailure(
  progress: MailMergeExportProgress | null,
  base: MailMergeExportProgress,
  message: string,
): MailMergeExportProgress {
  const current = progress ?? base
  return {
    ...current,
    failed: current.failed + 1,
    errors: [...current.errors, { recipient: 'export', message }],
    cancelled: current.cancelled,
    status: 'failed',
  }
}

/** Classify a job that has stopped from its counters. */
export function terminalStatus(progress: MailMergeExportProgress): MailMergeExportStatus {
  if (progress.cancelled) return 'cancelled'
  if (progress.failed > 0 || progress.skipped > 0) return 'completed_with_errors'
  return 'completed'
}

export function isFinished(progress: MailMergeExportProgress): boolean {
  return progress.status !== 'running'
}
