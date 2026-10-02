import { describe, expect, it } from 'vitest'
import * as CFB from 'cfb'
import { legacyXlsToText, xlsToText } from '../src/xls'

/** A minimal BIFF8 workbook built by hand: one sheet, shared strings (one split by CONTINUE), numbers, an RK, a formula. */
function record(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt16LE(type, 0)
  head.writeUInt16LE(data.length, 2)
  return Buffer.concat([head, data])
}
const u16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const f64 = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(n)
  return b
}
const xlString = (text: string): Buffer => {
  const wide = [...text].some((ch) => ch.charCodeAt(0) > 0xff)
  return Buffer.concat([
    u16(text.length),
    Buffer.from([wide ? 1 : 0]),
    Buffer.from(text, wide ? 'utf16le' : 'latin1'),
  ])
}

function workbook(): Buffer {
  const bof = (type: number) =>
    record(0x0809, Buffer.concat([u16(0x600), u16(type), u16(0), u16(0), u32(0), u32(0)]))
  // shared strings: "Họ tên" (UTF-16) and a long ASCII string split over a CONTINUE record
  const long = 'Phạm Hữu Công giấy ra viện'
  const first = xlString('Họ tên')
  const half = Math.floor(long.length / 2)
  const wideStart = Buffer.concat([
    u16(long.length),
    Buffer.from([1]),
    Buffer.from(long.slice(0, half), 'utf16le'),
  ])
  const sst = record(0x00fc, Buffer.concat([u32(2), u32(2), first, wideStart]))
  const cont = record(
    0x003c,
    Buffer.concat([Buffer.from([1]), Buffer.from(long.slice(half), 'utf16le')]),
  )
  const globalsTail = Buffer.concat([sst, cont, record(0x000a, Buffer.alloc(0))])

  const sheetRecords = (): Buffer =>
    Buffer.concat([
      bof(0x10),
      record(0x00fd, Buffer.concat([u16(0), u16(0), u16(0), u32(0)])), // A1 = "Họ tên"
      record(0x00fd, Buffer.concat([u16(0), u16(1), u16(0), u32(1)])), // B1 = long string
      record(0x0203, Buffer.concat([u16(1), u16(0), u16(0), f64(42.5)])), // A2 = 42.5
      record(0x027e, Buffer.concat([u16(1), u16(1), u16(0), u32((7 << 2) | 2)])), // B2 = 7 (RK int)
      record(
        0x0006,
        Buffer.concat([u16(2), u16(0), u16(0), f64(3), u16(0), u32(0), Buffer.alloc(2)]),
      ), // A3 = 3 (formula)
      record(0x000a, Buffer.alloc(0)),
    ])

  const boundsheet = (offset: number) =>
    record(
      0x0085,
      Buffer.concat([u32(offset), Buffer.from([0, 0]), Buffer.from([5, 0]), Buffer.from('Sheet')]),
    )
  const head = bof(0x05)
  const fixed = head.length + boundsheet(0).length + globalsTail.length
  return Buffer.concat([head, boundsheet(fixed), globalsTail, sheetRecords()])
}

function xlsBytes(): Uint8Array {
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, '/Workbook', workbook())
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }) as Buffer)
}

describe('xlsToText', () => {
  it('reads strings (also across CONTINUE), numbers, RK values and formula results', () => {
    const text = xlsToText(xlsBytes())
    expect(text).toBe('# Sheet\nHọ tên | Phạm Hữu Công giấy ra viện\n42.5 | 7\n3')
  })

  it('rejects a file that is not a workbook', () => {
    expect(() => xlsToText(Buffer.from('not an xls'))).toThrow()
  })
})

describe('legacyXlsToText', () => {
  it('reads an HTML table saved as .xls', async () => {
    const html =
      '<html><body><table><tr><th>STT</th><th>Họ tên</th></tr><tr><td>1</td><td>Phạm &amp; Công</td></tr></table></body></html>'
    expect(await legacyXlsToText(Buffer.from(html))).toBe('STT | Họ tên\n1 | Phạm & Công')
  })

  it('reads a real workbook through the same entry', async () => {
    expect(await legacyXlsToText(xlsBytes())).toContain('Họ tên | Phạm Hữu Công giấy ra viện')
  })
})
