import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  MIN_SIGNIFICANT_IMAGE_BYTES,
  MAX_OFFICE_IMAGES,
  countEmbeddedImages,
  loadOfficePictures,
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

const BIG = 20_000
const rel = (items: Array<[string, string]>): string =>
  `<Relationships>${items
    .map(([id, target]) => `<Relationship Id="${id}" Type="x/image" Target="${target}"/>`)
    .join('')}</Relationships>`

describe('loadOfficePictures', () => {
  it('lists the pictures of a Word file in the order of the body, each once, and reads them', async () => {
    const bytes = await pack({
      'word/document.xml':
        '<w:document><w:p><a:blip r:embed="rId3"/></w:p><w:p><a:blip r:embed="rId1"/></w:p>' +
        '<w:p><v:imagedata r:id="rId2"/></w:p><w:p><a:blip r:embed="rId3"/></w:p></w:document>',
      'word/_rels/document.xml.rels': rel([
        ['rId1', 'media/image1.png'],
        ['rId2', 'media/image2.jpeg'],
        ['rId3', 'media/image10.png'],
        ['rId9', 'media/orphan.png'],
      ]),
      'word/media/image1.png': BIG,
      'word/media/image2.jpeg': BIG + 1,
      'word/media/image10.png': BIG + 2,
      'word/media/orphan.png': BIG,
    })
    const pictures = await loadOfficePictures(bytes)
    // image10 first (the body shows it first), a repeated picture once, the unused one not at all
    expect(pictures.names).toEqual([
      'word/media/image10.png',
      'word/media/image1.png',
      'word/media/image2.jpeg',
    ])
    expect((await pictures.read('word/media/image2.jpeg')).byteLength).toBe(BIG + 1)
    await expect(pictures.read('word/media/orphan.png')).rejects.toThrow()
  })

  it('leaves out the pictures of the headers, logos and external links', async () => {
    const bytes = await pack({
      'word/document.xml':
        '<w:document><a:blip r:embed="rId1"/><a:blip r:embed="rId2"/><a:blip r:link="rId3"/></w:document>',
      'word/_rels/document.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="media/logo.png"/>' +
        '<Relationship Id="rId2" Target="media/scan.png"/>' +
        '<Relationship Id="rId3" Target="https://example.com/x.png" TargetMode="External"/></Relationships>',
      'word/header1.xml': '<w:hdr><a:blip r:embed="rId1"/></w:hdr>',
      'word/media/logo.png': 3_000,
      'word/media/scan.png': BIG,
      'word/media/headeronly.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual(['word/media/scan.png'])
  })

  it('follows the order of the slides, not of the files, and skips layouts and masters', async () => {
    const bytes = await pack({
      'ppt/presentation.xml':
        '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': rel([
        ['rId1', 'slides/slide1.xml'],
        ['rId2', 'slides/slide2.xml'],
      ]),
      'ppt/slides/slide1.xml': '<p:sld><a:blip r:embed="rId1"/></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:blip r:embed="rId1"/><a:blip r:embed="rId2"/></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': rel([['rId1', '../media/a.png']]),
      'ppt/slides/_rels/slide2.xml.rels': rel([
        ['rId1', '../media/b.png'],
        ['rId2', '../media/c.png'],
      ]),
      'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster><a:blip r:embed="rId1"/></p:sldMaster>',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': rel([['rId1', '../media/master.png']]),
      'ppt/media/a.png': BIG,
      'ppt/media/b.png': BIG,
      'ppt/media/c.png': BIG,
      'ppt/media/master.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual([
      'ppt/media/b.png',
      'ppt/media/c.png',
      'ppt/media/a.png',
    ])
  })

  it('finds the pictures of the drawings of the sheets in the order of the sheets', async () => {
    const bytes = await pack({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="B" sheetId="2" r:id="rId2"/><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': rel([
        ['rId1', 'worksheets/sheet1.xml'],
        ['rId2', 'worksheets/sheet2.xml'],
      ]),
      'xl/worksheets/sheet1.xml': '<worksheet/>',
      'xl/worksheets/sheet2.xml': '<worksheet/>',
      'xl/worksheets/_rels/sheet1.xml.rels': rel([['rId1', '../drawings/drawing1.xml']]),
      'xl/worksheets/_rels/sheet2.xml.rels': rel([['rId1', '../drawings/drawing2.xml']]),
      'xl/drawings/drawing1.xml': '<xdr:wsDr><a:blip r:embed="rId1"/></xdr:wsDr>',
      'xl/drawings/drawing2.xml': '<xdr:wsDr><a:blip r:embed="rId1"/></xdr:wsDr>',
      'xl/drawings/_rels/drawing1.xml.rels': rel([['rId1', '../media/image1.png']]),
      'xl/drawings/_rels/drawing2.xml.rels': rel([['rId1', '../media/image2.png']]),
      'xl/media/image1.png': BIG,
      'xl/media/image2.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual([
      'xl/media/image2.png',
      'xl/media/image1.png',
    ])
  })

  it('falls back to the media folder in the order of the names when the package has no main part to walk', async () => {
    const bytes = await pack({
      'word/media/image10.png': BIG,
      'word/media/image2.png': BIG,
      'word/media/image1.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual([
      'word/media/image1.png',
      'word/media/image2.png',
      'word/media/image10.png',
    ])
  })

  it('lists no picture that only a header, a footer or nobody uses, when the body shows none', async () => {
    const bytes = await pack({
      'word/document.xml': '<w:document><w:p>some text</w:p></w:document>',
      'word/_rels/document.xml.rels': rel([['rId1', 'media/header.png']]),
      'word/header1.xml': '<w:hdr><a:blip r:embed="rId1"/></w:hdr>',
      'word/media/header.png': BIG,
      'word/media/orphan.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual([])
  })

  it('lists at most MAX_OFFICE_IMAGES, and nothing for a file with no picture', async () => {
    const total = MAX_OFFICE_IMAGES + 20
    const many: Record<string, number | string> = {
      'word/document.xml': `<w:document>${Array.from({ length: total }, (_x, i) => `<a:blip r:embed="rId${i + 1}"/>`).join('')}</w:document>`,
      'word/_rels/document.xml.rels': rel(
        Array.from({ length: total }, (_x, i): [string, string] => [
          `rId${i + 1}`,
          `media/image${i + 1}.png`,
        ]),
      ),
    }
    for (let i = 1; i <= MAX_OFFICE_IMAGES + 20; i++) many[`word/media/image${i}.png`] = BIG
    expect((await loadOfficePictures(await pack(many))).names).toHaveLength(MAX_OFFICE_IMAGES)
    expect(
      (await loadOfficePictures(await pack({ 'word/document.xml': '<w:document/>' }))).names,
    ).toEqual([])
  })
})
