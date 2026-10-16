/**
 * A numeric cell keeps its displayed form.
 *
 * Excel stores 1234 and displays 001234 when the cell carries a `000000` format.
 * Mail Merge reads cell text, so returning "1234" for that cell would claim a
 * value the sheet never shows. Formats that are not pure digit padding are left
 * as they are rather than guessed at.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { xlsxToGrid } from '../src/xlsx'

async function workbook(sheetXml: string, stylesXml: string): Promise<Uint8Array> {
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
  zip.file('xl/styles.xml', stylesXml)
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      sheetXml +
      '</sheetData></worksheet>',
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const styles = (numFmt: string, cellStyle: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="1000" formatCode="${numFmt}"/></numFmts><cellXfs count="1"><xf numFmtId="${cellStyle}"/></cellXfs></styleSheet>`

describe('zero-padded numeric cells', () => {
  it('returns the displayed value for a padded identifier', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1" s="0"><v>1234</v></c></row>',
      styles('000000', '1000'),
    )
    const grids = await xlsxToGrid(bytes)
    expect(grids[0].rows).toEqual([['001234']])
  })

  it('leaves a value already long enough alone', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1" s="0"><v>9876543</v></c></row>',
      styles('000000', '1000'),
    )
    expect((await xlsxToGrid(bytes))[0].rows).toEqual([['9876543']])
  })

  it('does not invent padding for a format that is not pure digits', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1" s="0"><v>1234</v></c></row>',
      styles('"ID-"0000', '1000'),
    )
    expect((await xlsxToGrid(bytes))[0].rows).toEqual([['1234']])
  })

  it('keeps a text cell exactly as written', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>001234</t></is></c></row>',
      styles('General', '0'),
    )
    expect((await xlsxToGrid(bytes))[0].rows).toEqual([['001234']])
  })

  it('pads a negative number on the digit side only', async () => {
    const bytes = await workbook(
      '<row r="1"><c r="A1" s="0"><v>-12</v></c></row>',
      styles('00000', '1000'),
    )
    expect((await xlsxToGrid(bytes))[0].rows).toEqual([['-00012']])
  })
})
