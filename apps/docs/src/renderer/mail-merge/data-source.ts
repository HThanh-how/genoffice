/**
 * Turn a recipient source (CSV file, XLSX file, or an open GenOffice
 * spreadsheet) into the normalized recipient list the picker and the export
 * pipeline work with.
 */
import { xlsxToGrid } from '@genoffice/file-parse/xlsx'
import { parseCsvRows, sniffDelimiter, trimEmptyRows } from './csv'
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
export function buildColumns(header: readonly string[]): MailMergeColumn[] {
  const seen = new Map<string, number>()
  const taken = new Set<string>()
  return header.slice(0, MAX_COLUMNS).map((raw, index) => {
    const base = raw.trim() || `Column ${index + 1}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    let name = count > 1 ? `${base} (${count})` : base
    let suffix = count
    while (taken.has(name)) {
      suffix += 1
      name = `${base} (${suffix})`
    }
    taken.add(name)
    return {
      name,
      header: raw,
      ...(count > 1 ? { duplicateOf: count } : {}),
    }
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
  const data = rows.slice(0, MAX_RECIPIENTS + 1)
  const headerRow = options.hasHeader ? (data[0] ?? []) : []
  const columns = options.hasHeader
    ? buildColumns(headerRow)
    : buildColumns(Array.from({ length: Math.max(1, ...data.map((r) => r.length)) }, () => ''))
  const body = options.hasHeader ? data.slice(1) : data
  const recipients: MailMergeRecipient[] = body.map((row, id) => {
    const values: Record<string, string> = {}
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
  const text = new TextDecoder('utf-8').decode(base64ToBytes(base64))
  const delimiter = sniffDelimiter(text)
  const rows = trimEmptyRows(parseCsvRows(text, delimiter))
  return sourceFromRows(rows, { kind: 'csv', label, hasHeader, delimiter })
}

export async function listXlsxSheets(base64: string): Promise<string[]> {
  const grids = await xlsxToGrid(base64ToBytes(base64), 200)
  return grids.map((sheet) => sheet.name)
}

export async function loadXlsxSource(
  base64: string,
  label: string,
  sheetName: string | null,
  hasHeader: boolean,
): Promise<MailMergeSource> {
  const grids = await xlsxToGrid(base64ToBytes(base64))
  if (grids.length === 0) throw new Error('the workbook has no worksheets')
  const sheet = sheetName ? (grids.find((g) => g.name === sheetName) ?? grids[0]) : grids[0]
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
function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

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
  const firstRow = Math.max(1, parseInt(m[2], 10))
  const lastRow = Math.min(1_048_576, parseInt(m[4], 10))
  if (firstCol < 0 || lastCol < 0 || lastCol < firstCol || lastRow < firstRow) return null
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
function cellText(cells: Record<string, { value?: unknown }>, col: number, row: number): string {
  const cell = cells[`${columnLabel(col)}${row}`]
  return cell === undefined ? '' : String(cell.value ?? '')
}

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
  const addresses = addressesInRange(range, MAX_RANGE_CELLS)
  if (addresses.length !== total) {
    throw new Error(
      `the range ${range} could not be read completely (${addresses.length} of ${total} cells)`,
    )
  }
  if (addresses.length === 0) throw new Error('invalid range')
  const response = await read(wcId, sheet, addresses)
  if (!response.ok) throw new Error(response.error ?? 'the spreadsheet could not be read')
  const cells = (response.result as { cells?: Record<string, { value?: unknown }> } | undefined)
    ?.cells
  if (!cells) throw new Error('the spreadsheet returned no cells')
  const width = Math.min(MAX_COLUMNS, bounds.lastCol - bounds.firstCol + 1)
  const rows: string[][] = []
  for (let r = bounds.firstRow; r <= bounds.lastRow && rows.length < MAX_RECIPIENTS + 1; r++) {
    const row: string[] = []
    for (let c = 0; c < width; c++) row.push(cellText(cells, bounds.firstCol + c, r))
    rows.push(row)
  }
  // blank rows at the end of the selection are not recipients; blank rows in
  // the middle are kept, exactly as a CSV or XLSX source keeps them
  while (rows.length > 0 && rows[rows.length - 1].every((v) => v.trim() === '')) rows.pop()
  return sourceFromRows(rows, { kind: 'sheets', label, sheet, hasHeader })
}
