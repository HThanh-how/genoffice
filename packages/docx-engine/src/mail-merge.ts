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
 * Can this column name be written as a MERGEFIELD at all?
 *
 * A field name is one token. Inside quotes it ends at the next `"`, so a name
 * containing a quote — `He said "hi"` — cannot be expressed: Word would read
 * the name as `He said ` and treat the rest as junk. Folding the quote to an
 * apostrophe would name a column that does not exist in the source, so such a
 * name is rejected rather than silently renamed.
 */
export function isRepresentableColumnName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && !trimmed.includes('"')
}

/**
 * The instruction Word writes for a merge field, or null when the column name
 * cannot be one (see `isRepresentableColumnName`).
 *
 * A multi-word name has to be quoted — `MERGEFIELD Postal Address` would merge
 * the column `Postal` and silently swallow `Address`. Quoting is what Word
 * itself emits, and MERGEFIELD_INSTR_RE round-trips it.
 */
export function mergeFieldInstruction(name: string): string | null {
  const safe = name.trim()
  if (!isRepresentableColumnName(safe)) return null
  return /\s/.test(safe) ? `MERGEFIELD "${safe}"` : `MERGEFIELD ${safe}`
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
 * XML patch for a passthrough paragraph — a block the run model cannot reach,
 * so its merge fields have to be rewritten inside its own XML.
 *
 * A merged document must not still contain a field: Word re-evaluates fields
 * when the file is opened, and a MERGEFIELD left in the output would fall back
 * to «Name» the moment the field refreshes. The whole field — begin, instr,
 * separate, cached result, end — is therefore replaced by one ordinary run
 * carrying the recipient's value, with the field's own formatting kept.
 *
 * The patch is run-aware, not string-aware. `w:fldChar` sits *inside* a `w:r`,
 * so cutting at a fldChar and pasting a `<w:r>` there nests runs, which is not
 * valid WordprocessingML. Runs never nest, so a flat scan yields every run, and
 * a field is exactly the run range from its `begin` to its `end`.
 */

/** Index of the `>` that closes an opening tag, skipping `>` inside quoted attributes. */
function tagEnd(xml: string, start: number): number {
  let i = start + 1
  while (i < xml.length) {
    const ch = xml[i]
    if (ch === '"') {
      const close = xml.indexOf('"', i + 1)
      if (close < 0) return -1
      i = close + 1
      continue
    }
    if (ch === '>') return i
    i += 1
  }
  return -1
}

interface RunSpan {
  /** index of `<w:r` */
  start: number
  /** index just after the run's closing tag */
  end: number
  /** everything between the opening tag and `</w:r>` */
  inner: string
}

/** Runs never nest in WordprocessingML, so one flat pass finds all of them. */
function splitRuns(xml: string): RunSpan[] {
  const runs: RunSpan[] = []
  let i = 0
  while (i < xml.length) {
    const start = xml.indexOf('<w:r', i)
    if (start < 0) break
    const next = xml[start + 4]
    // `<w:rPr>`, `<w:rules>`… are not runs
    if (next !== ' ' && next !== '>' && next !== '/') {
      i = start + 4
      continue
    }
    const closeTag = tagEnd(xml, start)
    if (closeTag < 0) break
    if (xml[closeTag - 1] === '/') {
      runs.push({ start, end: closeTag + 1, inner: '' })
      i = closeTag + 1
      continue
    }
    const close = xml.indexOf('</w:r>', closeTag)
    if (close < 0) {
      i = closeTag + 1
      continue
    }
    runs.push({ start, end: close + 6, inner: xml.slice(closeTag + 1, close) })
    i = close + 6
  }
  return runs
}

type FieldMarker =
  | { kind: 'begin' | 'separate' | 'end'; offset: number; length: number }
  | { kind: 'instr'; offset: number; length: number; text: string }

/** Every field marker inside one run, in document order (a run may carry several). */
function fieldMarkers(inner: string): FieldMarker[] {
  const out: FieldMarker[] = []
  const re = /<w:fldChar\b[^>]*>|<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(inner)) !== null) {
    const whole = match[0]
    if (whole.startsWith('<w:fldChar')) {
      const kind = /w:fldCharType="(begin|separate|end)"/.exec(whole)?.[1]
      if (kind)
        out.push({
          kind: kind as 'begin' | 'separate' | 'end',
          offset: match.index,
          length: whole.length,
        })
      continue
    }
    out.push({
      kind: 'instr',
      offset: match.index,
      length: whole.length,
      text: decodeEntities(
        whole.slice(whole.indexOf('>') + 1, whole.lastIndexOf('</w:instrText>')),
      ),
    })
  }
  return out
}

function rPrOf(xml: string): string | null {
  return /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(xml)?.[0] ?? null
}

/** The formatting of the field's cached-result runs, when the begin run has none. */
function firstRPr(runs: RunSpan[], from: number, to: number): string | null {
  for (let i = from; i <= to; i++) {
    const rpr = rPrOf(runs[i].inner)
    if (rpr) return rpr
  }
  return null
}

interface Patch {
  from: number
  to: number
  replacement: string
}

/** Spans are applied in document order; two fields sharing a run merge into one. */
function addPatch(patches: Patch[], patch: Patch): void {
  const last = patches[patches.length - 1]
  if (last && patch.from < last.to) {
    patches[patches.length - 1] = {
      from: last.from,
      to: Math.max(last.to, patch.to),
      replacement: last.replacement + patch.replacement,
    }
    return
  }
  patches.push(patch)
}

function applyPatches(xml: string, patches: Patch[]): string {
  let out = ''
  let cursor = 0
  for (const patch of patches) {
    out += xml.slice(cursor, patch.from) + patch.replacement
    cursor = patch.to
  }
  return out + xml.slice(cursor)
}

/** The recipient's value for one instruction, or null when it cannot be resolved. */
function fieldResult(instr: string, values: MergeValues, report: MergeReport): string | null {
  const isMerge = isMergeField(instr)
  const isIf = isConditionalField(instr)
  if (!isMerge && !isIf) return null
  const name = isMerge ? mergeFieldName(instr) : null
  const value = isIf
    ? evaluateConditionalField(instr, values)
    : name && name in values
      ? values[name]
      : null
  if (value === null) {
    if (name) report.missing.push(name)
    else report.unsupported += 1
    return null
  }
  return value
}

export function patchMergeFieldXml(xml: string, values: MergeValues, report: MergeReport): string {
  return patchComplexFields(patchSimpleFields(xml, values, report), values, report)
}

/** Word's single-element field form: `<w:fldSimple w:instr=" MERGEFIELD Name ">result</w:fldSimple>`. */
function patchSimpleFields(xml: string, values: MergeValues, report: MergeReport): string {
  const patches: Patch[] = []
  const open: Array<{ start: number; instr: string; nested: boolean }> = []
  let i = 0
  for (;;) {
    const nextOpen = xml.indexOf('<w:fldSimple', i)
    const nextClose = xml.indexOf('</w:fldSimple>', i)
    if (nextOpen < 0 && nextClose < 0) break
    if (nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)) {
      const end = tagEnd(xml, nextOpen)
      if (end < 0) break
      const openTag = xml.slice(nextOpen, end + 1)
      const instrMatch = /w:instr\s*=\s*"([^"]*)"/.exec(openTag)
      const instr = instrMatch ? decodeEntities(instrMatch[1]) : ''
      if (openTag.endsWith('/>')) {
        if (open.length > 0) report.unsupported += 1
        else if (instr) addFieldPatch(patches, nextOpen, end + 1, '', instr, values, report)
        i = end + 1
        continue
      }
      open.push({ start: nextOpen, instr, nested: open.length > 0 })
      i = end + 1
      continue
    }
    const field = open.pop()
    if (!field) {
      i = nextClose + 14
      continue
    }
    if (field.nested) {
      report.unsupported += 1
      i = nextClose + 14
      continue
    }
    const inner = xml.slice(tagEnd(xml, field.start) + 1, nextClose)
    addFieldPatch(patches, field.start, nextClose + 14, inner, field.instr, values, report)
    i = nextClose + 14
  }
  return applyPatches(xml, patches)
}

/** A resolved fldSimple becomes a plain run: the field machinery is gone for good. */
function addFieldPatch(
  patches: Patch[],
  from: number,
  to: number,
  inner: string,
  instr: string,
  values: MergeValues,
  report: MergeReport,
): void {
  const value = fieldResult(instr, values, report)
  if (value === null) return
  const rPr = rPrOf(inner) ?? ''
  addPatch(patches, {
    from,
    to,
    replacement: `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`,
  })
  report.applied += 1
}

function patchComplexFields(xml: string, values: MergeValues, report: MergeReport): string {
  const runs = splitRuns(xml)
  const patches: Patch[] = []
  const open: Array<{
    run: number
    instr: string
    nested: boolean
    offset: number
    length: number
  }> = []
  for (let i = 0; i < runs.length; i++) {
    for (const marker of fieldMarkers(runs[i].inner)) {
      if (marker.kind === 'begin') {
        open.push({
          run: i,
          instr: '',
          nested: open.length > 0,
          offset: marker.offset,
          length: marker.length,
        })
        continue
      }
      if (marker.kind === 'instr') {
        // Word splits the instruction across several w:instrText runs
        if (open.length > 0) open[open.length - 1].instr += marker.text
        continue
      }
      if (marker.kind === 'separate') continue
      const field = open.pop()
      if (!field) continue
      // a field inside another field: the outer span would have to be rewritten
      // as a whole, which the merge model cannot do faithfully — leave it alone
      if (field.nested) {
        report.unsupported += 1
        continue
      }
      const value = fieldResult(field.instr, values, report)
      if (value === null) continue
      const beginRun = runs[field.run]
      const endRun = runs[i]
      // keep whatever the two boundary runs hold outside the field markers
      const before = beginRun.inner.slice(0, field.offset).replace(/<w:fldChar\b[^>]*>/g, '')
      const after = endRun.inner
        .slice(marker.offset + marker.length)
        .replace(/<w:fldChar\b[^>]*>/g, '')
      const rPr = rPrOf(before) ?? firstRPr(runs, field.run, i) ?? ''
      addPatch(patches, {
        from: beginRun.start,
        to: endRun.end,
        replacement:
          `<w:r>${rPr && !before.includes('<w:rPr>') ? rPr : ''}${before}` +
          `<w:t xml:space="preserve">${escapeXml(value)}</w:t>${after}</w:r>`,
      })
      report.applied += 1
    }
  }
  // a begin with no end is a broken field: it cannot be merged
  report.unsupported += open.length
  return applyPatches(xml, patches)
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

/**
 * A file name is limited in bytes, not characters. Two long recipient columns
 * already exceed the ceiling, and slicing the whole name at the ceiling can cut
 * off `.docx` / `.pdf` — a file Word cannot open. The extension is taken first,
 * the base is fitted to the remaining budget, and the extension is put back.
 */
export const MAX_FILE_NAME_BYTES = 200

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

/** Trim `base` so `base + extra + ext` still fits, without splitting a character. */
function fitBase(base: string, ext: string, extra: string): string {
  const budget = MAX_FILE_NAME_BYTES - utf8Length(ext) - utf8Length(extra)
  if (budget <= 0) return ''
  if (utf8Length(base) <= budget) return base
  let out = ''
  let used = 0
  for (const ch of base) {
    const size = utf8Length(ch)
    if (used + size > budget) break
    out += ch
    used += size
  }
  // cutting a name short can leave a trailing space or dot, which is not a legal name
  return out.replace(/[\s.]+$/g, '')
}

/** The name actually written: sanitized, extension-preserving, inside the limit. */
export function safeFileName(name: string): string {
  const extMatch = /\.(docx|pdf)$/i.exec(name)
  const ext = extMatch ? extMatch[0].toLowerCase() : ''
  const base = sanitizeFileNamePart(extMatch ? name.slice(0, extMatch.index) : name)
  const fitted = fitBase(base, ext, '')
  return fitted ? `${fitted}${ext}` : `merge${ext}`
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
  return safeFileName(`${base}.${ext}`)
}

/**
 * Deterministic collision handling: `name.docx`, `name (2).docx`, …
 *
 * `taken` may be a set of names or a predicate, so the caller can ask the
 * filesystem directly. The suffix is part of the byte budget: a base already at
 * the ceiling is shortened further rather than pushed over it.
 */
export function uniqueFileName(
  name: string,
  taken: Set<string> | ((candidate: string) => boolean),
): string {
  const has = typeof taken === 'function' ? taken : (candidate: string) => taken.has(candidate)
  if (!has(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10000; n++) {
    const suffix = ` (${n})`
    const fitted = fitBase(base, ext, suffix)
    if (!fitted) continue
    const candidate = `${fitted}${suffix}${ext}`
    if (!has(candidate)) return candidate
  }
  const suffix = `-${Date.now()}`
  const fitted = fitBase(base, ext, suffix)
  return fitted ? `${fitted}${suffix}${ext}` : `${Date.now()}${ext}`
}
