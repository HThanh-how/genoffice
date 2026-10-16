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
 * testable without touching a disk. `allocated` is the set of names this batch
 * has already written: a name an earlier recipient of the same batch received is
 * not a file the user chose to skip or overwrite, it is that recipient's own
 * output, so it is always renamed away. Shortening a name is likewise not the
 * user's "overwrite" choice: two recipients that collapse to the same shortened
 * name must not destroy the first one's file.
 */
export function resolveSafeFileName(
  name: string,
  policy: MailMergeOverwritePolicy,
  exists: (candidate: string) => boolean,
  allocated?: Set<string>,
): { name: string; skipped: boolean } {
  const safe = safeFileName(name)
  if (!safe) return { name: '', skipped: true }
  if (!exists(safe)) return { name: safe, skipped: false }
  // the file is there. Was it put there by this batch, or was it already there
  // when the batch started? Only the second case is what the policy is about.
  const takenByThisBatch = allocated?.has(safe) === true
  if (takenByThisBatch) return { name: uniqueFileName(safe, exists), skipped: false }
  if (policy === 'skip') return { name: safe, skipped: true }
  if (policy === 'overwrite') return { name: safe, skipped: false }
  return { name: uniqueFileName(safe, exists), skipped: false }
}
