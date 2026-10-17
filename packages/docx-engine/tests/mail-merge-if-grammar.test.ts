/**
 * One IF grammar, one owner.
 *
 * `fieldReferencedColumns` decides which columns a batch must supply;
 * `conditionHolds`/`ifBranch` decide what the instruction prints. If the two
 * read the instruction differently, a template can pass validation and then
 * silently print an empty value for a column the source never had — the exact
 * failure the missing-column policy exists to prevent.
 *
 * The contract these tests pin down:
 *   - the condition's operands are data references;
 *   - a bare word in a comparison is a literal, not a column (Word's rule);
 *   - the branches an IF prints are literal text, guillemets included;
 *   - an instruction the model cannot evaluate is reported as unsupported,
 *     never merged as if it worked.
 */
import { describe, expect, it } from 'vitest'
import {
  conditionHolds,
  evaluateConditionalField,
  fieldReferencedColumns,
  ifBranch,
  isConditionalField,
  isMergeableFieldInstruction,
} from '../src/mail-merge'

describe('F1 — a guillemet inside an IF branch is literal text', () => {
  const instr = 'IF «Status» = "vip" "Hello «Customer»" "Hello"'

  it('requires only the column the condition reads', () => {
    expect(fieldReferencedColumns(instr)).toEqual(['Status'])
  })

  it('prints the branch exactly as written when the column is missing', () => {
    expect(ifBranch(instr, { Status: 'vip' })).toBe('Hello «Customer»')
    expect(ifBranch(instr, { Status: 'other' })).toBe('Hello')
  })

  it('and prints it unchanged when the column is present too', () => {
    expect(ifBranch(instr, { Status: 'vip', Customer: 'Ada' })).toBe('Hello «Customer»')
  })
})

describe('F2 — MERGEFIELD written as an operand', () => {
  const instr = 'IF MERGEFIELD Amount > 10 "High" "Low"'

  it('the validator sees the column the evaluator reads', () => {
    expect(fieldReferencedColumns(instr)).toEqual(['Amount'])
  })

  it('the condition really uses that column', () => {
    expect(conditionHolds(instr, { Amount: '50' })).toBe(true)
    expect(conditionHolds(instr, { Amount: '5' })).toBe(false)
    expect(ifBranch(instr, { Amount: '50' })).toBe('High')
  })

  it('a quoted MERGEFIELD name with a space is one column', () => {
    const quoted = 'IF MERGEFIELD "Total Amount" > 10 "High" "Low"'
    expect(fieldReferencedColumns(quoted)).toEqual(['Total Amount'])
    expect(conditionHolds(quoted, { 'Total Amount': '20' })).toBe(true)
  })
})

describe('F3/F4/F5 — field-to-field and simple branches', () => {
  it('compares two columns', () => {
    const instr = 'IF «Amount» > «Threshold» "High" "Low"'
    expect(fieldReferencedColumns(instr)).toEqual(['Amount', 'Threshold'])
    expect(ifBranch(instr, { Amount: '50', Threshold: '10' })).toBe('High')
    expect(ifBranch(instr, { Amount: '5', Threshold: '10' })).toBe('Low')
  })

  it('prints the branch it selects', () => {
    const instr = 'IF «Status» = "vip" "VIP" "Regular"'
    expect(fieldReferencedColumns(instr)).toEqual(['Status'])
    expect(ifBranch(instr, { Status: 'vip' })).toBe('VIP')
    expect(ifBranch(instr, { Status: 'no' })).toBe('Regular')
  })

  it('an empty branch merges to nothing', () => {
    const instr = 'IF «Status» = "vip" "" "Regular"'
    expect(ifBranch(instr, { Status: 'vip' })).toBe('')
    expect(ifBranch(instr, { Status: 'x' })).toBe('Regular')
  })
})

describe('F6-F8 — malformed IF fails closed', () => {
  it('a single branch is still a valid IF', () => {
    const instr = 'IF «Status» = "vip" "VIP"'
    expect(isConditionalField(instr)).toBe(true)
    expect(isMergeableFieldInstruction(instr)).toBe(true)
    expect(fieldReferencedColumns(instr)).toEqual(['Status'])
    expect(evaluateConditionalField(instr, { Status: 'vip' })).toBe('VIP')
    expect(evaluateConditionalField(instr, { Status: 'x' })).toBe('')
  })

  it('an IF with no branch at all is not mergeable', () => {
    expect(isConditionalField('IF «Status» = "vip"')).toBe(false)
    expect(isMergeableFieldInstruction('IF «Status» = "vip"')).toBe(false)
    expect(fieldReferencedColumns('IF «Status» = "vip"')).toEqual([])
    expect(evaluateConditionalField('IF «Status» = "vip"', { Status: 'vip' })).toBeNull()
  })

  it('a dangling operator is not mergeable', () => {
    expect(isConditionalField('IF «Status» =')).toBe(false)
    expect(isMergeableFieldInstruction('IF «Status» =')).toBe(false)
    expect(fieldReferencedColumns('IF «Status» =')).toEqual([])
    expect(evaluateConditionalField('IF «Status» =', { Status: 'x' })).toBeNull()
  })
})

describe('F9-F12 — literals, missing columns and empty values', () => {
  it('a bare word in a comparison is a literal, not a column', () => {
    const instr = 'IF "literal" = "literal" "yes" "no"'
    expect(fieldReferencedColumns(instr)).toEqual([])
    expect(conditionHolds(instr, {})).toBe(true)
    expect(ifBranch(instr, {})).toBe('yes')
    // Word reads `SKIPIF Status = "yes"` as the text "Status" against "yes"
    expect(conditionHolds('IF Status = "yes" "a" "b"', { Status: 'yes' })).toBe(false)
  })

  it('a missing column in the condition is reported, not silently emptied', () => {
    const instr = 'IF «MissingColumn» = "x" "yes" "no"'
    expect(fieldReferencedColumns(instr)).toEqual(['MissingColumn'])
    // the evaluator still resolves it as empty text — the validator is what
    // stops the batch before that ever reaches a file
    expect(conditionHolds(instr, {})).toBe(false)
  })

  it('distinguishes an empty value from an absent column', () => {
    const instr = 'IF «Note» "has" "none"'
    expect(fieldReferencedColumns(instr)).toEqual(['Note'])
    expect(conditionHolds(instr, { Note: '' })).toBe(false)
    expect(conditionHolds(instr, { Note: 'x' })).toBe(true)
    expect(conditionHolds(instr, {})).toBe(false)
  })

  it('zero is false, one is true, the way Word reads a numeric test', () => {
    expect(conditionHolds('IF «N» "yes" "no"', { N: '0' })).toBe(false)
    expect(conditionHolds('IF «N» "yes" "no"', { N: '1' })).toBe(true)
    expect(conditionHolds('IF «N» "yes" "no"', { N: 'false' })).toBe(true)
  })
})

describe('F13-F19 — Unicode, quoting and whitespace', () => {
  it('a Vietnamese branch survives verbatim', () => {
    const instr = 'IF «Status» = "vip" "Xin chào «Khách VIP»" ""'
    expect(fieldReferencedColumns(instr)).toEqual(['Status'])
    expect(ifBranch(instr, { Status: 'vip' })).toBe('Xin chào «Khách VIP»')
  })

  it('literal guillemets in a branch are not stripped', () => {
    expect(ifBranch('IF «A» "«»" "x"', { A: 'y' })).toBe('«»')
  })

  it('mixed-case keywords behave the same', () => {
    for (const instr of ['IF «N» = "x" "a" "b"', 'if «N» = "x" "a" "b"', 'If «N» = "x" "a" "b"']) {
      expect(isConditionalField(instr)).toBe(true)
      expect(fieldReferencedColumns(instr)).toEqual(['N'])
      expect(ifBranch(instr, { N: 'x' })).toBe('a')
    }
  })

  it('Unicode column names are read as one column', () => {
    const instr = 'IF «Họ và tên» = "x" "a" "b"'
    expect(fieldReferencedColumns(instr)).toEqual(['Họ và tên'])
    expect(conditionHolds(instr, { 'Họ và tên': 'x' })).toBe(true)
  })

  it('multiword quoted column names are one column', () => {
    const instr = 'IF «Postal Address» = "x" "a" "b"'
    expect(fieldReferencedColumns(instr)).toEqual(['Postal Address'])
    expect(conditionHolds(instr, { 'Postal Address': 'x' })).toBe(true)
  })

  it('numeric strings with leading zeros compare numerically', () => {
    const instr = 'IF «Code» > 10 "big" "small"'
    expect(ifBranch(instr, { Code: '0050' })).toBe('big')
    expect(ifBranch(instr, { Code: '0009' })).toBe('small')
  })

  it('a whitespace-only value is non-empty text', () => {
    expect(conditionHolds('IF «N» "yes" "no"', { N: '  ' })).toBe(true)
    expect(ifBranch('IF «N» "yes" "no"', { N: '  ' })).toBe('yes')
  })

  it('a quoted branch containing spaces stays one branch', () => {
    const instr = 'IF «A» = "x" "a b c" "d e f"'
    expect(ifBranch(instr, { A: 'x' })).toBe('a b c')
    expect(ifBranch(instr, { A: 'y' })).toBe('d e f')
  })
})
