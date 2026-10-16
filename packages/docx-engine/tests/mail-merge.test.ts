import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx } from '../src/index'
import type { Block, GeneratedBlock, Run } from '../src/types'
import {
  applyMergeValues,
  applyMergeValuesToHeaderFooter,
  buildOutputFileName,
  collectMergeFields,
  evaluateConditionalField,
  isRepresentableColumnName,
  MAX_FILE_NAME_BYTES,
  mergeFieldName,
  mergeFieldInstruction,
  patchMergeFieldXml,
  safeFileName,
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
    expect(
      evaluateConditionalField('IF «Department» "Sales" "Other"', { Department: 'Sales' }),
    ).toBe('Sales')
    expect(
      evaluateConditionalField('IF «Department» "Sales" "Other"', { Department: 'Finance' }),
    ).toBe('Sales')
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
    const finalBlocks = merged.map((block) =>
      block.type === 'passthrough'
        ? { kind: 'original' as const, docxIndex: block.docxIndex! }
        : { kind: 'generated' as const, block: { ...block, type: 'paragraph' } as GeneratedBlock },
    )
    const bytes = await saveDocx(parsed, finalBlocks)
    const xml = await documentXmlOf(bytes)
    expect(xml).toContain('Nguyễn Văn A')
    expect(xml).not.toContain('MERGEFIELD')
    const reparsed = await parseDocx(bytes)
    expect(reparsed.blocks[0].runs?.map((r) => r.text).join('')).toBe('Dear Nguyễn Văn A!')
  })

  it('never mutates the template blocks it is given', () => {
    const blocks: Block[] = [
      {
        id: 'b0',
        type: 'paragraph',
        docxIndex: 0,
        originalXml: null,
        runs: [{ text: '«Name»', instrField: 'MERGEFIELD Name' }],
      },
    ]
    const before = JSON.stringify(blocks)
    applyMergeValues(blocks, { Name: 'Alice' })
    expect(JSON.stringify(blocks)).toBe(before)
  })

  it('reports a field the row has no column for instead of blanking it', () => {
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValues(
      [
        {
          id: 'b0',
          type: 'paragraph',
          docxIndex: 0,
          originalXml: null,
          runs: [{ text: '«City»', instrField: 'MERGEFIELD City' }],
        },
      ],
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
    const table = merged.find((b) => b.type === 'table')?.table
    expect(table).toBeTruthy()
    const cellText = (table!.rows[0] ?? [])
      .map((cell) => (cell.richParas ?? []).flatMap((p) => p.runs.map((r) => r.text)).join(''))
      .join('|')
    expect(cellText).toBe('Alice|Sales')
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
  it("patches Word's single-element fldSimple form", () => {
    const xml =
      '<w:p><w:fldSimple w:instr=" MERGEFIELD Name "><w:r><w:t>«Name»</w:t></w:r></w:fldSimple></w:p>'
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, report)
    expect(patched).toContain('<w:t xml:space="preserve">Huy</w:t>')
    expect(patched).not.toContain('«Name»')
    expect(report.applied).toBe(1)
  })

  it('keeps the run formatting of a fldSimple field it resolves', () => {
    const xml =
      '<w:p><w:fldSimple w:instr=" MERGEFIELD Name "><w:r><w:rPr><w:b/></w:rPr><w:t>«Name»</w:t></w:r></w:fldSimple></w:p>'
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    expect(patchMergeFieldXml(xml, { Name: 'Huy' }, report)).toContain('<w:rPr><w:b/></w:rPr>')
  })

  it('resolves every field of a passthrough paragraph, not just the first', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:r><w:t xml:space="preserve"> / </w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD City </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>«City»</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const patched = patchMergeFieldXml(xml, { Name: 'Huy', City: 'Tokyo' }, report)
    expect(patched).toContain('Huy')
    expect(patched).toContain('Tokyo')
    expect(patched).not.toContain('«City»')
    expect(report.applied).toBe(2)
  })
})

/**
 * WordprocessingML sanity check. A generic XML parser cannot catch a run
 * nested inside a run — `<w:r><w:r>…</w:r></w:r>` is perfectly well-formed XML
 * and invalid OOXML — so the scanner checks tag balance and run nesting.
 */
function scanTags(xml: string): Array<{ name: string; closing: boolean; selfClosing: boolean }> {
  const tags: Array<{ name: string; closing: boolean; selfClosing: boolean }> = []
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    let j = lt + 1
    while (j < xml.length) {
      const ch = xml[j]
      if (ch === '"') {
        j = xml.indexOf('"', j + 1) + 1
        continue
      }
      if (ch === '>') break
      j += 1
    }
    if (j >= xml.length) break
    const raw = xml.slice(lt + 1, j)
    const closing = raw.startsWith('/')
    const selfClosing = raw.endsWith('/')
    const name = (closing ? raw.slice(1) : raw).split(/[\s/]/)[0]
    tags.push({ name, closing, selfClosing })
    i = j + 1
  }
  return tags
}

function assertValidWordprocessing(xml: string): void {
  const stack: string[] = []
  for (const tag of scanTags(xml)) {
    if (tag.closing) {
      const open = stack.pop()
      if (open !== tag.name) {
        throw new Error(`mismatched tag </${tag.name}> closes <${open ?? 'nothing'}>`)
      }
      continue
    }
    if (tag.name === 'w:r' && stack[stack.length - 1] === 'w:r') {
      throw new Error('a w:run nested inside another w:run')
    }
    if (!tag.selfClosing) stack.push(tag.name)
  }
  if (stack.length > 0) throw new Error(`unclosed tags: ${stack.join(', ')}`)
}

describe('merge field instruction', () => {
  it('quotes a column name that contains spaces, the way Word writes it', () => {
    expect(mergeFieldInstruction('Full Name')).toBe('MERGEFIELD "Full Name"')
    expect(mergeFieldInstruction('Postal Address')).toBe('MERGEFIELD "Postal Address"')
    expect(mergeFieldInstruction('Name')).toBe('MERGEFIELD Name')
    expect(mergeFieldInstruction('  Department  ')).toBe('MERGEFIELD Department')
  })

  it('refuses a column name that cannot be a field name instead of renaming it', () => {
    // a bare `MERGEFIELD He said "hi"` would merge the column `He` and swallow
    // the rest, and folding the quote to an apostrophe would name a column the
    // source does not have — so the name is rejected, never rewritten
    expect(mergeFieldInstruction('He said "hi"')).toBeNull()
    expect(isRepresentableColumnName('He said "hi"')).toBe(false)
    expect(isRepresentableColumnName('Full Name')).toBe(true)
    expect(isRepresentableColumnName('')).toBe(false)
    expect(isRepresentableColumnName('   ')).toBe(false)
  })

  it('round-trips a multi-word column name through parse → merge → save → reopen', async () => {
    const bytes = await buildDocx({
      bodyXml:
        '<w:p>' +
        field(mergeFieldInstruction('Full Name')!, null) +
        '<w:r><w:t xml:space="preserve"> of </w:t></w:r>' +
        field(mergeFieldInstruction('Postal Address')!, null) +
        '</w:p>',
    })
    const parsed = await parseDocx(bytes)
    expect(collectMergeFields(parsed.blocks).map((f) => f.name)).toEqual([
      'Full Name',
      'Postal Address',
    ])
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValues(
      parsed.blocks,
      { 'Full Name': 'Nguyễn Văn A', 'Postal Address': '123 Nguyễn Huệ' },
      report,
    )
    expect(report.applied).toBe(2)
    expect(report.missing).toEqual([])
    const finalBlocks = merged.map((block) =>
      block.type === 'passthrough'
        ? { kind: 'original' as const, docxIndex: block.docxIndex! }
        : { kind: 'generated' as const, block: { ...block, type: 'paragraph' } as GeneratedBlock },
    )
    const out = await saveDocx(parsed, finalBlocks)
    const xml = await documentXmlOf(out)
    expect(xml).not.toContain('MERGEFIELD')
    const reopened = await parseDocx(out)
    expect(reopened.blocks[0].runs?.map((run) => run.text).join('')).toBe(
      'Nguyễn Văn A of 123 Nguyễn Huệ',
    )
  })
})

describe('passthrough field patching', () => {
  const report = () => ({ missing: [], unused: [], unsupported: 0, applied: 0 })

  it('replaces a field that already has a cached result, keeping its formatting', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:rPr><w:b/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Amount </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>«Amount»</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Amount: '1,500' }, r)
    assertValidWordprocessing(patched)
    expect(patched).not.toContain('fldChar')
    expect(patched).not.toContain('instrText')
    expect(patched).toContain('<w:t xml:space="preserve">1,500</w:t>')
    expect(patched).toContain('<w:rPr><w:b/></w:rPr>')
    expect(r.applied).toBe(1)
  })

  it('replaces a field with no cached result at all', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'A & B <x>' }, r)
    assertValidWordprocessing(patched)
    expect(patched).not.toContain('fldChar')
    expect(patched).toContain('<w:t xml:space="preserve">A &amp; B &lt;x&gt;</w:t>')
    expect(r.applied).toBe(1)
  })

  it('takes the formatting from the cached-result run when the begin run has none', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:rPr><w:i/></w:rPr><w:t>«Name»</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, report())
    assertValidWordprocessing(patched)
    expect(patched).toContain('<w:rPr><w:i/></w:rPr>')
  })

  it('resolves two fields in one paragraph and keeps the text between them', async () => {
    const xml =
      '<w:p>' +
      '<w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:r><w:t xml:space="preserve"> of </w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD City </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>«City»</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'Huy', City: 'Tokyo' }, r)
    assertValidWordprocessing(patched)
    expect(patched).not.toContain('fldChar')
    expect(r.applied).toBe(2)
    const reopened = await parseDocx(await buildDocx({ bodyXml: patched }))
    expect(reopened.blocks[0].runs?.map((run) => run.text).join('')).toBe('Dear Huy of Tokyo')
  })

  it('handles adjacent fields that share nothing but their runs', async () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD First </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Last </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { First: 'Huy', Last: 'Tran' }, r)
    assertValidWordprocessing(patched)
    expect(patched).not.toContain('fldChar')
    expect(r.applied).toBe(2)
    const reopened = await parseDocx(await buildDocx({ bodyXml: patched }))
    expect(reopened.blocks[0].runs?.map((run) => run.text).join('')).toBe('HuyTran')
  })

  it('joins an instruction split across several w:instrText runs', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD </w:instrText></w:r>' +
      '<w:r><w:instrText xml:space="preserve">"Postal Address" </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { 'Postal Address': '123 Nguyễn Huệ' }, r)
    assertValidWordprocessing(patched)
    expect(patched).not.toContain('fldChar')
    expect(patched).toContain('123 Nguyễn Huệ')
    expect(r.applied).toBe(1)
  })

  it('leaves a field it cannot resolve in place and reports it', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD City </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, r)
    expect(patched).toBe(xml)
    expect(r.missing).toEqual(['City'])
    expect(r.applied).toBe(0)
  })

  it('reports a field nested inside another field as unsupported instead of corrupting it', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, r)
    expect(patched).toBe(xml)
    expect(r.unsupported).toBe(1)
    assertValidWordprocessing(patched)
  })

  it('reports an unbalanced field as unsupported', () => {
    const xml =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
      '</w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, r)
    expect(patched).toBe(xml)
    expect(r.unsupported).toBe(1)
  })

  it('turns a fldSimple field into a plain run, so Word cannot re-evaluate it', async () => {
    const xml =
      '<w:p><w:fldSimple w:instr=" MERGEFIELD Name "><w:r><w:rPr><w:b/></w:rPr><w:t>«Name»</w:t></w:r></w:fldSimple></w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, r)
    assertValidWordprocessing(patched)
    expect(patched).not.toContain('fldSimple')
    expect(patched).not.toContain('«Name»')
    expect(patched).toContain('<w:rPr><w:b/></w:rPr>')
    expect(patched).toContain('<w:t xml:space="preserve">Huy</w:t>')
    expect(r.applied).toBe(1)
    const reopened = await parseDocx(await buildDocx({ bodyXml: patched }))
    expect(reopened.blocks[0].runs?.map((run) => run.text).join('')).toBe('Huy')
  })

  it('resolves a self-closing fldSimple', () => {
    const xml = '<w:p><w:fldSimple w:instr=" MERGEFIELD Name "/></w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, r)
    assertValidWordprocessing(patched)
    expect(patched).toContain('Huy')
    expect(r.applied).toBe(1)
  })

  it('leaves an unresolved fldSimple untouched', () => {
    const xml =
      '<w:p><w:fldSimple w:instr=" MERGEFIELD City "><w:r><w:t>«City»</w:t></w:r></w:fldSimple></w:p>'
    const r = report()
    const patched = patchMergeFieldXml(xml, { Name: 'Huy' }, r)
    expect(patched).toBe(xml)
    expect(r.missing).toEqual(['City'])
  })
})

describe('headers and footers', () => {
  const run = (text: string, instr?: string, bold = false): Run => ({
    text,
    ...(instr ? { instrField: instr } : {}),
    ...(bold ? { bold: true } : {}),
  })

  it('merges a header field and keeps the run formatting', () => {
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const hf = applyMergeValuesToHeaderFooter(
      {
        text: '«Name» — page',
        paras: [{ runs: [run('«Name»', 'MERGEFIELD Name', true), run(' — page')] }],
      },
      { Name: 'Huy' },
      report,
    )
    expect(hf.paras![0].runs[0].text).toBe('Huy')
    expect(hf.paras![0].runs[0].instrField).toBeUndefined()
    expect(hf.paras![0].runs[0].bold).toBe(true)
    expect(hf.text).toBe('Huy — page')
    expect(report.applied).toBe(1)
  })

  it('reports a header field the row has no column for instead of blanking it', () => {
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    applyMergeValuesToHeaderFooter(
      { text: '', paras: [{ runs: [run('«City»', 'MERGEFIELD City')] }] },
      { Name: 'Huy' },
      report,
    )
    expect(report.missing).toEqual(['City'])
    expect(report.applied).toBe(0)
  })

  it('leaves a page-number field in the footer alone', () => {
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const hf = applyMergeValuesToHeaderFooter(
      { text: 'Page 1', paras: [{ runs: [run('Page ', undefined), run('1', 'PAGE')] }] },
      { Name: 'Huy' },
      report,
    )
    expect(hf.paras![0].runs[1].instrField).toBe('PAGE')
    expect(report.unsupported).toBe(0)
    expect(report.applied).toBe(0)
  })

  it('counts an IF the merge model cannot evaluate as unsupported', () => {
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    applyMergeValuesToHeaderFooter(
      { text: '', paras: [{ runs: [run('x', 'IF «Status» = "vip"')] }] },
      { Status: 'vip' },
      report,
    )
    expect(report.unsupported).toBe(1)
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
    ).toBe('_.._.._.._test.pdf')
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

  it('keeps the extension when the name is longer than the limit', () => {
    const bytes = (value: string) => new TextEncoder().encode(value).length
    const name = safeFileName(`${'a'.repeat(300)}.docx`)
    expect(name.endsWith('.docx')).toBe(true)
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
  })

  it('fits a name built from two long columns into the limit', () => {
    const bytes = (value: string) => new TextEncoder().encode(value).length
    const name = buildOutputFileName({
      pattern: '{A}_{B}',
      index: 1,
      total: 1,
      values: { A: 'a'.repeat(150), B: 'b'.repeat(150) },
      extension: 'docx',
    })
    expect(name.endsWith('.docx')).toBe(true)
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
  })

  it('fits a multi-byte name without splitting a character', () => {
    const bytes = (value: string) => new TextEncoder().encode(value).length
    const name = safeFileName(`${'日'.repeat(100)}.pdf`)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
  })

  it('does not push a name over the limit when adding a collision suffix', () => {
    const bytes = (value: string) => new TextEncoder().encode(value).length
    const atLimit = 'a'.repeat(MAX_FILE_NAME_BYTES - 5)
    const name = uniqueFileName(`${atLimit}.docx`, (n) => n === `${atLimit}.docx`)
    expect(name).not.toBe(`${atLimit}.docx`)
    expect(name.endsWith('.docx')).toBe(true)
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
  })
})
