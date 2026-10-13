import { randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, link, open, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

const TOLERATED_SYNC_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EINVAL', 'ENOSYS'])
const LINK_UNSUPPORTED_CODES = new Set(['EXDEV', 'ENOTSUP', 'EPERM', 'EINVAL', 'ENOSYS'])

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? ''

async function syncFileBestEffort(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r+')
  } catch (error) {
    if (TOLERATED_SYNC_CODES.has(errorCode(error))) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!TOLERATED_SYNC_CODES.has(errorCode(error))) throw error
  } finally {
    await handle.close()
  }
}

/**
 * Builds candidate filename for duplicate:
 * e.g., "Report Copy.docx", then "Report Copy 2.docx", "Report Copy 3.docx"
 */
export function buildDuplicateCandidatePath(
  sourcePath: string,
  copySuffix: string,
  index: number,
): string {
  const ext = extname(sourcePath)
  const base = basename(sourcePath, ext)
  const dir = dirname(sourcePath)
  const suffixPart = copySuffix ? ` ${copySuffix}` : ' Copy'
  const numberPart = index === 1 ? '' : ` ${index}`
  return join(dir, `${base}${suffixPart}${numberPart}${ext}`)
}

export interface DuplicateDocumentOptions {
  copySuffix?: string
  maxAttempts?: number
}

/**
 * Safely duplicates a document file on disk without clobbering any existing file (no-clobber).
 * - Copies source to a unique temporary file beside source.
 * - Attempts atomic publication to the first free candidate path using hard-link (`link`) with
 *   guaranteed `EEXIST` rejection if destination exists, or `copyFile` with `COPYFILE_EXCL` fallback.
 * - If candidate destination already exists, tries the next candidate until a free name is published.
 * - Cleans up the temporary file on success or failure.
 * - Never modifies or overwrites the source file or any pre-existing destination file.
 */
export async function duplicateDocumentFile(
  sourcePath: string,
  options?: DuplicateDocumentOptions,
): Promise<string> {
  const copySuffix = options?.copySuffix ?? 'Copy'
  const maxAttempts = options?.maxAttempts ?? 500

  const dir = dirname(sourcePath)
  const tmp = join(dir, `.${basename(sourcePath)}.${randomBytes(8).toString('hex')}.tmp`)

  try {
    // 1. Copy source to temporary file first (guaranteed cleanup in finally block)
    await copyFile(sourcePath, tmp)
    await syncFileBestEffort(tmp)

    // 2. Find and exclusively publish to candidate target
    for (let i = 1; i <= maxAttempts; i++) {
      const target = buildDuplicateCandidatePath(sourcePath, copySuffix, i)

      // Fast-path skip if target is visibly present
      if (existsSync(target)) continue

      // Attempt atomic no-clobber publish via link()
      try {
        await link(tmp, target)
        return target
      } catch (linkError) {
        const code = errorCode(linkError)
        if (code === 'EEXIST') {
          // Destination appeared concurrently between exists check and link; try next candidate
          continue
        }
        if (LINK_UNSUPPORTED_CODES.has(code)) {
          // Filesystem does not support hard links (e.g. FAT32/exFAT/network mount); fallback to exclusive copyFile.
          // Fallback uses COPYFILE_EXCL to avoid overwriting an existing destination.
          // Unlike hard-link publication, the copy is not atomic across content transfer.
          // Do not unlink the destination on failure because another actor may own that path.
          try {
            await copyFile(tmp, target, constants.COPYFILE_EXCL)
            return target
          } catch (copyError) {
            if (errorCode(copyError) === 'EEXIST') {
              continue
            }
            throw copyError
          }
        }
        throw linkError
      }
    }

    throw new Error(
      `[duplicate] Unable to find an available duplicate filename for "${sourcePath}" after ${maxAttempts} attempts`,
    )
  } finally {
    await unlink(tmp).catch(() => {})
  }
}
