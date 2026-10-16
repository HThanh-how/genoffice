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
 * `Buffer.from(text, 'base64')` is forgiving: it ignores characters outside the
 * alphabet, accepts padding in the middle, and silently discards the leftover
 * bits of a non-canonical last group. A length computed from the string's
 * character count therefore disagrees with the bytes actually written — "A"
 * decodes to one byte, "AAAA=" to three, "A===" to one. The writer's size limit
 * and the file on disk must describe the same buffer, so the payload is decoded
 * first and only then measured, and anything that does not round-trip is refused.
 *
 * The encoded length is checked *before* `Buffer.from`: a gigabyte of base64 is
 * rejected on its character count, so refusing an oversized payload never
 * allocates the gigabyte Buffer it would have produced.
 */
export function inspectMailMergePayload(text: unknown): MailMergePayload {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: 'the file content is empty' }
  }
  // 32 MiB decoded needs exactly 4 * ceil(32MiB / 3) characters encoded; the
  // ceiling has to be taken on the group count, not on the product, or a
  // payload sitting exactly at the limit is rejected
  const maxEncodedChars = 4 * Math.ceil(MAX_MAIL_MERGE_PAYLOAD_BYTES / 3)
  if (text.length > maxEncodedChars) {
    return { ok: false, error: 'the file content is larger than a merge document can be' }
  }
  // canonical base64 comes in whole groups of four, with at most two '=' at the end
  if (text.length % 4 !== 0) return { ok: false, error: 'the file content is not valid base64' }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return { ok: false, error: 'the file content is not valid base64' }
  }
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === 0) return { ok: false, error: 'the file content is empty' }
  if (decoded.length > MAX_MAIL_MERGE_PAYLOAD_BYTES) {
    return { ok: false, error: 'the file content is larger than a merge document can be' }
  }
  // stray padding or a last group with unused bits decodes to something the
  // sender did not mean to send
  if (Buffer.from(decoded).toString('base64') !== text) {
    return { ok: false, error: 'the file content is not valid base64' }
  }
  return { ok: true, bytes: decoded }
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
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'invalid file name' }
  }
  if (!isMailMergeOutputName(name)) {
    return { ok: false, error: 'only .docx or .pdf files can be written to a merge folder' }
  }
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
    resolvePath: (candidate) => contained(grant.dir, join(grant.dir, candidate)),
  }
}
