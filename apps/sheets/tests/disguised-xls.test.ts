import { describe, expect, it } from 'vitest'
import { htmlTableToTsv, sniffXlsKind } from '../src/main/disguised-xls'

const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'))

describe('files saved as .xls that are not Excel 97-2003', () => {
  it('tells the real formats apart from the first bytes', () => {
    expect(sniffXlsKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]))).toBe('ole')
    expect(sniffXlsKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('xlsx')
    expect(sniffXlsKind(bytes('﻿  <html><body><table>'))).toBe('html')
    expect(sniffXlsKind(bytes('<?xml version="1.0"?><Workbook>'))).toBe('html')
    expect(sniffXlsKind(bytes('Ten\tDiem\nAn\t9\n'))).toBe('text')
    expect(sniffXlsKind(bytes('Ten,Diem\nAn,9\n'))).toBe('text')
  })

  it('leaves an unknown binary to the real reader, so its error reaches the user', () => {
    expect(sniffXlsKind(new Uint8Array([0x01, 0x02, 0x00, 0x03]))).toBe('ole')
  })

  it('turns an HTML table into tab-separated rows', () => {
    const html =
      '<table><tr><th>Họ tên</th><th>Điểm</th></tr><tr><td>An &amp; Bình</td><td>9<br>10</td></tr></table>'
    expect(htmlTableToTsv(html)).toBe('Họ tên\tĐiểm\nAn & Bình\t9 10')
  })

  it('keeps quotes, skips empty rows and ignores scripts', () => {
    const html =
      '<script>var a = "<tr><td>x</td></tr>"</script><table><tr><td></td></tr><tr><td>say "hi"</td><td>1</td></tr></table>'
    expect(htmlTableToTsv(html)).toBe('"say ""hi"""\t1')
  })
})
