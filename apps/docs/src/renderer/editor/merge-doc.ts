/**
 * Mail merge at the editor-document level.
 *
 * `pmDocToSavePlan` decides per block whether the paragraph is byte-preserved
 * or regenerated, so the only reliable place to substitute recipient values is
 * the ProseMirror tree itself: every text node carrying the `instrField` mark
 * with a MERGEFIELD instruction gets its cached result replaced by the
 * recipient's value and the mark dropped. The paragraph keeps its own runs,
 * formatting and table structure, and the save pipeline then emits ordinary
 * runs — exactly what Word writes for a merged document.
 */
import type { Editor } from '@tiptap/core'
import type { Mark, Node as PmNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import {
  evaluateConditionalField,
  isConditionalField,
  isMergeField,
  mergeFieldName,
  mergeFieldInstruction,
  mergePlaceholder,
  type MergeReport,
  type MergeValues,
} from '@genoffice/docx-engine'

export type { MergeReport, MergeValues } from '@genoffice/docx-engine'

interface Replacement {
  from: number
  to: number
  text: string
  marks: readonly Mark[]
}

/** The value a field should show for this row, or null when it cannot be resolved. */
export function mergeFieldValue(
  instr: string,
  values: MergeValues,
  report: MergeReport,
): string | null {
  if (isMergeField(instr)) {
    const name = mergeFieldName(instr)
    if (name === null) {
      // `MERGEFIELD` with no parsable name: the field cannot be resolved, and
      // leaving it in the output would silently write a raw field
      report.unsupported += 1
      return null
    }
    if (!(name in values)) {
      report.missing.push(name)
      return null
    }
    report.applied += 1
    return values[name]
  }
  if (isConditionalField(instr)) {
    const result = evaluateConditionalField(instr, values)
    if (result === null) {
      report.unsupported += 1
      return null
    }
    report.applied += 1
    return result
  }
  // an IF/MERGEFIELD the merge model cannot parse is not recipient data, but it
  // is still a field the merge was asked to resolve
  if (/^\s*(MERGEFIELD|IF)\b/i.test(instr)) {
    report.unsupported += 1
    return null
  }
  return null
}

/**
 * A copy of `doc` with every merge field resolved for one recipient. The
 * original document is not modified; replacements are applied from the end of
 * the document backwards so earlier positions stay valid.
 */
export function applyMergeValuesToPmDoc(
  doc: PmNode,
  values: MergeValues,
  report: MergeReport,
): PmNode {
  const replacements: Replacement[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'instrField')
    if (!mark) return
    const value = mergeFieldValue(String(mark.attrs.instr ?? ''), values, report)
    if (value === null) return
    // the field mark goes away; the run's own formatting (bold, font, colour) stays
    replacements.push({
      from: pos,
      to: pos + node.nodeSize,
      text: value,
      marks: mark.type.removeFromSet(node.marks),
    })
  })
  if (replacements.length === 0) return doc
  const tr = new Transform(doc)
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]
    // ProseMirror rejects an empty text node: a field that merges to nothing
    // (an empty address line, an IF with no else branch) is simply removed,
    // which is what Word does with an empty merge result
    if (!r.text) {
      tr.delete(r.from, r.to)
      continue
    }
    tr.replaceWith(r.from, r.to, doc.type.schema.text(r.text, r.marks))
  }
  return tr.doc
}

/**
 * Insert a real merge field at the cursor, the way Word's "Insert Merge Field"
 * does: the run carries the `instrField` mark, so the engine round-trips it to
 * `<w:fldChar>…MERGEFIELD…</w:fldChar>` and preview/export can resolve it.
 * The instruction is built by `mergeFieldInstruction`, which quotes column
 * names containing spaces — `MERGEFIELD Postal Address` would merge the column
 * `Postal` and drop the rest of the name.
 */
export function insertMergeField(editor: Editor, name: string): void {
  if (!editor.isEditable) return
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'text',
      text: mergePlaceholder(name),
      marks: [{ type: 'instrField', attrs: { instr: mergeFieldInstruction(name) } }],
    })
    .run()
}
