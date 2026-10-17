/**
 * The main process' mail-merge write boundary.
 *
 * The renderer proposes a name; this module decides the name that actually lands
 * on disk. `skip` and `rename` open the file with `wx`, so the existence check
 * and the write are one operation: a file created by another process between the
 * renderer choosing a name and the writer using it cannot be clobbered. Only
 * `overwrite` may replace a file, and it keeps the temp+rename path used by the
 * rest of the app.
 *
 * Three ordering rules make the boundary safe:
 *   1. Every candidate path is resolved through `resolvePath` (the caller's
 *      containment check) *before* the file is opened. A name the renderer
 *      invented never reaches the filesystem.
 *   2. A name is claimed in the batch's allocation set before the bytes are
 *      written. The claim is synchronous, so two recipients of the same batch
 *      that start at the same instant cannot both take the same destination.
 *   3. A write that fails partway is undone: the file this attempt created is
 *      removed, so the folder never keeps a truncated .docx or .pdf.
 */
import { existsSync } from 'node:fs'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'
import {
  resolveSafeFileName,
  uniqueSafeFileName,
  type MailMergeOverwritePolicy,
} from './mail-merge-names'

export interface WriteOutcome {
  /** the name actually written (or the name that was skipped) */
  name: string
  path: string
  skipped: boolean
}

/** Turn a candidate file name into the path the write would use, or null when
 *  that name would land outside the authorized directory. */
export type PathResolver = (candidate: string) => string | null

/**
 * A resolver for a granted directory: the writer proposes a bare name, the
 * containment rule decides where it may land. Both the DOCX batch path and the
 * PDF commit path build their resolver this way, so the identical operation
 * cannot end up with two different rules.
 */
export function resolverInsideGrant(
  dir: string,
  contained: (dir: string, path: string) => string | null,
): PathResolver {
  return (candidate: string) => contained(dir, join(dir, candidate))
}

type WriteFn = (handle: FileHandle, data: Buffer) => Promise<void>

/**
 * `FileHandle.write` reports the number of bytes it took. Node returns a plain
 * number in some versions and a `{ bytesWritten, buffer }` object in others, so
 * both shapes are read rather than assuming one.
 */
function writtenCount(result: unknown, fallback: number): number {
  if (typeof result === 'number') return result
  if (result && typeof result === 'object' && 'bytesWritten' in result) {
    const value = (result as { bytesWritten?: unknown }).bytesWritten
    if (typeof value === 'number') return value
  }
  return fallback
}

/**
 * Write the whole buffer. `FileHandle.write` reports how many bytes it took and
 * a single call is not guaranteed to take all of them, so the loop keeps writing
 * until the buffer is exhausted. Stopping early would leave a truncated .docx
 * that opens as a corrupt file.
 */
async function writeEntirely(handle: FileHandle, data: Buffer): Promise<void> {
  let written = 0
  while (written < data.length) {
    const count = writtenCount(await handle.write(data, written), data.length - written)
    if (count <= 0) throw new Error(`the write stalled after ${written} of ${data.length} bytes`)
    written += count
  }
}

/**
 * Create-and-fill a file that must not already exist.
 *
 * If the write fails partway the file this attempt created is removed: a
 * half-written document in the output folder is worse than no document, and the
 * attempt owns the file it created, so deleting it cannot touch anything the user
 * had there before.
 */
async function writeExclusive(path: string, data: Buffer, write: WriteFn): Promise<void> {
  const handle = await open(path, 'wx')
  try {
    await write(handle, data)
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

export async function writeMailMergeOutput(
  dir: string,
  name: string,
  data: Buffer,
  policy: MailMergeOverwritePolicy,
  allocated?: Set<string>,
  resolvePath: PathResolver = (candidate) => join(dir, candidate),
  write: WriteFn = writeEntirely,
  exists: (candidate: string) => boolean = (candidate) => existsSync(join(dir, candidate)),
): Promise<WriteOutcome> {
  // `notes.docx` and `NOTES.docx` are the same file on Windows and on the
  // case-insensitive volumes macOS ships with by default; `Nǫtes.docx` and
  // `notes.docx` can collide once the filesystem normalises the name. Folding
  // every claim the same way (NFC, then case) is conservative: on a
  // case-sensitive filesystem it may rename a pair that could have coexisted,
  // but it can never let one recipient's file erase another's.
  const fold = (candidate: string) => candidate.normalize('NFC').toLowerCase()
  const claimed = new Set<string>()
  for (const entry of allocated ?? []) claimed.add(fold(entry))
  const isTaken = (candidate: string) => claimed.has(fold(candidate)) || exists(candidate)
  const decision = resolveSafeFileName(name, policy, isTaken, claimed, fold)
  if (!decision.name) return { name: '', path: '', skipped: true }
  if (decision.skipped) {
    // the policy said "leave the file that is already there alone" — checked
    // before any write, so nothing is created or touched
    const path = resolvePath(decision.name)
    if (!path) throw new Error(`the output path for ${decision.name} is outside the directory`)
    return { name: decision.name, path, skipped: true }
  }
  // A name this batch already handed to another recipient is not a file the user
  // chose to overwrite or skip: it is that recipient's own output. Claiming the
  // name before writing is what makes two recipients of the same batch
  // collide-safe even when their writes start at the same moment.
  const taken = isTaken
  let candidate = claimed.has(fold(decision.name))
    ? uniqueSafeFileName(decision.name, taken)
    : decision.name
  for (let attempt = 0; attempt < 1000; attempt++) {
    const path = resolvePath(candidate)
    if (!path) throw new Error(`the output path for ${candidate} is outside the directory`)
    claimed.add(fold(candidate))
    allocated?.add(candidate)
    try {
      if (policy === 'overwrite') await atomicWriteFile(path, data)
      else await writeExclusive(path, data, write)
      return { name: candidate, path, skipped: false }
    } catch (err) {
      // the attempt produced nothing, so the claim is released again
      claimed.delete(fold(candidate))
      allocated?.delete(candidate)
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (policy === 'skip') return { name: candidate, path, skipped: true }
      candidate = uniqueSafeFileName(candidate, taken)
    }
  }
  throw new Error(`no free file name for ${name}`)
}
