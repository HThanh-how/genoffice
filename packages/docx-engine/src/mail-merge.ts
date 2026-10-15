/**
 * Mail merge: turn a template's MERGEFIELD (and IF) fields into per-recipient
 * content without touching the template itself.
 *
 * The parser already folds `w:fldChar`/`w:fldSimple` MERGEFIELD runs into the
 * block model as a run carrying `instrField` (see parse.ts / merge-field.test.ts),
 * so merging is a run-level rewrite: the field run's cached result becomes the
 * recipient's value, and the run's own formatting (font, bold, colour, size)
 * is kept because only `text` changes and `instrField` is dropped.
 *
 * Two shapes of paragraph need different treatment:
 *   - editable paragraphs (runs modelled)  → rewrite the run list
 *   - passthrough paragraphs (byte-preserved originalXml, e.g. a paragraph with
 *     an unbalanced or unmodelled field) → patch the cached result inside the XML
 *
 * Everything here is pure and synchronous: no I/O, no AI, no network.
 */
import { MERGEFIELD_INSTR_RE } from './parse-props'
import type { Block, GeneratedBlock, HeaderFooter, HfParagraph, Run, TableModel } from './types'

/** One merge field occurrence found in a template. */
export interface MergeFieldRef {
  /** the data-source column name the field asks for */
  name: string
  /** the full instruction text as it appears in the document */
  instr: string
  /** where the field sits, for the error report */
  blockId?: string
}

/** A recipient's row, keyed by column name. Values are always strings. */
export type MergeValues = Record<string, string>

export interface MergeReport {
  /** fields referenced by the template that the row has no value for */
  missing: string[]
  /** fields the template never uses (dead columns in the source) */
  unused: string[]
  /** paragraphs whose merge fields could not be rewritten (unsupported shape) */
  unsupported: number
  /** how many field occurrences were actually replaced */
  applied: number
}

/** Word's own placeholder for a field with no cached result. */
export function mergePlaceholder(name: string): string {
  return `\u00AB${name}\u00BB`
}

/** `MERGEFIELD "Postal Address" \* MERGEFORMAT` → `Postal Address` */
export function mergeFieldName(instr: string): string | null {
  const m = MERGEFIELD_INSTR_RE.exec(instr)
  if (!m) return null
  const name = m[1] ?? m[2]
  return name ? name.trim() : null
}

export function isMergeField(instr: string): boolean {
  return MERGEFIELD_INSTR_RE.test(instr)
}

/**
 * `IF` field: `IF «Name» "yes" "no"`, `IF «Name» = "Sales" "a" "b"`.
 * Only the forms a mail-merge template can actually express are recognised;
 * anything else stays untouched and is reported as unsupported.
 */
const IF_INSTR_RE = /^\s*IF\s+([\s\S]*?)\s*"([^"]*)"\s*(?:"([^"]*)")?\s*$/
const IF_EXPR_RE = /^«([^»]+)»\s*(?:([=<>!]+)\s*(?:"([^"]*)"|([-+0-9.]+)))?$/

export function isConditionalField(instr: string): boolean {
  return /^\s*IF\s/.test(instr) && IF_INSTR_RE.test(instr)
}

function truthy(value: string, operator: string | undefined, literal: string | undefined): boolean {
  if (operator === undefined) return value.trim() !== ''
  const left = value.trim()
  const right = (literal ?? '').trim()
  const numeric = Number(left)
  const numericRight = Number(right)
  const bothNumeric =
    left !== '' && right !== '' && Number.isFinite(numeric) && Number.isFinite(numericRight)
  const compare = bothNumeric ? numeric - numericRight : left.localeCompare(right)
  switch (operator) {
    case '=':
    case '==':
      return compare === 0
    case '!=':
    case '<>':
      return compare !== 0
    case '<':
      return compare < 0
    case '>':
      return compare > 0
    case '<=':
      return compare <= 0
    case '>=':
      return compare >= 0
    default:
      return false
  }
}

/** Evaluate an IF field against a row; null when the instruction is not supported. */
export function evaluateConditionalField(instr: string, values: MergeValues): string | null {
  const m = IF_INSTR_RE.exec(instr)
  if (!m) return null
  const expr = IF_EXPR_RE.exec(m[1].trim())
  if (!expr) return null
  const name = expr[1].trim()
  const value = values[name]
  if (value === undefined) return null
  return truthy(value, expr[2], expr[3]) ? m[2] : (m[3] ?? '')
}

/** A field run whose text is the recipient's value, with the field machinery gone. */
function resolvedRun(run: Run, text: string): Run {
  const next: Run = { ...run, text, instrField: undefined, fldDirty: undefined }
  delete next.fldBeginXml
  return next
}

function mapRuns(runs: Run[], values: MergeValues, report: MergeReport): Run[] {
  const out: Run[] = []
  for (const run of runs) {
    const instr = run.instrField
    if (instr === undefined) {
      out.push(run)
      continue
    }
    if (isMergeField(instr)) {
      const name = mergeFieldName(instr)
      if (name === null) {
        report.unsupported += 1
        out.push(run)
        continue
      }
      if (!(name in values)) {
        report.missing.push(name)
        out.push(run)
        continue
      }
      report.applied += 1
      out.push(resolvedRun(run, values[name]))
      continue
    }
    if (isConditionalField(instr)) {
      const result = evaluateConditionalField(instr, values)
      if (result === null) {
        report.unsupported += 1
        out.push(run)
        continue
      }
      report.applied += 1
      out.push(resolvedRun(run, result))
      continue
    }
    // PAGE, DATE, REF, … are not mail-merge fields: leave them exactly as they are.
    out.push(run)
  }
  return out
}

function mapTableModel(model: TableModel, values: MergeValues, report: MergeReport): TableModel {
  return {
    ...model,
    // rows are arrays of cells; only the cell's paragraph runs are rewritten,
    // so borders, widths, merges and shading are untouched
    rows: model.rows.map((cells) =>
      cells.map((cell) => ({
        ...cell,
        paras: cell.paras.map((para) =>
          para.replace(/\u00AB[^\u00BB]*\u00BB/g, (whole) => {
            const name = whole.slice(1, -1)
            return name in values ? values[name] : whole
          }),
        ),
        richParas: cell.richParas?.map((para) => ({
          ...para,
          runs: mapRuns(para.runs, values, report),
        })),
        nestedTables: cell.nestedTables?.map((nested) => mapTableModel(nested, values, report)),
      })),
    ),
  }
}

/**
 * XML patch for a passthrough paragraph: rewrite the cached result of every
 * MERGEFIELD between `fldCharType="separate"` and `fldCharType="end"`, or
 * insert a separate+result pair when the field carries no cached result at all
 * (the usual state of an unmerged main document).
 */
/** Word's single-element field form: `<w:fldSimple w:instr=" MERGEFIELD Name ">result</w:fldSimple>`. */
const FLD_SIMPLE_RE = /<w:fldSimple\b[^>]*?(?:\/>|>[\s\S]*?<\/w:fldSimple>)/g

function patchSimpleFields(xml: string, values: MergeValues, report: MergeReport): string {
  return xml.replace(FLD_SIMPLE_RE, (whole) => {
    const instrMatch = /w:instr\s*=\s*"([^"]*)"/.exec(whole)
    if (!instrMatch) return whole
    const instr = decodeEntities(instrMatch[1])
    const isMerge = isMergeField(instr)
    const isIf = isConditionalField(instr)
    if (!isMerge && !isIf) return whole
    const name = isMerge ? mergeFieldName(instr) : null
    const value = isIf
      ? evaluateConditionalField(instr, values)
      : name && name in values
        ? values[name]
        : null
    if (value === null) {
      if (name) report.missing.push(name)
      else report.unsupported += 1
      return whole
    }
    // keep the field itself (Word refreshes it on open) but write the recipient's
    // value as its cached result, preserving the run's formatting
    const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(whole)?.[0] ?? ''
    const open = whole.slice(0, whole.indexOf('>') + 1).replace('/>', '>')
    report.applied += 1
    return `${open}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:fldSimple>`
  })
}

export function patchMergeFieldXml(xml: string, values: MergeValues, report: MergeReport): string {
  return patchComplexFields(patchSimpleFields(xml, values, report), values, report)
}

function patchComplexFields(xml: string, values: MergeValues, report: MergeReport): string {
  let out = xml
  let cursor = 0
  for (;;) {
    const begin = out.indexOf('<w:fldChar', cursor)
    if (begin < 0) break
    if (!/w:fldCharType="begin"/.test(out.slice(begin, begin + 60))) {
      cursor = begin + 1
      continue
    }
    const instrMatch = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/.exec(out.slice(begin))
    if (!instrMatch) {
      cursor = begin + 1
      continue
    }
    const instr = decodeEntities(instrMatch[1])
    const isMerge = isMergeField(instr)
    const isIf = isConditionalField(instr)
    if (!isMerge && !isIf) {
      cursor = begin + instrMatch.index + instrMatch[0].length
      continue
    }
    const name = isMerge ? mergeFieldName(instr) : null
    const value = isIf
      ? evaluateConditionalField(instr, values)
      : name && name in values
        ? values[name]
        : null
    if (value === null) {
      if (name) report.missing.push(name)
      else report.unsupported += 1
      cursor = begin + instrMatch.index + instrMatch[0].length
      continue
    }
    const instrEnd = begin + instrMatch.index + instrMatch[0].length
    const endAt = out.indexOf('<w:fldChar w:fldCharType="end"', instrEnd)
    if (endAt < 0) {
      report.unsupported += 1
      cursor = instrEnd
      continue
    }
    const separateAt = out.indexOf('<w:fldChar w:fldCharType="separate"', instrEnd)
    const resultRun = `<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`
    if (separateAt >= 0 && separateAt < endAt) {
      // drop the cached result runs and write the recipient's value in their place
      out = out.slice(0, separateAt) + resultRun + out.slice(endAt)
    } else {
      out = out.slice(0, endAt) + resultRun + out.slice(endAt)
    }
    report.applied += 1
    cursor = separateAt >= 0 && separateAt < endAt ? separateAt + resultRun.length : endAt
  }
  return out
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/** Every merge field referenced by a block tree, in document order. */
export function collectMergeFields(blocks: Block[]): MergeFieldRef[] {
  const found: MergeFieldRef[] = []
  const seen = new Set<string>()
  const push = (instr: string, blockId: string) => {
    const name = mergeFieldName(instr)
    if (name === null) return
    if (seen.has(name)) return
    seen.add(name)
    found.push({ name, instr: instr.trim(), blockId })
  }
  for (const block of blocks) {
    for (const run of block.runs ?? []) {
      if (run.instrField !== undefined) push(run.instrField, block.id)
    }
    if (block.table) {
      for (const row of block.table.rows) {
        for (const cell of row) {
          for (const para of cell.richParas ?? []) {
            for (const run of para.runs ?? []) push(run.instrField!, block.id)
          }
        }
      }
    }
    if (block.originalXml) {
      for (const instr of block.originalXml.matchAll(
        /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g,
      )) {
        push(decodeEntities(instr[1]), block.id)
      }
    }
  }
  return found
}

/** One template paragraph, merged. */
export function applyMergeValuesToBlock(
  block: Block,
  values: MergeValues,
  report: MergeReport,
): Block {
  const next: Block = { ...block }
  // the run/table model is the source of truth whenever it exists
  if (next.runs) next.runs = mapRuns(next.runs, values, report)
  if (next.table) next.table = mapTableModel(next.table, values, report)
  // a block the model cannot reach is byte-preserved: patch the cached field
  // result inside its original XML instead. Only done when nothing was merged
  // through the model, so a field is never counted (or rewritten) twice.
  if (!next.runs && !next.table && next.originalXml && /MERGEFIELD/.test(next.originalXml)) {
    next.originalXml = patchMergeFieldXml(next.originalXml, values, report)
  }
  return next
}

/** The whole body, merged for one recipient. The input blocks are never mutated. */
export function applyMergeValues(
  blocks: Block[],
  values: MergeValues,
  report?: MergeReport,
): Block[] {
  const r = report ?? { missing: [], unused: [], unsupported: 0, applied: 0 }
  return blocks.map((block) => applyMergeValuesToBlock(block, values, r))
}

/** A generated (editor-created) paragraph, merged. */
export function applyMergeValuesToGenerated(
  block: GeneratedBlock,
  values: MergeValues,
  report: MergeReport,
): GeneratedBlock {
  return { ...block, runs: mapRuns(block.runs, values, report) }
}

/** Header/footer content, merged. */
export function applyMergeValuesToHeaderFooter(
  hf: HeaderFooter,
  values: MergeValues,
  report: MergeReport,
): HeaderFooter {
  const paras: HfParagraph[] | undefined = hf.paras?.map((para) => ({
    ...para,
    runs: mapRuns(para.runs, values, report),
  }))
  const text = paras
    ? paras.map((para) => (para.runs ?? []).map((run) => run.text).join('')).join('\n')
    : hf.text
  return { ...hf, text, paras }
}

/**
 * Filename for one merged output. Recipient values are attacker-controlled text:
 * every path separator, control character and reserved name is neutralised, and
 * the result can never escape the directory it is written into.
 */
const ILLEGAL_NAME_CHARS =
  // eslint-disable-next-line no-control-regex -- recipient values are user text: the C0 range and DEL must not reach the filesystem
  /[\\/:*?"<>|\u0000-\u001f\u007f]/g

export function sanitizeFileNamePart(raw: string): string {
  const cleaned = raw
    .replace(ILLEGAL_NAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120)
  if (!cleaned) return ''
  // Windows reserved device names, with or without an extension
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(cleaned)) return `_${cleaned}`
  return cleaned
}

export interface FileNamePatternOptions {
  /** `{index}`, `{name}`, `{field}` … */
  pattern: string
  index: number
  total: number
  values: MergeValues
  extension: string
}

/**
 * Expand a `{index}_{Name}_{Department}` style pattern. Unknown tokens are
 * dropped rather than left as literal braces, so a typo cannot produce a
 * filename full of `{}`.
 */
export function buildOutputFileName(options: FileNamePatternOptions): string {
  const { pattern, index, total, values, extension } = options
  const indexWidth = Math.max(1, String(total).length)
  const name = pattern.replace(/\{(\d*)index\}/g, () => String(index).padStart(indexWidth, '0'))
  const expanded = name.replace(/\{([^{}]*)\}/g, (_whole, key: string) => {
    const trimmed = key.trim()
    if (!trimmed) return ''
    const value = values[trimmed]
    if (value === undefined) return ''
    return sanitizeFileNamePart(value)
  })
  const base =
    expanded.replace(/\s+/g, ' ').trim() || `merge-${String(index).padStart(indexWidth, '0')}`
  const ext = extension.replace(/^\./, '').toLowerCase() || 'docx'
  return `${base}.${ext}`
}

/** Deterministic collision handling: `name.docx`, `name (2).docx`, … */
export function uniqueFileName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}${ext}`
}
