/**
 * One instruction, one interpretation.
 *
 * The engine's `fieldReferencedColumns` is the single source of truth for which
 * columns a MERGEFIELD or IF reads, and `patternTokens` is the single source of
 * truth for what a file-name pattern may contain. The validation panel and the
 * export dialog read both through these, so they can never disagree with the
 * engine that produces the file.
 */
import { describe, expect, it } from 'vitest'
import {
  buildOutputFileName,
  fieldReferencedColumns,
  isIndexToken,
  isMergeableFieldInstruction,
  MAX_FILE_NAME_BYTES,
  patternTokens,
  safeFileName,
} from '../src/mail-merge'

const bytes = (value: string) => new TextEncoder().encode(value).length

describe('IF field operands', () => {
  it('reads only the comparison operand, not the literal text it prints', () => {
    const instr = 'IF «Status» = "vip" "Xin chào «Khách VIP»" ""'
    expect(fieldReferencedColumns(instr)).toEqual(['Status'])
    expect(isMergeableFieldInstruction(instr)).toBe(true)
  })

  it('does not require a column named after the text the IF displays', () => {
    const instr = 'IF «Status» = "vip" "Xin chào «Khách VIP»" ""'
    const columns = fieldReferencedColumns(instr)
    expect(columns).not.toContain('Khách VIP')
    expect(columns).not.toContain('vip')
  })

  it('handles a truthy test with no operator', () => {
    expect(fieldReferencedColumns('IF «Address» "has an address" "none"')).toEqual(['Address'])
  })

  it('reports an instruction it cannot evaluate as having no columns', () => {
    expect(fieldReferencedColumns('IF «Status» = ')).toEqual([])
    expect(isMergeableFieldInstruction('IF «Status» = ')).toBe(false)
    expect(fieldReferencedColumns('MERGEFIELD')).toEqual([])
    expect(isMergeableFieldInstruction('MERGEFIELD')).toBe(false)
    expect(fieldReferencedColumns('PAGE')).toEqual([])
  })

  it('quotes a multi-word merge field as one column', () => {
    expect(fieldReferencedColumns('MERGEFIELD "Postal Address"')).toEqual(['Postal Address'])
    expect(fieldReferencedColumns('MERGEFIELD Postal Address')).toEqual(['Postal'])
  })
})

describe('file name pattern grammar', () => {
  it('tokenizes the pattern the way the engine expands it', () => {
    expect(patternTokens('{index}_{Name}')).toEqual(['index', 'Name'])
    expect(patternTokens('{ Name }')).toEqual(['Name'])
    expect(patternTokens('{1index}_{First}_{Last}')).toEqual(['1index', 'First', 'Last'])
    expect(patternTokens('report.pdf')).toEqual([])
  })

  it('recognises the index token in every form the engine accepts', () => {
    expect(isIndexToken('index')).toBe(true)
    expect(isIndexToken('1index')).toBe(true)
    expect(isIndexToken('INDEX')).toBe(true)
    expect(isIndexToken('index2')).toBe(false)
  })

  it('does not let a long first token erase a later one', () => {
    const values = { First: 'a'.repeat(300), Last: 'Nguyen' }
    const name = buildOutputFileName({
      pattern: '{First}_{Last}',
      index: 1,
      total: 1,
      values,
      extension: 'docx',
    })
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
    expect(name.endsWith('.docx')).toBe(true)
    // the base is fitted once, so the name is the longest legal prefix rather than
    // a 120-character token followed by nothing
    expect(name.length).toBeGreaterThan(120)
  })

  it('keeps the extension and the byte budget for every pattern form', () => {
    for (const pattern of [
      '{index}',
      '{index}_{Name}',
      '{Name}',
      '{ Name }',
      '{index}_{Unknown}',
    ]) {
      const name = buildOutputFileName({
        pattern,
        index: 7,
        total: 1200,
        values: { Name: 'Huy' },
        extension: 'pdf',
      })
      expect(name.endsWith('.pdf')).toBe(true)
      expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
    }
  })

  it('pads the index to the width of the total', () => {
    const name = buildOutputFileName({
      pattern: '{index}_{Name}',
      index: 7,
      total: 1200,
      values: { Name: 'Huy' },
      extension: 'docx',
    })
    expect(name).toBe('0007_Huy.docx')
  })

  it('falls back to a deterministic name when every token is empty', () => {
    const name = buildOutputFileName({
      pattern: '{Missing}',
      index: 3,
      total: 3,
      values: {},
      extension: 'docx',
    })
    expect(name).toBe('merge-3.docx')
  })

  it('respects Windows reserved names in a pattern result', () => {
    const name = buildOutputFileName({
      pattern: '{Name}',
      index: 1,
      total: 1,
      values: { Name: 'CON' },
      extension: 'docx',
    })
    expect(name).toBe('_CON.docx')
  })

  it('fits a multi-byte name without splitting a character', () => {
    const name = safeFileName(`${'日'.repeat(100)}_{Last}.docx`)
    expect(name.endsWith('.docx')).toBe(true)
    expect(bytes(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
  })
})
