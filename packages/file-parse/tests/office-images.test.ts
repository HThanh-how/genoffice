import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  MIN_SIGNIFICANT_IMAGE_BYTES,
  LARGE_PICTURE_BYTES,
  MAX_OFFICE_IMAGES,
  countEmbeddedImages,
  loadOfficePictures,
  mayHoldPictures,
  realOfficeText,
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

  it('says that there were more pictures than it lists', async () => {
    const total = MAX_OFFICE_IMAGES + 3
    const files: Record<string, number | string> = {
      'word/document.xml': `<w:document>${Array.from({ length: total }, (_x, i) => `<a:blip r:embed="rId${i + 1}"/>`).join('')}</w:document>`,
      'word/_rels/document.xml.rels': rel(
        Array.from({ length: total }, (_x, i): [string, string] => [
          `rId${i + 1}`,
          `media/i${i + 1}.png`,
        ]),
      ),
    }
    for (let i = 1; i <= total; i++) files[`word/media/i${i}.png`] = BIG
    const pictures = await loadOfficePictures(await pack(files))
    expect(pictures.names).toHaveLength(MAX_OFFICE_IMAGES)
    expect(pictures.more).toBe(true)
    expect(
      (await loadOfficePictures(await pack({ ...files, 'word/document.xml': '<w:document/>' })))
        .more,
    ).toBe(false)
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

describe('loadOfficePictures: what is a picture of the document', () => {
  it('does not take the number of a bookmark or a change for the id of a relationship', async () => {
    const bytes = await pack({
      'word/document.xml':
        '<w:document><w:bookmarkStart w:id="1" w:name="x"/><w:ins w:id="2"/></w:document>',
      'word/_rels/document.xml.rels': rel([
        ['1', 'media/header.png'],
        ['2', 'media/other.png'],
      ]),
      'word/media/header.png': BIG,
      'word/media/other.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual([])
  })

  it('reads the relationship attributes under another prefix of the same namespace', async () => {
    const bytes = await pack({
      'word/document.xml':
        '<w:document xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip rel:embed="rId7"/></w:document>',
      'word/_rels/document.xml.rels': rel([['rId7', 'media/page.png']]),
      'word/media/page.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual(['word/media/page.png'])
  })

  it('leaves out the background of a page and follows a target spelled in another case', async () => {
    const bytes = await pack({
      'word/document.xml':
        '<w:document><w:background><v:fill r:id="rId1"/></w:background><a:blip r:embed="rId2"/></w:document>',
      'word/_rels/document.xml.rels': rel([
        ['rId1', 'media/texture.png'],
        ['rId2', 'media/SCAN.PNG'],
      ]),
      'word/media/texture.png': BIG,
      'word/media/scan.png': BIG,
    })
    expect((await loadOfficePictures(bytes)).names).toEqual(['word/media/scan.png'])
  })

  it('counts what the document shows but nobody reads: too large, or a vector picture', async () => {
    const bytes = await pack({
      'word/document.xml':
        '<w:document><a:blip r:embed="rId1"/><a:blip r:embed="rId2"/><a:blip r:embed="rId3"/></w:document>',
      'word/_rels/document.xml.rels': rel([
        ['rId1', 'media/drawing.emf'],
        ['rId2', 'media/chart.svg'],
        ['rId3', 'media/ok.png'],
      ]),
      'word/media/drawing.emf': BIG,
      'word/media/chart.svg': BIG,
      'word/media/ok.png': BIG,
    })
    const pictures = await loadOfficePictures(bytes)
    expect(pictures.names).toEqual(['word/media/ok.png'])
    expect(pictures.unreadable).toBe(2)
  })

  it('tells the large pictures (a page of a scan) from the figures', async () => {
    const bytes = await pack({
      'word/document.xml':
        '<w:document><a:blip r:embed="rId1"/><a:blip r:embed="rId2"/></w:document>',
      'word/_rels/document.xml.rels': rel([
        ['rId1', 'media/page.png'],
        ['rId2', 'media/figure.png'],
      ]),
      'word/media/page.png': LARGE_PICTURE_BYTES + 10,
      'word/media/figure.png': BIG,
    })
    const pictures = await loadOfficePictures(bytes)
    expect(pictures.names).toHaveLength(2)
    expect(pictures.large).toBe(1)
  })

  it('stops a picture that declares a small size and inflates to a great one, before it is read', async () => {
    const real = Buffer.alloc(3 * 1024 * 1024, 0)
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document><a:blip r:embed="rId1"/></w:document>')
    zip.file('word/_rels/document.xml.rels', rel([['rId1', 'media/bomb.png']]))
    zip.file('word/media/bomb.png', real, { compression: 'DEFLATE' })
    const bytes = Buffer.from(
      await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    )
    // write the size of a small picture over the real one, in the local header and in the central directory
    for (let at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); at !== -1;) {
      const nameLength = bytes.readUInt16LE(at + 26)
      if (bytes.toString('latin1', at + 30, at + 30 + nameLength) === 'word/media/bomb.png')
        bytes.writeUInt32LE(20_000, at + 22)
      at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at + 4)
    }
    for (let at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at !== -1;) {
      const nameLength = bytes.readUInt16LE(at + 28)
      if (bytes.toString('latin1', at + 46, at + 46 + nameLength) === 'word/media/bomb.png')
        bytes.writeUInt32LE(20_000, at + 24)
      at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)
    }
    await expect(loadOfficePictures(bytes)).rejects.toThrow()
  })
})

describe('realOfficeText', () => {
  it('leaves out the lines that the slide and sheet extractors write for pictures', () => {
    const slides =
      '[No extractable text: none of the 3 slides carries text; the content is in embedded images, which this extraction does not read.]\n\n' +
      '## Slide 1\n[picture-only slide: 1 image, no extractable text]\n\n## Slide 2\n[picture-only slide: 2 images, no extractable text]'
    expect(realOfficeText(slides, 'deck.pptx').trim()).toBe('')
    expect(
      realOfficeText('# Sheet1\n[image-only sheet: 1 image, no cell data]', 'a.xlsx').trim(),
    ).toBe('')
  })

  it('leaves only the first line of a section for a heading: the same look in the middle of a cell is a word', () => {
    expect(realOfficeText('# Sheet1\nA1\n## Tong cong\n42', 'a.xlsx')).toBe('A1\n## Tong cong\n42')
    expect(realOfficeText('## Slide 1\nTitle\n\n## Slide 2\nOther', 'd.pptx')).toBe(
      'Title\n\nOther',
    )
  })

  it('keeps the words of the document, and a heading in a Word file', () => {
    expect(
      realOfficeText('## Slide 1\nQuarterly results\n[picture-only slide: 1 image]', 'd.pptx'),
    ).toBe('Quarterly results')
    expect(realOfficeText('# Heading\nBody', 'letter.docx')).toBe('# Heading\nBody')
  })
})
