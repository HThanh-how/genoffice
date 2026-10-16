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
import type { FileActionContext } from '../file-actions'
import { insertMergeField } from '../editor/merge-doc'
import { setMailMergeHighlight, setMailMergePreview } from '../editor/mail-merge-preview'
import { runMailMergeExport, type CancelToken } from './export'
import { initialProgress, applyJobFailure } from './progress'
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

    /**
     * Closing the progress dialog while a batch is still running does not hide
     * it: it asks the job to stop, and the dialog stays open until the job
     * reaches a terminal state, so the user can read the result.
     */
    closeDialog: () => {
      if (dialog === 'progress' && runningRef.current) {
        cancelRef.current.cancelled = true
        return
      }
      setDialog(null)
    },

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
      // Word inserts the field as a real MERGEFIELD, not as literal «text».
      // insertMergeField quotes multi-word column names, so "Postal Address"
      // round-trips as one field instead of merging the column "Postal".
      insertMergeField(editor, name)
    },

    checkErrors: () => {
      if (!editor) return
      const blocks = getCtx().doc?.parsed.blocks ?? []
      setIssues(validateMergeSession(source, templateMergeFields(editor), blocks))
      setDialog('validate')
    },

    startExport: (options) => {
      if (runningRef.current || !source || !editor) return
      // Preflight: a template that references a column the source does not have
      // would write «Name» into every output file. Word refuses to merge in that
      // situation, and so does GenOffice — the user gets the error list instead
      // of a folder of broken documents.
      const blocks = getCtx().doc?.parsed.blocks ?? []
      const issues = validateMergeSession(source, templateMergeFields(editor), blocks)
      const blocking = issues.filter((issue) => issue.severity === 'error')
      if (blocking.length > 0) {
        setIssues(blocking)
        setDialog('validate')
        return
      }
      runningRef.current = true
      setRunning(true)
      cancelRef.current = { cancelled: false }
      const base = initialProgress(selectedCount(source))
      setProgress(base)
      setDialog('progress')
      void runMailMergeExport(getCtx(), source, options, cancelRef.current, (p) => setProgress(p))
        .catch((error) =>
          // the job died before it could report a terminal state: say so, rather
          // than leaving the dialog showing an export that never finishes
          setProgress((prev) => applyJobFailure(prev, base, String(error))),
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
