/**
 * Pre-flight checks before a batch export. Word refuses to merge when the
 * template references a column the source does not have; GenOffice reports the
 * same problems up front rather than writing hundreds of wrong documents.
 */
import {
  fieldInstructionsInXml,
  fieldReferencedColumns,
  isIndexToken,
  isMergeableFieldInstruction,
  isRepresentableColumnName,
  mergeFieldName,
  patternTokens,
  type MergeFieldRef,
  type ParsedDocFull,
} from '@genoffice/docx-engine'
import type { Editor } from '@tiptap/core'
import type { Block } from '@genoffice/docx-engine'
import { fieldCodeText } from '../editor/field-codes'
import type { MailMergeSource, MailMergeValidationIssue } from './types'

/** Merge fields present in the editor (body) — the instrField mark is the model. */
export function templateMergeFields(editor: Editor): MergeFieldRef[] {
  const found = new Map<string, string>()
  for (const instr of templateFieldInstructions(editor)) {
    for (const name of referencedColumnNames(instr)) {
      if (!found.has(name)) found.set(name, instr.trim())
    }
  }
  return [...found].map(([name, instr]) => ({ name, instr }))
}

/**
 * Every MERGEFIELD/IF instruction the editor models, in document order.
 * `IF` counts too: an IF whose operand names a column the source does not have
 * is just as unresolvable as a MERGEFIELD with no column.
 */
export function templateFieldInstructions(editor: Editor): string[] {
  const found: string[] = []
  editor.state.doc.descendants((node) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type.name !== 'instrField') continue
      const instr = String(mark.attrs.instr ?? '')
      if (/^\s*(MERGEFIELD|IF)\b/i.test(instr) && !found.includes(instr)) found.push(instr)
    }
  })
  return found
}

/**
 * The columns one field instruction asks for.
 *
 * The engine owns the grammar (`fieldReferencedColumns`), so validation, the
 * preview and the export all read the same instruction the same way. An IF's
 * literal branches are not columns: `IF «Status» = "vip" "Xin chào «Khách VIP»" ""`
 * needs `Status`, not `Khách VIP`.
 */
export function referencedColumnNames(instr: string): string[] {
  return fieldReferencedColumns(instr)
}

/** Instructions the merge model cannot evaluate — reported, never silently merged. */
export function unmergeableEditorFields(editor: Editor): string[] {
  return templateFieldInstructions(editor).filter((instr) => !isMergeableFieldInstruction(instr))
}

/**
 * Every column a merge has to supply: the fields the editor models plus the
 * ones hiding in byte-preserved blocks. Export uses this to refuse a recipient
 * whose row is missing a column outright, instead of writing «Name» into the
 * output file.
 */
export function requiredMergeFields(editor: Editor, blocks: readonly Block[]): string[] {
  const names = new Set<string>(templateMergeFields(editor).map((field) => field.name))
  for (const name of passthroughMergeFields(blocks)) names.add(name)
  return [...names]
}

/**
 * The instructions in one byte-preserved paragraph, read with the engine's own
 * OOXML walker. `<w:fldSimple w:instr=" MERGEFIELD Name ">` and a complex field
 * whose instruction is split across several `w:instrText` runs are both found;
 * a plain regex misses the first and truncates the second.
 */
function blockFieldInstructions(block: Block): string[] {
  return fieldInstructionsInXml(block.originalXml ?? '')
}

/** Merge fields the editor cannot model: they live in byte-preserved blocks. */
export function passthroughMergeFields(blocks: readonly Block[]): string[] {
  const names = new Set<string>()
  for (const block of blocks) {
    if (block.runs || block.table) continue
    for (const instr of blockFieldInstructions(block)) {
      const name = mergeFieldName(instr)
      if (name) names.add(name)
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
    for (const instr of blockFieldInstructions(block)) {
      const trimmed = instr.trim()
      if (/^\s*(MERGEFIELD|IF)\b/i.test(trimmed) && !found.includes(trimmed)) found.push(trimmed)
    }
  }
  return found
}

/**
 * Merge fields in the parts the merge pipeline never touches: header/footer
 * parts the user has not opened in the header editor, footnote/endnote bodies,
 * and textboxes. Whatever the engine writes for those parts is copied from the
 * template byte-for-byte, so a MERGEFIELD there is printed as «Name» in every
 * output file.
 */
/**
 * Merge fields sitting in parts the merge pipeline never rewrites: header and
 * footer parts the user has not opened in the header editor. Those parts are
 * copied from the template byte-for-byte, so a MERGEFIELD inside one would print
 * as «Name» in every output file.
 */
export function unmergeableHeaderFooterFields(parsed: ParsedDocFull): string[] {
  const found: string[] = []
  const push = (instr: string | undefined): void => {
    const trimmed = (instr ?? '').trim()
    if (/^\s*(MERGEFIELD|IF)\b/i.test(trimmed) && !found.includes(trimmed)) found.push(trimmed)
  }
  // header/footer parts the user never opened in the header editor are copied
  // from the template byte-for-byte: a field inside one is never rewritten
  for (const part of Object.values(parsed.hfParts ?? {})) {
    for (const para of part.paras ?? []) for (const run of para.runs ?? []) push(run.instrField)
  }
  for (const para of parsed.headerParas ?? []) for (const run of para.runs ?? []) push(run.instrField)
  for (const para of parsed.footerParas ?? []) for (const run of para.runs ?? []) push(run.instrField)
  return found
}

export function validateMergeSession(
  source: MailMergeSource | null,
  fields: MergeFieldRef[],
  blocks: readonly Block[],
  editor?: Editor | null,
  scope?: 'selected' | 'all',
  parsed?: ParsedDocFull | null,
): MailMergeValidationIssue[] {
  const issues: MailMergeValidationIssue[] = []
  if (!source) {
    issues.push({ severity: 'error', key: 'mailMergeNoSource' })
    return issues
  }
  if (source.recipients.length === 0) {
    issues.push({ severity: 'error', key: 'mailMergeNoRecipients' })
  }
  // "no recipient is ticked" only blocks an export that exports the ticked ones.
  // With scope=all the batch runs over every row, so an unticked list is not an
  // error there — it is just the user's selection, which they are not using.
  const exported = scope === 'all' ? source.recipients.length : selected(source)
  if (exported === 0) {
    issues.push({
      severity: scope === 'all' ? 'error' : scope === undefined ? 'warning' : 'error',
      key: 'mailMergeNoneSelected',
    })
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
    // a header containing a double quote can never be a MERGEFIELD name, so no
    // field in the template can ever read it — say so instead of quietly
    // renaming the column when a field is inserted
    if (!isRepresentableColumnName(column.name)) {
      issues.push({ severity: 'warning', key: 'mailMergeUnusableColumn', detail: column.name })
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
  // an instruction the merge model cannot evaluate would stay in the output as a
  // raw field; the export refuses such a recipient, so say so here too
  const unmergeable = editor ? unmergeableEditorFields(editor) : []
  if (unmergeable.length > 0) {
    issues.push({
      severity: 'error',
      key: 'mailMergeUnsupportedField',
      detail: unmergeable.join(', '),
    })
  }
  // a field in a header/footer part the user never opened is copied verbatim from
  // the template: the merge cannot reach it, and the writer refuses the file
  if (parsed) {
    const unreachable = unmergeableHeaderFooterFields(parsed)
    if (unreachable.length > 0) {
      issues.push({
        severity: 'error',
        key: 'mailMergeUnsupportedField',
        detail: `${unreachable.join(', ')} (header/footer)`,
      })
    }
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

/**
 * Check a file-name pattern with the same grammar the engine expands.
 *
 * `{index}`, `{1index}` and `{ColumnName}` are the only tokens `buildOutputFileName`
 * understands, so the dialog must not accept `{Name` or reject `{ Name }` that the
 * engine would happily expand. An unknown token is reported by name: silently
 * dropping it would produce a file name the user did not ask for.
 */
export function validateFileNamePattern(
  pattern: string,
  columns: readonly string[],
): { valid: boolean; unknown: string[] } {
  const known = new Set(columns)
  const tokens = patternTokens(pattern)
  if (tokens.length === 0) return { valid: false, unknown: [] }
  const unknown = tokens.filter((token) => !isIndexToken(token) && !known.has(token))
  return { valid: unknown.length === 0, unknown }
}
