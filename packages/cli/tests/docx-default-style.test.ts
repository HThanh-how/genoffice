import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DOCUMENT_PAGE } from '@genoffice/agent-core'
import { DEFAULT_DOCUMENT_STYLES } from '@genoffice/docx-engine'
import { validateGeneratedDocx } from '../src/formats/docx-validation'
import { closeDocument, openDocument } from '../src/formats/docx'
import { markdownToDocx } from '../src/formats/markdown'

const VI_MARKDOWN = [
  '# Báo cáo tổng kết năm học',
  '',
  'Đoạn mở đầu của báo cáo, trình bày kết quả đạt được trong năm học vừa qua.',
  '',
  '## Kết quả chính',
  '',
  '### Chi tiết',
  '',
  '- Ý thứ nhất',
  '- Ý thứ hai',
  '',
  '1. Bước một',
  '2. Bước hai',
  '',
  '| Chỉ tiêu | Kết quả |',
  '|---|---|',
  '| Học sinh giỏi | 120 |',
  '| Học sinh khá | 240 |',
  '',
  '> Trích dẫn quan trọng',
  '',
  '```',
  'const x = 1',
  '```',
].join('\n')

async function parts(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (name: string) => (await zip.file(name)?.async('string')) ?? ''
  return {
    styles: await read('word/styles.xml'),
    document: await read('word/document.xml'),
    numbering: await read('word/numbering.xml'),
    core: await read('docProps/core.xml'),
  }
}

describe('AI-created docx default style (Vietnamese office standard)', () => {
  it('declares the default page setup and body typography in the package', () => {
    expect(DEFAULT_DOCUMENT_PAGE).toEqual({
      paperSize: 'A4',
      orientation: 'portrait',
      margins: { top: 20, bottom: 20, left: 30, right: 20 },
      typography: {
        bodyFont: 'Times New Roman',
        bodySizePt: 13,
        lineSpacing: 1.3,
        paragraphSpacingAfterPt: 6,
      },
    })
    expect(DEFAULT_DOCUMENT_STYLES.headingSizesHalfPoints).toEqual([32, 28, 26])
  })

  it('writes A4 portrait with 2/2/3/2 cm margins in the section properties', async () => {
    const { document } = await parts(await markdownToDocx(VI_MARKDOWN))
    const sectPr = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(document)?.[0] ?? ''
    expect(sectPr).toContain('<w:pgSz w:w="11906" w:h="16838"')
    expect(sectPr).not.toContain('w:orient="landscape"')
    expect(sectPr).toMatch(/w:top="1134"/)
    expect(sectPr).toMatch(/w:bottom="1134"/)
    expect(sectPr).toMatch(/w:left="1701"/)
    expect(sectPr).toMatch(/w:right="1134"/)
  })

  it('defines fonts, size, spacing and language once in styles.xml', async () => {
    const { styles } = await parts(await markdownToDocx(VI_MARKDOWN))
    const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)?.[0] ?? ''
    for (const slot of ['ascii', 'hAnsi', 'cs', 'eastAsia']) {
      expect(defaults).toContain(`w:${slot}="Times New Roman"`)
    }
    expect(defaults).toContain('<w:sz w:val="26"/>')
    expect(defaults).toContain('<w:szCs w:val="26"/>')
    // line spacing 1.3 (312/240), 6 pt after
    expect(defaults).toContain('w:after="120" w:line="312" w:lineRule="auto"')
    expect(defaults).toContain('<w:lang w:val="vi-VN"')

    const style = (id: string) =>
      new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(styles)?.[0] ?? ''
    const h1 = style('Heading1')
    expect(h1).toContain('<w:keepNext/>')
    expect(h1).toContain('<w:b/>')
    expect(h1).toContain('<w:sz w:val="32"/>')
    expect(h1).not.toContain('<w:jc ')
    expect(style('Heading2')).toContain('<w:sz w:val="28"/>')
    const h3 = style('Heading3')
    expect(h3).toContain('<w:sz w:val="26"/>')
    expect(h3).toContain('<w:b/>')
    expect(h3).toContain('<w:i/>')
    expect(style('ListBullet')).toContain('<w:numId w:val="1"/>')
    expect(style('ListNumber')).toContain('<w:numId w:val="2"/>')
    expect(style('Quote')).toContain('<w:ind w:left="567"/>')
    expect(style('SourceCode')).toContain('Consolas')
    expect(style('TableText')).toContain('w:after="0"')
  })

  it('defines thin table borders and cell padding in the Table Grid style', async () => {
    const { styles } = await parts(await markdownToDocx(VI_MARKDOWN))
    const grid = /<w:style [^>]*w:styleId="TableGrid"[\s\S]*?<\/w:style>/.exec(styles)?.[0] ?? ''
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
      expect(grid).toContain(`<w:${side} w:val="single" w:sz="4"`)
    }
    expect(grid).toContain('<w:top w:w="40" w:type="dxa"/>')
    expect(grid).toContain('<w:left w:w="100" w:type="dxa"/>')
  })

  it('references the styles from the content instead of formatting each element', async () => {
    const { document, numbering } = await parts(await markdownToDocx(VI_MARKDOWN))
    const body = document.slice(0, document.lastIndexOf('<w:sectPr'))

    expect(body).toContain('<w:pStyle w:val="Heading1"/>')
    expect(body).toContain('<w:pStyle w:val="Heading2"/>')
    expect(body).toContain('<w:pStyle w:val="Heading3"/>')
    expect(body).toContain('<w:pStyle w:val="Quote"/>')
    expect(body).toContain('<w:pStyle w:val="SourceCode"/>')

    // lists are real Word numbering, not typed markers
    expect(body).toContain('<w:pStyle w:val="ListBullet"/>')
    expect(body).toContain('<w:pStyle w:val="ListNumber"/>')
    expect(body).toMatch(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/)
    expect(body).toMatch(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="100"\/><\/w:numPr>/)
    expect(body).not.toMatch(/<w:t[^>]*>\s*[-*•]\s/)
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>')
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>')
    expect(numbering).toMatch(/<w:ind w:left="720" w:hanging="360"\/>/)

    // no per-paragraph spacing or run fonts: those live in styles.xml
    expect(body).not.toContain('<w:spacing')
    expect(body).not.toContain('<w:rFonts')
    expect(body).not.toContain('<w:sz ')
  })

  it('lays tables out with a header row that repeats, shading, padding and full width', async () => {
    const { document } = await parts(await markdownToDocx(VI_MARKDOWN))
    const table = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(document)?.[0] ?? ''
    expect(table).toContain('<w:tblStyle w:val="TableGrid"/>')
    expect(table).toContain('<w:tblW w:w="5000" w:type="pct"/>')
    expect(table).toContain('<w:tblLayout w:type="autofit"/>')
    expect(table).toContain('<w:top w:w="40" w:type="dxa"/>')
    expect(table).toContain('<w:left w:w="100" w:type="dxa"/>')
    // text width = 11906 - 1701 - 1134 = 9071 split over 2 columns
    expect(table).toContain('<w:gridCol w:w="4535"/>')
    const rows = table.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? []
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('<w:tblHeader/>')
    expect(rows[1]).not.toContain('<w:tblHeader/>')
    expect(rows[0]).toContain('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>')
    expect(rows[0]).toContain('<w:b/>')
    expect(rows[1]).not.toContain('<w:b/>')
    expect(table).toContain('<w:pStyle w:val="TableText"/>')
  })

  it('sets the document title from the first heading and the language from the content', async () => {
    const vi = await parts(await markdownToDocx(VI_MARKDOWN))
    expect(vi.core).toContain('<dc:title>Báo cáo tổng kết năm học</dc:title>')
    expect(vi.styles).toContain('<w:lang w:val="vi-VN" w:eastAsia="vi-VN"')

    const en = await parts(
      await markdownToDocx('# Quarterly review\n\nRevenue grew in every region this quarter.'),
    )
    expect(en.core).toContain('<dc:title>Quarterly review</dc:title>')
    expect(en.styles).toContain('<w:lang w:val="en-US" w:eastAsia="en-US"')
  })

  it('styles appended content the same way: one regeneration from accumulated markdown', async () => {
    const part1 = VI_MARKDOWN.split('## Kết quả chính')[0]
    const part2 = '## Kết quả chính' + VI_MARKDOWN.split('## Kết quả chính')[1]
    const whole = await parts(await markdownToDocx(`${part1}${part2}`))
    const appended = await parts(await markdownToDocx(`${part1}\n\n${part2}`))
    expect(appended.styles).toBe(whole.styles)
    expect(appended.numbering).toBe(whole.numbering)
    expect(appended.document.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0]).toBe(
      whole.document.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0],
    )
  })

  it('stays valid and opens in the Docs editor with the headings, list items and table intact', async () => {
    const bytes = await markdownToDocx(VI_MARKDOWN)
    const validation = await validateGeneratedDocx(bytes, {
      requireHeading: true,
      requireTable: true,
      minParagraphs: 3,
      expectedText: 'Báo cáo tổng kết năm học',
      checkPlaceholders: true,
    })
    expect(validation.errors).toEqual([])
    expect(validation.ok).toBe(true)

    const doc = await openDocument(bytes)
    try {
      const text = JSON.stringify(doc.editor.getJSON())
      for (const expected of ['Kết quả chính', 'Ý thứ nhất', 'Bước hai', 'Học sinh khá']) {
        expect(text).toContain(expected)
      }
      expect(text).toMatch(/"type":"[a-zA-Z]*[Tt]able[a-zA-Z]*"/)
    } finally {
      closeDocument(doc)
    }
  })
})
