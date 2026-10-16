/**
 * What a workbook that is not perfectly shaped reads as.
 *
 * Mail Merge builds recipient rows from `xlsxToGrid`, so a row whose cells are
 * sparse, a worksheet with no name, a formula with no cached result, or a
 * workbook whose relationship points at a part that does not exist all have to
 * produce a predictable answer rather than a silently wrong one. The rule the
 * reader follows is: keep the column position a cell's own `r` attribute gives
 * it, and drop nothing that the file actually contains.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { xlsxToGrid } from '../src/xlsx'

const DECL = '<?xml version="1.0" encoding="UTF-8"?>'
const SHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'

async function workbook(
  sheetXml: string,
  sheetName = 'Sheet1',
  relTarget = 'worksheets/sheet1.xml',
): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/workbook" Target="xl/workbook.xml"/></Relationships>`,
  )
  zip.file(
    'xl/workbook.xml',
    `${DECL}<workbook ${SHEET_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${relTarget}"/></Relationships>`,
  )
  zip.file(
    'xl/styles.xml',
    `${DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`,
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `${DECL}<worksheet ${SHEET_NS}><sheetData>${sheetXml}</sheetData></worksheet>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('sparse and oddly shaped worksheets', () => {
  it('keeps a cell in the column its own ref names, padding the gaps', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>' +
        '<row r="3"><c r="C3"><v>3</v></c></row>',
    )
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].rows).toEqual([
      ['1', '', '', '4'],
      ['', '', '3'],
    ])
  })

  it('reads a worksheet that carries no name rather than losing it', async () => {
    const bytes = await workbook('<row r="1"><c r="A1"><v>only</v></c></row>', '')
    const grids = await xlsxToGrid(bytes)
    expect(grids.length).toBe(1)
    expect(grids[0].name).toBe('')
    expect(grids[0].rows[0][0]).toBe('only')
  })

  it('returns the formula text when a cell has no cached result', async () => {
    const bytes = await workbook('<row r="1"><c r="A1"><f>B1+C1</f></c></row>')
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].rows[0][0]).toBe('=B1+C1')
  })

  it('uses the shared formula of a cell that only names its index', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1"><f>B1+1</f><v>5</v></c><c r="B1"><f t="shared" si="0"/><v>6</v></c></row>',
    )
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].rows[0]).toEqual(['5', '6'])
  })

  it('skips a worksheet whose relationship points at a missing part', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1"><v>x</v></c></row>',
      'Broken',
      'worksheets/nope.xml',
    )
    const grids = await xlsxToGrid(bytes)
    expect(grids).toEqual([])
  })

  it('does not pad a row for an absurd column reference', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1"><v>first</v></c><c r="ZZZZZZ99"><v>far</v></c></row>',
    )
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].rows[0].length).toBeLessThan(100)
    expect(grids[0].rows[0]).toContain('first')
    expect(grids[0].rows[0]).toContain('far')
  })
})
