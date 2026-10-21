import type { IndexedFolder } from '../../../shared/fork/document-index-api'

/** What a folder row says about itself, in the order a person should read it. */
export type FolderChip = 'offline' | 'scanning' | 'stopped' | 'indexing' | 'errors' | 'ready'

export function folderChips(
  folder: Pick<IndexedFolder, 'unavailable' | 'state' | 'pendingFiles' | 'errorFiles'>,
): FolderChip[] {
  if (folder.unavailable) return ['offline']
  const chips: FolderChip[] = []
  if (folder.state === 'running') chips.push('scanning')
  else if (folder.state === 'stopped') chips.push('stopped')
  else if (folder.pendingFiles > 0) chips.push('indexing')
  if (folder.errorFiles > 0) chips.push('errors')
  if (chips.length === 0) chips.push('ready')
  return chips
}

/** "x / y files": what is done out of what was found (empty, failed and released files count as handled). */
export function folderDone(
  folder: Pick<IndexedFolder, 'readyFiles' | 'errorFiles' | 'totalFiles' | 'releasedFiles'>,
): { done: number; total: number } {
  const total = Math.max(0, folder.totalFiles)
  return { done: Math.min(total, Math.max(0, folder.readyFiles + folder.errorFiles + (folder.releasedFiles ?? 0))), total }
}
