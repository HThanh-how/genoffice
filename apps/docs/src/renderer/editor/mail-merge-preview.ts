/**
 * Live mail-merge preview.
 *
 * Preview is a display-time decoration, exactly like Word's Toggle Field Codes
 * (see field-codes.ts): the template's text is never rewritten, so turning
 * preview off restores the «Name» placeholders, undo history is untouched, and
 * saving the template still writes the original MERGEFIELD runs.
 *
 * Each merge field gets an inline decoration (highlight, or hide the
 * placeholder) and a widget decoration that inserts the recipient's value in
 * its place. The pagination preview measures the DOM, so page breaks follow the
 * merged text.
 */
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { isConditionalField, isMergeField } from '@genoffice/docx-engine'
import { collectFields } from './field-codes'
import { mergeFieldValue, type MergeReport, type MergeValues } from './merge-doc'

export interface MailMergePreviewState {
  /** the recipient whose values are on screen, or null when preview is off */
  values: MergeValues | null
  /** outline every merge field so the author can see where they sit */
  highlight: boolean
  decos: DecorationSet
}

type PreviewMeta = { values?: MergeValues | null; highlight?: boolean }

export const mailMergePreviewKey = new PluginKey<MailMergePreviewState>('mailMergePreview')

/** merge/IF fields only — PAGE, DATE, REF… are not recipient data */
function mergeFields(doc: PmNode) {
  return collectFields(doc).filter((f) => isMergeField(f.instr) || isConditionalField(f.instr))
}

function buildDecorations(
  doc: PmNode,
  values: MergeValues | null,
  highlight: boolean,
): DecorationSet {
  const decos: Decoration[] = []
  for (const field of mergeFields(doc)) {
    if (highlight)
      decos.push(Decoration.inline(field.from, field.to, { class: 'mm-field-highlight' }))
    if (!values) continue
    const report: MergeReport = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const value = mergeFieldValue(field.instr, values, report)
    if (value === null) continue
    // the placeholder is hidden (font-size: 0) and the value is inserted beside it
    decos.push(Decoration.inline(field.from, field.to, { class: 'mm-field-preview-src' }))
    decos.push(
      Decoration.widget(
        field.from,
        () => {
          const el = document.createElement('span')
          el.className = 'mm-field-preview-value'
          el.textContent = value
          return el
        },
        { side: -1, key: `mm:${field.from}:${value}` },
      ),
    )
  }
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty
}

function applyState(tr: Transaction, old: MailMergePreviewState): MailMergePreviewState {
  const meta = tr.getMeta(mailMergePreviewKey) as PreviewMeta | undefined
  let values = old.values
  let highlight = old.highlight
  if (meta) {
    if ('values' in meta) values = meta.values ?? null
    if ('highlight' in meta) highlight = Boolean(meta.highlight)
  }
  if (!meta && !tr.docChanged) return old
  if (!values && !highlight) return { values: null, highlight: false, decos: DecorationSet.empty }
  return { values, highlight, decos: buildDecorations(tr.doc, values, highlight) }
}

/** Set (or clear) the recipient whose values the editor should show. */
export function setMailMergePreview(editor: Editor, values: MergeValues | null): void {
  if (!editor.isEditable) return
  editor.view.dispatch(editor.state.tr.setMeta(mailMergePreviewKey, { values }))
}

export function setMailMergeHighlight(editor: Editor, on: boolean): void {
  if (!editor.isEditable) return
  editor.view.dispatch(editor.state.tr.setMeta(mailMergePreviewKey, { highlight: on }))
}

export function mailMergePreviewActive(state: EditorState): boolean {
  const s = mailMergePreviewKey.getState(state)
  return !!s?.values
}

export function currentMailMergeValues(state: EditorState): MergeValues | null {
  return mailMergePreviewKey.getState(state)?.values ?? null
}

export const MailMergePreviewExtension = Extension.create({
  name: 'mailMergePreview',
  addProseMirrorPlugins() {
    return [
      new Plugin<MailMergePreviewState>({
        key: mailMergePreviewKey,
        state: {
          init: () => ({ values: null, highlight: false, decos: DecorationSet.empty }),
          apply: applyState,
        },
        props: {
          decorations(state) {
            return mailMergePreviewKey.getState(state)?.decos ?? null
          },
        },
      }),
    ]
  },
})

/** Count of merge fields in the document, for the ribbon's "no fields yet" hint. */
export function countMergeFields(editor: Editor): number {
  return mergeFields(editor.state.doc).length
}

/** Positions of every merge field, used by the preview stepper. */
export function mergeFieldPositions(
  doc: PmNode,
): Array<{ from: number; to: number; instr: string }> {
  return mergeFields(doc).map((f) => ({ from: f.from, to: f.to, instr: f.instr }))
}
