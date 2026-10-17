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
import { escapeXmlText } from './xml-utils'
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

/** One recipient row; the keys are the column headers. */
export type MergeRecord = Record<string, string>

/** The workflow's name for a row. Same object, named for the caller that reads it. */
export type MergeValues = MergeRecord

/** A recipient list: the column headers in file order and one record per row. */
export interface MergeData {
  readonly fields: readonly string[]
  readonly records: readonly MergeRecord[]
}

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

/**
 * Word's formatting switches on a MERGEFIELD.
 *
 * `\f " "` is what makes an Address Block read "Ada Lovelace" rather than
 * "AdaLovelace": the text after the switch is written only when the value is
 * non-empty. `\* Upper` / `\* Lower` / `\* FirstCap` / `\* Caps` change the
 * case of the value. Ignoring them merges the wrong text into the document and
 * still reports success, which is worse than not merging at all.
 */
export interface MergeFieldSwitches {
  /** `\b "…"`: text placed before the value, only when the value is non-empty */
  before: string
  /** `\f "…"`: text placed after the value, only when the value is non-empty */
  after: string
  /** `\* Upper | Lower | FirstCap | Caps` */
  caseFormat: string | null
}

/**
 * Split a field instruction into its keyword and the rest: `MERGEFIELD "Postal
 * Address" \* MERGEFORMAT` -> `['MERGEFIELD', '"Postal Address" \\* MERGEFORMAT']`.
 *
 * The keyword is upper-cased here so `mergefield`, `MergeField` and `MERGEFIELD`
 * reach the same branch. Every other part of the instruction is kept exactly as
 * Word wrote it.
 */
export function splitInstruction(instr: string): [keyword: string, rest: string] {
  const trimmed = instr.trim()
  const space = trimmed.search(/\s/)
  return space === -1
    ? [trimmed.toUpperCase(), '']
    : [trimmed.slice(0, space).toUpperCase(), trimmed.slice(space + 1).trim()]
}

/**
 * The column name a MERGEFIELD asks for. Quoted so a header with a space
 * survives; a bare name stops at the first whitespace, which keeps the
 * `\* MERGEFORMAT`-style switches out of the name.
 */
export function mergeFieldName(instr: string): string | null {
  const [keyword, rest] = splitInstruction(instr)
  if (keyword !== 'MERGEFIELD' || !rest) return null
  const quoted = /^"([^"]*)"/.exec(rest)
  return quoted ? quoted[1]! : (rest.split(/\s/)[0] ?? null)
}

/** Word's placeholder for a field whose cached result has not been filled in. */
export function placeholderText(name: string): string {
  return `«${name}»`
}

const SWITCH_RE = /\\([bf*])\s+(?:"([^"]*)"|(\S+))/g

export function mergeFieldSwitches(instr: string): MergeFieldSwitches {
  const out: MergeFieldSwitches = { before: '', after: '', caseFormat: null }
  for (const match of instr.matchAll(SWITCH_RE)) {
    const argument = match[2] ?? match[3] ?? ''
    if (match[1] === 'b') out.before = argument
    else if (match[1] === 'f') out.after = argument
    // `\* MERGEFORMAT` and `\* CHARFORMAT` are Word's own "keep the formatting"
    // markers, not a case instruction
    else if (!/^MERGEFORMAT$/i.test(argument) && !/^CHARFORMAT$/i.test(argument)) {
      out.caseFormat = argument
    }
  }
  return out
}

function applyCaseFormat(value: string, format: string | null): string {
  switch (format?.toLowerCase()) {
    case 'upper':
      return value.toUpperCase()
    case 'lower':
      return value.toLowerCase()
    case 'firstcap':
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
    case 'caps':
      return value
        .toLowerCase()
        .replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    default:
      return value
  }
}

/** the record a cursor position reads; past the last row every field is empty,
 *  the way the trailing labels of Word's last sheet come out blank */
function recordAt(data: MergeData, index: number): MergeRecord {
  return data.records[Math.max(index, 0)] ?? {}
}

/** the value a record holds for `name`, or '' when the column is absent */
export function valueOf(record: MergeRecord, name: string): string {
  return record[name] ?? ''
}

/** the text a MERGEFIELD contributes for one row, switches applied */
export function mergeFieldText(instr: string, values: MergeValues): string {
  const name = mergeFieldName(instr)
  const value = applyCaseFormat(
    name ? valueOf(values, name) : '',
    mergeFieldSwitches(instr).caseFormat,
  )
  if (value === '') return ''
  const { before, after } = mergeFieldSwitches(instr)
  return before + value + after
}

/**
 * NEXT and SKIPIF are control fields: they move the record cursor or drop a
 * record. GenOffice writes one file per recipient, so there is no cursor to
 * move — a template that uses them is refused before the batch starts rather
 * than merged as if every recipient were the same record. The cursor-aware
 * engine (`mergeRecords`, `mergeBlockTree`) does support them for consumers that
 * walk a whole template in one pass.
 */
export function isMergeControlField(instr: string): boolean {
  const keyword = splitInstruction(instr)[0]
  return keyword === 'NEXT' || keyword === 'SKIPIF'
}

/** Word's own placeholder for a field with no cached result. */
export function mergePlaceholder(name: string): string {
  return placeholderText(name)
}

export function isMergeField(instr: string): boolean {
  // a MERGEFIELD with no parsable name is not a field the merge can resolve:
  // counting it as one would leave a raw field in the output and report success
  return splitInstruction(instr)[0] === 'MERGEFIELD' && mergeFieldName(instr) !== null
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
 * Word's `IF` field: `IF «Name» "yes" "no"`, `IF «Name» = "Sales" "a" "b"`,
 * `IF «Amount» > «Threshold» "High" "Low"`.
 *
 * The evaluation is the canonical one the engine uses for control fields, so
 * the preview, the editor merge and the OOXML patch all answer an `IF` the same
 * way. An operand is a column only when Word writes it as one: wrapped in
 * guillemets or spelled out as a MERGEFIELD. A bare word is a literal — reading
 * `SKIPIF Status = "yes"` as the column `Status` would make a template skip or
 * keep rows at random.
 */

/**
 * An IF with no comparison tests one operand: `IF «Paid» "yes" "no"` is true
 * when the column holds anything. A bare word with no guillemets is a literal,
 * so it is true exactly when it is non-empty text.
 */
function isTruthyOperand(text: string, record: MergeRecord): boolean {
  const value = resolveOperand(text, record)
  return value !== '' && value !== '0'
}

/**
 * Evaluate an IF / SKIPIF comparison. Word writes `«Field» = "literal"` or
 * `«Field» = «Other»`; both sides are resolved against the record first, so a
 * MERGEFIELD wrapper around a name is invisible here.
 */
export function compareOperands(
  left: string,
  op: string,
  right: string,
  record: MergeRecord,
): boolean {
  const a = resolveOperand(left, record)
  const b = resolveOperand(right, record)
  // Word compares numerically when both sides are numbers: `IF 9 < 50` is true
  const na = numeric(a)
  const nb = numeric(b)
  if (na !== null && nb !== null) return compareValues(na, nb, op)
  return compareValues(a, b, op)
}

function numeric(text: string): number | null {
  const t = text.trim()
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null
  return Number(t)
}

function compareValues<T extends string | number>(a: T, b: T, op: string): boolean {
  switch (op) {
    case '=':
    case '<>':
      return (a === b) === (op === '=')
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
    default:
      return false
  }
}

/**
 * Resolve one comparison operand against the record.
 *
 * A bare word is a LITERAL, not a field reference: in `SKIPIF Status = "yes"`
 * `Status` is the text "Status" and `"yes"` is the text "yes", so the test is
 * false for every record. Word only treats an operand as a data column when it
 * is wrapped in guillemets (`«Status»`) or carries the MERGEFIELD keyword.
 */
function resolveOperand(token: string, record: MergeRecord): string {
  const trimmed = token.trim()
  const quoted = /^"(.*)"$/s.exec(trimmed)
  if (quoted) return quoted[1] ?? ''
  const guillemet = /^«([^»]*)»$/.exec(trimmed)
  if (guillemet) return valueOf(record, guillemet[1] ?? '')
  const instruction = /^MERGEFIELD\s+(?:"([^"]*)"|(\S+))/i.exec(trimmed)
  if (instruction) return valueOf(record, instruction[1] ?? instruction[2] ?? '')
  return trimmed
}

/**
 * The first comparison an IF/SKIPIF instruction carries, plus whatever follows it.
 *
 * `right` must stop at the operand's own end: in `Skip = "yes" "hidden" "shown"`
 * the right operand is `"yes"` and the two branch literals are what is left, so
 * the trailing group has to be lazy about where `right` stops and greedy about
 * what it keeps.
 */
function parseComparison(
  instr: string,
): { left: string; op: string; right: string; rest: string } | null {
  const m = /^(.+?)\s*(<>|=|<=|>=|<|>)\s*("(?:[^"]*)"|\S+)(?:\s+([\s\S]*))?$/.exec(instr.trim())
  return m ? { left: m[1]!, op: m[2]!, right: m[3]!, rest: m[4] ?? '' } : null
}

/** true when an IF/SKIPIF condition holds for this record */
export function conditionHolds(instr: string, record: MergeRecord): boolean {
  const [, rest] = splitInstruction(instr)
  const cmp = parseComparison(rest)
  if (!cmp) {
    // no comparison: the FIRST operand is the test (`IF «Paid» "got" "missed"`),
    // not the whole instruction — that is non-empty text for every record, so
    // the false branch would be unreachable
    return isTruthyOperand(tokenizeOperands(rest)[0] ?? '', record)
  }
  return compareOperands(cmp.left, cmp.op, cmp.right, record)
}

/**
 * The branch an IF instruction selects, unwrapped from its quotes.
 *
 * Word writes `IF «Field» = "yes" "hidden" "shown"` — the condition comes
 * first, so the branches are whatever follows the comparison, not the first two
 * tokens. An IF with no comparison (`IF «Field» "yes" "no"`) uses the field as
 * the test and takes the two operands as the branches.
 */
export function ifBranch(instr: string, record: MergeRecord): string {
  const [, rest] = splitInstruction(instr)
  const branches = branchesAfterCondition(rest)
  const chosen = conditionHolds(instr, record) ? (branches[0] ?? '') : (branches[1] ?? '')
  // the branch is literal text. Word evaluates a field inside an IF only when
  // it is nested as its own field (`{ IF … "Hello { MERGEFIELD X }" … }`); a
  // guillemet typed into the branch is just characters. Substituting here while
  // `fieldReferencedColumns` refuses to count it as a column would silently
  // blank out a name the source does not have.
  return chosen.replace(/^"(.*)"$/s, '$1')
}

/** the two branch literals of an IF, with the condition stripped off the front */
function branchesAfterCondition(rest: string): string[] {
  // parseComparison returns everything after the right operand, which for an IF
  // is exactly the two branches; without a comparison the first operand is the
  // test itself, so drop it and take what follows
  const cmp = parseComparison(rest)
  const operands = tokenizeOperands(cmp ? cmp.rest : rest)
  return cmp ? operands : operands.slice(1)
}

/**
 * Split the IF operands on whitespace but keep a quoted run (with spaces)
 * together: `Skip = "yes" "a b" "c d"` -> 5 tokens.
 */
function tokenizeOperands(rest: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i]!
    if (ch === '"') {
      quoted = !quoted
      current += ch
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/** what a control field does to the run that carries it */
export type ControlEffect =
  | { readonly kind: 'next' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'skipNoop' }
  | { readonly kind: 'if'; readonly text: string }

export function controlEffect(instr: string, record: MergeRecord): ControlEffect | null {
  const [keyword] = splitInstruction(instr)
  if (keyword === 'NEXT') return { kind: 'next' }
  if (keyword === 'SKIPIF')
    return conditionHolds(instr, record) ? { kind: 'skip' } : { kind: 'skipNoop' }
  if (keyword === 'IF') return { kind: 'if', text: ifBranch(instr, record) }
  return null
}

/** Word's `IF` field, as the fork's consumers name it. */
export function isConditionalField(instr: string): boolean {
  if (splitInstruction(instr)[0] !== 'IF') return false
  const [, rest] = splitInstruction(instr)
  const cmp = parseComparison(rest)
  // a comparison is only an IF if something follows it to print: Word writes
  // `IF cond "yes" "no"`, and `IF cond "yes"` prints nothing when the test is
  // false. `IF cond` alone has no branch at all.
  if (cmp) return branchesAfterCondition(rest).length > 0
  const operands = tokenizeOperands(rest)
  // without a comparison the first operand is the test and the rest are branches;
  // a dangling operator (`IF «Status» =`) is a malformed instruction, and the
  // model refuses it rather than merging the operator into the document
  return operands.length >= 2 && !/^(<>|<=|>=|=|<|>)$/.test(operands[1] ?? '')
}

/** The branch an `IF` selects for this row; null when the instruction is not an IF. */
export function evaluateConditionalField(instr: string, values: MergeValues): string | null {
  if (!isConditionalField(instr)) return null
  return ifBranch(instr, values)
}

/**
 * The columns an instruction actually reads.
 *
 * One instruction must have exactly one interpretation. An `IF` prints literal
 * text, and that text may itself contain «guillemets» — Word's display form for a
 * field name — which are not operands. `IF «Status» = "vip" "Xin chào «Khách
 * VIP»" ""` reads the column `Status` only; requiring a column named `Khách VIP`
 * would reject a template Word merges happily.
 *
 * Returns an empty list for an instruction the merge model cannot evaluate; the
 * caller reports it as unsupported rather than guessing at its columns.
 */
export function fieldReferencedColumns(instr: string): string[] {
  if (isMergeField(instr)) {
    const name = mergeFieldName(instr)
    return name ? [name] : []
  }
  if (!isConditionalField(instr)) return []
  const [, rest] = splitInstruction(instr)
  // the condition's operands, taken with the same grammar `resolveOperand`
  // uses. Tokenising the whole instruction by whitespace loses an operand that
  // contains a space — `IF MERGEFIELD Amount > 10 "High" "Low"` would report no
  // column at all while the evaluator reads `Amount`.
  const cmp = parseComparison(rest)
  const operands = cmp ? [cmp.left, cmp.right] : tokenizeOperands(rest).slice(0, 1)
  const names: string[] = []
  for (const token of operands) {
    const name = operandColumn(token)
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** the column one IF/SKIPIF operand names, or null when it is a literal */
function operandColumn(token: string): string | null {
  const trimmed = token.trim()
  const guillemet = /^«([^»]*)»$/.exec(trimmed)
  if (guillemet) {
    const name = (guillemet[1] ?? '').trim()
    return name || null
  }
  const instruction = /^MERGEFIELD\s+(?:"([^"]*)"|(\S+))/i.exec(trimmed)
  if (instruction) {
    const name = (instruction[1] ?? instruction[2] ?? '').trim()
    return name || null
  }
  return null
}

/** Can the per-recipient merge model evaluate this instruction at all? */
export function isMergeableFieldInstruction(instr: string): boolean {
  return isMergeField(instr) || isConditionalField(instr)
}

/**
 * The run-position cursor a single template pass walks with.
 *
 * This is the cursor-aware half of the engine: it is what makes NEXT and SKIPIF
 * mean what Word means when a consumer walks a whole template in one pass. The
 * per-recipient workflow does not use it — it writes one file per recipient —
 * but the semantics live here so there is only one definition of a control field.
 */
export interface MergeCursorState {
  /** index into data.records; NEXT moves it forward */
  index: number
  /** a NEXT fired during this pass */
  next: boolean
  /** a SKIPIF tested true during this pass */
  skipped: boolean
}

/** true when every run in the paragraph was consumed by a control field, so the
 *  paragraph itself must not survive into the merged output */
function consumedByControlField(runs: readonly Run[] | undefined): boolean {
  if (!runs || runs.length === 0) return false
  return runs.every((run) => {
    if (!run.instrField) return false
    const [keyword] = splitInstruction(run.instrField)
    return keyword === 'NEXT' || keyword === 'SKIPIF'
  })
}

function mergeRun(
  run: Run,
  record: MergeRecord,
): { run: Run; effect: ControlEffect | null; untouched: boolean } {
  const instr = run.instrField
  if (!instr) return { run, effect: null, untouched: false }
  const [keyword] = splitInstruction(instr)
  // keep the run's formatting, drop the instruction — the value replaces both
  const { instrField: _dropped, fldDirty: _dirty, ...rest } = run
  if (keyword === 'MERGEFIELD') {
    return {
      run: { ...rest, text: mergeFieldText(instr, record) },
      effect: null,
      untouched: false,
    }
  }
  const effect = controlEffect(instr, record)
  // an unrelated field (PAGE, DATE, a Zotero citation): leave the run alone
  if (!effect) return { run, effect: null, untouched: true }
  return {
    run: { ...rest, text: effect.kind === 'if' ? effect.text : '' },
    effect,
    untouched: false,
  }
}

function mergeRuns(
  runs: readonly Run[] | undefined,
  data: MergeData,
  cursor: MergeCursorState,
): Run[] {
  if (!runs || runs.length === 0) return []
  const out: Run[] = []
  for (const run of runs) {
    // a run without a field is the template's own content: an image or an
    // index entry carries its payload beside an empty text and must survive
    // every record's copy
    if (!run.instrField) {
      out.push(run)
      continue
    }
    const record = recordAt(data, cursor.index)
    const { run: merged, effect, untouched } = mergeRun(run, record)
    // a field this merge knows nothing about (a PAGE, a DATE) is left exactly as
    // it was — it still evaluates in Word, and dropping it would lose the field
    if (untouched) {
      out.push(run)
      continue
    }
    if (effect === null) {
      // a substituted MERGEFIELD keeps its slot even when the column is empty
      // or absent — the position is the user's layout; only a control field
      // takes its paragraph's content away
      out.push(merged)
      continue
    }
    if (effect.kind === 'next') {
      cursor.next = true
      cursor.index += 1
      continue
    }
    if (effect.kind === 'skip') {
      cursor.skipped = true
      continue
    }
    // skipNoop: a SKIPIF that tested false — contributes nothing, marks nothing
    if (effect.kind === 'skipNoop') continue
    // IF contributes its chosen branch inline, exactly where the field sat
    if (effect.text) out.push(merged)
  }
  return out
}

/**
 * Walk the template once, substituting fields from `data` as the cursor moves.
 *
 * The tree is walked structurally rather than through a serializer, so a field
 * inside a table cell is substituted exactly like one in the body. Floating
 * textboxes are display-only (the save keeps their original bytes), so a field
 * inside one stays as it was — for the same reason as the nested tables below.
 */
export function mergeRecords(
  blocks: readonly Block[],
  data: MergeData,
  startIndex = 0,
): { blocks: Block[]; cursor: MergeCursorState } {
  const cursor: MergeCursorState = { index: startIndex, next: false, skipped: false }
  // merge FIRST, drop the paragraph afterwards: a paragraph holding only a NEXT
  // is invisible in the output, but its field still has to advance the cursor —
  // filtering before the walk would leave every record reading the same row
  const walk = (list: readonly Block[]): Block[] => {
    const out: Block[] = []
    for (const block of list) {
      const controlOnly = consumedByControlField(block.runs)
      const runs = mergeRuns(block.runs, data, cursor)
      if (controlOnly) continue
      const copy: Block = { ...block, runs }
      // the table is merged with the SAME cursor object, so a NEXT inside a
      // cell advances the body walk too — that is how a label sheet stays in step
      if (block.table) copy.table = mergeTable(block.table, data, cursor)
      out.push(copy)
    }
    return out
  }
  return { blocks: walk(blocks), cursor }
}

/** table cells, their rich paragraphs and any nested table */
function mergeTable(
  table: NonNullable<Block['table']>,
  data: MergeData,
  cursor: MergeCursorState,
): NonNullable<Block['table']> {
  return {
    ...table,
    // TableModel.rows is a grid of cells (w:tr -> w:tc), not row objects
    rows: table.rows.map((row) =>
      row.map((cell) => {
        const next = { ...cell }
        if (cell.richParas) {
          next.richParas = cell.richParas.map((para) => ({
            ...para,
            runs: mergeRuns(para.runs, data, cursor),
          }))
          next.paras = next.richParas.map((para) => (para.runs ?? []).map((r) => r.text).join(''))
        }
        // nestedTables are display-only: the outer table keeps their original
        // bytes on save, so substituting inside one would change what is shown
        // but not what is written — the field would come back on the next open
        return next
      }),
    ),
  }
}

/**
 * Merge every record into its own copy of the block tree.
 *
 * A template with no NEXT yields one set per record — the letter-per-recipient
 * case. A NEXT hands the remainder of the template to the next record, which is
 * what a directory or a label sheet does. A SKIPIF removes the whole record.
 */
export function mergeBlockTree(blocks: readonly Block[], data: MergeData): Block[][] {
  const out: Block[][] = []
  let index = 0
  for (let round = 0; index < data.records.length && round <= data.records.length; round += 1) {
    const { blocks: merged, cursor } = mergeRecords(blocks, data, index)
    if (!cursor.skipped) out.push(merged)
    // a NEXT-driven pass (a label sheet) consumed several records; the next
    // sheet starts after the last one read
    index = cursor.index + 1
  }
  return out
}

/**
 * Build a recipient list from already-parsed spreadsheet rows.
 *
 * Takes `string[][]` rather than CSV text on purpose: the CSV text→rows step
 * belongs to xlsx-gateway, which already owns `parseCsv` (RFC 4180 quotes, the
 * BOM, CRLF, the `sep=` declaration) and is what Sheets uses on open. The app
 * layer wires them together, so a list that opens correctly in Sheets opens
 * correctly here, and this package keeps no CSV parser of its own.
 *
 * The first row names the columns; the rest are records.
 */
export function mergeDataFromRows(rows: readonly (readonly string[])[]): MergeData {
  if (rows.length === 0) return { fields: [], records: [] }
  const header = (rows[0] ?? []).map((h) => h.trim())
  const records = rows.slice(1).map((row) => {
    const record: MergeRecord = {}
    header.forEach((name, i) => {
      record[name] = row[i] ?? ''
    })
    return record
  })
  return { fields: header, records }
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
      out.push(resolvedRun(run, mergeFieldText(instr, values)))
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
    // an IF the model cannot evaluate is counted as unsupported rather than left
    // in the document as a field Word would re-evaluate on open
    if (splitInstruction(instr)[0] === 'IF') {
      report.unsupported += 1
      out.push(run)
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
  if (isMergeControlField(instr)) {
    // NEXT/SKIPIF need a record cursor; one file per recipient has none
    report.unsupported += 1
    return null
  }
  if (!isMerge && !isIf) {
    // an IF the model cannot evaluate is reported, so the caller knows the field
    // was left in the document rather than merged
    if (splitInstruction(instr)[0] === 'IF') report.unsupported += 1
    return null
  }
  const name = isMerge ? mergeFieldName(instr) : null
  const value = isIf
    ? evaluateConditionalField(instr, values)
    : name && name in values
      ? mergeFieldText(instr, values)
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
    replacement: `<w:r>${rPr}${runContentXml(value)}</w:r>`,
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
          `${runContentXml(value)}${after}</w:r>`,
      })
      report.applied += 1
    }
  }
  // a begin with no end is a broken field: it cannot be merged
  report.unsupported += open.length
  return applyPatches(xml, patches)
}

/**
 * A recipient value as run content.
 *
 * `escapeXmlText` is the serializer the rest of the engine uses: it drops the
 * characters XML 1.0 cannot carry (U+0000, U+0001, …) and escapes &, < and >.
 * Tabs and line breaks are not text — Word prints them as elements — so a
 * postal address spanning two lines becomes `<w:br/>` rather than a newline
 * inside `<w:t>`, which Word renders as a space.
 */
function runContentXml(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split(/([\t\n])/g)
    .map((segment) => {
      if (segment === '') return ''
      if (segment === '\t') return '<w:tab/>'
      if (segment === '\n') return '<w:br/>'
      return `<w:t xml:space="preserve">${escapeXmlText(segment)}</w:t>`
    })
    .join('')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/**
 * Every field instruction sitting in a piece of OOXML, found the same way the
 * merge engine reads it.
 *
 * A regex cannot do this: `w:fldChar` lives *inside* a `w:r`, Word splits one
 * instruction across several `w:instrText` elements, and `<w:fldSimple w:instr=
 * " MERGEFIELD Name ">` carries the instruction in an attribute rather than as
 * element text. Both forms are walked structurally here, so a validator that
 * uses this list sees exactly the fields `patchMergeFieldXml` can and cannot
 * rewrite — nothing that is left untouched can be reported as merged.
 */
function simpleFieldInstructions(xml: string): string[] {
  const out: string[] = []
  const open: string[] = []
  let i = 0
  for (;;) {
    const nextOpen = xml.indexOf('<w:fldSimple', i)
    const nextClose = xml.indexOf('</w:fldSimple>', i)
    if (nextOpen < 0 && nextClose < 0) break
    if (nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)) {
      const end = tagEnd(xml, nextOpen)
      if (end < 0) break
      const openTag = xml.slice(nextOpen, end + 1)
      const instr = /w:instr\s*=\s*"([^"]*)"/.exec(openTag)?.[1] ?? ''
      // the engine decodes entities in the instruction before matching it, so
      // the validator has to see the same text
      const decoded = decodeEntities(instr)
      // a self-closing fldSimple has no body to rewrite, but it is still a field
      if (openTag.endsWith('/>')) {
        if (decoded) out.push(decoded)
        i = end + 1
        continue
      }
      open.push(decoded)
      i = end + 1
      continue
    }
    const instr = open.pop()
    if (instr) out.push(instr)
    i = nextClose + 14
  }
  return out
}

function complexFieldInstructions(xml: string): string[] {
  const out: string[] = []
  const open: string[] = []
  for (const run of splitRuns(xml)) {
    for (const marker of fieldMarkers(run.inner)) {
      if (marker.kind === 'begin') open.push('')
      else if (marker.kind === 'instr' && open.length > 0) open[open.length - 1] += marker.text
      else if (marker.kind === 'end') {
        const instr = open.pop()
        if (instr && instr.trim()) out.push(instr)
      }
    }
  }
  // an unterminated begin is still a field the merge cannot rewrite
  for (const instr of open) if (instr.trim()) out.push(instr)
  return out
}

export function fieldInstructionsInXml(xml: string): string[] {
  if (!xml) return []
  return [...simpleFieldInstructions(xml), ...complexFieldInstructions(xml)]
}

/**
 * The merge-relevant field instructions in a part's raw OOXML.
 *
 * A header/footer part is parsed for *display*: its field spans collapse into
 * the cached result text («Name»), so the paragraph model carries no
 * `instrField`. Anything that has to know whether a part still contains a
 * MERGEFIELD or an IF has to read the markup, not the display runs.
 */
export function mergeFieldInstructionsInXml(xml: string): string[] {
  const out: string[] = []
  for (const instr of fieldInstructionsInXml(xml)) {
    const trimmed = instr.trim()
    if (/^\s*(MERGEFIELD|IF|NEXT|SKIPIF)\b/i.test(trimmed) && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
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

export function sanitizeFileNamePart(raw: string, maxChars = 0): string {
  const cleaned = raw
    .replace(ILLEGAL_NAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, maxChars > 0 ? maxChars : undefined)
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
 * Expand a `{index}_{Name}_{Department}` style pattern.
 *
 * The token grammar is exported (`patternTokens`, `isIndexToken`) so the UI
 * validates exactly what the engine expands: an unknown token is reported by the
 * dialog instead of silently vanishing from the file name. Tokens are not
 * truncated individually — the whole base is fitted to the byte budget once, so a
 * long first token cannot delete a later one while the name still has room.
 */
export function patternTokens(pattern: string): string[] {
  return [...pattern.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1].trim())
}

export function isIndexToken(token: string): boolean {
  return /^\d*index$/i.test(token)
}

/**
 * `{3index}` asks for at least three digits. The padding is applied before the
 * name is fitted to the byte budget, so an unbounded width — `{100000000index}` —
 * would allocate a 100 MB string for every recipient. Word's own numbering never
 * needs more than this, and anything larger is clamped rather than honoured.
 */
const MAX_INDEX_PADDING = 100

export function buildOutputFileName(options: FileNamePatternOptions): string {
  const { pattern, index, total, values, extension } = options
  // the widest index in the batch decides the padding, so 100 recipients produce
  // 001..100 rather than 1, 2, … 100 (which would sort as text)
  const indexWidth = Math.max(1, String(total).length)
  const expanded = pattern.replace(/\{([^{}]*)\}/g, (_whole, key: string) => {
    const trimmed = key.trim()
    if (isIndexToken(trimmed)) {
      // `{3index}` asks for at least three digits; the batch size can ask for more
      const digits = /^(\d*)index$/i.exec(trimmed)?.[1] ?? ''
      const requested = digits === '' ? 0 : Number(digits)
      const width = Math.min(Math.max(requested, indexWidth), MAX_INDEX_PADDING)
      return String(index).padStart(width, '0')
    }
    if (!trimmed) return ''
    const value = values[trimmed]
    if (value === undefined) return ''
    return sanitizeFileNamePart(value, 0)
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
