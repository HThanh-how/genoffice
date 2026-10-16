/**
 * The final file name written to the mail-merge destination directory.
 *
 * The policy itself lives in the merge engine (`safeFileName`), so the renderer
 * and the main process agree on one name: the renderer never sends a name the
 * writer would have to change, and the writer is still the last stop before the
 * filesystem. Truncating a whole name can cut off `.docx` / `.pdf`, so the
 * extension is taken first, the base is fitted to the remaining byte budget, and
 * the extension is put back.
 */
import { MAX_FILE_NAME_BYTES, safeFileName, uniqueFileName } from '@genoffice/docx-engine'

export type MailMergeOverwritePolicy = 'skip' | 'rename' | 'overwrite'

export const MAX_NAME_BYTES = MAX_FILE_NAME_BYTES

export const safeOutputFileName = safeFileName

/** `name`, `name (2)`, `name (3)` … — the first one `exists` says is free. */
export const uniqueSafeFileName = uniqueFileName

/**
 * Decide which name the writer uses for one recipient.
 *
 * `exists` is the destination directory's view of the world, so the decision is
 * testable without touching a disk. Shortening a name is not the user's
 * "overwrite" choice: two recipients that collapse to the same shortened name
 * must not destroy the first one's file, so a shortened collision is renamed even
 * under `overwrite`.
 */
export function resolveSafeFileName(
  name: string,
  policy: MailMergeOverwritePolicy,
  exists: (candidate: string) => boolean,
): { name: string; skipped: boolean } {
  const safe = safeFileName(name)
  if (!safe) return { name: '', skipped: true }
  const collisionFromShortening = safe !== name
  if ((policy !== 'overwrite' || collisionFromShortening) && exists(safe)) {
    if (policy === 'skip') return { name: safe, skipped: true }
    return { name: uniqueFileName(safe, exists), skipped: false }
  }
  return { name: safe, skipped: false }
}
