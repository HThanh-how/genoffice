/**
 * Pre-flight checks before a batch export. Word refuses to merge when the
 * template references a column the source does not have; GenOffice reports the
 * same problems up front rather than writing hundreds of wrong documents.
 */
import { type MergeFieldRef } from '@genoffice/docx-engine'
import type { Editor } from '@tiptap/core'
import { fieldCodeText } from '../editor/field-codes'
import type { MailMergeSource, MailMergeValidationIssue } from './types'

/** Merge fields present in the editor (body) — the instrField mark is the model. */
export function templateMergeFields(editor: Editor): MergeFieldRef[] {
  const found = new Map<string, string>()
  editor.state.doc.descendants((node) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'instrField')
    if (!mark) return
    const instr = String(mark.attrs.instr ?? '')
    const name = instr.match(/^\s*MERGEFIELD\s+(?:"([^"]*)"|(\S+))/)?.[1] ?? instr.match(/^\s*MERGEFIELD\s+(?:"([^"]*)"|(\S+))/)?.[2]
    if (!name) return
    if (!found.has(name)) found.set(name, instr.trim())
  })
  return [...found].map(([name, instr]) => ({ name, instr }))
}

/** Merge fields the editor cannot model: they live in byte-preserved XML. */
export function passthroughMergeFields(editor: Editor): string[] {
  const names = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'docProtected') return
    const xml = String(node.attrs?.genXml ?? '')
    for (const match of xml.matchAll(/<w:instrText[^>]*>\s*MERGEFIELD\s+([^<]+)<\/w:instrText>/g)) {
      names.add(match[1].trim().replace(/^"|"$/g, ''))
    }
  })
  return [...names]
}

export function validateMergeSession(
  source: MailMergeSource | null,
  fields: MergeFieldRef[],
  editor: Editor,
): MailMergeValidationIssue[] {
  const issues: MailMergeValidationIssue[] = []
  if (!source) {
    issues.push({ severity: 'error', key: 'mailMergeNoSource' })
    return issues
  }
  if (source.recipients.length === 0) {
    issues.push({ severity: 'error', key: 'mailMergeNoRecipients' })
  }
  if (selected(source) === 0) {
    issues.push({ severity: 'error', key: 'mailMergeNoneSelected' })
  }
  const columns = new Set(source.columns.map((c) => c.name))
  for (const field of fields) {
    if (!columns.has(field.name)) {
      issues.push({
        severity: 'error',
        key: 'mailMergeMissingColumn',
        detail: field.name,
      })
    }
  }
  for (const column of source.columns) {
    if (column.duplicateOf !== undefined) {
      issues.push({ severity: 'warning', key: 'mailMergeDuplicateColumn', detail: column.header })
    }
  }
  const used = new Set(fields.map((f) => f.name))
  const unused = source.columns.filter((c) => !used.has(c.name)).length
  if (unused > 0) {
    issues.push({ severity: 'warning', key: 'mailMergeUnusedColumns', detail: String(unused) })
  }
  const passthrough = passthroughMergeFields(editor)
  if (passthrough.length > 0) {
    issues.push({
      severity: 'warning',
      key: 'mailMergePassthroughFields',
      detail: passthrough.join(', '),
    })
  }
  // empty values in a field the template uses are a warning, not a blocker:
  // an optional address line being blank is normal
  for (const field of fields) {
    const empty = source.recipients.filter((r) => (r.values[field.name] ?? '').trim() === '').length
    if (empty > 0 && empty < source.recipients.length) {
      issues.push({ severity: 'warning', key: 'mailMergeEmptyValues', detail: `${field.name}: ${empty}` })
    }
  }
  return issues
}

function selected(source: MailMergeSource): number {
  return source.recipients.reduce((n, r) => n + (r.selected ? 1 : 0), 0)
}

/** Field codes view helper for the validation panel (Word's { MERGEFIELD X }). */
export function fieldCodePreview(instr: string): string {
  return fieldCodeText(instr)
}
