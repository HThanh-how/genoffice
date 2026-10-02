import * as CFB from 'cfb'
import { xlsxToText } from './xlsx'

/**
 * Text of a legacy Excel 97-2003 workbook (.xls, BIFF8): one "# SheetName" section per sheet,
 * a row per line with its cells joined by " | ", like xlsxToText. Reads only what search needs:
 * strings, numbers, booleans and the cached result of formulas. Dates stay serial numbers.
 */
const MAX_COLS = 16_384
const MAX_ROWS = 1_048_576

interface Rec {
  type: number
  data: Buffer
}

function records(book: Buffer): Rec[] {
  const out: Rec[] = []
  let at = 0
  while (at + 4 <= book.length) {
    const type = book.readUInt16LE(at)
    const length = book.readUInt16LE(at + 2)
    if (at + 4 + length > book.length) break
    out.push({ type, data: book.subarray(at + 4, at + 4 + length) })
    at += 4 + length
  }
  return out
}

/** Reads strings across CONTINUE records, where a string may restart with its own flag byte. */
class StringReader {
  private chunk = 0
  private pos = 0
  constructor(private readonly chunks: Buffer[]) {}

  atEnd(): boolean {
    while (this.chunk < this.chunks.length && this.pos >= this.chunks[this.chunk]!.length) {
      this.chunk++
      this.pos = 0
    }
    return this.chunk >= this.chunks.length
  }
  private cur(): Buffer {
    return this.chunks[this.chunk]!
  }
  u8(): number {
    if (this.atEnd()) return 0
    return this.cur()[this.pos++]!
  }
  u16(): number {
    return this.u8() | (this.u8() << 8)
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }
  skip(n: number): void {
    while (n > 0 && !this.atEnd()) {
      const take = Math.min(n, this.cur().length - this.pos)
      this.pos += take
      n -= take
    }
  }
  /** XLUnicodeRichExtendedString (cch already read). */
  string(cch: number, flags: number): string {
    const rich = (flags & 0x08) !== 0 ? this.u16() : 0
    const ext = (flags & 0x04) !== 0 ? this.u32() : 0
    let wide = (flags & 0x01) !== 0
    let text = ''
    let left = cch
    while (left > 0 && !this.atEnd()) {
      const room = this.cur().length - this.pos
      const unit = wide ? 2 : 1
      const take = Math.min(left, Math.floor(room / unit))
      if (take > 0) {
        const bytes = this.cur().subarray(this.pos, this.pos + take * unit)
        text += wide ? bytes.toString('utf16le') : bytes.toString('latin1')
        this.pos += take * unit
        left -= take
      }
      if (left > 0 && this.pos >= this.cur().length) {
        // the string goes on in the next CONTINUE record, which restarts with a flag byte
        this.chunk++
        this.pos = 0
        if (this.chunk < this.chunks.length) wide = (this.u8() & 0x01) !== 0
      } else if (take === 0) break
    }
    this.skip(rich * 4 + ext)
    return text
  }
}

function sharedStrings(globals: Rec[]): string[] {
  const at = globals.findIndex((r) => r.type === 0x00fc)
  if (at < 0) return []
  const chunks = [globals[at]!.data]
  for (let i = at + 1; i < globals.length && globals[i]!.type === 0x003c; i++)
    chunks.push(globals[i]!.data)
  const reader = new StringReader(chunks)
  reader.u32() // total references
  const unique = reader.u32()
  const out: string[] = []
  for (let i = 0; i < unique && !reader.atEnd(); i++) {
    const cch = reader.u16()
    const flags = reader.u8()
    out.push(reader.string(cch, flags))
  }
  return out
}

function readXlString(data: Buffer, offset: number): string {
  const cch = data.readUInt16LE(offset)
  const flags = data[offset + 2] ?? 0
  const reader = new StringReader([data.subarray(offset + 3)])
  return reader.string(cch, flags)
}

function rkValue(rk: number): number {
  let value: number
  if (rk & 0x02) value = rk >> 2
  else {
    const buf = Buffer.alloc(8)
    buf.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4)
    value = buf.readDoubleLE(0)
  }
  return rk & 0x01 ? value / 100 : value
}

const show = (n: number): string => (Number.isInteger(n) ? String(n) : String(+n.toPrecision(15)))

/** extract text from a .xls workbook */
export function xlsToText(bytes: Uint8Array): string {
  const container = CFB.read(Buffer.from(bytes), { type: 'buffer' })
  const entry = CFB.find(container, '/Workbook') ?? CFB.find(container, '/Book')
  if (!entry?.content) throw new Error('Invalid xls: no Workbook stream')
  const book = Buffer.from(entry.content as Uint8Array)
  const all = records(book)
  if (all.some((r) => r.type === 0x002f)) throw new Error('This xls is password protected')

  // the workbook globals end at the first EOF
  const firstEof = all.findIndex((r) => r.type === 0x000a)
  const globals = all.slice(0, firstEof < 0 ? all.length : firstEof + 1)
  const strings = sharedStrings(globals)
  const sheets: Array<{ name: string; offset: number }> = []
  for (const r of globals) {
    if (r.type !== 0x0085 || r.data.length < 8) continue
    const type = r.data[5]
    if (type !== 0) continue // worksheets only (not charts, macro sheets)
    const cch = r.data[6]!
    const flags = r.data[7]!
    const name =
      flags & 0x01
        ? r.data.subarray(8, 8 + cch * 2).toString('utf16le')
        : r.data.subarray(8, 8 + cch).toString('latin1')
    sheets.push({ name, offset: r.data.readUInt32LE(0) })
  }

  // records by their byte offset, so each sheet can start where its BOUNDSHEET points
  const offsets: number[] = []
  let at = 0
  for (const r of all) {
    offsets.push(at)
    at += 4 + r.data.length
  }

  const sections: string[] = []
  for (const sheet of sheets) {
    const start = offsets.indexOf(sheet.offset)
    if (start < 0) continue
    const cells = new Map<number, Map<number, string>>()
    let lastFormula: { row: number; col: number } | null = null
    let depth = 0
    const put = (row: number, col: number, text: string) => {
      if (!text || row >= MAX_ROWS || col >= MAX_COLS) return
      let line = cells.get(row)
      if (!line) cells.set(row, (line = new Map()))
      line.set(col, text)
    }
    for (let i = start; i < all.length; i++) {
      const { type, data } = all[i]!
      if (type === 0x0809) {
        depth++
        continue
      }
      if (type === 0x000a) {
        if (--depth <= 0) break
        continue
      }
      if (depth !== 1) continue
      switch (type) {
        case 0x00fd: // LABELSST
          put(data.readUInt16LE(0), data.readUInt16LE(2), strings[data.readUInt32LE(6)] ?? '')
          break
        case 0x0204: // LABEL
          put(data.readUInt16LE(0), data.readUInt16LE(2), readXlString(data, 6))
          break
        case 0x0203: // NUMBER
          put(data.readUInt16LE(0), data.readUInt16LE(2), show(data.readDoubleLE(6)))
          break
        case 0x027e: // RK
          put(data.readUInt16LE(0), data.readUInt16LE(2), show(rkValue(data.readUInt32LE(6))))
          break
        case 0x00bd: {
          // MULRK: a run of RK cells
          const row = data.readUInt16LE(0)
          const first = data.readUInt16LE(2)
          const count = (data.length - 6) / 6
          for (let k = 0; k < count; k++)
            put(row, first + k, show(rkValue(data.readUInt32LE(4 + k * 6 + 2))))
          break
        }
        case 0x0205: // BOOLERR
          if (data[7] === 0)
            put(data.readUInt16LE(0), data.readUInt16LE(2), data[6] ? 'TRUE' : 'FALSE')
          break
        case 0x0006: {
          // FORMULA: the cached result
          const row = data.readUInt16LE(0)
          const col = data.readUInt16LE(2)
          if (data.readUInt16LE(12) === 0xffff) {
            const kind = data[6]
            if (kind === 0)
              lastFormula = { row, col } // text follows in a STRING record
            else if (kind === 1) put(row, col, data[8] ? 'TRUE' : 'FALSE')
          } else put(row, col, show(data.readDoubleLE(6)))
          break
        }
        case 0x0207: // STRING (text result of the formula before it)
          if (lastFormula) {
            put(lastFormula.row, lastFormula.col, readXlString(data, 0))
            lastFormula = null
          }
          break
      }
    }
    const lines = [`# ${sheet.name}`]
    for (const row of [...cells.keys()].sort((a, b) => a - b)) {
      const line = cells.get(row)!
      const last = Math.max(...line.keys())
      const parts: string[] = []
      for (let c = 0; c <= last; c++) parts.push(line.get(c) ?? '')
      lines.push(parts.join(' | '))
    }
    sections.push(lines.join('\n'))
  }
  return sections.join('\n\n')
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** A "spreadsheet" that is really an HTML table (web exports save these as .xls). */
function htmlTableToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(tr|p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]+/g, ' ')
        .replace(/(\| )+$/, '')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')
}

/**
 * Text of a file saved as .xls. Most are real BIFF workbooks, but some are an .xlsx or an HTML
 * table with the wrong extension, so the first bytes decide how to read it.
 */
export async function legacyXlsToText(bytes: Uint8Array): Promise<string> {
  const head = Buffer.from(bytes.subarray(0, 8))
  if (head[0] === 0x50 && head[1] === 0x4b) return xlsxToText(bytes)
  const start = Buffer.from(bytes.subarray(0, 256))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (start.startsWith('<')) return htmlTableToText(Buffer.from(bytes).toString('utf8'))
  return xlsToText(bytes)
}
