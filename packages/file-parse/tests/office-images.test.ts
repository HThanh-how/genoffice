import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  MIN_SIGNIFICANT_IMAGE_BYTES,
  countEmbeddedImages,
  mayHoldPictures,
} from '../src/office-images'

async function pack(files: Record<string, number | string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, typeof content === 'number' ? Buffer.alloc(content, 7) : content)
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

describe('countEmbeddedImages', () => {
  it('counts the pictures big enough to hold text, and all of them separately', async () => {
    const bytes = await pack({
      'word/document.xml': '<w:document/>',
      'word/media/image1.png': 20_000,
      'word/media/image2.jpeg': MIN_SIGNIFICANT_IMAGE_BYTES,
      'word/media/logo.png': 2_000,
    })
    expect(await countEmbeddedImages(bytes)).toEqual({ count: 2, total: 3 })
  })

  it('looks in the media folder of PowerPoint and Excel files too', async () => {
    expect(await countEmbeddedImages(await pack({ 'ppt/media/image1.png': 30_000 }))).toEqual({
      count: 1,
      total: 1,
    })
    expect(await countEmbeddedImages(await pack({ 'xl/media/image1.jpg': 30_000 }))).toEqual({
      count: 1,
      total: 1,
    })
  })

  it('ignores what is not a picture or not in a media folder', async () => {
    const bytes = await pack({
      'word/media/data.bin': 50_000,
      'word/embeddings/object.png': 50_000,
      'word/document.xml': '<x/>',
      'docProps/thumbnail.jpeg': 50_000,
    })
    expect(await countEmbeddedImages(bytes)).toEqual({ count: 0, total: 0 })
  })

  it('does not inflate: a picture that compresses to almost nothing still counts by its declared size', async () => {
    const bytes = await pack({ 'word/media/image1.png': 5_000_000 })
    expect(bytes.byteLength).toBeLessThan(50_000)
    expect((await countEmbeddedImages(bytes)).count).toBe(1)
  })

  it('knows which files can carry pictures', () => {
    for (const name of ['a.docx', 'b.PPTX', 'c.xlsx', 'd.xlsm'])
      expect(mayHoldPictures(name)).toBe(true)
    for (const name of ['a.pdf', 'b.doc', 'c.txt', 'd.png'])
      expect(mayHoldPictures(name)).toBe(false)
  })
})
