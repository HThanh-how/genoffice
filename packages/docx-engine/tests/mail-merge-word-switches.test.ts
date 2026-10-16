/**
 * Word's MERGEFIELD switches and control fields.
 *
 * `\f " "` is how an Address Block keeps its spaces; `\* Upper` is how a
 * template shouts a name. A merge that ignores them writes text the user did not
 * ask for and still reports success. NEXT and SKIPIF move a record cursor that a
 * one-file-per-recipient batch does not have, so they are refused rather than
 * quietly skipped.
 */
import { describe, expect, it } from 'vitest'
import {
  isMergeControlField,
  mergeFieldSwitches,
  mergeFieldText,
  patchMergeFieldXml,
  type MergeReport,
} from '../src/mail-merge'

const report = (): MergeReport => ({ missing: [], unused: [], unsupported: 0, applied: 0 })

const simpleField = (instr: string) => `<w:fldSimple w:instr=" ${instr} ">«x»</w:fldSimple>`

describe('MERGEFIELD switches', () => {
  it('reads the before/after/case switches Word writes', () => {
    expect(mergeFieldSwitches('MERGEFIELD First \\f " " \\* Upper')).toEqual({
      before: '',
      after: ' ',
      caseFormat: 'Upper',
    })
    // MERGEFORMAT is Word's "keep the formatting" marker, not a case instruction
    expect(mergeFieldSwitches('MERGEFIELD Name \\* MERGEFORMAT').caseFormat).toBeNull()
  })

  it('joins address parts with the text after \\f instead of gluing them', () => {
    const values = { First: 'Ada', Last: 'Lovelace' }
    expect(mergeFieldText('MERGEFIELD First \\f " "', values)).toBe('Ada ')
    expect(mergeFieldText('MERGEFIELD Last \\b " "', values)).toBe(' Lovelace')
    // an empty part contributes nothing, so its padding is not written either
    expect(mergeFieldText('MERGEFIELD Middle \\f " "', { Middle: '' })).toBe('')
  })

  it('applies the case switches', () => {
    expect(mergeFieldText('MERGEFIELD Name \\* Upper', { Name: 'nguyễn' })).toBe('NGUYỄN')
    expect(mergeFieldText('MERGEFIELD Name \\* Lower', { Name: 'NGUYỄN' })).toBe('nguyễn')
    expect(mergeFieldText('MERGEFIELD Name \\* FirstCap', { Name: 'huy thanh' })).toBe('Huy thanh')
    expect(mergeFieldText('MERGEFIELD Name \\* Caps', { Name: 'huy-thanh' })).toBe('Huy-Thanh')
  })

  it('writes the switched value into the document, not the bare column', () => {
    const xml = simpleField('MERGEFIELD Name \\* Upper')
    const merged = patchMergeFieldXml(xml, { Name: 'huy' }, report())
    expect(merged).toContain('<w:t xml:space="preserve">HUY</w:t>')
    expect(merged).not.toContain('fldSimple')
  })
})

describe('values that are not plain text', () => {
  it('turns a multiline address into real line breaks', () => {
    const xml = simpleField('MERGEFIELD Address')
    const merged = patchMergeFieldXml(xml, { Address: '123 Nguyễn Huệ\nDa Nang' }, report())
    expect(merged).toContain(
      '<w:t xml:space="preserve">123 Nguyễn Huệ</w:t><w:br/><w:t xml:space="preserve">Da Nang</w:t>',
    )
    // a literal newline inside <w:t> is what Word renders as a space
    expect(merged).not.toContain('Huệ\nDa Nang')
  })

  it('escapes markup and drops characters XML cannot carry', () => {
    const xml = simpleField('MERGEFIELD Note')
    const merged = patchMergeFieldXml(xml, { Note: 'a & b < c \u0000 d' }, report())
    expect(merged).toContain('a &amp; b &lt; c')
    expect(merged).not.toContain('\u0000')
  })
})

describe('control fields', () => {
  it('recognises NEXT and SKIPIF', () => {
    expect(isMergeControlField(' NEXT ')).toBe(true)
    expect(isMergeControlField('SKIPIF «Status» = "yes"')).toBe(true)
    expect(isMergeControlField('MERGEFIELD Name')).toBe(false)
  })

  it('refuses a control field instead of merging every recipient as one record', () => {
    const report0 = report()
    const merged = patchMergeFieldXml(
      simpleField('SKIPIF Status = "yes"'),
      { Status: 'yes' },
      report0,
    )
    expect(report0.unsupported).toBe(1)
    expect(merged).toContain('SKIPIF')
  })
})
