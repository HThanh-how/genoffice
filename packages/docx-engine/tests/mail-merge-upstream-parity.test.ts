/**
 * Differential field semantics: what the engine does with the forms Word writes.
 *
 * The fork and upstream each grew a mail-merge engine. These tests pin the
 * canonical behaviour the two now share — IF truthiness, field-to-field
 * comparison, numeric comparison, keyword capitalisation, switches, quoted
 * names, missing columns, control fields, and fields that are not merge fields
 * at all — so a change in one place cannot quietly mean something different in
 * another.
 *
 * Where Word's own contract is not documented by an existing test here, the
 * behaviour is described as the engine's decision, not as a claim of Word
 * compatibility.
 */
import { describe, expect, it } from 'vitest'
import type { Block } from '../src/types'
import {
  compareOperands,
  conditionHolds,
  controlEffect,
  fieldReferencedColumns,
  ifBranch,
  isConditionalField,
  isMergeControlField,
  isMergeField,
  isMergeableFieldInstruction,
  mergeBlockTree,
  mergeDataFromRows,
  mergeFieldName,
  mergeFieldText,
  mergeRecords,
  splitInstruction,
  valueOf,
  type MergeData,
} from '../src/mail-merge'

const blk = (runs: unknown[]): Block =>
  ({ id: '', docxIndex: 0, originalXml: '', type: 'paragraph', runs }) as unknown as Block

const mergeName = (name = 'Name') => blk([{ text: `«${name}»`, instrField: `MERGEFIELD ${name}` }])
const control = (instr: string) => blk([{ text: '', instrField: instr }])
const lines = (blocks: readonly Block[]): string[] =>
  blocks.map((b) => (b.runs ?? []).map((r) => r.text ?? '').join(''))

describe('CASE A: IF with a single operand', () => {
  const branches = (value: string) => ifBranch('IF «N» "yes" "no"', { N: value })

  it('an empty column takes the false branch', () => {
    expect(branches('')).toBe('no')
  })

  it('zero is false, the way Word reads a numeric test', () => {
    expect(branches('0')).toBe('no')
  })

  it('one, "false" and "yes" are all non-empty text and take the true branch', () => {
    expect(branches('1')).toBe('yes')
    expect(branches('false')).toBe('yes')
    expect(branches('yes')).toBe('yes')
  })

  it('whitespace alone is non-empty text, so it takes the true branch', () => {
    // the engine does not trim a column's value: Word tests the field's content,
    // and a field holding spaces has content
    expect(branches('  ')).toBe('yes')
    expect(branches(' ')).toBe('yes')
  })

  it('the test is the first operand, not the whole instruction', () => {
    // passing the entire instruction would be non-empty text for every record,
    // making the false branch unreachable
    const data: MergeData = { fields: ['Paid'], records: [{ Paid: '' }, { Paid: 'yes' }] }
    expect(mergeBlockTree([control('IF «Paid» "got" "missed"')], data).map(lines)).toEqual([
      ['missed'],
      ['got'],
    ])
  })
})

describe('CASE B: IF comparing two fields', () => {
  it('compares one column against another rather than against a literal', () => {
    const record = { Amount: '50', Threshold: '10' }
    expect(ifBranch('IF «Amount» > «Threshold» "High" "Low"', record)).toBe('High')
    expect(
      ifBranch('IF «Amount» > «Threshold» "High" "Low"', { Amount: '5', Threshold: '10' }),
    ).toBe('Low')
  })

  it('a bare word in a comparison is a literal, not a column', () => {
    // Word wraps a column in guillemets. `SKIPIF Status = "yes"` compares the
    // text "Status" with "yes" and is false for every record; reading `Status`
    // as a column would make a template skip rows at random.
    const rows: MergeData = { fields: ['Status'], records: [{ Status: 'yes' }] }
    expect(mergeRecords([control('SKIPIF Status = "yes"')], rows, 0).cursor.skipped).toBe(false)
    expect(mergeRecords([control('SKIPIF «Status» = "yes"')], rows, 0).cursor.skipped).toBe(true)
  })

  it('a MERGEFIELD-wrapped operand resolves to the same column', () => {
    expect(conditionHolds('IF MERGEFIELD Amount > 10', { Amount: '20' })).toBe(true)
  })
})

describe('CASE C: numeric comparison', () => {
  it('compares numerically when both sides are numbers', () => {
    expect(compareOperands('9', '<', '50', {})).toBe(true)
    expect(compareOperands('5', '=', '5.0', {})).toBe(true)
    expect(compareOperands('-3', '<', '2', {})).toBe(true)
    expect(compareOperands('0.1', '>', '0.05', {})).toBe(true)
    expect(compareOperands('007', '=', '7', {})).toBe(true)
  })

  it('stays textual when either side is not a number', () => {
    expect(compareOperands('"9"', '<', '"50a"', {})).toBe(false)
    expect(compareOperands('apple', '<', 'banana', {})).toBe(true)
    expect(compareOperands('', '=', '', {})).toBe(true)
    expect(compareOperands('', '=', 'x', {})).toBe(false)
  })

  it('an unsupported operator is false rather than a guess', () => {
    expect(compareOperands('1', '!=', '2', {})).toBe(false)
  })
})

describe('CASE D: keyword capitalisation', () => {
  it('reads the keyword whatever its case', () => {
    for (const instr of ['MERGEFIELD Name', 'mergefield Name', 'MergeField Name']) {
      expect(splitInstruction(instr)[0]).toBe('MERGEFIELD')
      expect(isMergeField(instr)).toBe(true)
      expect(mergeFieldName(instr)).toBe('Name')
      expect(mergeFieldText(instr, { Name: 'ada' })).toBe('ada')
    }
    for (const instr of ['IF «N» "a" "b"', 'if «N» "a" "b"', 'If «N» "a" "b"']) {
      expect(isConditionalField(instr)).toBe(true)
      expect(ifBranch(instr, { N: 'x' })).toBe('a')
    }
    for (const instr of ['NEXT', 'next', 'Next']) {
      expect(isMergeControlField(instr)).toBe(true)
      expect(controlEffect(instr, {})?.kind).toBe('next')
    }
    for (const instr of ['SKIPIF «N» = "yes"', 'skipif «N» = "yes"', 'SkipIf «N» = "yes"']) {
      expect(isMergeControlField(instr)).toBe(true)
    }
  })

  it('does not mistake another field for a merge field', () => {
    expect(isMergeField('PAGE')).toBe(false)
    expect(isMergeField('MERGEFORMAT')).toBe(false)
    expect(mergeFieldName('MERGEFIELD')).toBeNull()
  })
})

describe('CASE E: switches', () => {
  const rec = { First: 'ada', Last: 'LOVELACE', Empty: '' }

  it('applies \\b and \\f only around a non-empty value', () => {
    expect(mergeFieldText('MERGEFIELD First \\f " "', rec)).toBe('ada ')
    expect(mergeFieldText('MERGEFIELD Empty \\b "(" \\f ")"', rec)).toBe('')
    expect(mergeFieldText('MERGEFIELD Last \\b "Ms. "', rec)).toBe('Ms. LOVELACE')
  })

  it('applies the case switches and ignores MERGEFORMAT/CHARFORMAT', () => {
    expect(mergeFieldText('MERGEFIELD First \\* Upper', rec)).toBe('ADA')
    expect(mergeFieldText('MERGEFIELD Last \\* Lower', rec)).toBe('lovelace')
    expect(mergeFieldText('MERGEFIELD Last \\* FirstCap \\* MERGEFORMAT', rec)).toBe('Lovelace')
    expect(mergeFieldText('MERGEFIELD Last \\* Caps', { Last: 'van der berg' })).toBe(
      'Van Der Berg',
    )
    expect(mergeFieldText('MERGEFIELD First \\* CHARFORMAT', rec)).toBe('ada')
  })

  it('handles a Vietnamese name under each case switch', () => {
    expect(mergeFieldText('MERGEFIELD Name \\* Upper', { Name: 'nguyễn' })).toBe('NGUYỄN')
    expect(mergeFieldText('MERGEFIELD Name \\* Lower', { Name: 'NGUYỄN' })).toBe('nguyễn')
  })
})

describe('CASE F: quoted and unusual column names', () => {
  it('reads a quoted name whole', () => {
    expect(mergeFieldName('MERGEFIELD "Postal Address" \\* MERGEFORMAT')).toBe('Postal Address')
    expect(
      mergeFieldText('MERGEFIELD "Postal Address"', { 'Postal Address': '123 Nguyễn Huệ' }),
    ).toBe('123 Nguyễn Huệ')
  })

  it('an IF only reads the columns in its condition, not its literal branches', () => {
    expect(fieldReferencedColumns('IF «Status» = "vip" "Xin chào «Khách VIP»" ""')).toEqual([
      'Status',
    ])
  })
})

describe('CASE G: missing, empty and unsupported', () => {
  it('a missing column reads as empty text in the cursor-aware engine', () => {
    const data: MergeData = { fields: ['Name'], records: [{ Name: 'Ada' }] }
    const { blocks } = mergeRecords([mergeName('Nope')], data)
    expect(blocks[0]!.runs).toEqual([{ text: '' }])
  })

  it('an existing column with an empty value is not the same as a missing one', () => {
    expect(valueOf({ Name: '' }, 'Name')).toBe('')
    expect(valueOf({}, 'Name')).toBe('')
    expect(fieldReferencedColumns('MERGEFIELD Name')).toEqual(['Name'])
  })

  it('a field the merge cannot evaluate is reported, not silently dropped', () => {
    expect(isMergeableFieldInstruction('MERGEFIELD Name')).toBe(true)
    expect(isMergeableFieldInstruction('IF «N» "a" "b"')).toBe(true)
    // NEXT/SKIPIF need a record cursor; the per-recipient path has none, so the
    // workflow refuses them instead of pretending they worked
    expect(isMergeableFieldInstruction('NEXT')).toBe(false)
    expect(isMergeableFieldInstruction('SKIPIF «N» = "yes"')).toBe(false)
    expect(isMergeableFieldInstruction('PAGE')).toBe(false)
  })
})

describe('CASE H: NEXT and SKIPIF cursor semantics', () => {
  const data: MergeData = {
    fields: ['Name', 'Skip'],
    records: [
      { Name: 'Ada', Skip: 'no' },
      { Name: 'Grace', Skip: 'yes' },
      { Name: 'Linus', Skip: 'no' },
    ],
  }

  it('NEXT advances the cursor inside one pass', () => {
    const { blocks, cursor } = mergeRecords([mergeName(), control('NEXT'), mergeName()], data, 0)
    expect(lines(blocks)).toEqual(['Ada', 'Grace'])
    expect(cursor.next).toBe(true)
  })

  it('a NEXT past the last record reads empty fields', () => {
    const { blocks } = mergeRecords([mergeName(), control('NEXT'), mergeName()], data, 2)
    expect(lines(blocks)).toEqual(['Linus', ''])
  })

  it('a paragraph holding only a control field does not survive', () => {
    const { blocks } = mergeRecords([mergeName(), control('NEXT')], data, 0)
    expect(lines(blocks)).toEqual(['Ada'])
  })

  it('SKIPIF drops the record it rejects and keeps the others', () => {
    const out = mergeBlockTree([mergeName(), control('SKIPIF «Skip» = "yes"')], data)
    expect(out.map(lines)).toEqual([['Ada'], ['Linus']])
  })

  it('a NEXT-driven template lays records end to end', () => {
    const out = mergeBlockTree([mergeName(), control('NEXT'), mergeName()], {
      fields: ['Name'],
      records: [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }],
    })
    expect(out.map(lines)).toEqual([
      ['A', 'B'],
      ['C', ''],
    ])
  })

  it('the engine does not mutate the template blocks', () => {
    const input = [mergeName()]
    const before = JSON.stringify(input)
    mergeBlockTree(input, { fields: ['Name'], records: [{ Name: 'Ada' }] })
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('CASE I: tables and unrelated fields', () => {
  it('reaches into a table cell', () => {
    const data: MergeData = { fields: ['Name'], records: [{ Name: 'Ada' }] }
    const { blocks } = mergeRecords(
      [
        {
          id: '',
          docxIndex: 0,
          originalXml: '',
          type: 'table',
          table: {
            rows: [
              [
                {
                  paras: [],
                  richParas: [{ runs: [{ text: '«Name»', instrField: 'MERGEFIELD Name' }] }],
                },
              ],
            ],
          },
        } as unknown as Block,
      ],
      data,
    )
    const table = (blocks[0] as { table?: NonNullable<Block['table']> }).table!
    expect(table.rows[0]![0]!.richParas?.[0]!.runs[0]!.text).toBe('Ada')
  })

  it('leaves PAGE, DATE and REF fields exactly as they were', () => {
    const data: MergeData = { fields: ['Name'], records: [{ Name: 'Ada' }] }
    for (const instr of ['PAGE', 'DATE', 'REF Zotero', 'HYLINK https://example.com']) {
      const { blocks } = mergeRecords([blk([{ text: 'x', instrField: instr }])], data)
      expect(blocks[0]!.runs?.[0]!.instrField).toBe(instr)
    }
  })

  it('keeps a run that carries no text — a logo, an index entry', () => {
    const data: MergeData = { fields: ['Name'], records: [{ Name: 'Ada' }] }
    const logo = blk([{ text: '', image: { rid: 'r1', name: 'logo' } }])
    const { blocks } = mergeRecords([blk([{ text: 'x' }]), logo, mergeName()], data)
    expect(blocks[1]!.runs?.[0]!.image).toBeDefined()
  })

  it('keeps the formatting the field carried', () => {
    const data: MergeData = { fields: ['Name'], records: [{ Name: 'Ada' }] }
    const { blocks } = mergeRecords(
      [blk([{ text: '«Name»', instrField: 'MERGEFIELD Name', bold: true }])],
      data,
    )
    expect(blocks[0]!.runs?.[0]!.bold).toBe(true)
    expect(blocks[0]!.runs?.[0]!.text).toBe('Ada')
  })
})

describe('CASE J: recipient rows from parsed rows', () => {
  it('builds one record per row and pads short rows', () => {
    const data = mergeDataFromRows([['Name', 'City'], ['Ada', 'London'], ['Grace']])
    expect(data.fields).toEqual(['Name', 'City'])
    expect(data.records).toEqual([
      { Name: 'Ada', City: 'London' },
      { Name: 'Grace', City: '' },
    ])
  })

  it('trims headers but not values', () => {
    const data = mergeDataFromRows([[' Name '], ['  padded  ']])
    expect(data.fields).toEqual(['Name'])
    expect(data.records[0]).toEqual({ Name: '  padded  ' })
  })

  it('an empty source yields no fields rather than throwing', () => {
    expect(mergeDataFromRows([])).toEqual({ fields: [], records: [] })
  })
})
