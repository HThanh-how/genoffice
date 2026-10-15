/**
 * Turn a recipient source (CSV file, XLSX file, or an open GenOffice
 * spreadsheet) into the normalized recipient list the picker and the export
 * pipeline work with.
 */
import { xlsxToGrid } from '@genoffice/file-parse'
import { parseCsvRows, sniffDelimiter, trimEmptyRows } from './csv'
import type { MailMergeColumn, MailMergeRecipient, MailMergeSource } from './types'

/** A hard ceiling keeps the picker and the export bounded on pathological files. */
export const MAX_RECIPIENTS = 100_000
export const MAX_COLUMNS = 100

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
 */
export function buildColumns(header: readonly string[]): MailMergeColumn[] {
  const seen = new Map<string, number>()
  return header.slice(0, MAX_COLUMNS).map((raw, index) => {
    const base = raw.trim() || `Column ${index + 1}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return {
      name: count > 1 ? `${base} (${count})` : base,
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
    : buildColumns(Array.from({ length: Math.max(1, ...data.map((r) => r.length)) }, (_, i) => ''))
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
  const sheet = sheetName
    ? grids.find((g) => g.name === sheetName) ?? grids[0]
    : grids[0]
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

/** A1:F500 → every address in the rectangle, capped so a wild range cannot hang the tab. */
export function addressesInRange(range: string, maxCells = 200_000): string[] {
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(range.trim())
  if (!m) return []
  const toIndex = (letters: string) => {
    let n = 0
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n - 1
  }
  const c1 = toIndex(m[1])
  const c2 = toIndex(m[3])
  const r1 = Math.max(1, parseInt(m[2], 10))
  const r2 = Math.min(1_048_576, parseInt(m[4], 10))
  if (c2 < c1 || r2 < r1) return []
  const out: string[] = []
  for (let r = r1; r <= r2 && out.length < maxCells; r++) {
    for (let c = c1; c <= c2 && out.length < maxCells; c++) out.push(`${columnLabel(c)}${r}`)
  }
  return out
}

/**
 * Read the live workbook through the shell's spreadsheet bridge: no save, no
 * intermediate file, and the values are the ones the user sees on screen.
 */
export async function loadSheetSource(
  wcId: number,
  label: string,
  sheet: string,
  range: string,
  hasHeader: boolean,
): Promise<MailMergeSource> {
  const addresses = addressesInRange(range)
  if (addresses.length === 0) throw new Error('invalid range')
  const response = await window.desktop.readSheetGrid(wcId, sheet, addresses)
  if (!response.ok) throw new Error(response.error ?? 'the spreadsheet could not be read')
  const cells = (response.result as { cells?: Record<string, { value?: unknown }> } | undefined)?.cells
  if (!cells) throw new Error('the spreadsheet returned no cells')
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(range.trim())
  if (!m) throw new Error('invalid range')
  const firstRow = parseInt(m[2], 10)
  const firstCol = m[1].toUpperCase()
  const lastCol = m[3].toUpperCase()
  const width = Math.min(MAX_COLUMNS, addressesInRange(`${firstCol}${firstRow}:${lastCol}${firstRow}`).length)
  const rows: string[][] = []
  for (let r = firstRow; ; r++) {
    const row: string[] = []
    for (let c = 0; c < width; c++) {
      const cell = cells[`${columnLabel(c)}${r}`]
      row.push(cell === undefined ? '' : String(cell.value ?? ''))
    }
    if (row.every((v) => v.trim() === '')) break
    rows.push(row)
    if (rows.length >= MAX_RECIPIENTS + 1) break
  }
  return sourceFromRows(rows, { kind: 'sheets', label, sheet, hasHeader })
}
