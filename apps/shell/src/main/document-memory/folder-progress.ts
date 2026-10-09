import type { FolderChunkProgress } from './store'

/** The folder progress payload shown by the "Document index" popup. */
export interface FolderIndexProgress {
  totalFiles: number
  readyFiles: number
  /** Files that truly wait for extraction / embedding (released files are not included). */
  pendingFiles: number
  waitingFiles?: number
  /** Vectors/content released to save space: searchable by name/text, reloaded when opened. */
  releasedFiles?: number
  errorFiles: number
  emptyFiles?: number
  /** Files indexed only in part (chunk cap or sampled rows). */
  truncatedFiles?: number
  completedChunks: number
  totalChunks: number
  percent: number | null
}

/**
 * Turn stored per-folder counts into the popup payload. Pure and O(1), so the cheap, live inputs
 * (scan state and error count) can be applied to counts that were read some time ago.
 */
export function foldFolderProgress(
  counts: FolderChunkProgress,
  discoveryComplete: boolean,
  scanErrors = 0,
): FolderIndexProgress {
  let percent: number | null = null
  if (discoveryComplete) {
    if (counts.totalFiles === 0) percent = scanErrors ? 99 : 100
    else {
      percent = Math.floor((counts.partialFileProgress / counts.totalFiles) * 100)
      if (counts.pendingFiles || counts.errorFiles || scanErrors) percent = Math.min(percent, 99)
    }
  }
  return {
    totalFiles: counts.totalFiles,
    readyFiles: counts.readyFiles,
    pendingFiles: counts.pendingFiles,
    waitingFiles: counts.waitingFiles ?? counts.pendingFiles,
    releasedFiles: counts.releasedFiles ?? 0,
    errorFiles: counts.errorFiles,
    emptyFiles: counts.emptyFiles ?? 0,
    truncatedFiles: counts.truncatedFiles,
    completedChunks: counts.completedChunks,
    totalChunks: counts.totalChunks,
    percent,
  }
}
