/**
 * Mail Merge refuses an oversized source instead of quietly trimming it. A
 * truncated recipient list looks complete, and the batch would merge for the
 * wrong people.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  MAX_COLUMNS,
  MAX_RECIPIENTS,
  buildColumns,
  loadCsvSource,
  loadSheetSource,
  loadXlsxSource,
  sourceFromRows,
} from '../src/renderer/mail-merge/data-source'

const withHeader = (n: number): string[][] => [
  ['Name'],
  ...Array.from({ length: n }, (_, i) => [`row ${i + 1}`]),
]

const withoutHeader = (n: number): string[][] =>
  Array.from({ length: n }, (_, i) => [`row ${i + 1}`])

const b64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const columnLetter = (index: number): string => {
  let n = index + 1
  let label = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    label = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[rem] + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

/** A minimal one-sheet workbook: `rows` rows, `cols` columns, all inline strings. */
async function workbookBase64(rows: number, cols: number): Promise<string> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/workbook" Target="xl/workbook.xml"/></Relationships>',
  )
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  )
  const body: string[] = []
  for (let r = 1; r <= rows; r++) {
    const cells = Array.from(
      { length: cols },
      (_, c) => `<c r="${columnLetter(c)}${r}" t="inlineStr"><is><t>${r}_${c + 1}</t></is></c>`,
    ).join('')
    body.push(`<row r="${r}">${cells}</row>`)
  }
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      body.join('') +
      '</sheetData></worksheet>',
  )
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  return Buffer.from(bytes).toString('base64')
}

/** A spreadsheet bridge that answers every address it is asked for. */
const echoReader = async (_id: number, _sheet: string, addresses: string[]) => ({
  ok: true,
  result: {
    cells: Object.fromEntries(addresses.map((a) => [a, { value: a }])),
  },
})

describe('recipient limits', () => {
  it('accepts exactly the supported number of recipients', () => {
    const source = sourceFromRows(withHeader(MAX_RECIPIENTS), {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    expect(source.recipients.length).toBe(MAX_RECIPIENTS)
  })

  it('refuses one recipient more than the supported number', () => {
    expect(() =>
      sourceFromRows(withHeader(MAX_RECIPIENTS + 1), {
        kind: 'csv',
        label: 'list.csv',
        hasHeader: true,
      }),
    ).toThrow(/more than Mail Merge can handle/)
  })

  it('counts a headerless source without an off-by-one', () => {
    const ok = sourceFromRows(withoutHeader(MAX_RECIPIENTS), {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: false,
    })
    expect(ok.recipients.length).toBe(MAX_RECIPIENTS)
    expect(() =>
      sourceFromRows(withoutHeader(MAX_RECIPIENTS + 1), {
        kind: 'csv',
        label: 'list.csv',
        hasHeader: false,
      }),
    ).toThrow(/more than Mail Merge can handle/)
  })

  it('refuses a CSV that is too large rather than reading part of it', () => {
    const csv = [
      'Name',
      ...Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `row ${i + 1}`),
    ].join('\n')
    expect(() => loadCsvSource(b64(csv), 'big.csv', true)).toThrow(
      /more than Mail Merge can handle/,
    )
  })

  it('refuses a headerless CSV that is too large', () => {
    const csv = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `row ${i + 1}`).join('\n')
    expect(() => loadCsvSource(b64(csv), 'big.csv', false)).toThrow(
      /more than Mail Merge can handle/,
    )
  })

  it('refuses an XLSX sheet with more rows than the limit', async () => {
    const base64 = await workbookBase64(MAX_RECIPIENTS + 2, 1)
    await expect(loadXlsxSource(base64, 'book.xlsx', null, true)).rejects.toThrow(
      /more than Mail Merge can handle/,
    )
  })

  it('keeps every recipient of an XLSX sheet that fits', async () => {
    const base64 = await workbookBase64(MAX_RECIPIENTS + 1, 1)
    const source = await loadXlsxSource(base64, 'book.xlsx', null, true)
    expect(source.recipients.length).toBe(MAX_RECIPIENTS)
  })

  it('refuses a spreadsheet range with more rows than the limit', async () => {
    const calls: string[][] = []
    const read = async (_id: number, _sheet: string, addresses: string[]) => {
      calls.push(addresses)
      return echoReader(0, '', addresses)
    }
    await expect(
      loadSheetSource(1, 'book', 'Sheet1', `A1:A${MAX_RECIPIENTS + 2}`, true, read),
    ).rejects.toThrow(/more than Mail Merge can handle/)
    expect(calls.length).toBe(0)
  })

  it('keeps every row of a spreadsheet range that fits', async () => {
    const source = await loadSheetSource(
      1,
      'book',
      'Sheet1',
      `A1:A${MAX_RECIPIENTS + 1}`,
      true,
      echoReader,
    )
    expect(source.recipients.length).toBe(MAX_RECIPIENTS)
  })
})

describe('column limits', () => {
  it('accepts exactly the supported number of columns', () => {
    const header = Array.from({ length: MAX_COLUMNS }, (_, i) => `c${i + 1}`)
    expect(buildColumns(header).length).toBe(MAX_COLUMNS)
  })

  it('refuses one column more than the supported number', () => {
    expect(() =>
      buildColumns(Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i + 1}`)),
    ).toThrow(/at most 100/)
  })

  it('refuses a CSV with too many columns instead of dropping them', () => {
    const header = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i + 1}`).join(',')
    expect(() => loadCsvSource(b64(header + '\n1,2,3'), 'wide.csv', true)).toThrow(/at most 100/)
  })

  it('refuses an XLSX sheet with too many columns instead of dropping them', async () => {
    const base64 = await workbookBase64(2, MAX_COLUMNS + 1)
    await expect(loadXlsxSource(base64, 'book.xlsx', null, true)).rejects.toThrow(/at most 100/)
  })

  it('refuses a spreadsheet range wider than the column limit', async () => {
    const calls: string[][] = []
    const read = async (_id: number, _sheet: string, addresses: string[]) => {
      calls.push(addresses)
      return echoReader(0, '', addresses)
    }
    await expect(loadSheetSource(1, 'book', 'Sheet1', 'A1:CW10', true, read)).rejects.toThrow(
      /at most 100/,
    )
    expect(calls.length).toBe(0)
  })

  it('keeps every column of a spreadsheet range that fits', async () => {
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:CV10', true, echoReader)
    expect(source.columns.length).toBe(MAX_COLUMNS)
    expect(new Set(source.columns.map((c) => c.name)).size).toBe(MAX_COLUMNS)
    expect(Object.keys(source.recipients[0].values).length).toBe(MAX_COLUMNS)
  })
})
