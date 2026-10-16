/**
 * Field discovery reads OOXML the way the merge engine writes it.
 *
 * The validator used a regex over byte-preserved XML. That regex cannot see
 * `<w:fldSimple w:instr=" MERGEFIELD Name ">` (the instruction is an attribute,
 * not element text) and truncates a complex field whose instruction Word split
 * across several `w:instrText` elements. Both cases were reported as "no field
 * here", so a document that still contained the raw field was exported as if the
 * merge had worked.
 */
import { describe, expect, it } from 'vitest'
import {
  buildOutputFileName,
  fieldInstructionsInXml,
  isIndexToken,
  isMergeableFieldInstruction,
  mergeFieldName,
  patternTokens,
} from '../src/mail-merge'

const run = (inner: string) => `<w:r>${inner}</w:r>`
const complexField = (instr: string) =>
  run('<w:fldChar w:fldCharType="begin"/>') +
  run(`<w:instrText xml:space="preserve"> ${instr} </w:instrText>`) +
  run('<w:fldChar w:fldCharType="end"/>')

describe('field instructions found in OOXML', () => {
  it('finds a MERGEFIELD written as a simple field', () => {
    const xml =
      '<w:p><w:fldSimple w:instr=" MERGEFIELD Name "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>'
    const found = fieldInstructionsInXml(xml)
    expect(found).toEqual([' MERGEFIELD Name '])
    expect(mergeFieldName(found[0])).toBe('Name')
  })

  it('finds a simple field with no body at all', () => {
    const found = fieldInstructionsInXml('<w:p><w:fldSimple w:instr="MERGEFIELD Total"/></w:p>')
    expect(found).toEqual(['MERGEFIELD Total'])
  })

  it('reassembles an instruction Word split across several runs', () => {
    const xml =
      '<w:p>' +
      run('<w:fldChar w:fldCharType="begin"/>') +
      run('<w:instrText xml:space="preserve"> MERGEFIELD </w:instrText>') +
      run('<w:instrText xml:space="preserve">"Postal Address"</w:instrText>') +
      run('<w:instrText xml:space="preserve"> * MERGEFORMAT</w:instrText>') +
      run('<w:fldChar w:fldCharType="end"/>') +
      '</w:p>'
    const found = fieldInstructionsInXml(xml)
    expect(found.length).toBe(1)
    expect(mergeFieldName(found[0])).toBe('Postal Address')
  })

  it('does not invent a field from ordinary text', () => {
    expect(fieldInstructionsInXml('<w:p><w:r><w:t>MERGEFIELD Name</w:t></w:r></w:p>')).toEqual([])
  })

  it('reports an unterminated field instead of missing it', () => {
    const xml =
      '<w:p>' +
      run('<w:fldChar w:fldCharType="begin"/>') +
      run('<w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText>') +
      '</w:p>'
    const found = fieldInstructionsInXml(xml)
    expect(found.length).toBe(1)
    expect(mergeFieldName(found[0])).toBe('Name')
  })

  it('sees a field nested inside another field', () => {
    const xml =
      '<w:p>' +
      run('<w:fldChar w:fldCharType="begin"/>') +
      run('<w:instrText xml:space="preserve"> IF «Status» "a" "b" </w:instrText>') +
      run('<w:fldChar w:fldCharType="begin"/>') +
      run('<w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText>') +
      run('<w:fldChar w:fldCharType="end"/>') +
      run('<w:fldChar w:fldCharType="end"/>') +
      '</w:p>'
    const found = fieldInstructionsInXml(xml)
    expect(found.some((instr) => mergeFieldName(instr) === 'Name')).toBe(true)
  })

  it('agrees with the merge model on what can be merged', () => {
    const xml = '<w:p>' + complexField('PAGE') + '</w:p>'
    const found = fieldInstructionsInXml(xml)
    expect(found.length).toBe(1)
    expect(found[0].trim()).toBe('PAGE')
    expect(isMergeableFieldInstruction(found[0])).toBe(false)
  })
})

describe('file-name token grammar', () => {
  const values = { Name: 'Huy', 'First Name': 'Huy', Last: 'Nguyen' }

  it('expands every spelling of the index token the validator accepts', () => {
    for (const token of ['index', 'INDEX', 'Index', '3index', '00index']) {
      const name = buildOutputFileName({
        pattern: `{${token}}`,
        index: 7,
        total: 500,
        values,
        extension: 'docx',
      })
      // total=500 needs three digits, so a short explicit width never truncates
      expect(name).toBe('007.docx')
    }
  })

  it('honours an explicit index width when the batch is small', () => {
    expect(
      buildOutputFileName({ pattern: '{3index}', index: 5, total: 9, values, extension: 'docx' }),
    ).toBe('005.docx')
  })

  it('accepts whitespace inside a token, as the validator does', () => {
    const name = buildOutputFileName({
      pattern: '{ Name }',
      index: 1,
      total: 1,
      values,
      extension: 'docx',
    })
    expect(name).toBe('Huy.docx')
    expect(patternTokens('{ Name }').map((t) => isIndexToken(t))).toEqual([false])
  })

  it('leaves an unknown token out rather than writing it literally', () => {
    const name = buildOutputFileName({
      pattern: '{Missing}',
      index: 1,
      total: 1,
      values,
      extension: 'docx',
    })
    expect(name).toBe('merge-1.docx')
  })

  it('does not expand an unbalanced brace, and the validator rejects it', () => {
    const name = buildOutputFileName({
      pattern: '{Name',
      index: 1,
      total: 1,
      values,
      extension: 'docx',
    })
    expect(name.endsWith('.docx')).toBe(true)
    expect(patternTokens('{Name')).toEqual([])
  })

  it('keeps the extension when a multi-token name hits the byte ceiling', () => {
    const long = 'x'.repeat(120)
    const name = buildOutputFileName({
      pattern: '{a}_{b}_{c}',
      index: 1,
      total: 1,
      values: { a: long, b: long, c: long },
      extension: 'docx',
    })
    expect(name.endsWith('.docx')).toBe(true)
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200)
  })
})
