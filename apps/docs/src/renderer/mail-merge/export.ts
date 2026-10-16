/**
 * Batch export: one document per recipient, written to a directory the user
 * picked. DOCX output goes through the app's own save pipeline (PM doc →
 * save plan → saveDocx), and PDF output through the app's own PDF export
 * (pagination preview → Chromium printToPDF). Nothing here re-implements
 * either, so a merged file is byte-for-byte what saving that document would
 * produce.
 *
 * Two rules the pipeline must not break:
 *   1. A recipient whose merge fields cannot be resolved produces no file.
 *      Writing «Name» into a hundred documents is worse than writing none.
 *   2. The overwrite policy the user chose is honoured — the file name is only
 *      made unique when the policy says "rename".
 *
 * Recipients are processed one at a time: the renderer is single-threaded and
 * each document is released as soon as it is written, so a 10,000-row source
 * does not accumulate 10,000 buffers.
 */
import type { Editor } from '@tiptap/core'
import { buildOutputFileName, uniqueFileName, type MergeReport } from '@genoffice/docx-engine'
import { buildDocBytes, exportPdf, type FileActionContext } from '../file-actions'
import { currentMailMergeValues, setMailMergePreview } from '../editor/mail-merge-preview'
import { exportRecipients } from './recipient-store'
import { initialProgress, terminalStatus } from './progress'
import {
  passthroughFieldInstructions,
  requiredMergeFields,
} from './validation'
import type {
  MailMergeExportOptions,
  MailMergeExportProgress,
  MailMergeSource,
} from './types'

export interface CancelToken {
  cancelled: boolean
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The editor publishes its pagination state on `window.__pageDebug` (App.tsx):
 * the slice list plus `rev`, the number of layout passes that have committed.
 * `rev` is the only signal that says "the pages were measured *after* this
 * recipient's values went on screen" — a slice count can be identical for two
 * recipients, so counting pages alone cannot tell a fresh layout from a stale
 * one.
 */
function layoutState(): { rev: number; pages: number } {
  const debug = (window as unknown as { __pageDebug?: { rev?: number; slices?: unknown[] } })
    .__pageDebug
  return { rev: debug?.rev ?? 0, pages: Array.isArray(debug?.slices) ? debug.slices.length : 0 }
}

/**
 * Wait for a pagination pass that ran after `sinceRev` and whose page count has
 * stopped moving. Returns false when the layout never settled: the caller must
 * not print a page layout that predates the recipient.
 */
export async function waitForPagination(
  editor: Editor,
  sinceRev: number,
  deadlineMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  let lastPages = -1
  let stable = 0
  while (Date.now() < deadline) {
    const { rev, pages } = layoutState()
    if (rev > sinceRev && pages >= 1) {
      stable = pages === lastPages ? stable + 1 : 0
      lastPages = pages
      if (stable >= 2) return true
    }
    await sleep(120)
  }
  return false
}

/**
 * The file name to write for one recipient under the chosen policy.
 * `taken` is the listing of the destination directory, so "skip" and "rename"
 * act on files that really exist there.
 */
export function resolveOutputName(
  base: string,
  taken: Set<string>,
  policy: MailMergeExportOptions['overwrite'],
): { name: string; skipped: boolean } {
  if (policy === 'skip' && taken.has(base)) return { name: base, skipped: true }
  if (policy === 'rename') return { name: uniqueFileName(base, taken), skipped: false }
  return { name: base, skipped: false }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export async function runMailMergeExport(
  ctx: FileActionContext,
  source: MailMergeSource,
  options: MailMergeExportOptions,
  cancel: CancelToken,
  onProgress: (progress: MailMergeExportProgress) => void,
): Promise<MailMergeExportProgress> {
  const recipients = exportRecipients(source, options.scope)
  const progress: MailMergeExportProgress = initialProgress(recipients.length)
  const failJob = (message: string): MailMergeExportProgress => {
    progress.failed += 1
    progress.errors.push({ recipient: 'export', message })
    progress.status = 'failed'
    onProgress({ ...progress })
    return progress
  }
  if (recipients.length === 0) {
    progress.status = 'completed'
    return progress
  }
  if (!ctx.editor || !ctx.doc) return failJob('the document is not open')

  // every field the template references, from the editor tree and from the
  // byte-preserved blocks the editor cannot model
  const required = requiredMergeFields(ctx.editor, ctx.doc.parsed.blocks)
  // Byte-preserved paragraphs are copied verbatim by the save pipeline, so a
  // field inside one cannot be rewritten. That is a known limitation, but it
  // must not be reported as a successful merge: the output would still contain
  // the raw field and its «placeholder».
  const unmergeable = passthroughFieldInstructions(ctx.doc.parsed.blocks)

  const listing = await window.desktop.listMailMergeOutput(options.outputDir)
  const taken = new Set<string>(listing.ok ? listing.names ?? [] : [])

  if (options.format === 'pdf') {
    if (!document.querySelector('.pagination-preview')) ctx.setShowPagePreview(true)
    await waitForPagination(ctx.editor, layoutState().rev)
  }

  // whatever the user had on screen before the batch starts is restored at the
  // end of every recipient, so the editor never ends up showing a stranger's row
  const priorPreview = currentMailMergeValues(ctx.editor.state)

  for (let i = 0; i < recipients.length; i++) {
    if (cancel.cancelled) {
      progress.cancelled = true
      break
    }
    const recipient = recipients[i]
    const base = buildOutputFileName({
      pattern: options.pattern,
      index: i + 1,
      total: recipients.length,
      values: recipient.values,
      extension: options.format,
    })
    const resolved = resolveOutputName(base, taken, options.overwrite)
    if (resolved.skipped) {
      progress.skipped += 1
      progress.done += 1
      progress.current = resolved.name
      onProgress({ ...progress })
      continue
    }
    const name = resolved.name
    taken.add(name)
    progress.current = name
    onProgress({ ...progress })

    // a column the row does not have at all is a hard error: the field would
    // stay «Name» in the output. An empty cell is not — it merges to nothing.
    const missingColumns = required.filter((field) => !(field in recipient.values))
    if (missingColumns.length > 0) {
      progress.failed += 1
      progress.errors.push({
        recipient: name,
        message: `missing column(s): ${missingColumns.join(', ')}`,
      })
      progress.done += 1
      continue
    }

    if (unmergeable.length > 0) {
      progress.failed += 1
      progress.errors.push({
        recipient: name,
        message: `field(s) the merge cannot rewrite: ${unmergeable.join(', ')}`,
      })
      progress.done += 1
      continue
    }

    try {
      if (options.format === 'docx') {
        const report: MergeReport = { missing: [], unused: [], unsupported: 0, applied: 0 }
        const bytes = await buildDocBytes(ctx, { values: recipient.values, report })
        if (!bytes) {
          progress.failed += 1
          progress.errors.push({ recipient: name, message: 'the document could not be serialized' })
        } else if (report.missing.length > 0) {
          progress.failed += 1
          progress.errors.push({
            recipient: name,
            message: `unresolved merge field(s): ${uniqueStrings(report.missing).join(', ')}`,
          })
        } else if (report.unsupported > 0) {
          progress.failed += 1
          progress.errors.push({
            recipient: name,
            message: `${report.unsupported} field(s) could not be merged (unsupported field form)`,
          })
        } else {
          const result = await window.desktop.writeMailMergeFile(
            options.outputDir,
            name,
            bytesToBase64(bytes),
            options.overwrite,
          )
          if (result.ok) progress.succeeded += 1
          else if (result.skipped) progress.skipped += 1
          else {
            progress.failed += 1
            progress.errors.push({ recipient: name, message: result.error ?? 'write failed' })
          }
        }
      } else {
        // the preview decoration is what makes the printed DOM contain this
        // recipient's values; the template text itself is never modified
        const revBefore = layoutState().rev
        setMailMergePreview(ctx.editor, recipient.values)
        try {
          if (!(await waitForPagination(ctx.editor, revBefore))) {
            progress.failed += 1
            progress.errors.push({
              recipient: name,
              message: 'the page layout did not settle for this recipient',
            })
          } else {
            const ok = await exportPdf(ctx, `${options.outputDir}/${name}`)
            if (ok) progress.succeeded += 1
            else {
              progress.failed += 1
              progress.errors.push({ recipient: name, message: 'PDF export failed' })
            }
          }
        } finally {
          setMailMergePreview(ctx.editor, priorPreview)
        }
      }
    } catch (error) {
      progress.failed += 1
      progress.errors.push({ recipient: name, message: String(error) })
    }
    progress.done += 1
    onProgress({ ...progress })
    // yield so the progress dialog and the editor stay responsive
    await sleep(0)
  }

  // the last recipient's values must not stay on screen after the batch
  setMailMergePreview(ctx.editor, priorPreview)
  progress.cancelled = progress.cancelled || cancel.cancelled
  progress.status = terminalStatus(progress)
  onProgress({ ...progress })
  return progress
}
