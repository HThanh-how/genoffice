import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { docxToText } from '@genoffice/file-parse'
import { convertLegacyDoc } from '../src/main/legacy-doc'

const fixture = fileURLToPath(
  new URL('../../../packages/file-parse/tests/fixtures/legacy-sample.doc', import.meta.url),
)

describe('legacy .doc import', () => {
  it('produces an editable .docx copy while leaving the source unchanged', async () => {
    const before = await readFile(fixture)
    const converted = await convertLegacyDoc(fixture)
    expect(['formatted', 'text']).toContain(converted.fidelity)
    expect(await docxToText(converted.bytes)).toContain('Legacy DOC body text')
    expect(await readFile(fixture)).toEqual(before)
  })

  it('rejects a non-.doc input', async () => {
    await expect(convertLegacyDoc('example.docx')).rejects.toThrow('Expected a .doc file')
  })
})
