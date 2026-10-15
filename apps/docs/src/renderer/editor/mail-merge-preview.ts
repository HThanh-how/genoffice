/**
 * Live mail-merge preview.
 *
 * Preview is a display-time decoration, exactly like Word's Toggle Field Codes
 * (see field-codes.ts): the template's text is never rewritten, so turning
 * preview off restores the «Name» placeholders, undo history is untouched, and
 * saving the template still writes the original MERGEFIELD runs.
 *
 * Each merge field gets an attribute decoration that hides the placeholder and
 * a widget decoration that inserts the recipient's value in its place. The
 * pagination preview measures the DOM, so page breaks follow the merged text.
 */
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { mergeFieldName, type MergeValues } from '@genoffice/docx-engine'
import { mergeFieldValue, type MergeReport } from './merge-doc'

export const mailMergePreviewKey = new PluginKey<MailMergePreviewState>('mailMergePreview')

export interface MailMergePreviewState {
  values: MergeValues | null
  highlight: boolean
  decos: DecorationSet
}

interface FieldRange {
  from: number
  to: number
  instr: string
}

/** every instrField-marked field in the document, in order */
function mergeFieldRanges(doc: PmNode, markType: PmNode | undefined): FieldRange[] {
  if (!markType) return []
  const out: FieldRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    let i = 0
    while (i < node.childCount) {
      const child = node.child(i)
      const mark = child.isText ? child.marks.find((m) => m.type === markType) : undefined
      if (!mark) {
        i += 1
        continue
      }
      const instr = String(mark.attrs.instr ?? '')
      // a field is one contiguous run of text sharing the same mark instance
      let start = i
      let end = i + 1
      while (end < node.childCount && mark.isInSet(node.child(end).marks)) end += 1
      let from = pos + 1
      for (let k = 0; k < start; k++) from += node.child(k).nodeSize
      let to = from
      for (let k = start; k < end; k++) to += node.child(k).nodeSize
      if (mergeFieldName(instr) !== null || /^\s*IF\s/.test(instr)) out.push({ from, to, instr })
      i = end
    }
    return false
  })
  return out
}

function buildDecorations(doc: PmNode, values: MergeValues | null, highlight: boolean): DecorationSet {
  const markType = doc.type.schema.marks.instrField
  const ranges = mergeFieldRanges(doc, markType)
  const decos: Decoration[] = []
  for (const range of ranges) {
    if (highlight) {
      decos.push(Decoration.create(range.from, range.to, { class: 'mm-field-highlight' }))
    }
    if (!values) continue
    const report: MergeReport = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const value = mergeFieldValue(range.instr, values, report)
    if (value === null) continue
    decos.push(Decoration.create(range.from, range.to, { class: 'mm-field-preview-src' }))
    decos.push(
      Decoration.create(range.to, range.to, {
        node: doc.schema.createTextNode(value, null),
        class: 'mm-field-preview-value',
      }),
    )
  }
  return DecorationSet.create(doc, decos)
}

/** Set (or clear) the recipient whose values the editor should show. */
export function setMailMergePreview(editor: Editor, values: MergeValues | null): void {
  editor.view.dispatch(editor.state.tr.setMeta(mailMergePreviewKey, { values }))
}

export function setMailMergeHighlight(editor: Editor, on: boolean): void {
  editor.view.dispatch(editor.state.tr.setMeta(mailMergePreviewKey, { highlight: on }))
}

export function mailMergePreviewActive(state: EditorState): boolean {
  const s = mailMergePreviewKey.getState(state)
  return !!s?.values
}

export const MailMergePreviewExtension = Extension.create({
  name: 'mailMergePreview',
  addProseMirrorPlugins() {
    return [
      new Plugin<MailMergePreviewState>({
        key: mailMergePreviewKey,
        state: (state) => ({ values: null, highlight: false, decos: DecorationSet.empty }),
        apply: (state, tr, oldState) => {
          const history = oldState.meta.get(mailMergePreviewKey) as MailMergePreviewState | undefined
          const meta = tr.meta.get(mailMergePreviewKey) as
            | { values?: MergeValues | null; highlight?: boolean }
            | undefined
          const values = meta && 'values' in meta ? meta.values : history?.values ?? null
          const highlight = meta?.highlight ?? history?.highlight ?? false
          if (!values && !highlight) return { values: null, highlight: false, decos: DecorationSet.empty }
          return { values, highlight, decos: buildDecorations(tr.doc, values, highlight) }
        },
        decorations: (state) => mailMergePreviewKey.getState(state)?.decos ?? DecorationSet.empty,
      }),
    ]
  },
})
