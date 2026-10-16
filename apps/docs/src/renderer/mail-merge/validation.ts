/**
 * Pre-flight checks before a batch export. Word refuses to merge when the
 * template references a column the source does not have; GenOffice reports the
 * same problems up front rather than writing hundreds of wrong documents.
 */
import { type MergeFieldRef } from '@genoffice/docx-engine'
import type { Editor } from '@tiptap/core'
import type { Block } from '@genoffice/docx-engine'
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
    const name =
      instr.match(/^\s*MERGEFIELD\s+(?:"([^"]*)"|(\S+))/)?.[1] ??
      instr.match(/^\s*MERGEFIELD\s+(?:"([^"]*)"|(\S+))/)?.[2]
    if (!name) return
    if (!found.has(name)) found.set(name, instr.trim())
  })
  return [...found].map(([name, instr]) => ({ name, instr }))
}

/**
 * Every column a merge has to supply: the fields the editor models plus the
 * ones hiding in byte-preserved blocks. Export uses this to refuse a recipient
 * whose row is missing a column outright, instead of writing «Name» into the
 * output file.
 */
export function requiredMergeFields(
  editor: Editor,
  blocks: readonly Block[],
): string[] {
  const names = new Set<string>(templateMergeFields(editor).map((field) => field.name))
  for (const name of passthroughMergeFields(blocks)) names.add(name)
  return [...names]
}

/** Merge fields the editor cannot model: they live in byte-preserved blocks. */
export function passthroughMergeFields(blocks: readonly Block[]): string[] {
  const names = new Set<string>()
  for (const block of blocks) {
    if (block.runs || block.table) continue
    for (const match of (block.originalXml ?? '').matchAll(
      /<w:(?:instrText|fldSimple)[^>]*>\s*MERGEFIELD\s+([^<]+?)(?:<\/w:instrText>|<\/w:fldSimple>)/g,
    )) {
      names.add(match[1].trim().replace(/^"|"$/g, ''))
    }
  }
  return [...names]
}

/**
 * Field instructions sitting in a byte-preserved paragraph. The save pipeline
 * copies those paragraphs verbatim, so a MERGEFIELD or IF inside one is not
 * rewritten by the merge — the recipient's value would never appear. Export
 * reports them instead of writing a document that still contains the raw field.
 */
export function passthroughFieldInstructions(blocks: readonly Block[]): string[] {
  const found: string[] = []
  for (const block of blocks) {
    if (block.runs || block.table) continue
    for (const match of (block.originalXml ?? '').matchAll(
      /<w:(?:instrText|fldSimple)[^>]*>\s*(MERGEFIELD|IF)\s+([^<]*?)(?:<\/w:instrText>|<\/w:fldSimple>)/g,
    )) {
      const instr = `${match[1]} ${match[2].trim()}`
      if (!found.includes(instr)) found.push(instr)
    }
  }
  return found
}

export function validateMergeSession(
  source: MailMergeSource | null,
  fields: MergeFieldRef[],
  blocks: readonly Block[],
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
  const passthrough = passthroughMergeFields(blocks)
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
      issues.push({
        severity: 'warning',
        key: 'mailMergeEmptyValues',
        detail: `${field.name}: ${empty}`,
      })
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
