import { isRetryableReason, type IndexIssueReason } from '../../../main/document-memory/issues'

export interface RowActionState {
  path: string
  reason?: IndexIssueReason
  status?: string
  deleted?: boolean
  offline?: boolean
}

/** Only offer operations that make sense for this file's current pipeline stage. */
export function indexRowActions(
  item: RowActionState,
  localStage?: 'reading' | 'embedding' | 'queued' | 'paused',
  ocrQueued = false,
  ocrRunning = false,
) {
  const cloudWork = ocrQueued || ocrRunning
  const localActive = localStage === 'reading' || localStage === 'embedding'
  const localWaiting =
    localStage === 'queued' || localStage === 'paused' || item.reason === 'waiting'
  return {
    open: !item.deleted && !item.offline,
    retry:
      !item.offline &&
      !cloudWork &&
      !localActive &&
      (item.status === 'ready' || (item.reason !== undefined && isRetryableReason(item.reason))),
    ocr:
      !item.offline &&
      !cloudWork &&
      !localActive &&
      /\.pdf$/i.test(item.path) &&
      item.reason === 'no-text',
    stop: cloudWork || localActive || localWaiting,
    defer: !item.offline && !cloudWork && (localActive || localWaiting),
  }
}

/** Never show a misleading progress fraction from a malformed or not-yet-known total. */
export function fileProgress(done: number, total: number) {
  if (!Number.isFinite(done) || !Number.isFinite(total) || Math.floor(total) <= 0) return null
  return {
    done: Math.max(0, Math.min(Math.floor(done), Math.floor(total))),
    total: Math.floor(total),
  }
}
