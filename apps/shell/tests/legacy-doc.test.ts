import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { docxToText } from '@genoffice/file-parse'
import { convertLegacyDoc } from '../src/main/legacy-doc'

const fixture = fileURLToPath(
  new URL('../../../packages/file-parse/tests/fixtures/legacy-sample.doc', import.meta.url),
)

describe('legacy .doc import', () => {
  it('produces an editable .docx copy while leaving the source unchanged', async () => {
    const before = await readFile(fixture)
    const converted = await convertLegacyDoc(fixture)
    expect(converted.fidelity).toBe(process.platform === 'darwin' ? 'formatted' : 'text')
    expect(await docxToText(converted.bytes)).toContain('Legacy DOC body text')
    expect(await readFile(fixture)).toEqual(before)
  })

  it('rejects a non-.doc input', async () => {
    await expect(convertLegacyDoc('example.docx')).rejects.toThrow('Expected a .doc file')
  })

  it('uses a configured conversion service first for formatted DOCX', async () => {
    const copy = await convertLegacyDoc(fixture)
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(Buffer.from(copy.bytes), { status: 200 }))
    try {
      const converted = await convertLegacyDoc(fixture, 'https://d2x.clouds.io.vn')
      expect(converted.fidelity).toBe('formatted')
      expect(await docxToText(converted.bytes)).toContain('Legacy DOC body text')
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('https://d2x.clouds.io.vn/v1/convert/docx'),
        expect.objectContaining({ method: 'POST' }),
      )
    } finally {
      fetchMock.mockRestore()
    }
  })
})
