/**
 * RFC 4180 CSV reader: quoted fields, doubled quotes, embedded delimiters and
 * embedded newlines, LF/CRLF, UTF-8 BOM, and delimiter sniffing.
 *
 * Values are returned as strings — never coerced to numbers — so an
 * identifier such as `001234` survives intact.
 */

const BOM = '\uFEFF'
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|']

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text
}

/** Pick the delimiter that actually separates columns on the first data line. */
export function sniffDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  let best: string | null = null
  let bestCount = 0
  for (const d of CANDIDATE_DELIMITERS) {
    let count = 0
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes
      else if (ch === d && !inQuotes) count += 1
    }
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best ?? ','
}

export function parseCsvRows(input: string, delimiter: string): string[][] {
  const text = stripBom(input)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    if (ch === '\r') {
      i += text[i + 1] === '\n' ? 2 : 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Drop trailing all-empty rows; a stray blank line is not a recipient. */
export function trimEmptyRows(rows: string[][]): string[][] {
  const out = rows.filter((row) => row.some((cell) => cell.trim() !== ''))
  return out
}
