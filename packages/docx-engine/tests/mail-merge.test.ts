import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx } from '../src/index'
import {
  applyMergeValues,
  buildOutputFileName,
  collectMergeFields,
  evaluateConditionalField,
  mergeFieldName,
  patchMergeFieldXml,
  sanitizeFileNamePart,
  uniqueFileName,
} from '../src/mail-merge'
import { buildDocx } from './helpers/build-docx'

const field = (instr: string, cached: string | null, rPr = '') =>
  `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r>${rPr}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  (cached === null
    ? ''
    : `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r>${rPr}<w:t xml:space="preserve">${cached}</w:t></w:r>`) +
  `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`

const documentXmlOf = async (bytes: Uint8Array): Promise<string> =>
  (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')

describe('merge field instructions', () => {
  it('reads bare, quoted and CJK field names', () => {
    expect(mergeFieldName('MERGEFIELD Name \\* MERGEFORMAT')).toBe('Name')
    expect(mergeFieldName('MERGEFIELD "Postal Address"')).toBe('Postal Address')
    expect(mergeFieldName('MERGEFIELD HọTen')).toBe('HọTen')
    expect(mergeFieldName('DATE \\@ "yyyy-MM-dd"')).toBeNull()
  })

  it('evaluates IF fields against a row', () => {
    expect(evaluateConditionalField('IF «Department» "Sales" "Other"', { Department: 'Sales' })).toBe(
      'Sales',
    )
    expect(evaluateConditionalField('IF «Department» "Sales" "Other"', { Department: 'Finance' })).toBe(
      'Sales',
    )
    expect(
      evaluateConditionalField('IF «Amount» > "1000" "large" "small"', { Amount: '2500' }),
    ).toBe('large')
    expect(
      evaluateConditionalField('IF «Amount» > "1000" "large" "small"', { Amount: '500' }),
    ).toBe('small')
    // an instruction the model cannot express is left alone rather than guessed
    expect(evaluateConditionalField('IF «Name» = "x" "a"', { Name: 'x' })).toBeNull()
  })
})

describe('collectMergeFields', () => {
  it('lists every field the template references, once per name, in order', async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml:
          '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
          field('MERGEFIELD FirstName', null) +
          '</w:p>' +
          '<w:p>' +
          field('MERGEFIELD "Postal Address"', null) +
          field('MERGEFIELD FirstName', null) +
          '</w:p>',
      }),
    )
    expect(collectMergeFields(doc.blocks).map((f) => f.name)).toEqual([
      'FirstName',
      'Postal Address',
    ])
  })
})

describe('applyMergeValues', () => {
  it('replaces the placeholder with the recipient value and keeps the run formatting', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml:
          '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
          field('MERGEFIELD Name \\* MERGEFORMAT', null, '<w:rPr><w:b/></w:rPr>') +
          '<w:r><w:t xml:space="preserve">!</w:t></w:r></w:p>',
      }),
    )
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValues(parsed.blocks, { Name: 'Nguyễn Văn A' }, report)
    expect(merged[0].runs?.map((r) => r.text)).toEqual(['Dear ', 'Nguyễn Văn A', '!'])
    expect(merged[0].runs?.[1].bold).toBe(true)
    expect(merged[0].runs?.[1].instrField).toBeUndefined()
    expect(report.applied).toBe(1)

    // the merged tree serialises to a real docx whose text is the recipient's
    const bytes = await saveDocx(parsed, merged.map((block) => ({ kind: 'generated', block })))
    const xml = await documentXmlOf(bytes)
    expect(xml).toContain('Nguyễn Văn A')
    expect(xml).not.toContain('MERGEFIELD')
    const reparsed = await parseDocx(bytes)
    expect(reparsed.blocks[0].runs?.map((r) => r.text).join('')).toBe('Dear Nguyễn Văn A!')
  })

  it('never mutates the template blocks it is given', () => {
    const parsed = { blocks: [{ runs: [{ text: '«Name»', instrField: 'MERGEFIELD Name' }] }] } as never
    const before = JSON.stringify(parsed.blocks)
    applyMergeValues(parsed.blocks as never, { Name: 'Alice' })
    expect(JSON.stringify(parsed.blocks)).toBe(before)
  })

  it('reports a field the row has no column for instead of blanking it', () => {
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValues(
      [{ runs: [{ text: '«City»', instrField: 'MERGEFIELD City' }] }] as never,
      { Name: 'Alice' },
      report,
    )
    expect(merged[0].runs?.[0].text).toBe('«City»')
    expect(report.missing).toEqual(['City'])
  })

  it('merges fields inside table cells without touching the table structure', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml:
          '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
          '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
          '<w:tr><w:tc><w:p>' +
          field('MERGEFIELD Name', null) +
          '</w:p></w:tc><w:tc><w:p>' +
          field('MERGEFIELD Department', null) +
          '</w:p></w:tc></w:tr></w:tbl>',
      }),
    )
    const tableBlock = parsed.blocks.find((b) => b.type === 'table')
    expect(tableBlock).toBeTruthy()
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValues(parsed.blocks, { Name: 'Alice', Department: 'Sales' }, report)
    const cellRuns = JSON.stringify(merged[0].table ?? {}).includes('Alice')
    expect(cellRuns).toBe(true)
    expect(report.applied).toBe(2)
  })

  it('patches a byte-preserved paragraph that the run model cannot reach', () => {
    const xml =
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Amount </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>«Amount»</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const patched = patchMergeFieldXml(xml, { Amount: '1,500' }, report)
    expect(patched).toContain('<w:t xml:space="preserve">1,500</w:t>')
    expect(patched).not.toContain('«Amount»')
    expect(report.applied).toBe(1)
    // a field with no cached result at all gets one inserted
    const noResult =
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    expect(patchMergeFieldXml(noResult, { Name: 'A & B <x>' }, report)).toContain(
      '<w:t xml:space="preserve">A &amp; B &lt;x&gt;</w:t>',
    )
  })
})

describe('output file naming', () => {
  it('expands the pattern with a zero-padded index and the recipient values', () => {
    expect(
      buildOutputFileName({
        pattern: '{index}_{Name}_{Department}',
        index: 1,
        total: 1000,
        values: { Name: 'Nguyen Van A', Department: 'Sales' },
        extension: 'docx',
      }),
    ).toBe('0001_Nguyen Van A_Sales.docx')
  })

  it('neutralises path traversal and illegal characters in recipient values', () => {
    expect(sanitizeFileNamePart('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(sanitizeFileNamePart('C:\\Users\\x')).toBe('C__Users_x')
    expect(sanitizeFileNamePart('')).toBe('')
    expect(sanitizeFileNamePart('nul')).toBe('_nul')
    expect(
      buildOutputFileName({
        pattern: '{Name}',
        index: 1,
        total: 1,
        values: { Name: '../../../../test' },
        extension: 'pdf',
      }),
    ).toBe('_.._.._.._.._test.pdf')
  })

  it('falls back to a numbered name when every token is empty', () => {
    expect(
      buildOutputFileName({
        pattern: '{Name} {Department}',
        index: 7,
        total: 10,
        values: { Name: '', Department: '   ' },
        extension: 'docx',
      }),
    ).toBe('merge-07.docx')
  })

  it('disambiguates duplicate names deterministically', () => {
    const taken = new Set<string>()
    const first = uniqueFileName('a.docx', taken)
    taken.add(first)
    expect(uniqueFileName('a.docx', taken)).toBe('a (2).docx')
    taken.add('a (2).docx')
    expect(uniqueFileName('a.docx', taken)).toBe('a (3).docx')
  })
})
