/**
 * Batch export: one document per recipient, written to a directory the user
 * picked. DOCX output goes through the app's own save pipeline (PM doc →
 * save plan → saveDocx), and PDF output through the app's own PDF export
 * (pagination preview → Chromium printToPDF). Nothing here re-implements
 * either, so a merged file is byte-for-byte what saving that document would
 * produce.
 *
 * Recipients are processed one at a time: the renderer is single-threaded and
 * each document is released as soon as it is written, so a 10,000-row source
 * does not accumulate 10,000 buffers.
 */
import type { Editor } from '@tiptap/core'
import { buildOutputFileName, uniqueFileName, type MergeReport } from '@genoffice/docx-engine'
import { buildDocBytes, exportPdf, type FileActionContext } from '../file-actions'
import { setMailMergePreview } from '../editor/mail-merge-preview'
import { exportRecipients } from './recipient-store'
import type { MailMergeExportOptions, MailMergeExportProgress, MailMergeSource } from './types'

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

/** Pagination is only trustworthy when the slice count has stopped changing. */
async function waitForPagination(editor: Editor, deadlineMs = 20_000): Promise<void> {
  const debug = window as unknown as { __pageDebug?: { slices?: unknown[] } }
  const deadline = Date.now() + deadlineMs
  let last = -1
  let stable = 0
  while (Date.now() < deadline) {
    const count = debug.__pageDebug?.slices?.length ?? 0
    if (count >= 1) {
      stable = count === last ? stable + 1 : 0
      last = count
      if (stable >= 2) return
    }
    await sleep(150)
  }
}

export async function runMailMergeExport(
  ctx: FileActionContext,
  source: MailMergeSource,
  options: MailMergeExportOptions,
  cancel: CancelToken,
  onProgress: (progress: MailMergeExportProgress) => void,
): Promise<MailMergeExportProgress> {
  const recipients = exportRecipients(source, options.scope)
  const progress: MailMergeExportProgress = {
    total: recipients.length,
    done: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    current: '',
    errors: [],
    cancelled: false,
  }
  if (recipients.length === 0 || !ctx.editor || !ctx.doc) return progress

  const listing = await window.desktop.listMailMergeOutput(options.outputDir)
  const taken = new Set<string>(listing.ok ? listing.names ?? [] : [])

  if (options.format === 'pdf') {
    if (!document.querySelector('.pagination-preview')) ctx.setShowPagePreview(true)
    await waitForPagination(ctx.editor)
  }

  for (let i = 0; i < recipients.length; i++) {
    if (cancel.cancelled) {
      progress.cancelled = true
      break
    }
    const recipient = recipients[i]
    const name = uniqueFileName(
      buildOutputFileName({
        pattern: options.pattern,
        index: i + 1,
        total: recipients.length,
        values: recipient.values,
        extension: options.format,
      }),
      taken,
    )
    taken.add(name)
    progress.current = name
    onProgress({ ...progress })

    try {
      if (options.format === 'docx') {
        const report: MergeReport = { missing: [], unused: [], unsupported: 0, applied: 0 }
        const bytes = await buildDocBytes(ctx, { values: recipient.values, report })
        if (!bytes) {
          progress.failed += 1
          progress.errors.push({ recipient: name, message: 'the document could not be serialized' })
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
        setMailMergePreview(ctx.editor, recipient.values)
        await waitForPagination(ctx.editor)
        const ok = await exportPdf(ctx, `${options.outputDir}/${name}`)
        setMailMergePreview(ctx.editor, null)
        if (ok) progress.succeeded += 1
        else {
          progress.failed += 1
          progress.errors.push({ recipient: name, message: 'PDF export failed' })
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

  if (options.format === 'pdf') setMailMergePreview(ctx.editor, null)
  return progress
}
