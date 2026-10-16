/**
 * The authorization decision for one mail-merge batch write.
 *
 * Everything a renderer sends to `docs:write-mail-merge-file` is untrusted: the
 * directory string, the file name, the payload and the overwrite policy. Each is
 * checked here, and the target path is resolved *before* any file is opened, so a
 * refused request never touches the filesystem. The writer then re-derives the
 * final name (sanitizing, fitting the byte limit, renaming a collision) and every
 * candidate it produces goes through the same containment resolver.
 *
 * `parseOverwritePolicy` deliberately does not guess: an unknown or missing
 * policy is refused rather than defaulted to the most destructive one.
 */
import { join } from 'node:path'
import { safeFileName } from '@genoffice/docx-engine'
import { type MailMergeOverwritePolicy } from './mail-merge-names'

/** A batch file is one document: anything larger is a mistake or an attack. */
export const MAX_MAIL_MERGE_PAYLOAD_BYTES = 32 * 1024 * 1024

export interface MailMergeGrant {
  /** the directory this renderer picked through the dialog */
  dir: string
  /** names this batch has already written or claimed */
  allocated: Set<string>
}

export type MailMergeWriteDecision =
  | {
      ok: true
      dir: string
      name: string
      policy: MailMergeOverwritePolicy
      allocated: Set<string>
      resolvePath: (candidate: string) => string | null
    }
  | { ok: false; error: string }

export function parseOverwritePolicy(value: unknown): MailMergeOverwritePolicy | null {
  return value === 'skip' || value === 'rename' || value === 'overwrite' ? value : null
}

/**
 * Byte length of a base64 string without decoding it, or -1 when it is not
 * base64 at all. Checking the size before `Buffer.from` keeps an oversized
 * payload from being turned into a Buffer first.
 */
export function base64ByteLength(text: string): number {
  if (text === '') return 0
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return -1
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.floor((text.length * 3) / 4) - padding
}

/** Only the two formats a mail-merge batch can produce. */
export function isMailMergeOutputName(name: string): boolean {
  return /\.(docx|pdf)$/.test(safeFileName(name))
}

export function decideMailMergeWrite(
  grant: MailMergeGrant | undefined,
  dir: unknown,
  name: unknown,
  base64: unknown,
  overwrite: unknown,
  contained: (dir: string, path: string) => string | null,
): MailMergeWriteDecision {
  if (!grant || typeof grant.dir !== 'string') {
    return { ok: false, error: 'output directory is not authorized' }
  }
  if (typeof dir !== 'string' || dir !== grant.dir) {
    return { ok: false, error: 'output directory is not authorized' }
  }
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'invalid file name' }
  }
  if (!isMailMergeOutputName(name)) {
    return { ok: false, error: 'only .docx or .pdf files can be written to a merge folder' }
  }
  if (typeof base64 !== 'string' || base64.length === 0) {
    return { ok: false, error: 'the file content is empty' }
  }
  const bytes = base64ByteLength(base64)
  if (bytes < 0) return { ok: false, error: 'the file content is not valid base64' }
  if (bytes > MAX_MAIL_MERGE_PAYLOAD_BYTES) {
    return { ok: false, error: 'the file content is larger than a merge document can be' }
  }
  const policy = parseOverwritePolicy(overwrite)
  if (!policy)
    return { ok: false, error: 'the overwrite policy is not one of skip, rename, overwrite' }
  const safe = safeFileName(name)
  if (!safe) return { ok: false, error: 'invalid file name' }
  const path = contained(grant.dir, join(grant.dir, safe))
  if (!path) return { ok: false, error: 'output path is outside the chosen directory' }
  return {
    ok: true,
    dir: grant.dir,
    name: safe,
    policy,
    allocated: grant.allocated ?? new Set<string>(),
    resolvePath: (candidate) => contained(grant.dir, join(grant.dir, candidate)),
  }
}
