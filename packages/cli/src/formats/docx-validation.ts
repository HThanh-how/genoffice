import JSZip from 'jszip'

export interface DocxValidationOptions {
  /** If true, asserts at least one table exists */
  requireTable?: boolean
  /** If true, asserts at least one heading exists */
  requireHeading?: boolean
  /** Minimum number of paragraphs expected */
  minParagraphs?: number
  /** Expected document title or substring in document text */
  expectedText?: string
  /** If true, asserts no raw template placeholders (e.g. {{name}}, __TODO__) leaked into text */
  checkPlaceholders?: boolean
}

export interface DocxValidationStats {
  paragraphs: number
  tables: number
  headings: number
  textLength: number
}

export interface DocxValidationResult {
  ok: boolean
  errors: string[]
  stats: DocxValidationStats
}

const FORBIDDEN_PLACEHOLDER_REGEX = /(\{\{[^}]+\}\}|__TODO__|<TBD>)/i

/**
 * Validates that generated DOCX bytes represent a well-formed OOXML document
 * package containing expected structure, parts, and content without corruption.
 */
export async function validateGeneratedDocx(
  bytes: Uint8Array,
  options?: DocxValidationOptions,
): Promise<DocxValidationResult> {
  const errors: string[] = []
  const stats: DocxValidationStats = {
    paragraphs: 0,
    tables: 0,
    headings: 0,
    textLength: 0,
  }

  if (!bytes || bytes.length === 0) {
    return { ok: false, errors: ['Generated DOCX byte array is empty'], stats }
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    return {
      ok: false,
      errors: [`Invalid ZIP/OOXML package: ${err instanceof Error ? err.message : String(err)}`],
      stats,
    }
  }

  // Check required package parts
  const requiredParts = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
  for (const part of requiredParts) {
    if (!zip.file(part)) {
      errors.push(`Missing mandatory OOXML part: ${part}`)
    }
  }

  const documentXmlFile = zip.file('word/document.xml')
  if (!documentXmlFile) {
    return { ok: false, errors, stats }
  }

  let xmlContent: string
  try {
    xmlContent = await documentXmlFile.async('text')
  } catch (err) {
    errors.push(
      `Failed to read word/document.xml: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false, errors, stats }
  }

  // Basic XML structure checks
  if (!xmlContent.includes('<w:document') || !xmlContent.includes('</w:document>')) {
    errors.push('word/document.xml is missing <w:document> root element')
  }
  if (!xmlContent.includes('<w:body>') && !xmlContent.includes('<w:body ')) {
    errors.push('word/document.xml is missing <w:body> element')
  }

  // Count structures
  const pMatches = xmlContent.match(/<w:p([ >])/g)
  stats.paragraphs = pMatches ? pMatches.length : 0

  const tblMatches = xmlContent.match(/<w:tbl([ >])/g)
  stats.tables = tblMatches ? tblMatches.length : 0

  const headingMatches = xmlContent.match(/<w:pStyle\s+w:val=["']Heading\d+["']/gi)
  stats.headings = headingMatches ? headingMatches.length : 0

  // Extract all visible text runs
  const textMatches = Array.from(xmlContent.matchAll(/<w:t(?:[^>]*)>([^<]*)<\/w:t>/g), (m) => m[1])
  const fullText = textMatches.join(' ')
  stats.textLength = fullText.length

  if (stats.paragraphs === 0) {
    errors.push('Document contains no paragraphs (<w:p>)')
  }

  if (options?.minParagraphs !== undefined && stats.paragraphs < options.minParagraphs) {
    errors.push(
      `Document has ${stats.paragraphs} paragraphs, expected at least ${options.minParagraphs}`,
    )
  }

  if (options?.requireTable && stats.tables === 0) {
    errors.push('Document requires at least one table (<w:tbl>), but none was found')
  }

  if (options?.requireHeading && stats.headings === 0) {
    errors.push(
      'Document requires at least one heading (<w:pStyle w:val="Heading..."/>), but none was found',
    )
  }

  if (
    options?.expectedText &&
    !fullText.toLowerCase().includes(options.expectedText.toLowerCase())
  ) {
    errors.push(`Document does not contain expected text: "${options.expectedText}"`)
  }

  // Check for leaked raw placeholders in text if requested
  if (options?.checkPlaceholders) {
    for (const t of textMatches) {
      const leakMatch = FORBIDDEN_PLACEHOLDER_REGEX.exec(t)
      if (leakMatch) {
        errors.push(`Unrendered template placeholder leaked into document text: "${leakMatch[0]}"`)
        break
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats,
  }
}
