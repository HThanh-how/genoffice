/**
 * Reading recipients straight from an open GenOffice spreadsheet. The range the
 * user typed is the contract: the columns it names are the columns read, the
 * rows it covers are the rows read, and nothing outside it can leak in.
 */
import { describe, expect, it } from 'vitest'
import {
  addressesInRange,
  loadSheetSource,
  rangeBounds,
} from '../src/renderer/mail-merge/data-source'

/** A stand-in for the shell's spreadsheet bridge: cells keyed by their A1 address. */
function fakeReader(cells: Record<string, string>) {
  const requested: string[] = []
  const read = async (_wcId: number, _sheet: string, addresses: string[]) => {
    requested.push(...addresses)
    return {
      ok: true,
      result: {
        cells: Object.fromEntries(addresses.map((a) => [a, { value: cells[a] ?? '' }])),
      },
    }
  }
  return { read, requested }
}

describe('range parsing', () => {
  it('maps a range to the columns and rows it actually names', () => {
    expect(rangeBounds('A1:D10')).toEqual({ firstCol: 0, lastCol: 3, firstRow: 1, lastRow: 10 })
    expect(rangeBounds('C5:F100')).toEqual({ firstCol: 2, lastCol: 5, firstRow: 5, lastRow: 100 })
    expect(rangeBounds('AA10:AC20')).toEqual({
      firstCol: 26,
      lastCol: 28,
      firstRow: 10,
      lastRow: 20,
    })
    expect(rangeBounds('B2:B8')).toEqual({ firstCol: 1, lastCol: 1, firstRow: 2, lastRow: 8 })
    expect(rangeBounds('10:20')).toBeNull()
    expect(rangeBounds('F5:C100')).toBeNull()
    // a 30-letter column cannot exist in a worksheet, and the arithmetic would
    // overflow to Infinity before any address was generated
    expect(rangeBounds('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ1:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ2')).toBeNull()
    expect(rangeBounds('XFE1:XFE2')).toBeNull()
    expect(rangeBounds('A1:1000000000000000000000')).toBeNull()
    // Excel's own row ceiling: a range past row 1,048,576 is not a range
    expect(rangeBounds('A1:A1048577')).toBeNull()
    expect(rangeBounds('A1:A1048576')).toEqual({
      firstCol: 0,
      lastCol: 0,
      firstRow: 1,
      lastRow: 1048576,
    })
  })

  it('builds addresses that start at the selected column, not at A', () => {
    const addresses = addressesInRange('C5:F7')
    expect(addresses[0]).toBe('C5')
    expect(addresses[addresses.length - 1]).toBe('F7')
    expect(addresses.length).toBe(4 * 3)
    expect(addresses.filter((a) => a.startsWith('A') || a.startsWith('B'))).toEqual([])
  })

  it('handles two-letter columns', () => {
    const addresses = addressesInRange('AA10:AC11')
    expect(addresses).toEqual(['AA10', 'AB10', 'AC10', 'AA11', 'AB11', 'AC11'])
  })
})

describe('loading recipients from a range', () => {
  it('reads a non-A1 range and ignores everything outside it', async () => {
    const cells = {
      A1: 'outside header',
      B2: 'outside row',
      C5: 'Name',
      D5: 'City',
      E5: 'Amount',
      F5: 'Note',
      C6: 'Huy',
      D6: 'Tokyo',
      E6: '100',
      F6: 'vip',
      C7: 'An',
      D7: 'Paris',
      E7: '250',
      C8: '',
      D8: '',
      E8: '',
      F8: '',
      C9: 'Bo',
      D9: 'Berlin',
      E9: '300',
    }
    const { read, requested } = fakeReader(cells)
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'C5:F100', true, read)
    expect(source.columns.map((c) => c.name)).toEqual(['Name', 'City', 'Amount', 'Note'])
    expect(source.recipients.map((r) => r.values.Name)).toEqual(['Huy', 'An', '', 'Bo'])
    expect(source.recipients.map((r) => r.id)).toEqual([0, 1, 2, 3])
    // the bridge is only ever asked for cells inside the selection
    expect(requested.some((a) => a === 'A1' || a === 'B2')).toBe(false)
    expect(requested[0]).toBe('C5')
    expect(requested[requested.length - 1]).toBe('F100')
  })

  it('does not stop at the first blank row inside the selection', async () => {
    const cells = {
      C5: 'Name',
      D5: 'City',
      C6: 'Huy',
      D6: 'Tokyo',
      C7: '',
      D7: '',
      C8: 'Bo',
      D8: 'Berlin',
    }
    const { read } = fakeReader(cells)
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'C5:D8', true, read)
    expect(source.recipients.map((r) => r.values.Name)).toEqual(['Huy', '', 'Bo'])
  })

  it('drops the blank rows trailing the selection', async () => {
    const cells = {
      B2: 'Name',
      B3: 'Huy',
      B4: 'An',
    }
    const { read } = fakeReader(cells)
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'B2:B50', true, read)
    expect(source.recipients.map((r) => r.values.Name)).toEqual(['Huy', 'An'])
  })

  it('honours the last row of the range', async () => {
    const cells = {
      A1: 'Name',
      A2: 'Huy',
      A3: 'An',
      A4: 'Bo',
    }
    const { read } = fakeReader(cells)
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:A3', true, read)
    expect(source.recipients.map((r) => r.values.Name)).toEqual(['Huy', 'An'])
  })

  it('rejects a range it cannot parse', async () => {
    const { read } = fakeReader({})
    await expect(loadSheetSource(1, 'book', 'Sheet1', 'not a range', true, read)).rejects.toThrow(
      'invalid range',
    )
  })

  it('refuses a range bigger than one read can return rather than reading part of it', async () => {
    // A1:Z10000 selects 260,000 cells; a single read returns at most 200,000.
    // Trimming it would produce a "complete" list of 7,692 rows and the batch
    // would merge for a subset of the recipients without anyone being told.
    const calls: string[][] = []
    const read = async (_wcId: number, _sheet: string, addresses: string[]) => {
      calls.push(addresses)
      return { ok: true, result: { cells: { A1: { value: 'Name' }, A2: { value: 'Huy' } } } }
    }
    await expect(loadSheetSource(1, 'book', 'Sheet1', 'A1:Z10000', true, read)).rejects.toThrow(
      /260000/,
    )
    // nothing was read at all: no partial dataset is ever handed to the picker
    expect(calls.length).toBe(0)
  })

  it('reads a range that fits inside the cap in one pass', async () => {
    const { read, requested } = fakeReader({ A1: 'Name', A2: 'Huy' })
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:A7692', true, read)
    expect(requested.length).toBe(7692)
    expect(source.recipients.map((r) => r.values.Name)).toEqual(['Huy'])
  })
})

/**
 * What a cell's value means to a recipient.
 *
 * The spreadsheet bridge answers with the model value in `value` and, when a
 * number format makes the cell look different from that model value, the text
 * the user actually sees in `display`. Mail Merge writes what the user reads:
 * an identifier formatted `000000` merges as `001234`, a date cell merges as
 * `1-Jan-24` rather than its serial number, a currency cell as `$1,000.00`.
 *
 * A cell the bridge did not answer for is not a blank cell — it is a read that
 * never happened, and merging an empty string for it would silently drop an
 * address.
 */
describe('recipient value semantics', () => {
  const bridgeReader = (
    cells: Record<string, { value?: unknown; display?: unknown; formula?: string }>,
  ) => {
    const requested: string[] = []
    const read = async (_wcId: number, _sheet: string, addresses: string[]) => {
      requested.push(...addresses)
      return { ok: true, result: { cells } }
    }
    return { read, requested }
  }

  it('merges the formatted identifier, not the number behind it', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Name' },
      A2: { value: 1234, display: '001234' },
    })
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:A2', true, read)
    expect(source.recipients[0].values.Name).toBe('001234')
  })

  it('merges a formatted date as the user sees it', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Due' },
      A2: { value: 45292, display: '1-Jan-24' },
    })
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:A2', true, read)
    expect(source.recipients[0].values.Due).toBe('1-Jan-24')
  })

  it('merges currency and percentage as displayed', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Amount' },
      A2: { value: 1000, display: '$1,000.00' },
      B1: { value: 'Share' },
      B2: { value: 0.25, display: '25%' },
    })
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:B2', true, read)
    expect(source.columns.map((c) => c.name)).toEqual(['Amount', 'Share'])
    expect(source.recipients[0].values).toEqual({ Amount: '$1,000.00', Share: '25%' })
  })

  it('uses the cached result of a formula cell', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Total' },
      A2: { value: 42, display: '42', formula: 'SUM(B1:B9)' },
    })
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:A2', true, read)
    expect(source.recipients[0].values.Total).toBe('42')
  })

  it('treats a genuinely empty cell as empty', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Name' },
      A2: { value: 'Huy' },
      B1: { value: 'Address2' },
      B2: { value: '' },
    })
    const source = await loadSheetSource(1, 'book', 'Sheet1', 'A1:B2', true, read)
    expect(source.recipients[0].values).toEqual({ Name: 'Huy', Address2: '' })
  })

  it('refuses a range the bridge did not answer for instead of merging blanks', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Name' },
      A2: { value: 'Huy' },
      // A3 was requested but never returned
    })
    await expect(loadSheetSource(1, 'book', 'Sheet1', 'A1:A3', true, read)).rejects.toThrow(
      /did not return 1 cell/,
    )
  })

  it('refuses a cell holding a spreadsheet error', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Name' },
      A2: { value: '#REF!', display: '#REF!' },
    })
    await expect(loadSheetSource(1, 'book', 'Sheet1', 'A1:A2', true, read)).rejects.toThrow(
      /cell A2 contains the spreadsheet error #REF!/,
    )
  })

  it('refuses #DIV/0! the same way', async () => {
    const { read } = bridgeReader({
      A1: { value: 'Name' },
      A2: { value: '#DIV/0!', display: '#DIV/0!' },
    })
    await expect(loadSheetSource(1, 'book', 'Sheet1', 'A1:A2', true, read)).rejects.toThrow(
      /#DIV\/0!/,
    )
  })
})
