/**
 * The grouped PDF export's commit pipeline.
 *
 * "Finish & Merge → PDF" prints the document group by group (one Chromium print
 * job per paper size or per chunk of pages) and merges the fragments here. The
 * merge is a chain of awaits: pdf-lib is imported, every fragment is parsed,
 * pages are copied, and the result is serialised. A mail-merge batch that is
 * cancelled, or a folder that is re-picked, while that chain runs has released
 * its grant — and a file committed afterwards would land in a directory the tab
 * no longer owns.
 *
 * So the pipeline is: bound the untrusted fragments, assemble, re-check that the
 * batch which authorized the target is still the live one, then write. Once a
 * file has been committed it is never undone: the batch owns only the file it
 * created, and deleting it on a later cancellation would destroy a document the
 * user asked for.
 *
 * `assemble` is injected so the re-check can be exercised with a pause in the
 * middle of the merge without launching Electron.
 */
import { basename } from 'node:path'
import type { PdfInternalLink } from './ipc'
import { writeMailMergeOutput, type PathResolver } from './mail-merge-write'
import type { PdfWriteTarget } from './pdf-write-auth'

/** One print job per group; the renderer chunks at 10 pages, so a few hundred
 *  groups is already a document of thousands of pages. Beyond that the request
 *  is not a document but a flood. */
export const MAX_PDF_PARTS = 512
/** A single printed group's PDF, before it is merged. */
export const MAX_PDF_PART_BYTES = 16 * 1024 * 1024
/** The whole merged document, summed across fragments. */
export const MAX_PDF_TOTAL_BYTES = 256 * 1024 * 1024
/** Internal links are one annotation per in-document link; a document with more
 *  than this is not a document the print path can have produced. */
export const MAX_PDF_LINKS = 20_000

export type PdfPartsDecision =
  { ok: true; parts: Buffer[]; links: PdfInternalLink[] } | { ok: false; error: string }

/**
 * Bound the renderer-supplied fragments before a single byte is allocated.
 *
 * `Buffer.from(text, 'base64')` decodes whatever it can and never throws, so a
 * size ceiling has to be applied to the encoded string first: an attacker cannot
 * smuggle a gigabyte past a check that runs after the decode.
 */
export function validatePdfMergeParts(parts: unknown, links: unknown): PdfPartsDecision {
  if (!Array.isArray(parts)) return { ok: false, error: 'the PDF fragments are not a list' }
  if (parts.length === 0) return { ok: false, error: 'there are no PDF pages to merge' }
  if (parts.length > MAX_PDF_PARTS) {
    return {
      ok: false,
      error: `the document printed ${parts.length} fragments; an export merges at most ${MAX_PDF_PARTS}`,
    }
  }
  const maxEncodedChars = 4 * Math.ceil(MAX_PDF_PART_BYTES / 3)
  const decoded: Buffer[] = []
  let total = 0
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0) {
      return { ok: false, error: 'a PDF fragment is not printable data' }
    }
    if (part.length > maxEncodedChars) {
      return { ok: false, error: 'a PDF fragment is larger than a printed page can be' }
    }
    const bytes = Buffer.from(part, 'base64')
    if (bytes.length === 0) return { ok: false, error: 'a PDF fragment is empty' }
    if (bytes.length > MAX_PDF_PART_BYTES) {
      return { ok: false, error: 'a PDF fragment is larger than a printed page can be' }
    }
    total += bytes.length
    if (total > MAX_PDF_TOTAL_BYTES) {
      return { ok: false, error: 'the printed document is larger than an export can be' }
    }
    decoded.push(bytes)
  }
  const linkList = Array.isArray(links)
    ? links.filter(
        (link) =>
          link !== null &&
          typeof link === 'object' &&
          Number.isFinite((link as PdfInternalLink).page) &&
          Number.isFinite((link as PdfInternalLink).toPage),
      )
    : []
  if (linkList.length > MAX_PDF_LINKS) {
    return { ok: false, error: 'the document has more internal links than an export can carry' }
  }
  return { ok: true, parts: decoded, links: linkList }
}

export interface PdfCommitResult {
  ok: boolean
  path?: string
  name?: string
  error?: string
  skipped?: boolean
}

export interface PdfCommitOptions {
  /** is the batch that authorized this target still the batch the tab holds? */
  batchStillLive: () => boolean
  /**
   * Resolve a candidate file name to the path the write would use, or null when
   * it would leave the authorized directory. The writer renames a colliding name
   * on its own, so every name it might open — the one proposed and every
   * collision variant — has to pass through this resolver. Without it the writer
   * falls back to joining the name onto the directory, which is a weaker rule than
   * the one the DOCX batch path applies to the identical operation.
   */
  resolvePath: PathResolver
  /** write a non-batch target (save-dialog path, image-export temp) */
  writeDirect: (path: string, data: Buffer) => Promise<void>
  /** was this path staged by "Export as Images" rather than chosen by the user? */
  isImageTemp: (path: string) => boolean
  /** reveal a finished export the way a normal PDF export is revealed */
  openGenerated: (path: string) => void
}

export interface PdfMergeCommitOptions extends PdfCommitOptions {
  /** parse the fragments and join them into one PDF; the awaited boundary */
  assemble: (parts: Buffer[], links: PdfInternalLink[]) => Promise<Buffer>
}

/**
 * Commit one finished PDF to an already-authorized target.
 *
 * Both PDF paths — the single print and the grouped merge — end here, so they
 * share the same two guarantees: the batch must still be live at the moment of
 * the commit, and every candidate name the writer could open must resolve inside
 * the granted directory.
 */
export async function commitPdfOutput(
  target: PdfWriteTarget,
  data: Buffer,
  options: PdfCommitOptions,
): Promise<PdfCommitResult> {
  // The work before this point crossed several awaits. A batch cancelled during
  // it has released its grant, and a batch that picked the same folder afterwards
  // has a different id; re-checking the identity rather than the directory string
  // is what stops a cancelled batch's PDF from landing in a folder the tab no
  // longer holds.
  if (target.batchDir && !options.batchStillLive()) {
    return { ok: false, error: 'output directory is no longer authorized' }
  }
  try {
    if (target.batchDir) {
      // the writer is the authority on the final name and on skip/rename/overwrite
      const outcome = await writeMailMergeOutput(
        target.batchDir,
        target.name,
        data,
        target.policy,
        target.allocated,
        options.resolvePath,
      )
      if (outcome.skipped)
        return { ok: false, skipped: true, path: outcome.path, name: outcome.name }
      return { ok: true, path: outcome.path, name: outcome.name }
    }
    await options.writeDirect(target.path, data)
    if (!options.isImageTemp(target.path)) options.openGenerated(target.path)
    return { ok: true, path: target.path, name: basename(target.path) }
  } catch (error) {
    return { ok: false, error: String(error), path: target.path }
  }
}

export async function commitMergedPdf(
  target: PdfWriteTarget,
  parts: Buffer[],
  links: PdfInternalLink[],
  options: PdfMergeCommitOptions,
): Promise<PdfCommitResult> {
  let data: Buffer
  try {
    data = await options.assemble(parts, links)
  } catch (error) {
    return { ok: false, error: String(error), path: target.path }
  }
  return commitPdfOutput(target, data, options)
}
