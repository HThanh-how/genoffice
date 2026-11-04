import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { issueReason } from '../src/main/document-memory/issues'
import { extractDocument } from '../src/main/document-memory/worker'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

async function writeDocx(
  name: string,
  text: string,
  media: Record<string, number>,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'picture-only-'))
  dirs.push(dir)
  const zip = new JSZip()
  // the body shows every picture, so that they are the pictures of the document and not stray files
  const shown = Object.keys(media)
  zip.file(
    'word/_rels/document.xml.rels',
    `<Relationships>${shown
      .map((file, i) => `<Relationship Id="rIdP${i}" Target="media/${file}"/>`)
      .join('')}</Relationships>`,
  )
  zip.file(
    '_rels/.rels',
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W}><w:body>${
      text ? `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>` : '<w:p/>'
    }${shown.map((_file, i) => `<w:p><a:blip r:embed="rIdP${i}"/></w:p>`).join('')}</w:body></w:document>`,
  )
  for (const [file, bytes] of Object.entries(media))
    zip.file(`word/media/${file}`, Buffer.alloc(bytes, 3))
  const path = join(dir, name)
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }))
  return path
}

describe('Word files made only of pictures', () => {
  it('says the pictures have not been read, not that the file is blank', async () => {
    const path = await writeDocx('scan.docx', '', {
      'image1.png': 30_000,
      'image2.png': 40_000,
      'logo.png': 1_000,
    })
    const result = await extractDocument(path)
    expect(result.chunks).toEqual([])
    expect(result.status).toBe('empty')
    expect(result.error).toBe('No readable text; the 2 pictures in this file have not been read')
    // the list of problems puts it with the files that wait for OCR, not with the blank ones
    expect(issueReason(result.error ?? null, result.status)).toBe('no-text')
  })

  it('uses the singular for one picture', async () => {
    const result = await extractDocument(await writeDocx('one.docx', '', { 'image1.png': 30_000 }))
    expect(result.error).toBe('No readable text; the 1 picture in this file has not been read')
  })

  it('still calls a file blank when its only picture is a logo', async () => {
    const result = await extractDocument(await writeDocx('logo.docx', '', { 'logo.png': 1_500 }))
    expect(result.error).toBe('No readable text in this file; there is nothing to search')
    expect(issueReason(result.error ?? null, result.status)).toBe('empty')
  })

  it('still calls a file blank when it has no pictures at all', async () => {
    const result = await extractDocument(await writeDocx('empty.docx', '', {}))
    expect(result.error).toBe('No readable text in this file; there is nothing to search')
  })

  it('indexes a file with text normally, pictures or not', async () => {
    const result = await extractDocument(
      await writeDocx('text.docx', 'A paragraph with real words in it.', { 'image1.png': 30_000 }),
    )
    expect(result.status).toBe('text-only')
    expect(result.error).toBeUndefined()
    expect(result.chunks.map((c) => c.text).join(' ')).toContain('real words')
  })
})
