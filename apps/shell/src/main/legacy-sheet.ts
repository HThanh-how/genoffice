import { readFile } from 'node:fs/promises'
import { XLSX_ROUTE, convertThroughService, type ServiceRoute } from './legacy-service'

/** The conversion service takes up to 20 MB. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** An .xlsx is a zip; anything else is not a workbook. */
async function acceptXlsx(bytes: Uint8Array): Promise<void> {
  if (bytes.length < 100 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('The conversion service did not return a workbook')
  }
}

/**
 * New .xlsx bytes for an old Excel file, converted by the service so the formatting survives.
 * Throws when the file is not a genuine Excel 97-2003 workbook (some .xls files are an HTML table
 * or a text export; the editor opens those itself) or when the service cannot convert it.
 */
export async function convertLegacySheet(
  filePath: string,
  endpoint: string,
  pause?: (ms: number) => Promise<void>,
  route: ServiceRoute = XLSX_ROUTE,
): Promise<Uint8Array> {
  if (!/\.xls$/i.test(filePath)) throw new Error('Expected an .xls file')
  const source = await readFile(filePath)
  if (source.length === 0 || source.length > MAX_INPUT_BYTES) {
    throw new Error('The .xls file is empty or larger than 20 MB')
  }
  if (!source.subarray(0, 8).equals(OLE_MAGIC)) {
    throw new Error('Not an Excel 97-2003 workbook')
  }
  const bytes = await convertThroughService(source, endpoint, route, acceptXlsx, pause)
  if (!bytes) throw new Error('The conversion service could not convert this workbook')
  return bytes
}
