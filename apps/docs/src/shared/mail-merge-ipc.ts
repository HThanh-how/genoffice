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
import { decodeCanonicalBase64 } from './base64-payload'
import { type MailMergeOverwritePolicy } from './mail-merge-names'
import { resolverInsideGrant } from './mail-merge-write'

/** A batch file is one document: anything larger is a mistake or an attack. */
export const MAX_MAIL_MERGE_PAYLOAD_BYTES = 32 * 1024 * 1024

/**
 * A lazily opened template carries its pictures in the source file, so the bytes
 * the renderer sends are slimmed and the file that finally lands on disk is
 * bigger than the payload that described it. Restoring them is bounded by the
 * largest source Mail Merge is allowed to read at all: a merged document cannot
 * legitimately contain more media than the template it came from.
 */
export const MAX_MAIL_MERGE_OUTPUT_BYTES = 64 * 1024 * 1024

export interface MailMergeGrant {
  /** the directory this renderer picked through the dialog */
  dir: string
  /** names this batch has already written or claimed */
  allocated: Set<string>
  /** identity of the batch that holds the grant, minted when the folder is picked */
  batch: string
}

export type MailMergeWriteDecision =
  | {
      ok: true
      dir: string
      name: string
      /** the payload, decoded exactly once by this decision */
      payload: Buffer
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
export type MailMergePayload = { ok: true; bytes: Buffer } | { ok: false; error: string }

/**
 * Decode a payload the renderer sent, or say precisely why it cannot be used.
 *
 * The rules live in `base64-payload.ts` and are the same ones the grouped PDF
 * merge applies to its fragments: one policy, two size limits.
 */
export function inspectMailMergePayload(text: unknown): MailMergePayload {
  return decodeCanonicalBase64(text, MAX_MAIL_MERGE_PAYLOAD_BYTES, 'the file content')
}

/** The decoded payload, or null when it is malformed or oversized. */
export function decodeMailMergePayload(text: unknown): Buffer | null {
  const payload = inspectMailMergePayload(text)
  return payload.ok ? payload.bytes : null
}

/**
 * Byte length of a base64 string, or -1 when it is not a usable payload. The
 * size is measured on the decoded buffer, so the limit and the bytes written
 * always describe the same thing.
 */
export function base64ByteLength(text: string): number {
  if (text === '') return 0
  const payload = inspectMailMergePayload(text)
  return payload.ok ? payload.bytes.length : -1
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
  // the cheap rejections run first, so a request that is refused for its name or
  // its policy never pays for decoding a payload it was never going to write
  const policy = parseOverwritePolicy(overwrite)
  if (!policy)
    return { ok: false, error: 'the overwrite policy is not one of skip, rename, overwrite' }
  const safe = safeFileName(name)
  if (!safe) return { ok: false, error: 'invalid file name' }
  const path = contained(grant.dir, join(grant.dir, safe))
  if (!path) return { ok: false, error: 'output path is outside the chosen directory' }
  const payload = inspectMailMergePayload(base64)
  if (!payload.ok) return { ok: false, error: payload.error }
  return {
    ok: true,
    dir: grant.dir,
    name: safe,
    payload: payload.bytes,
    policy,
    allocated: grant.allocated ?? new Set<string>(),
    resolvePath: resolverInsideGrant(grant.dir, contained),
  }
}
