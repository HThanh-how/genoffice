/**
 * Reading recipients straight from an open GenOffice spreadsheet. The range the
 * user typed is the contract: the columns it names are the columns read, the
 * rows it covers are the rows read, and nothing outside it can leak in.
 */
import { describe, expect, it } from 'vitest'
import { addressesInRange, loadSheetSource, rangeBounds } from '../src/renderer/mail-merge/data-source'

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
    expect(rangeBounds('AA10:AC20')).toEqual({ firstCol: 26, lastCol: 28, firstRow: 10, lastRow: 20 })
    expect(rangeBounds('B2:B8')).toEqual({ firstCol: 1, lastCol: 1, firstRow: 2, lastRow: 8 })
    expect(rangeBounds('10:20')).toBeNull()
    expect(rangeBounds('F5:C100')).toBeNull()
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
})
