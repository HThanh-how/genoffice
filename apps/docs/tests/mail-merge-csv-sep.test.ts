/**
 * CSV sources: Excel's separator declaration and quotes that do not parse.
 *
 * Excel writes `sep=;` as the first line of a CSV it saves in a locale that uses
 * semicolons. Treating that line as data makes "sep=" the header and shifts every
 * recipient by one row. The declaration is Excel's own, so honouring it is not a
 * concession — ignoring it is the bug.
 *
 * A quote glued to the end of a quoted field (`"Alice"Jones`) is not valid RFC
 * 4180. Neither `Alice` nor `AliceJones` is what the file says, so the source is
 * refused rather than guessed.
 */
import { describe, expect, it } from 'vitest'
import { loadCsvSource } from '../src/renderer/mail-merge/data-source'
import { splitSepDeclaration, strayQuoteAfterField } from '../src/renderer/mail-merge/csv'

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

describe('Excel sep= declaration', () => {
  it('reads a semicolon file declared with sep=; as columns, not as a header row', () => {
    const source = loadCsvSource(b64('sep=;\nName;City\nLan;HCM\n'), 'list.csv', true)
    expect(source.columns.map((c) => c.name)).toEqual(['Name', 'City'])
    expect(source.recipients.length).toBe(1)
    expect(source.recipients[0].values).toEqual({ Name: 'Lan', City: 'HCM' })
  })

  it('honours a BOM-prefixed declaration', () => {
    const source = loadCsvSource(b64('﻿sep=;\nName;City\nAn;Da Nang\n'), 'list.csv', true)
    expect(source.columns.map((c) => c.name)).toEqual(['Name', 'City'])
    expect(source.recipients[0].values.City).toBe('Da Nang')
  })

  it('does not treat sep= as a delimiter when it is not the first line', () => {
    const { delimiter } = splitSepDeclaration('Name,City\nsep=;\nLan,HCM\n')
    expect(delimiter).toBeUndefined()
  })

  it('keeps Vietnamese, quoted multiline fields, literal quotes and leading zeros', () => {
    const csv =
      'sep=;\n' +
      '"Full Name";"Address";"Id"\n' +
      '"Nguyễn Văn A";"123 Nguyễn Huệ";"001234"\n' +
      'Ha"noi;"Line 1\nLine 2";"7"\n'
    const source = loadCsvSource(b64(csv), 'list.csv', true)
    expect(source.columns.map((c) => c.name)).toEqual(['Full Name', 'Address', 'Id'])
    expect(source.recipients[0].values).toEqual({
      'Full Name': 'Nguyễn Văn A',
      Address: '123 Nguyễn Huệ',
      Id: '001234',
    })
    // a quote in the middle of an unquoted field is data, not a broken quote
    expect(source.recipients[1].values['Full Name']).toBe('Ha"noi')
    expect(source.recipients[1].values.Address).toBe('Line 1\nLine 2')
  })

  it('still refuses a quote that never closes', () => {
    expect(() => loadCsvSource(b64('Name\n"unterminated\n'), 'list.csv', true)).toThrow(
      /quote that never closes/,
    )
  })

  it('refuses a field with a quote glued to its closing quote', () => {
    expect(strayQuoteAfterField('"Alice"Jones,1\n', ',')).toBe(0)
    expect(strayQuoteAfterField('"Alice",1\n', ',')).toBeNull()
    expect(strayQuoteAfterField('"a""b",1\n', ',')).toBeNull()
    expect(strayQuoteAfterField('Ha"noi,1\n', ',')).toBeNull()
    expect(() => loadCsvSource(b64('"Alice"Jones,1\n'), 'list.csv', true)).toThrow(
      /quote in the middle of a field/,
    )
  })
})
