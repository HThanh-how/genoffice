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
import type { Node as PmNode } from '@tiptap/pm/model'
import { Transaction } from '@tiptap/pm/state'
import {
  evaluateConditionalField,
  isConditionalField,
  isMergeField,
  mergeFieldName,
  type MergeReport,
  type MergeValues,
} from '@genoffice/docx-engine'

interface Replacement {
  from: number
  to: number
  node: PmNode
}

/** The value a field should show for this row, or null when it cannot be resolved. */
export function mergeFieldValue(
  instr: string,
  values: MergeValues,
  report: MergeReport,
): string | null {
  if (isMergeField(instr)) {
    const name = mergeFieldName(instr)
    if (name === null) return null
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
    const marks = node.marks.filter((m) => m.type.name !== 'instrField')
    replacements.push({ from: pos, to: pos + node.nodeSize, node: doc.schema.createTextNode(value, marks) })
  })
  if (replacements.length === 0) return doc
  const tr = new Transaction(doc)
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]
    tr.replace(r.from, r.to, r.node)
  }
  return tr.doc
}
