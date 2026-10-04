export interface DeleteFilesResult {
  /** Number of unique requested files successfully sent to the system trash. */
  trashed: number
  /** Number of unique requested paths rejected, missing, or not sent to trash. */
  failed: number
}

/** Trash only paths the caller can prove were visible, and report partial failures honestly. */
export async function trashUserFiles(
  paths: readonly string[],
  deps: {
    isAllowed: (path: string) => boolean
    isFile: (path: string) => boolean
    trash: (path: string) => Promise<void>
    afterTrashed: (paths: readonly string[]) => void
  },
): Promise<DeleteFilesResult> {
  const unique = [...new Set(paths)]
  const trashedPaths: string[] = []
  let failed = 0
  for (const path of unique) {
    if (!deps.isAllowed(path) || !deps.isFile(path)) {
      failed++
      continue
    }
    try {
      await deps.trash(path)
      trashedPaths.push(path)
    } catch {
      failed++
    }
  }
  if (trashedPaths.length) deps.afterTrashed(trashedPaths)
  return { trashed: trashedPaths.length, failed }
}
