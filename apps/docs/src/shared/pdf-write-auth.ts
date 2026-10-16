/**
 * Where a PDF export is allowed to write, and under which naming policy.
 *
 * The gate that answers "is this path authorized?" and the writer that opens the
 * file are the same function here. They used to be two rule sets, so a path the
 * gate accepted — the harness directory, for instance — could be refused by the
 * writer a moment later, and a batch would report a failure it never had. One
 * answer means the gate can never approve a target the writer then rejects.
 *
 * The state is injected rather than read from module globals so the rule can be
 * exercised with a torn-down renderer, a symlinked grant and a harness directory
 * without launching Electron.
 */
import { basename } from 'node:path'
import { parseOverwritePolicy } from './mail-merge-ipc'
import type { MailMergeOverwritePolicy } from './mail-merge-names'

export interface PdfAuthContext {
  /** true once the renderer that asked has been closed */
  tornDown: boolean
  /** the directory this renderer picked for a mail-merge batch, if any */
  batchDir: string | null
  /** names this batch has already claimed */
  allocated: Set<string>
  /** the export directory configured for the fidelity harness, if any */
  testExportDir: string | null
  /** a temp PDF this tab staged for an image export */
  isImageTemp: (filePath: string) => boolean
  /** paths a save dialog authorized for this tab */
  allowedPaths: Set<string>
  /** resolve a candidate inside a grant, or null when it escapes it */
  contained: (dir: string, filePath: string) => string | null
}

export interface PdfWriteTarget {
  path: string
  batchDir: string | null
  name: string
  policy: MailMergeOverwritePolicy
  allocated: Set<string>
}

/**
 * A path inside the batch directory goes through the same naming policy as a
 * DOCX batch file: the renderer's name is only a proposal, the collision rule is
 * applied in the writer, and skip/rename writes are exclusive so a file created
 * between choosing the name and writing it is never clobbered. A batch write must
 * state its policy explicitly; an absent or malformed one is refused rather than
 * defaulted to the most destructive option.
 */
export function pdfWriteTarget(
  filePath: unknown,
  overwrite: unknown,
  ctx: PdfAuthContext,
): PdfWriteTarget | null {
  if (ctx.tornDown || typeof filePath !== 'string' || !filePath) return null
  // only PDFs may use the batch grant: the same directory must not become a
  // blanket authorization for Markdown or HTML export targets
  if (ctx.batchDir && /\.pdf$/i.test(filePath)) {
    const inside = ctx.contained(ctx.batchDir, filePath)
    if (inside) {
      const policy = parseOverwritePolicy(overwrite)
      if (!policy) return null
      return {
        path: inside,
        batchDir: ctx.batchDir,
        name: basename(inside),
        policy,
        allocated: ctx.allocated,
      }
    }
  }
  // the fidelity harness has no save dialog, so its configured directory is
  // pre-authorized for PDFs — the same containment rule as every other grant
  if (ctx.testExportDir && /\.pdf$/i.test(filePath)) {
    const harness = ctx.contained(ctx.testExportDir, filePath)
    if (harness) {
      return {
        path: harness,
        batchDir: null,
        name: basename(harness),
        policy: 'overwrite',
        allocated: new Set<string>(),
      }
    }
  }
  if (ctx.isImageTemp(filePath) || ctx.allowedPaths.has(filePath)) {
    return {
      path: filePath,
      batchDir: null,
      name: basename(filePath),
      policy: 'overwrite',
      allocated: new Set<string>(),
    }
  }
  return null
}
