/** Builds tiny image-only ("scanned") PDFs for the OCR tests: one JPEG per page, nothing else. */

export interface ScannedPage {
  jpeg: Uint8Array
  /** pixel size of the JPEG */
  width: number
  height: number
  /** page size in points (default A4) */
  widthPt?: number
  heightPt?: number
  /** /Rotate entry */
  rotate?: number
  /** add a text object (a stamp) so the page is no longer "just one image" */
  stamp?: string
  /** place the image rotated 90 degrees through the page matrix */
  rotatedPlacement?: boolean
}

export function buildScannedPdf(pages: ScannedPage[]): Uint8Array {
  const chunks: Buffer[] = []
  const offsets: number[] = []
  let length = 0
  const push = (data: Buffer | string) => {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
    chunks.push(buffer)
    length += buffer.length
  }
  const object = (id: number, body: Buffer | string) => {
    offsets[id] = length
    push(`${id} 0 obj\n`)
    push(body)
    push('\nendobj\n')
  }
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  // ids: 1 catalog, 2 pages, 3 font, then per page: page, contents, image
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`)
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pages.forEach((page, i) => {
    const pageId = 4 + i * 3
    const w = page.widthPt ?? 595
    const h = page.heightPt ?? 842
    const content = [
      'q',
      page.rotatedPlacement ? `0 ${h} ${-w} 0 ${w} 0 cm` : `${w} 0 0 ${h} 0 0 cm`,
      '/Im0 Do',
      'Q',
      ...(page.stamp ? ['BT /F1 18 Tf 40 40 Td (' + page.stamp + ') Tj ET'] : []),
    ].join('\n')
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]${page.rotate ? ` /Rotate ${page.rotate}` : ''} ` +
        `/Resources << /XObject << /Im0 ${pageId + 2} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    )
    object(pageId + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    const head =
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
    object(
      pageId + 2,
      Buffer.concat([
        Buffer.from(head, 'latin1'),
        Buffer.from(page.jpeg),
        Buffer.from('\nendstream', 'latin1'),
      ]),
    )
  })
  const xrefAt = length
  const count = 4 + pages.length * 3
  push(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
  return new Uint8Array(Buffer.concat(chunks))
}

/** A grayscale test pattern (lines of "text"), so JPEGs of different pages differ. */
export function testPattern(width: number, height: number, seed = 0): Uint8Array {
  const pixels = new Uint8Array(width * height).fill(245)
  for (let y = 40; y < height - 40; y += 28)
    for (let x = 40 + ((y + seed * 7) % 20); x < width - 40; x += 6)
      for (let dy = 0; dy < 10; dy++) pixels[(y + dy) * width + x] = 20
  return pixels
}
