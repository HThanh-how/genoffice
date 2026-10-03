/**
 * Files named .xls that are not Excel 97-2003 workbooks. School and government software often
 * exports an HTML table, a tab/comma text file or an .xlsx under that name; the workbook reader
 * only understands the real format, so those would fail with "Invalid OLE".
 */
import { copyFile, open, readFile, stat, writeFile } from 'node:fs/promises'
import { csvToXlsxBufferForOpen, decodeCsvBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'

export type XlsKind = 'ole' | 'xlsx' | 'html' | 'text'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** What a file saved as .xls really is, from its first bytes. */
export function sniffXlsKind(head: Uint8Array): XlsKind {
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'ole'
  if (head[0] === 0x50 && head[1] === 0x4b) return 'xlsx'
  const start = Buffer.from(head.subarray(0, 512))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()
  if (start.startsWith('<')) return 'html'
  // an unknown binary stays with the real reader so its own error reaches the user
  return head.subarray(0, 512).includes(0) ? 'ole' : 'text'
}

function cellText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every table row of an HTML export as tab-separated text (one sheet, tables stacked). */
export function htmlTableToTsv(html: string): string {
  const lines: string[] = []
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => {
      const text = cellText(m[1]!)
      return text.includes('"') ? `"${text.replace(/"/g, '""')}"` : text
    })
    if (cells.some((c) => c !== '')) lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

/** The first bytes of a file, without reading the rest of a large workbook. */
export async function readFileHead(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Convert a file saved as .xls into an .xlsx at `targetPath`, whatever it really is: a real
 * Excel 97-2003 workbook goes through the workbook reader, the rest are read here.
 */
export async function convertLegacyXlsFile(
  path: string,
  targetPath: string,
  options: {
    convertOle(path: string, targetPath: string): Promise<unknown>
    charset?: string | undefined
    maxTextBytes: number
    tooLarge: () => Error
  },
): Promise<void> {
  const kind = sniffXlsKind(await readFileHead(path, 4096))
  if (kind === 'xlsx') return copyFile(path, targetPath)
  if (kind === 'ole') {
    await options.convertOle(path, targetPath)
    return
  }
  if ((await stat(path)).size > options.maxTextBytes) throw options.tooLarge()
  const text = decodeCsvBuffer(await readFile(path), options.charset)
  const converted =
    kind === 'html'
      ? await csvToXlsxBufferForOpen(htmlTableToTsv(text), 'Sheet1', '\t')
      : await csvToXlsxBufferForOpen(text, 'Sheet1')
  await writeFile(targetPath, converted.buffer)
}
