/**
 * RFC 4180 CSV reader: quoted fields, doubled quotes, embedded delimiters and
 * embedded newlines, LF/CRLF, UTF-8 BOM, and delimiter sniffing.
 *
 * Values are returned as strings — never coerced to numbers — so an
 * identifier such as `001234` survives intact.
 */

const BOM = '\uFEFF'
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|']

/**
 * Excel's own hint line: a first line of exactly `sep=<char>` names the
 * delimiter and is not data. Excel writes it for CSV exports in locales that
 * use ";" and honours it on open. Without it `sep=;` becomes a one-column
 * header and every recipient is shifted by one row.
 */
const SEP_DECLARATION = /^sep=(.)\r?\n/i

export function splitSepDeclaration(text: string): { text: string; delimiter?: string } {
  const match = SEP_DECLARATION.exec(text)
  if (!match) return { text }
  return { text: text.slice(match[0].length), delimiter: match[1] ?? ',' }
}

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text
}

/**
 * Decode a source file as UTF-8, or say so.
 *
 * The default decoder replaces an invalid byte with U+FFFD, so a file saved in
 * another encoding would load as a list of recipients with mojibake in the names
 * and nobody would be told. Mail Merge writes those names into documents, so an
 * undecodable file is refused instead of quietly mangled.
 */
export function decodeCsvText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('the source file is not valid UTF-8 text; re-save it as UTF-8 and try again')
  }
}

/**
 * The first `count` CSV records, quote-aware.
 *
 * A record is not a line: a quoted field may contain a newline, so
 * `"Address line 1\nAddress line 2";Name` is one record spanning two physical
 * lines. Delimiter detection that reads only physical lines sees the first half
 * of that record and picks the wrong delimiter.
 */
function firstRecords(text: string, count: number): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < text.length && out.length < count; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '""'
          i += 1
          continue
        }
        inQuotes = false
      }
      current += ch
      continue
    }
    if (ch === '"') {
      inQuotes = true
      current += ch
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      if (current.trim() !== '') out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (out.length < count && current.trim() !== '') out.push(current)
  return out
}

/**
 * Pick the delimiter that actually separates columns.
 *
 * The count is taken over up to three complete records rather than the first
 * physical line, and only outside quoted fields — a comma inside an address is
 * not a column separator. Three records are enough to break a tie between a
 * header that happens to contain one delimiter and the body that uses another.
 */
export function sniffDelimiter(text: string): string {
  const stripped = stripBom(text)
  const { text: body, delimiter: declared } = splitSepDeclaration(stripped)
  if (declared) return declared
  const records = firstRecords(body, 3)
  let best: string | null = null
  let bestCount = 0
  for (const d of CANDIDATE_DELIMITERS) {
    let count = 0
    for (const record of records) {
      let inQuotes = false
      for (const ch of record) {
        if (ch === '"') inQuotes = !inQuotes
        else if (ch === d && !inQuotes) count += 1
      }
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
      // A quote opens a quoted field only at the start of one. Anywhere else it
      // is data: `Ha"noi` is a city name, and dropping the character would write
      // a recipient's name that is not the one in the file.
      if (field === '') {
        inQuotes = true
        i += 1
        continue
      }
      field += ch
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

/**
 * Drop the blank rows at the end of the file.
 *
 * A trailing newline is not a recipient. A blank line in the middle of the data
 * is: Word reads it as a record whose fields are all empty, and dropping it would
 * silently lose a row the user counted. Only the tail is removed.
 */
export function trimEmptyRows(rows: string[][]): string[][] {
  const out = rows.slice()
  while (out.length > 0 && out[out.length - 1].every((cell) => cell.trim() === '')) out.pop()
  return out
}

/**
 * Does a quoted field have junk glued to its closing quote?
 *
 * RFC 4180 allows only a delimiter, a line break or the end of the input after a
 * closing quote. `"Alice"Jones` is not a field: reading it as `AliceJones`
 * silently loses the quote the user typed, and reading it as `Alice` silently
 * loses `Jones`. The row is refused instead, with the position of the quote, so
 * the user fixes the file rather than mailing a name that is not in it.
 */
export function strayQuoteAfterField(input: string, delimiter: string): number | null {
  const text = stripBom(input)
  let field = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '"' && field === '') {
      const openedAt = i
      i += 1
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      if (i < text.length && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
        return openedAt
      }
      // whatever follows belongs to the rest of this field, up to its end
      while (i < text.length && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
        i += 1
      }
      field = ''
      continue
    }
    if (text[i] === delimiter || text[i] === '\n' || text[i] === '\r') {
      field = ''
      i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += text[i]
    i += 1
  }
  return null
}

/**
 * Does the text end inside a quoted field?
 *
 * RFC 4180 has no way to recover from an unterminated quote: everything after it
 * is field content until the end of the input. The parser does exactly that, and
 * callers use this to tell the user the file is malformed rather than pretending
 * the last row is a normal recipient.
 */
export function unterminatedQuoteAt(input: string, delimiter: string): number | null {
  const text = stripBom(input)
  let inQuotes = false
  let field = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 2
          continue
        }
        inQuotes = false
      }
      i += 1
      continue
    }
    if (ch === '"') {
      // the same rule the row parser uses: a quote only opens a quoted field at
      // the start of one, so `Ha"noi` is a value, not a broken quote
      if (field === '') inQuotes = true
      i += 1
      continue
    }
    if (ch === delimiter || ch === '\n' || ch === '\r') {
      field = ''
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i += 1
  }
  return inQuotes ? i : null
}
