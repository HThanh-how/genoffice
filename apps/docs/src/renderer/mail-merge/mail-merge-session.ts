/**
 * Mail-merge session state for the Docs renderer.
 *
 * The session holds a *snapshot* of the recipient data: it is taken when the
 * picker is confirmed and never changes implicitly. Re-running the picker is
 * the only way to refresh it, so a 1,000-document export can never be
 * interrupted by a spreadsheet edit halfway through.
 */
import { useCallback, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { mergePlaceholder } from '@genoffice/docx-engine'
import type { FileActionContext } from '../file-actions'
import { setMailMergeHighlight, setMailMergePreview } from '../editor/mail-merge-preview'
import { runMailMergeExport, type CancelToken } from './export'
import { selectedCount } from './recipient-store'
import { templateMergeFields, validateMergeSession } from './validation'
import type {
  MailMergeExportOptions,
  MailMergeExportProgress,
  MailMergeSource,
  MailMergeSourceKind,
  MailMergeValidationIssue,
} from './types'

export type MailMergeDialog = 'picker' | 'export' | 'validate' | 'progress' | null

export interface MailMergeSession {
  source: MailMergeSource | null
  dialog: MailMergeDialog
  previewOn: boolean
  previewIndex: number
  highlight: boolean
  preferredKind?: MailMergeSourceKind
  progress: MailMergeExportProgress | null
  issues: MailMergeValidationIssue[]
  openPicker: (kind?: MailMergeSourceKind) => void
  openExport: (format: 'docx' | 'pdf') => void
  pendingFormat: 'docx' | 'pdf'
  applySource: (source: MailMergeSource) => void
  closeDialog: () => void
  togglePreview: (on: boolean) => void
  stepPreview: (delta: number) => void
  toggleHighlight: (on: boolean) => void
  insertField: (name: string) => void
  checkErrors: () => void
  startExport: (options: MailMergeExportOptions) => void
  cancelExport: () => void
  exportRunning: boolean
}

export function useMailMergeSession(
  editor: Editor | null,
  getCtx: () => FileActionContext,
): MailMergeSession {
  const [source, setSource] = useState<MailMergeSource | null>(null)
  const [dialog, setDialog] = useState<MailMergeDialog>(null)
  const [preferredKind, setPreferredKind] = useState<MailMergeSourceKind | undefined>(undefined)
  const [previewOn, setPreviewOn] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [highlight, setHighlight] = useState(false)
  const [progress, setProgress] = useState<MailMergeExportProgress | null>(null)
  const [issues, setIssues] = useState<MailMergeValidationIssue[]>([])
  const [running, setRunning] = useState(false)
  const cancelRef = useRef<CancelToken>({ cancelled: false })
  const runningRef = useRef(false)
  const [pendingFormat, setPendingFormat] = useState<'docx' | 'pdf'>('docx')

  const selectedRecipients = useCallback(
    (src: MailMergeSource | null) => (src ? src.recipients.filter((r) => r.selected) : []),
    [],
  )

  const showPreview = useCallback(
    (src: MailMergeSource | null, index: number) => {
      if (!editor) return
      const list = selectedRecipients(src)
      if (list.length === 0) {
        setMailMergePreview(editor, null)
        return
      }
      const clamped = Math.min(Math.max(index, 0), list.length - 1)
      setPreviewIndex(clamped)
      // dispatching the plugin meta is O(fields in the document); navigating
      // quickly just replaces the decoration set, it never touches the doc
      setMailMergePreview(editor, list[clamped].values)
    },
    [editor, selectedRecipients],
  )

  const applySource = useCallback(
    (next: MailMergeSource) => {
      setSource(next)
      setPreviewIndex(0)
      if (previewOn) showPreview(next, 0)
      setDialog(null)
    },
    [previewOn, showPreview],
  )

  return {
    source,
    dialog,
    preferredKind,
    previewOn,
    previewIndex,
    highlight,
    progress,
    issues,
    exportRunning: running,
    pendingFormat,

    openPicker: (kind) => {
      if (!editor) return
      setPreferredKind(kind)
      setDialog('picker')
    },

    openExport: (format) => {
      if (!source) return
      setPendingFormat(format)
      setDialog('export')
    },

    applySource,

    closeDialog: () => setDialog(null),

    togglePreview: (on) => {
      setPreviewOn(on)
      if (on) showPreview(source, previewIndex)
      else if (editor) setMailMergePreview(editor, null)
    },

    stepPreview: (delta) => {
      if (!previewOn) return
      showPreview(source, previewIndex + delta)
    },

    toggleHighlight: (on) => {
      setHighlight(on)
      if (editor) setMailMergeHighlight(editor, on)
    },

    insertField: (name) => {
      if (!editor) return
      // Word inserts the field as a real MERGEFIELD, not as literal «text»:
      // the run carries the instrField mark, so the engine round-trips it to
      // <w:fldChar>…MERGEFIELD… and preview/export can resolve it.
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: mergePlaceholder(name),
          marks: [{ type: 'instrField', attrs: { instr: `MERGEFIELD ${name}` } }],
        })
        .run()
    },

    checkErrors: () => {
      if (!editor) return
      const blocks = getCtx().doc?.parsed.blocks ?? []
      setIssues(validateMergeSession(source, templateMergeFields(editor), blocks))
      setDialog('validate')
    },

    startExport: (options) => {
      if (runningRef.current || !source) return
      runningRef.current = true
      setRunning(true)
      cancelRef.current = { cancelled: false }
      setProgress({
        total: selectedCount(source),
        done: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        current: '',
        errors: [],
        cancelled: false,
      })
      setDialog('progress')
      void runMailMergeExport(getCtx(), source, options, cancelRef.current, (p) => setProgress(p))
        .then((final) => setProgress(final))
        .catch((error) =>
          setProgress((prev) => ({
            ...(prev ?? {
              total: 0,
              done: 0,
              succeeded: 0,
              failed: 0,
              skipped: 0,
              current: '',
              errors: [],
              cancelled: false,
            }),
            failed: (prev?.failed ?? 0) + 1,
            errors: [...(prev?.errors ?? []), { recipient: 'export', message: String(error) }],
          })),
        )
        .finally(() => {
          runningRef.current = false
          setRunning(false)
        })
    },

    cancelExport: () => {
      cancelRef.current.cancelled = true
    },
  }
}
