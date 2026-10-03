import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertLegacySheet } from '../src/main/legacy-sheet'
import { ServiceRateLimitedError } from '../src/main/legacy-service'

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4])
const zip = new Uint8Array(200).map((_, i) => (i === 0 ? 0x50 : i === 1 ? 0x4b : 1))
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'legacy-sheet-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})
const noPause = () => Promise.resolve()

describe('converting an old Excel file through the service', () => {
  it('sends a genuine .xls to the xlsx route and returns the workbook it gets back', async () => {
    const file = join(dir, 'a.xls')
    await writeFile(file, OLE)
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(Buffer.from(zip)))
    const bytes = await convertLegacySheet(file, 'https://svc.example', noPause)
    expect(bytes).toHaveLength(200)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://svc.example/v1/convert/xlsx')
  })

  it('does not upload a file that is not an Excel 97-2003 workbook', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const html = join(dir, 'page.xls')
    await writeFile(html, '<html><table><tr><td>x</td></tr></table></html>')
    await expect(convertLegacySheet(html, 'https://svc.example', noPause)).rejects.toThrow(
      /Not an Excel/,
    )
    const wrong = join(dir, 'a.xlsx')
    await writeFile(wrong, OLE)
    await expect(convertLegacySheet(wrong, 'https://svc.example', noPause)).rejects.toThrow(
      /Expected an .xls/,
    )
    const empty = join(dir, 'empty.xls')
    await writeFile(empty, '')
    await expect(convertLegacySheet(empty, 'https://svc.example', noPause)).rejects.toThrow(/empty/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails when the service cannot convert it, and passes the hourly limit on', async () => {
    const file = join(dir, 'a.xls')
    await writeFile(file, OLE)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('no', { status: 422 }))
    await expect(convertLegacySheet(file, 'https://svc.example', noPause)).rejects.toThrow(
      /could not convert/,
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('limit', { status: 429 }))
    await expect(convertLegacySheet(file, 'https://svc.example', noPause)).rejects.toBeInstanceOf(
      ServiceRateLimitedError,
    )
  })
})
