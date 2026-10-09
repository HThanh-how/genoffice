import { describe, expect, it } from 'vitest'
import { fileNameVariants, fileNamesIn } from '../src/renderer/src/home-chat/utils'

describe('fileNamesIn', () => {
  it('finds the file names an answer quotes, once each', () => {
    const answer = [
      '1. `CamScanner 29-9-26 10.43.pdf` (Bản quét OCR)',
      '2. `NHẬN XÉT ĐỒ ÁN THIẾT KẾ ĐƯỜNG Ô TÔ. LƠP VB2K10 docx.docx`',
      '* `Đề BT lấy điểm QT lớp KTXD CTGT VB2K10.docx` và **033 BT điểm quá trình TKĐOTO-RUM.docx**',
      'lại `CamScanner 29-9-26 10.43.pdf`',
    ].join('\n')
    expect(fileNamesIn(answer)).toEqual([
      'CamScanner 29-9-26 10.43.pdf',
      'NHẬN XÉT ĐỒ ÁN THIẾT KẾ ĐƯỜNG Ô TÔ. LƠP VB2K10 docx.docx',
      'Đề BT lấy điểm QT lớp KTXD CTGT VB2K10.docx',
      '033 BT điểm quá trình TKĐOTO-RUM.docx',
    ])
  })

  it('ignores text that only looks like a file', () => {
    expect(fileNamesIn('use `config.yaml` or version 2.0 of the report')).toEqual([])
  })

  it('stops at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => `\`f${i}.pdf\``).join(' ')
    expect(fileNamesIn(many, 5)).toHaveLength(5)
  })
})

const A = 'Chungtu_chitien-LAN2018-61_2025.docx'
const B = 'Chungtu_chitien-LAN2018-61 (1).docx'
const C = 'Chungtu_chitien-LAN2018-53-LONGTRACH - HUNGTAN_2025.docx'

describe('fileNamesIn: the VNPT answer', () => {
  const tail = ' — vị trí: Chunk 5, Chunk 12 (Trạng thái: OK), hợp đồng số 289/HĐT-VNPT-LA'

  it.each([
    ['backticks', (n: string) => `\`${n}\``],
    ['bold', (n: string) => `**${n}**`],
    ['double quotes', (n: string) => `"${n}"`],
    ['curly quotes', (n: string) => `“${n}”`],
    ['nothing at all', (n: string) => n],
  ])('finds all three names when they are written with %s', (_label, wrap) => {
    const answer = `1. ${wrap(A)} & ${wrap(B)}${tail}\n2. ${wrap(C)} — Chunk 13 (Trạng thái: OK)`
    expect(fileNamesIn(answer)).toEqual([A, B, C])
  })

  it('reads a path as the file name', () => {
    expect(fileNamesIn('Tệp ở C:\\VNPT\\2025\\Hợp đồng số 1.PDF nhé')).toEqual([
      'Hợp đồng số 1.PDF',
    ])
  })

  it('handles uppercase extensions, commas, long names and a name ending a sentence', () => {
    const long = `${'Rất dài '.repeat(14)}x.xlsx`
    expect(fileNamesIn(`\`BAO CAO, THANG 5.XLSX\`, \`${long}\`.`)).toEqual([
      'BAO CAO, THANG 5.XLSX',
      long,
    ])
    expect(fileNamesIn('Bạn mở file Báo_cáo_Q3.pptx.')).toContain('Bạn mở file Báo_cáo_Q3.pptx')
  })

  it('does not take the digits of a list or a version number for a file', () => {
    expect(fileNamesIn('1. xem mục 2.5 và v1.docxx hoặc 3.14')).toEqual([])
  })

  it('offers shorter readings of an unquoted name, longest first', () => {
    expect(fileNameVariants('Bạn mở file Báo_cáo_Q3.pptx')).toEqual([
      'Bạn mở file Báo_cáo_Q3.pptx',
      'Báo_cáo_Q3.pptx',
    ])
    expect(fileNameVariants(C)[0]).toBe(C)
  })
})
