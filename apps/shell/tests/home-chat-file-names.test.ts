import { describe, expect, it } from 'vitest'
import { fileNamesIn } from '../src/renderer/src/home-chat/utils'

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
