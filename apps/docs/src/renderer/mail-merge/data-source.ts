/**
 * Turn a recipient source (CSV file, XLSX file, or an open GenOffice
 * spreadsheet) into the normalized recipient list the picker and the export
 * pipeline work with.
 */
import { xlsxSheetGrid, xlsxSheetNames, xlsxToGrid } from '@genoffice/file-parse/xlsx'
import {
  decodeCsvText,
  parseCsvRows,
  sniffDelimiter,
  splitSepDeclaration,
  strayQuoteAfterField,
  stripBom,
  trimEmptyRows,
  unterminatedQuoteAt,
} from './csv'
import type { MailMergeColumn, MailMergeRecipient, MailMergeSource } from './types'

/** A hard ceiling keeps the picker and the export bounded on pathological files. */
export const MAX_RECIPIENTS = 100_000
export const MAX_COLUMNS = 100
/** One spreadsheet read returns at most this many cells. */
export const MAX_RANGE_CELLS = 200_000

export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Column names come from the header row. Empty headers become "Column N", and
 * a repeated header gets a numeric suffix so two columns can never collide —
 * merge fields address columns by name, so ambiguity would silently pick one.
 *
 * Uniqueness is checked against every name already handed out, not just against
 * the original headers: `['Name', 'Name', 'Name (2)']` would otherwise give the
 * second column the generated name "Name (2)" and the third column the literal
 * header "Name (2)" — the same key, so one recipient value would overwrite the
 * other. The original header text is kept in `header` either way.
 */
/**
 * Give every header a name a merge field can refer to.
 *
 * A repeated header gets `Name`, `Name (2)`, `Name (3)` … — but a generated alias
 * may never take a name that belongs to a *different* header. With
 * `Name | Name | Name (2)` the third column is literally named `Name (2)`, so the
 * second `Name` must be renamed to `Name (3)`: otherwise the alias and the real
 * column would be the same field, and one of the two columns' data would be
 * unreachable. Names are reserved in two passes so a literal header is claimed
 * before any alias is invented.
 */
export function buildColumns(header: readonly string[]): MailMergeColumn[] {
  if (header.length > MAX_COLUMNS) {
    throw new Error(
      `the source has ${header.length} columns; Mail Merge reads at most ${MAX_COLUMNS}`,
    )
  }
  const bases = header.map((raw, index) => raw.trim() || `Column ${index + 1}`)
  const occurrences = new Map<string, number>()
  for (const base of bases) occurrences.set(base, (occurrences.get(base) ?? 0) + 1)
  // a header that appears once owns its exact name; nothing may take it
  const taken = new Set(bases.filter((base) => occurrences.get(base) === 1))
  const seen = new Map<string, number>()
  return header.map((raw, index) => {
    const base = bases[index]
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    if (occurrences.get(base) === 1) {
      taken.add(base)
      return { name: base, header: raw }
    }
    let name = count === 1 ? base : `${base} (${count})`
    let suffix = count
    while (taken.has(name)) {
      suffix += 1
      name = `${base} (${suffix})`
    }
    taken.add(name)
    return { name, header: raw, duplicateOf: count }
  })
}

export function sourceFromRows(
  rows: readonly (readonly string[])[],
  options: {
    kind: MailMergeSource['kind']
    label: string
    sheet?: string
    hasHeader: boolean
    delimiter?: string
  },
): MailMergeSource {
  // the limits are real, but they are enforced by refusing the source, never by
  // quietly dropping rows or columns: a truncated list looks complete and the
  // batch would merge for the wrong people
  const recipientLimit = options.hasHeader ? MAX_RECIPIENTS + 1 : MAX_RECIPIENTS
  if (rows.length > recipientLimit) {
    const count = rows.length - (options.hasHeader ? 1 : 0)
    throw new Error(
      `the source has ${count} recipients, more than Mail Merge can handle (${MAX_RECIPIENTS}); narrow the range or split the list`,
    )
  }
  const headerRow = options.hasHeader ? (rows[0] ?? []) : []
  const body = options.hasHeader ? rows.slice(1) : rows
  // a row with more values than the header has columns is not a row to trim: the
  // extra values are data the user put in the file, so the source grows columns
  // to hold them rather than dropping them
  const widest = body.reduce((max, row) => Math.max(max, row.length), 0)
  const headerForColumns = options.hasHeader
    ? Array.from({ length: Math.max(headerRow.length, widest) }, (_, i) => headerRow[i] ?? '')
    : Array.from({ length: Math.max(1, widest) }, () => '')
  const columns = buildColumns(headerForColumns)
  const recipients: MailMergeRecipient[] = body.map((row, id) => {
    // a null prototype is not cosmetic: `values['__proto__'] = 'x'` on a plain
    // object hits Object.prototype's setter and the column silently disappears.
    // With no prototype every header is an own key, and `name in values` is an
    // own-key test rather than a walk up an inheritance chain.
    const values: Record<string, string> = Object.create(null) as Record<string, string>
    columns.forEach((column, i) => {
      values[column.name] = row[i] ?? ''
    })
    return { id, values, selected: true }
  })
  return {
    kind: options.kind,
    label: options.label,
    ...(options.sheet !== undefined ? { sheet: options.sheet } : {}),
    columns,
    recipients,
    hasHeader: options.hasHeader,
    ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
  }
}

export function loadCsvSource(base64: string, label: string, hasHeader: boolean): MailMergeSource {
  const decoded = decodeCsvText(base64ToBytes(base64))
  // Excel writes `sep=;` as its first line; it is a delimiter declaration, not
  // a header row, and must not become a recipient
  const { text, delimiter: declared } = splitSepDeclaration(stripBom(decoded))
  const delimiter = declared ?? sniffDelimiter(text)
  // an unclosed quote swallows the rest of the file: every row after it would be
  // read as one field, so the source is refused rather than parsed into nonsense
  const broken = unterminatedQuoteAt(text, delimiter)
  if (broken !== null) {
    throw new Error(
      `the file has a quote that never closes (near character ${broken}); the rows after it cannot be read`,
    )
  }
  // `"Alice"Jones` is not a field: neither `Alice` nor `AliceJones` is what the
  // file says, so the row is refused instead of being guessed
  const glued = strayQuoteAfterField(text, delimiter)
  if (glued !== null) {
    throw new Error(
      `the file has a quote in the middle of a field (near character ${glued}); check the row that starts there`,
    )
  }
  const rows = trimEmptyRows(parseCsvRows(text, delimiter))
  return sourceFromRows(rows, { kind: 'csv', label, hasHeader, delimiter })
}

export async function listXlsxSheets(base64: string): Promise<string[]> {
  // names come from workbook.xml alone: parsing every worksheet to fill a
  // dropdown reads the whole workbook for a string the picker never uses
  return xlsxSheetNames(base64ToBytes(base64))
}

export async function loadXlsxSource(
  base64: string,
  label: string,
  sheetName: string | null,
  hasHeader: boolean,
): Promise<MailMergeSource> {
  // read only as far as the recipient ceiling plus the header: a workbook with
  // more rows than Mail Merge can handle is refused below, never trimmed into a
  // list that looks complete
  // only the requested worksheet is read: an unrelated wide or malformed sheet
  // must not make a valid recipient list unusable
  const sheet = sheetName
    ? await xlsxSheetGrid(base64ToBytes(base64), sheetName, MAX_RECIPIENTS + 2)
    : (await xlsxToGrid(base64ToBytes(base64), MAX_RECIPIENTS + 2))[0]
  if (!sheet) throw new Error('the workbook has no worksheets')
  // a formula with no cached result has no value to merge. Writing the formula
  // text into a letter is not a recipient field, and writing nothing is silent,
  // so the workbook is refused and the user is told which cells to fix
  if (sheet.uncachedFormulas?.length) {
    throw new Error(
      `worksheet "${sheet.name}" has ${sheet.uncachedFormulas.length} formula cell(s) with no computed value (${sheet.uncachedFormulas.slice(0, 5).join(', ')}${sheet.uncachedFormulas.length > 5 ? ', …' : ''}); open the file in a spreadsheet app, let it recalculate, save it, and try again`,
    )
  }
  return sourceFromRows(sheet.rows, { kind: 'xlsx', label, sheet: sheet.name, hasHeader })
}

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function columnLabel(index: number): string {
  let n = index + 1
  let label = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    label = COLUMN_LETTERS[rem] + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

/** `C5` → the 0-based column index of C, i.e. 2. */
/**
 * Column number of a range's letter run.
 *
 * `Z` is 25, `XFD` is 16383 — the last column a worksheet can have. The
 * accumulator is checked against `Number.isSafeInteger` on every step, so a
 * range like `ZZZZZZZZZZZZZZZZZZZZ1:ZZZZZZZZZZZZZZZZZZZZ2` is refused instead of
 * turning into Infinity and looping forever in `addressesInRange`.
 */
function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') return -1
    n = n * 26 + (ch.charCodeAt(0) - 64)
    if (!Number.isSafeInteger(n) || n > MAX_EXCEL_COLS) return -1
  }
  return n - 1
}

/** Excel's own bounds: a worksheet cannot have more columns or rows than these. */
const MAX_EXCEL_COLS = 16_384
const MAX_EXCEL_ROWS = 1_048_576

export interface RangeBounds {
  firstCol: number
  lastCol: number
  firstRow: number
  lastRow: number
}

/** The rectangle a range string selects, in 0-based column / 1-based row terms. */
export function rangeBounds(range: string): RangeBounds | null {
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(range.trim())
  if (!m) return null
  const firstCol = columnIndex(m[1])
  const lastCol = columnIndex(m[3])
  // parseInt on a 40-digit row number is not a safe integer: it cannot name a
  // real row, and letting it through would make the cell count NaN and the
  // "is this range too big" test meaningless
  const firstRowRaw = Number(m[2])
  const lastRowRaw = Number(m[4])
  if (!Number.isSafeInteger(firstRowRaw) || !Number.isSafeInteger(lastRowRaw)) return null
  // a row past Excel's ceiling is not a row the sheet can hold: clamping it
  // would silently read a different rectangle than the user typed
  if (firstRowRaw < 1 || lastRowRaw > MAX_EXCEL_ROWS) return null
  const firstRow = firstRowRaw
  const lastRow = lastRowRaw
  if (firstCol < 0 || lastCol < 0 || lastCol < firstCol || lastRow < firstRow) return null
  const cells = (lastCol - firstCol + 1) * (lastRow - firstRow + 1)
  if (!Number.isSafeInteger(cells) || cells <= 0) return null
  return { firstCol, lastCol, firstRow, lastRow }
}

/** How many cells the range selects, before any cap is applied. */
export function rangeCellCount(range: string): number {
  const b = rangeBounds(range)
  if (!b) return 0
  return (b.lastCol - b.firstCol + 1) * (b.lastRow - b.firstRow + 1)
}

/** A1:F500 → every address in the rectangle, capped so a wild range cannot hang the tab. */
export function addressesInRange(range: string, maxCells = MAX_RANGE_CELLS): string[] {
  const b = rangeBounds(range)
  if (!b) return []
  const out: string[] = []
  for (let r = b.firstRow; r <= b.lastRow && out.length < maxCells; r++) {
    for (let c = b.firstCol; c <= b.lastCol && out.length < maxCells; c++) {
      out.push(`${columnLabel(c)}${r}`)
    }
  }
  return out
}

/** Anything outside the requested rectangle is ignored, however wide the sheet is. */
interface BridgeCell {
  /** the model value behind the cell */
  value?: unknown
  /** the text the number format renders, present when it differs from `value` */
  display?: unknown
  formula?: string
}

/**
 * The value a recipient field should carry.
 *
 * The bridge reports the model value as `value` and, when a number format makes
 * the cell look different from that model value, the text the user sees as
 * `display`. Mail Merge writes what the user reads: an identifier formatted
 * `000000` merges as `001234`, a date cell merges as `1-Jan-24` rather than its
 * serial number 45292, and a currency cell merges as `$1,000.00`.
 *
 * A cell the bridge did not answer for is not a blank cell — it is a read that
 * did not happen, and merging an empty string for it would silently drop an
 * address. Those addresses are collected and reported.
 */
function cellText(
  cells: Record<string, BridgeCell | undefined>,
  col: number,
  row: number,
  missing: string[],
): string {
  const address = `${columnLabel(col)}${row}`
  const cell = cells[address]
  if (cell === undefined) {
    missing.push(address)
    return ''
  }
  const display = cell.display
  const text =
    display !== undefined && display !== null ? String(display) : String(cell.value ?? '')
  if (SPREADSHEET_ERRORS.has(text.trim().toUpperCase())) {
    throw new Error(
      `cell ${address} contains the spreadsheet error ${text.trim()}; fix the formula before merging`,
    )
  }
  return text
}

const SPREADSHEET_ERRORS = new Set([
  '#REF!',
  '#DIV/0!',
  '#VALUE!',
  '#NAME?',
  '#N/A',
  '#NUM!',
  '#NULL!',
])

export type SheetGridReader = (
  wcId: number,
  sheet: string,
  addresses: string[],
) => Promise<{ ok: boolean; result?: unknown; error?: string }>

/**
 * Read the live workbook through the shell's spreadsheet bridge: no save, no
 * intermediate file, and the values are the ones the user sees on screen.
 *
 * The rows are walked from the range's first row to its last row — not until
 * the first blank one — so a separator row in the middle of the selection does
 * not truncate the list, and a column further right than A is read from where
 * the user actually selected.
 */
export async function loadSheetSource(
  wcId: number,
  label: string,
  sheet: string,
  range: string,
  hasHeader: boolean,
  read: SheetGridReader = (id, s, addresses) => window.desktop.readSheetGrid(id, s, addresses),
): Promise<MailMergeSource> {
  const bounds = rangeBounds(range)
  if (!bounds) throw new Error('invalid range')
  // `addressesInRange` stops at the cap. A range bigger than one read can return
  // must be refused, not quietly trimmed: a truncated rectangle would look like a
  // complete recipient list and the batch would merge for the wrong people.
  const total = rangeCellCount(range)
  if (total > MAX_RANGE_CELLS) {
    throw new Error(
      `the range ${range} selects ${total} cells, more than one read can return (${MAX_RANGE_CELLS}); narrow the range, for example A1:D${Math.floor(MAX_RANGE_CELLS / (bounds.lastCol - bounds.firstCol + 1))}`,
    )
  }
  // the column and row ceilings are checked before the workbook is touched: an
  // oversized selection is refused outright, never read and then trimmed into a
  // list that looks complete
  const selectedColumns = bounds.lastCol - bounds.firstCol + 1
  if (selectedColumns > MAX_COLUMNS) {
    throw new Error(
      `the range ${range} selects ${selectedColumns} columns; Mail Merge reads at most ${MAX_COLUMNS}`,
    )
  }
  const selectedRows = bounds.lastRow - bounds.firstRow + 1
  const recipientCount = hasHeader ? selectedRows - 1 : selectedRows
  if (recipientCount > MAX_RECIPIENTS) {
    const fits = hasHeader ? MAX_RECIPIENTS + 1 : MAX_RECIPIENTS
    throw new Error(
      `the range ${range} selects ${recipientCount} recipients, more than Mail Merge can handle (${MAX_RECIPIENTS}); narrow the range, for example ${columnLabel(bounds.firstCol)}${bounds.firstRow}:${columnLabel(bounds.lastCol)}${bounds.firstRow + fits - 1}`,
    )
  }
  const addresses = addressesInRange(range, MAX_RANGE_CELLS)
  if (addresses.length !== total) {
    throw new Error(
      `the range ${range} could not be read completely (${addresses.length} of ${total} cells)`,
    )
  }
  if (addresses.length === 0) throw new Error('invalid range')
  const response = await read(wcId, sheet, addresses)
  if (!response.ok) throw new Error(response.error ?? 'the spreadsheet could not be read')
  const cells = (response.result as { cells?: Record<string, BridgeCell | undefined> } | undefined)
    ?.cells
  if (!cells) throw new Error('the spreadsheet returned no cells')
  const width = selectedColumns
  const rows: string[][] = []
  const missing: string[] = []
  for (let r = bounds.firstRow; r <= bounds.lastRow; r++) {
    const row: string[] = []
    for (let c = 0; c < width; c++) row.push(cellText(cells, bounds.firstCol + c, r, missing))
    rows.push(row)
  }
  // the addresses were requested explicitly; an address the workbook did not
  // answer for is a failed read, not an empty cell
  if (missing.length > 0) {
    throw new Error(
      `the spreadsheet did not return ${missing.length} cell(s) in the range ${range} (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}); the list is incomplete and was not loaded`,
    )
  }
  // blank rows at the end of the selection are not recipients; blank rows in
  // the middle are kept, exactly as a CSV or XLSX source keeps them
  while (rows.length > 0 && rows[rows.length - 1].every((v) => v.trim() === '')) rows.pop()
  return sourceFromRows(rows, { kind: 'sheets', label, sheet, hasHeader })
}
