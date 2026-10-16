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
import {
  buildDocBytes,
  exportPdf,
  currentDocGeneration,
  type FileActionContext,
} from '../file-actions'
import { currentMailMergeValues, setMailMergePreview } from '../editor/mail-merge-preview'
import { mergeFieldValue } from '../editor/merge-doc'
import { exportRecipients } from './recipient-store'
import { initialProgress, terminalStatus } from './progress'
import {
  passthroughFieldInstructions,
  referencedColumnNames,
  templateFieldInstructions,
} from './validation'
import type { MailMergeExportOptions, MailMergeExportProgress, MailMergeSource } from './types'
import type { MergeValues } from '@genoffice/docx-engine'
import { checkMergedDocx } from '../../shared/docx-output-contract'

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
 * What Chromium actually prints is the pagination preview's cloned `.pv-page`
 * sheets, not the editor state. Those sheets are a snapshot of the editor DOM
 * taken when the preview measures (PaginationPreview.tsx), and a recipient's
 * values reach that DOM only through the preview's value widgets — every widget
 * stamped with the generation of the preview that created it
 * (`editor/mail-merge-preview.ts`).
 *
 * A print is therefore safe only when the sheets carry this recipient's stamp.
 * A page count, a layout timestamp or "the preview is open" says nothing about
 * which recipient the cloned sheets hold: two recipients can paginate identically,
 * and a snapshot taken when the preview opened keeps its content however many
 * passes the editor makes afterwards.
 */
function previewSheets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.pv-page')]
}

export function printablePreviewIsCurrent(generation: number, hasMergeFields: boolean): boolean {
  const sheets = previewSheets()
  if (sheets.length === 0) return false
  const stamped = sheets.flatMap((sheet) =>
    [...sheet.querySelectorAll<HTMLElement>('.mm-field-preview-value')],
  )
  // a template with merge fields whose sheets show no value at all is a clone
  // taken before this recipient was put on screen
  if (hasMergeFields && stamped.length === 0) return false
  return stamped.every((el) => el.dataset.mmPreviewKey === String(generation))
}

/** The preview mounted and measured its print sheets. */
export async function waitForPreviewSheets(deadlineMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (previewSheets().length > 0) return true
    await sleep(120)
  }
  return false
}

/**
 * Wait until the cloned print sheets carry `generation`'s recipient. Returns false
 * when they never do: printing then would put the previous recipient's text on
 * paper, so the caller must fail the recipient instead.
 */
export async function waitForPrintablePreview(
  generation: number,
  hasMergeFields: boolean,
  deadlineMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (printablePreviewIsCurrent(generation, hasMergeFields)) return true
    await sleep(120)
  }
  return false
}

/**
 * The file name to write for one recipient under the chosen policy.
 *
 * `taken` is the listing of the destination directory taken before the batch
 * started, so "skip" and "rename" act on files that really existed there.
 * `allocated` is what this batch has already written. The two are kept apart on
 * purpose: a name an earlier recipient of the same batch received is not a file
 * the user chose to skip or overwrite, it is that recipient's own output. So
 * `skip` only ever skips pre-existing files, while every in-batch collision is
 * renamed away from the name already handed to somebody else.
 */
export function resolveOutputName(
  base: string,
  taken: Set<string>,
  policy: MailMergeExportOptions['overwrite'],
  allocated?: Set<string>,
): { name: string; skipped: boolean } {
  if (policy === 'skip' && taken.has(base)) return { name: base, skipped: true }
  if (policy === 'rename') {
    return {
      name: uniqueFileName(base, new Set([...taken, ...(allocated ?? [])])),
      skipped: false,
    }
  }
  if (allocated?.has(base)) {
    return {
      name: uniqueFileName(base, new Set([...taken, ...allocated])),
      skipped: false,
    }
  }
  return { name: base, skipped: false }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * The name the writer actually used. It can differ from the one the renderer
 * asked for: the writer sanitizes, fits the name to the byte limit, and renames
 * a collision that shortening created. Recording the real name is what keeps the
 * batch's own allocations accurate.
 */
function writtenName(result: { path?: string; name?: string }, fallback: string): string {
  const actual = result.name ?? (result.path ? result.path.split(/[\\/]/).pop() : undefined)
  return actual || fallback
}

/**
 * One validation policy for both formats.
 *
 * DOCX gets its report from the save pipeline, which resolves every field in the
 * document tree. A PDF is printed from the DOM, so nothing in the print path
 * checks the fields — the check has to happen here, over the same instructions,
 * before the print job starts. A MERGEFIELD with no column, an IF whose operand
 * names a column the row does not have, or an instruction the merge model cannot
 * parse all fail the recipient: no file is written and the recipient is counted
 * as failed.
 */
function recipientMergeReport(
  editor: Editor,
  values: MergeValues,
): { missing: string[]; unsupported: string[] } {
  const report: MergeReport = { missing: [], unused: [], unsupported: 0, applied: 0 }
  const missing: string[] = []
  const unsupported: string[] = []
  for (const instr of templateFieldInstructions(editor)) {
    // a column the row does not have at all: the field would stay «Name» in the
    // output. An empty cell is not missing — it merges to nothing.
    const absent = referencedColumnNames(instr).filter((name) => !(name in values))
    if (absent.length > 0) {
      missing.push(...absent)
      continue
    }
    const before = report.unsupported
    if (mergeFieldValue(instr, values, report) === null && report.unsupported > before) {
      unsupported.push(instr.trim())
    }
  }
  return { missing: uniqueStrings(missing), unsupported: uniqueStrings(unsupported) }
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

  // Byte-preserved paragraphs are copied verbatim by the save pipeline, so a
  // field inside one cannot be rewritten. That is a known limitation, but it
  // must not be reported as a successful merge: the output would still contain
  // the raw field and its «placeholder».
  const unmergeable = passthroughFieldInstructions(ctx.doc.parsed.blocks)
  // whether the template has any merge field at all: the printable sheets of a
  // template with fields must show this recipient's values, and a sheet that
  // shows none is a clone taken before the recipient was put on screen
  const hasMergeFields = templateFieldInstructions(ctx.editor).length > 0

  const listing = await window.desktop.listMailMergeOutput(options.outputDir, options.batch)
  // Skip/Rename/Overwrite can only be decided from a listing the writer can
  // trust. A failed or truncated listing is not that, so the batch stops rather
  // than guessing which files are already there.
  if (!listing.ok) {
    return failJob(`the output directory could not be read: ${listing.error ?? 'unknown error'}`)
  }
  if (listing.truncated) {
    return failJob(
      `the output directory holds more files than Mail Merge can inspect; choose an emptier directory`,
    )
  }
  // `preExisting` is frozen for the whole batch: the overwrite policy is about
  // files that were in the folder before the batch started. `allocated` is what
  // this batch has actually written. Keeping them apart is what stops a
  // recipient from being "skipped" because an earlier recipient of the same
  // batch happened to get the same name.
  const preExisting = new Set<string>(listing.names ?? [])
  const allocated = new Set<string>()
  // a template-level problem stops the whole batch: the recipients after it were
  // never attempted, so the job must not read as "completed"
  let aborted = false

  // the PDF path needs the pagination preview; if the batch opened it, the batch
  // closes it again so the user's UI is left as it was
  const previewWasOpen = Boolean(document.querySelector('.pagination-preview'))
  const restorePreview = () => {
    if (options.format === 'pdf' && !previewWasOpen) ctx.setShowPagePreview(false)
  }

  if (options.format === 'pdf') {
    // the PDF is printed from the rendered DOM, and the recipient's values reach
    // that DOM only through the preview decorations. A read-only editor refuses
    // those decorations, so printing now would put «Name» on the page for every
    // recipient. Refusing is better than printing placeholders.
    if (!ctx.editor.isEditable) {
      return failJob(
        'the document is open in read mode, so Mail Merge cannot print it; open it in edit mode and try again',
      )
    }
    if (!previewWasOpen) ctx.setShowPagePreview(true)
    // the print sheets are clones of the editor DOM: nothing has been shown yet,
    // so there is no recipient to isolate — but the sheets must exist, or the
    // print would fall back to Chromium auto-paginating the continuous canvas
    if (!(await waitForPreviewSheets(20_000))) {
      restorePreview()
      return failJob('the page layout never settled, so no PDF could be printed')
    }
  }

  // whatever the user had on screen before the batch starts is restored at the
  // end of every recipient, so the editor never ends up showing a stranger's row
  const priorPreview = currentMailMergeValues(ctx.editor.state)
  // the batch belongs to one document. `currentDocGeneration()` is the app's own
  // document identity: it is bumped by `noteDocumentSwapped()` every time a tab
  // loads, creates or reopens a file, which is exactly the event that makes the
  // rows being merged belong to a different document. Comparing the editor and
  // doc object references alone is not enough — the app reuses one Editor
  // instance across document opens, so the same object can hold a different file.
  const jobEditor = ctx.editor
  const jobDoc = ctx.doc
  const jobGeneration = currentDocGeneration()
  const documentMoved = () =>
    ctx.editor !== jobEditor || ctx.doc !== jobDoc || currentDocGeneration() !== jobGeneration

  for (let i = 0; i < recipients.length; i++) {
    if (cancel.cancelled) {
      progress.cancelled = true
      break
    }
    if (documentMoved()) {
      progress.cancelled = true
      progress.errors.push({
        recipient: 'export',
        message: 'the document changed while the batch was running',
      })
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
    const decided = resolveOutputName(base, preExisting, options.overwrite, allocated)
    if (decided.skipped) {
      progress.skipped += 1
      progress.done += 1
      progress.current = decided.name
      onProgress({ ...progress })
      continue
    }
    const name = decided.name
    progress.current = name
    onProgress({ ...progress })

    // one policy for DOCX and PDF: every field the template references has to
    // resolve against this row. An empty cell is fine — it merges to nothing —
    // but a column the row does not have would leave «Name» in the output, and
    // an IF or MERGEFIELD the merge model cannot parse would leave the raw field.
    const report = recipientMergeReport(ctx.editor, recipient.values)
    // every processed recipient publishes progress, including one that produced
    // no file: a batch of failures would otherwise look like a frozen export
    const failRecipient = (message: string) => {
      progress.failed += 1
      progress.errors.push({ recipient: name, message })
      progress.done += 1
      onProgress({ ...progress })
    }
    if (report.missing.length > 0) {
      failRecipient(`missing column(s): ${report.missing.join(', ')}`)
      await sleep(0)
      continue
    }

    if (report.unsupported.length > 0) {
      failRecipient(
        `${report.unsupported.length} field(s) could not be merged (unsupported field form)`,
      )
      await sleep(0)
      continue
    }

    if (unmergeable.length > 0) {
      failRecipient(`field(s) the merge cannot rewrite: ${unmergeable.join(', ')}`)
      await sleep(0)
      continue
    }

    try {
      if (options.format === 'docx') {
        const report: MergeReport = { missing: [], unused: [], unsupported: 0, applied: 0 }
        const bytes = await buildDocBytes(ctx, { values: recipient.values, report })
        if (cancel.cancelled || documentMoved()) {
          // the document was serialized but never written: a cancel that lands
          // mid-serialization must not put a half-batch on disk
          progress.cancelled = true
          break
        }
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
          // the bytes are inspected before a single one of them is stored: a
          // merge field the engine left in a header, footer, footnote or textbox
          // is copied from the template and would print as «Name» in Word
          const contract = await checkMergedDocx(bytes, { media: false })
          if (!contract.ok) {
            progress.failed += 1
            progress.errors.push({
              recipient: name,
              message: contract.error ?? 'output contract failed',
            })
            // a field in a part the pipeline never rewrites is a property of the
            // template, not of this row: every recipient would fail the same way
            if (contract.templateParts.length > 0) {
              progress.errors.push({
                recipient: 'export',
                message: `Mail Merge cannot reach merge fields in ${contract.templateParts.join(', ')}; move them into the document body`,
              })
              progress.done += 1
              aborted = true
              break
            }
            await sleep(0)
            continue
          }
          if (cancel.cancelled || documentMoved()) {
            progress.cancelled = true
            break
          }
          const result = await window.desktop.writeMailMergeFile(
            options.outputDir,
            name,
            bytesToBase64(bytes),
            options.overwrite,
            options.batch,
          )
          if (result.ok) {
            progress.succeeded += 1
            allocated.add(writtenName(result, name))
          } else if (result.skipped) {
            progress.skipped += 1
            allocated.add(writtenName(result, name))
          } else {
            progress.failed += 1
            progress.errors.push({ recipient: name, message: result.error ?? 'write failed' })
          }
        }
      } else {
        // the preview decoration is what makes the printed DOM contain this
        // recipient's values; the template text itself is never modified. The
        // returned generation is the stamp the cloned print sheets must carry
        // before Chromium is allowed to print them.
        const generation = setMailMergePreview(ctx.editor, recipient.values)
        try {
          if (!(await waitForPrintablePreview(generation, hasMergeFields))) {
            progress.failed += 1
            progress.errors.push({
              recipient: name,
              message: 'the printed pages did not update for this recipient',
            })
          } else if (cancel.cancelled || documentMoved()) {
            // the batch stopped while this page layout was being measured: the
            // print never started, so nothing was written
            progress.cancelled = true
            break
          } else {
            // the writer's real outcome, not just "the print did not throw": a
            // skipped destination is not a produced file, and a renamed one is
            // not the name the renderer asked for
            const result = await exportPdf(
              ctx,
              `${options.outputDir}/${name}`,
              options.overwrite,
              options.batch,
            )
            if (result.ok) {
              progress.succeeded += 1
              allocated.add(writtenName(result, name))
            } else if (result.skipped) {
              progress.skipped += 1
              allocated.add(writtenName(result, name))
            } else {
              progress.failed += 1
              progress.errors.push({
                recipient: name,
                message: result.error ?? 'PDF export failed',
              })
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
  restorePreview()
  progress.cancelled = progress.cancelled || cancel.cancelled
  progress.status = aborted ? 'failed' : terminalStatus(progress)
  onProgress({ ...progress })
  return progress
}
