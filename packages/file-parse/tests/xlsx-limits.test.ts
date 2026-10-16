/**
 * Resource limits applied while parsing, not after.
 *
 * A workbook with a cell in `XFD2` pads every row to 16 384 slots. A workbook
 * with 200 sheets should not have all 200 worksheets parsed just to fill a
 * dropdown. And a formula with no cached value has no value to merge.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { MAX_GRID_COLS, xlsxSheetGrid, xlsxSheetNames, xlsxToGrid } from '../src/xlsx'

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
      xml: Array.from(
        { length: 500 },
        (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c></row>`,
      ).join(''),
    }))
    const names = await xlsxSheetNames(await workbook(sheets))
    expect(names.length).toBe(40)
    expect(names[0]).toBe('Sheet0')
  })

  it('refuses a row that would pad out to a far-right column', async () => {
    const bytes = await workbook([
      {
        name: 'Sheet1',
        xml: '<row r="1"><c r="A1"><v>name</v></c><c r="XFD1"><v>stray</v></c></row>',
      },
    ])
    await expect(xlsxToGrid(bytes)).rejects.toThrow(/at most \d+ columns/)
  })

  it('does not allocate a slot for every column up to the limit for a sparse row', async () => {
    const bytes = await workbook([
      {
        name: 'Sheet1',
        xml: '<row r="1"><c r="A1"><v>name</v></c><c r="AJ1"><v>city</v></c></row>',
      },
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

describe('reading one worksheet only', () => {
  const RECIPIENTS =
    '<row r="1"><c r="A1"><v>Name</v></c><c r="B1"><v>City</v></c></row>' +
    '<row r="2"><c r="A2"><v>Nguyễn Văn A</v></c><c r="B2"><v>Da Nang</v></c></row>' +
    '<row r="3"><c r="A3"><v>Bo Tran</v></c></row>'

  it('reads the requested sheet even when an unrelated sheet has a far-right cell', async () => {
    const bytes = await workbook([
      { name: 'Recipients', xml: RECIPIENTS },
      { name: 'Junk', xml: '<row r="1"><c r="XFD1"><v>stray</v></c></row>' },
    ])
    const sheet = await xlsxSheetGrid(bytes, 'Recipients')
    expect(sheet.name).toBe('Recipients')
    expect(sheet.rows).toEqual([['Name', 'City'], ['Nguyễn Văn A', 'Da Nang'], ['Bo Tran']])
    // the same workbook is still unusable through the read-all API
    await expect(xlsxToGrid(bytes)).rejects.toThrow(/at most \d+ columns/)
  })

  it('reads the requested sheet when an unrelated worksheet part is missing', async () => {
    // a workbook that declares two sheets but ships only one worksheet part
    const full = await workbook([
      { name: 'Recipients', xml: RECIPIENTS },
      { name: 'Ghost', xml: '' },
    ])
    const parsed = await JSZip.loadAsync(full)
    parsed.remove('xl/worksheets/sheet2.xml')
    const broken = await parsed.generateAsync({ type: 'uint8array' })
    const sheet = await xlsxSheetGrid(broken, 'Recipients')
    expect(sheet.rows[0]).toEqual(['Name', 'City'])
    // the read-all API simply has no grid for the worksheet that is not there
    expect((await xlsxToGrid(broken)).map((g) => g.name)).toEqual(['Recipients'])
  })

  it('refuses a worksheet the workbook does not have', async () => {
    const bytes = await workbook([{ name: 'Recipients', xml: RECIPIENTS }])
    await expect(xlsxSheetGrid(bytes, 'Mailing list')).rejects.toThrow(
      /is not in this workbook \(available: Recipients\)/,
    )
  })

  it('finds a worksheet named in Vietnamese', async () => {
    const bytes = await workbook([
      { name: 'Danh sách', xml: RECIPIENTS },
      { name: 'Đánh giá', xml: '<row r="1"><c r="A1"><v>notes</v></c></row>' },
    ])
    const names = await xlsxSheetNames(bytes)
    expect(names).toEqual(['Danh sách', 'Đánh giá'])
    const sheet = await xlsxSheetGrid(bytes, 'Danh sách')
    expect(sheet.name).toBe('Danh sách')
    expect(sheet.rows.length).toBe(3)
  })

  it('keeps the gaps in a sparse row', async () => {
    const bytes = await workbook([
      {
        name: 'Sheet1',
        xml: '<row r="1"><c r="A1"><v>name</v></c><c r="E1"><v>city</v></c></row>',
      },
    ])
    const sheet = await xlsxSheetGrid(bytes, 'Sheet1')
    expect(sheet.rows[0]).toEqual(['name', '', '', '', 'city'])
  })

  it('reports an uncached formula only from the sheet it read', async () => {
    const bytes = await workbook([
      { name: 'Recipients', xml: '<row r="1"><c r="A1"><v>name</v></c></row>' },
      { name: 'Other', xml: '<row r="1"><c r="A1"><f>SUM(B1:B9)</f></c></row>' },
    ])
    const sheet = await xlsxSheetGrid(bytes, 'Recipients')
    expect(sheet.uncachedFormulas).toBeUndefined()
    const other = await xlsxSheetGrid(bytes, 'Other')
    expect(other.uncachedFormulas).toEqual(['A1 =SUM(B1:B9)'])
  })

  it('refuses a sheet with more rows than the caller will take', async () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join('')
    const bytes = await workbook([{ name: 'Big', xml: rows }])
    await expect(xlsxSheetGrid(bytes, 'Big', 5)).rejects.toThrow(/has 12 rows, more than the 5/)
    // the read-all API is held to the same rule, so no caller gets a silently
    // shortened list
    await expect(xlsxToGrid(bytes, 5)).rejects.toThrow(/has 12 rows, more than the 5/)
  })

  it('reads a numeric identifier and a date the way the sheet displays them', async () => {
    const zip = new JSZip()
    const DECL = '<?xml version="1.0" encoding="UTF-8"?>'
    zip.file(
      '[Content_Types].xml',
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    )
    zip.file(
      '_rels/.rels',
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/workbook" Target="xl/workbook.xml"/></Relationships>`,
    )
    zip.file(
      'xl/workbook.xml',
      `${DECL}<workbook ${SHEET_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Recipients" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    )
    zip.file(
      'xl/sharedStrings.xml',
      `${DECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>001234</t></si></sst>`,
    )
    zip.file(
      'xl/styles.xml',
      `${DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      `${DECL}<worksheet ${SHEET_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>45000</v></c></row></sheetData></worksheet>`,
    )
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const sheet = await xlsxSheetGrid(bytes, 'Recipients')
    // serial 45000 is 15 March 2023, and the identifier is text with its
    // leading zeros: the grid shows what the sheet shows
    expect(sheet.rows[0]).toEqual(['001234', '2023-03-15'])
  })
})
