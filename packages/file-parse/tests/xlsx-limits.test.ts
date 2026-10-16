/**
 * Resource limits applied while parsing, not after.
 *
 * A workbook with a cell in `XFD2` pads every row to 16 384 slots. A workbook
 * with 200 sheets should not have all 200 worksheets parsed just to fill a
 * dropdown. And a formula with no cached value has no value to merge.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { MAX_GRID_COLS, xlsxSheetNames, xlsxToGrid } from '../src/xlsx'

const DECL = '<?xml version="1.0" encoding="UTF-8"?>'
const SHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'

async function workbook(sheets: Array<{ name: string; xml: string }>): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/workbook" Target="xl/workbook.xml"/></Relationships>`,
  )
  const sheetEntries = sheets
    .map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')
  zip.file(
    'xl/workbook.xml',
    `${DECL}<workbook ${SHEET_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`,
  )
  const rels = sheets
    .map(
      (_sheet, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  )
  sheets.forEach((sheet, i) => {
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `${DECL}<worksheet ${SHEET_NS}><sheetData>${sheet.xml}</sheetData></worksheet>`,
    )
  })
  zip.file(
    'xl/styles.xml',
    `${DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('xlsx resource limits', () => {
  it('lists sheet names without parsing any worksheet', async () => {
    const sheets = Array.from({ length: 40 }, (_, i) => ({
      name: `Sheet${i}`,
      xml: Array.from({ length: 500 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c></row>`).join(''),
    }))
    const names = await xlsxSheetNames(await workbook(sheets))
    expect(names.length).toBe(40)
    expect(names[0]).toBe('Sheet0')
  })

  it('refuses a row that would pad out to a far-right column', async () => {
    const bytes = await workbook([
      { name: 'Sheet1', xml: '<row r="1"><c r="A1"><v>name</v></c><c r="XFD1"><v>stray</v></c></row>' },
    ])
    await expect(xlsxToGrid(bytes)).rejects.toThrow(/at most \d+ columns/)
  })

  it('does not allocate a slot for every column up to the limit for a sparse row', async () => {
    const bytes = await workbook([
      { name: 'Sheet1', xml: '<row r="1"><c r="A1"><v>name</v></c><c r="AJ1"><v>city</v></c></row>' },
    ])
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].rows[0].length).toBe(36)
    expect(grids[0].rows[0][0]).toBe('name')
    expect(grids[0].rows[0][35]).toBe('city')
    expect(MAX_GRID_COLS).toBeLessThan(16384)
  })

  it('records a formula cell that has no cached result', async () => {
    const bytes = await workbook([
      {
        name: 'Sheet1',
        xml: '<row r="1"><c r="A1"><f>SUM(B1:B9)</f></c></row>',
      },
    ])
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].uncachedFormulas).toEqual(['A1 =SUM(B1:B9)'])
    // the prose reader still shows the formula text
    expect(grids[0].rows[0][0]).toBe('=SUM(B1:B9)')
  })

  it('does not flag a formula that does have a cached value', async () => {
    const bytes = await workbook([
      { name: 'Sheet1', xml: '<row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>42</v></c></row>' },
    ])
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].uncachedFormulas).toBeUndefined()
    expect(grids[0].rows[0][0]).toBe('42')
  })
})
