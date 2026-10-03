import { describe, expect, it } from 'vitest'
import { convertLegacyXlsFile, htmlTableToTsv, sniffXlsKind } from '../src/main/disguised-xls'

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

describe('converting a file saved as .xls', () => {
  const options = (convertOle: (p: string, t: string) => Promise<unknown>) => ({
    convertOle,
    maxTextBytes: 1024 * 1024,
    tooLarge: () => new Error('too large'),
  })

  it('hands a real Excel 97-2003 file to the workbook reader', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'xls-'))
    const source = join(dir, 'a.xls')
    await writeFile(source, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]))
    const seen: string[] = []
    await convertLegacyXlsFile(
      source,
      join(dir, 'a.xlsx'),
      options(async (from, to) => void seen.push(from, to)),
    )
    expect(seen).toEqual([source, join(dir, 'a.xlsx')])
  })

  it('turns an HTML table and a tab-separated export into a real .xlsx', async () => {
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'xls-'))
    const never = async () => {
      throw new Error('the workbook reader must not see this file')
    }
    for (const [name, content] of [
      [
        'html.xls',
        '<table><tr><td>Ten</td><td>Diem</td></tr><tr><td>An</td><td>9</td></tr></table>',
      ],
      ['tsv.xls', 'Ten\tDiem\nAn\t9\n'],
    ] as const) {
      const source = join(dir, name)
      await writeFile(source, content)
      await convertLegacyXlsFile(source, `${source}x`, options(never))
      const out = await readFile(`${source}x`)
      expect(out[0]).toBe(0x50)
      expect(out[1]).toBe(0x4b)
    }
  })

  it('copies an .xlsx that was saved with the .xls name', async () => {
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'xls-'))
    const source = join(dir, 'z.xls')
    await writeFile(source, Buffer.from([0x50, 0x4b, 3, 4, 9, 9]))
    await convertLegacyXlsFile(
      source,
      join(dir, 'z.xlsx'),
      options(async () => {
        throw new Error('not for the workbook reader')
      }),
    )
    expect([...(await readFile(join(dir, 'z.xlsx')))]).toEqual([0x50, 0x4b, 3, 4, 9, 9])
  })
})
