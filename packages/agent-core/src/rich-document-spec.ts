/**
 * Typed Rich Document Specification and Profiles for Word (.docx) generation.
 * Defines document structure, layout, typography, profiles, and validation.
 */

export type DocumentType =
  'general' | 'report' | 'scientific-report' | 'memo' | 'proposal' | 'letter'

export type PaperSize = 'A4' | 'Letter'
export type Orientation = 'portrait' | 'landscape'

export interface Margins {
  /** Top margin in mm */
  top: number
  /** Bottom margin in mm */
  bottom: number
  /** Left margin in mm */
  left: number
  /** Right margin in mm */
  right: number
}

export interface Typography {
  bodyFont: string
  bodySizePt: number
  lineSpacing: number
  paragraphSpacingAfterPt: number
}

export type DocumentBlock =
  | {
      type: 'paragraph'
      text: string
      bold?: boolean | undefined
      italic?: boolean | undefined
      align?: 'left' | 'center' | 'right' | 'justify' | undefined
    }
  | { type: 'heading'; text: string; level: number }
  | { type: 'bullet-list'; items: string[] }
  | { type: 'numbered-list'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][]; caption?: string | undefined }
  | { type: 'quote'; text: string }
  | { type: 'page-break' }
  | { type: 'caption'; text: string }
  | { type: 'callout'; text: string; kind?: 'info' | 'warning' | 'note' | undefined }
  | { type: 'references'; entries: Array<{ id: string; text: string }> }

export interface RichDocumentSection {
  id: string
  heading: string
  headingLevel: number
  blocks: DocumentBlock[]
}

export interface SourceReference {
  name: string
  path?: string | undefined
  citation?: string | undefined
}

export interface HeaderFooterSpec {
  text?: string | undefined
  pageNumber?: boolean | undefined
  align?: 'left' | 'center' | 'right' | undefined
}

export interface RichDocumentSpec {
  title: string
  documentType: DocumentType
  layout: {
    paperSize: PaperSize
    orientation: Orientation
    margins: Margins
  }
  typography: Typography
  sections: RichDocumentSection[]
  sources?: SourceReference[] | undefined
  headers?: HeaderFooterSpec | undefined
  footers?: HeaderFooterSpec | undefined
}

export interface DocumentTypeProfile {
  documentType: DocumentType
  paperSize: PaperSize
  orientation: Orientation
  margins: Margins
  typography: Typography
  defaultSections?: string[] | undefined
  includeFooterPageNumber?: boolean | undefined
}

export const DOCUMENT_PROFILES: Record<DocumentType, DocumentTypeProfile> = {
  general: {
    documentType: 'general',
    paperSize: 'A4',
    orientation: 'portrait',
    margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
    typography: {
      bodyFont: 'Calibri',
      bodySizePt: 11,
      lineSpacing: 1.15,
      paragraphSpacingAfterPt: 6,
    },
    includeFooterPageNumber: true,
  },
  report: {
    documentType: 'report',
    paperSize: 'A4',
    orientation: 'portrait',
    margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
    typography: {
      bodyFont: 'Calibri',
      bodySizePt: 11,
      lineSpacing: 1.2,
      paragraphSpacingAfterPt: 6,
    },
    defaultSections: [
      'Executive Summary',
      'Introduction',
      'Key Findings',
      'Analysis',
      'Recommendations',
      'Conclusion',
    ],
    includeFooterPageNumber: true,
  },
  'scientific-report': {
    documentType: 'scientific-report',
    paperSize: 'A4',
    orientation: 'portrait',
    margins: { top: 25.0, bottom: 25.0, left: 25.0, right: 25.0 },
    typography: {
      bodyFont: 'Times New Roman',
      bodySizePt: 12,
      lineSpacing: 1.3,
      paragraphSpacingAfterPt: 6,
    },
    defaultSections: [
      'Title and Authors',
      'Abstract',
      'Introduction',
      'Methodology',
      'Results and Observations',
      'Discussion',
      'Conclusion',
      'References',
    ],
    includeFooterPageNumber: true,
  },
  memo: {
    documentType: 'memo',
    paperSize: 'A4',
    orientation: 'portrait',
    margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
    typography: {
      bodyFont: 'Arial',
      bodySizePt: 11,
      lineSpacing: 1.15,
      paragraphSpacingAfterPt: 6,
    },
    defaultSections: ['Summary', 'Background', 'Action Items'],
    includeFooterPageNumber: false,
  },
  proposal: {
    documentType: 'proposal',
    paperSize: 'A4',
    orientation: 'portrait',
    margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
    typography: {
      bodyFont: 'Calibri',
      bodySizePt: 11.5,
      lineSpacing: 1.2,
      paragraphSpacingAfterPt: 6,
    },
    defaultSections: [
      'Project Overview',
      'Problem Statement',
      'Proposed Solution',
      'Deliverables and Milestones',
      'Budget and Resource Plan',
      'Conclusion',
    ],
    includeFooterPageNumber: true,
  },
  letter: {
    documentType: 'letter',
    paperSize: 'A4',
    orientation: 'portrait',
    margins: { top: 30.0, bottom: 25.4, left: 25.4, right: 25.4 },
    typography: {
      bodyFont: 'Times New Roman',
      bodySizePt: 12,
      lineSpacing: 1.15,
      paragraphSpacingAfterPt: 8,
    },
    includeFooterPageNumber: false,
  },
}

export function getProfile(type?: string): DocumentTypeProfile {
  if (type && Object.prototype.hasOwnProperty.call(DOCUMENT_PROFILES, type)) {
    return DOCUMENT_PROFILES[type as DocumentType]
  }
  return DOCUMENT_PROFILES.general
}

/**
 * Validates a candidate RichDocumentSpec object.
 */
export function validateRichDocumentSpec(raw: unknown): {
  valid: boolean
  errors: string[]
  spec?: RichDocumentSpec
} {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Specification must be an object'] }
  }

  const candidate = raw as Partial<RichDocumentSpec>
  if (typeof candidate.title !== 'string' || !candidate.title.trim()) {
    errors.push('title is required and must be a non-empty string')
  }

  const validTypes: DocumentType[] = [
    'general',
    'report',
    'scientific-report',
    'memo',
    'proposal',
    'letter',
  ]
  const docType = candidate.documentType
  if (docType !== undefined && !validTypes.includes(docType)) {
    errors.push(`documentType must be one of: ${validTypes.join(', ')}`)
  }

  if (!Array.isArray(candidate.sections)) {
    errors.push('sections must be an array')
  } else if (candidate.sections.length === 0) {
    errors.push('sections must contain at least one section')
  } else {
    for (let i = 0; i < candidate.sections.length; i++) {
      const sec = candidate.sections[i]
      if (!sec || typeof sec !== 'object') {
        errors.push(`sections[${i}] must be an object`)
        continue
      }
      if (typeof sec.heading !== 'string' || !sec.heading.trim()) {
        errors.push(`sections[${i}].heading must be a non-empty string`)
      }
      if (typeof sec.headingLevel !== 'number' || sec.headingLevel < 1 || sec.headingLevel > 6) {
        errors.push(`sections[${i}].headingLevel must be an integer between 1 and 6`)
      }
      if (!Array.isArray(sec.blocks) || sec.blocks.length === 0) {
        errors.push(`sections[${i}].blocks must be a non-empty array of blocks`)
      } else {
        for (let j = 0; j < sec.blocks.length; j++) {
          const b = sec.blocks[j]
          if (!b || typeof b !== 'object') {
            errors.push(`sections[${i}].blocks[${j}] must be an object`)
            continue
          }
          if (b.type === 'table') {
            if (!Array.isArray(b.headers) || b.headers.length === 0) {
              errors.push(`sections[${i}].blocks[${j}] table must have non-empty headers array`)
            }
            if (!Array.isArray(b.rows) || b.rows.length === 0) {
              errors.push(`sections[${i}].blocks[${j}] table must have non-empty rows array`)
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  const profile = getProfile(candidate.documentType)
  const spec: RichDocumentSpec = {
    title: candidate.title!.trim(),
    documentType: candidate.documentType || profile.documentType,
    layout: {
      paperSize: candidate.layout?.paperSize || profile.paperSize,
      orientation: candidate.layout?.orientation || profile.orientation,
      margins: {
        top: candidate.layout?.margins?.top ?? profile.margins.top,
        bottom: candidate.layout?.margins?.bottom ?? profile.margins.bottom,
        left: candidate.layout?.margins?.left ?? profile.margins.left,
        right: candidate.layout?.margins?.right ?? profile.margins.right,
      },
    },
    typography: {
      bodyFont: candidate.typography?.bodyFont || profile.typography.bodyFont,
      bodySizePt: candidate.typography?.bodySizePt ?? profile.typography.bodySizePt,
      lineSpacing: candidate.typography?.lineSpacing ?? profile.typography.lineSpacing,
      paragraphSpacingAfterPt:
        candidate.typography?.paragraphSpacingAfterPt ?? profile.typography.paragraphSpacingAfterPt,
    },
    sections: candidate.sections as RichDocumentSection[],
    sources: candidate.sources,
    headers: candidate.headers,
    footers:
      candidate.footers ||
      (profile.includeFooterPageNumber ? { pageNumber: true, align: 'right' } : undefined),
  }

  return { valid: true, errors: [], spec }
}

/**
 * Converts a RichDocumentSpec into formatted Markdown suitable for DOCX conversion.
 * Generates true headings, clean paragraphs, and native markdown tables.
 */
export function richDocumentSpecToMarkdown(spec: RichDocumentSpec): string {
  const parts: string[] = []

  // Document Title
  parts.push(`# ${spec.title}\n`)

  for (const section of spec.sections) {
    const headingPrefix = '#'.repeat(Math.min(Math.max(section.headingLevel, 1), 6))
    parts.push(`${headingPrefix} ${section.heading}\n`)

    for (const block of section.blocks) {
      switch (block.type) {
        case 'paragraph': {
          let text = block.text.trim()
          if (block.bold && !text.startsWith('**')) text = `**${text}**`
          if (block.italic && !text.startsWith('*')) text = `*${text}*`
          parts.push(`${text}\n`)
          break
        }
        case 'heading': {
          const prefix = '#'.repeat(Math.min(Math.max(block.level, 1), 6))
          parts.push(`${prefix} ${block.text}\n`)
          break
        }
        case 'bullet-list': {
          for (const item of block.items) {
            parts.push(`- ${item}`)
          }
          parts.push('')
          break
        }
        case 'numbered-list': {
          block.items.forEach((item, index) => {
            parts.push(`${index + 1}. ${item}`)
          })
          parts.push('')
          break
        }
        case 'table': {
          if (block.headers.length > 0) {
            parts.push(`| ${block.headers.join(' | ')} |`)
            parts.push(`| ${block.headers.map(() => '---').join(' | ')} |`)
            for (const row of block.rows) {
              const paddedRow = block.headers.map((_, colIdx) => row[colIdx] ?? '')
              parts.push(`| ${paddedRow.join(' | ')} |`)
            }
            if (block.caption) {
              parts.push(`*Table: ${block.caption}*`)
            }
            parts.push('')
          }
          break
        }
        case 'quote': {
          parts.push(`> ${block.text}\n`)
          break
        }
        case 'callout': {
          const label = block.kind ? block.kind.toUpperCase() : 'NOTE'
          parts.push(`> **${label}**: ${block.text}\n`)
          break
        }
        case 'references': {
          block.entries.forEach((ref, index) => {
            parts.push(`[${index + 1}] ${ref.text}`)
          })
          parts.push('')
          break
        }
        case 'caption': {
          parts.push(`*${block.text}*\n`)
          break
        }
        case 'page-break': {
          parts.push(`\n---\n`)
          break
        }
      }
    }
  }

  return parts.join('\n')
}

/**
 * Parses raw markdown into a structured RichDocumentSpec using headings and tables.
 */
export function markdownToRichDocumentSpec(
  markdown: string,
  title?: string,
  docType: DocumentType = 'general',
): RichDocumentSpec {
  const profile = getProfile(docType)
  const lines = markdown.split(/\r?\n/)
  let docTitle = title || 'Document'
  const sections: RichDocumentSection[] = []

  let currentHeading = 'Overview'
  let currentLevel = 2
  let currentBlocks: DocumentBlock[] = []

  let inTable = false
  let tableHeaders: string[] = []
  let tableRows: string[][] = []

  const flushTable = () => {
    if (inTable && tableHeaders.length > 0) {
      currentBlocks.push({
        type: 'table',
        headers: tableHeaders,
        rows: tableRows,
      })
      inTable = false
      tableHeaders = []
      tableRows = []
    }
  }

  const flushSection = () => {
    flushTable()
    if (currentBlocks.length > 0) {
      sections.push({
        id: `sec-${sections.length + 1}`,
        heading: currentHeading,
        headingLevel: currentLevel,
        blocks: [...currentBlocks],
      })
      currentBlocks = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) {
      flushTable()
      continue
    }

    // Check heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      flushSection()
      const level = headingMatch[1]!.length
      const text = headingMatch[2]!.trim()
      if (level === 1 && (!title || docTitle === 'Document')) {
        docTitle = text
        currentHeading = 'Introduction'
        currentLevel = 2
      } else {
        currentHeading = text
        currentLevel = level
      }
      continue
    }

    // Check table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
      const isDivider = cells.every((c) => /^:?-+:?$/.test(c))
      if (isDivider) {
        continue
      }
      if (!inTable) {
        inTable = true
        tableHeaders = cells
        tableRows = []
      } else {
        tableRows.push(cells)
      }
      continue
    } else {
      flushTable()
    }

    // Check bullet list
    const bulletMatch = line.match(/^[-*+]\s+(.*)$/)
    if (bulletMatch) {
      const lastBlock = currentBlocks[currentBlocks.length - 1]
      if (lastBlock && lastBlock.type === 'bullet-list') {
        lastBlock.items.push(bulletMatch[1]!.trim())
      } else {
        currentBlocks.push({ type: 'bullet-list', items: [bulletMatch[1]!.trim()] })
      }
      continue
    }

    // Check numbered list
    const numMatch = line.match(/^\d+\.\s+(.*)$/)
    if (numMatch) {
      const lastBlock = currentBlocks[currentBlocks.length - 1]
      if (lastBlock && lastBlock.type === 'numbered-list') {
        lastBlock.items.push(numMatch[1]!.trim())
      } else {
        currentBlocks.push({ type: 'numbered-list', items: [numMatch[1]!.trim()] })
      }
      continue
    }

    // Check blockquote
    const quoteMatch = line.match(/^>\s*(.*)$/)
    if (quoteMatch) {
      currentBlocks.push({ type: 'quote', text: quoteMatch[1]!.trim() })
      continue
    }

    // Plain paragraph
    currentBlocks.push({ type: 'paragraph', text: line })
  }

  flushSection()

  if (sections.length === 0) {
    sections.push({
      id: 'sec-1',
      heading: 'General',
      headingLevel: 2,
      blocks: [{ type: 'paragraph', text: markdown.trim() || 'No content provided.' }],
    })
  }

  return {
    title: docTitle,
    documentType: docType,
    layout: {
      paperSize: profile.paperSize,
      orientation: profile.orientation,
      margins: { ...profile.margins },
    },
    typography: { ...profile.typography },
    sections,
    footers: profile.includeFooterPageNumber ? { pageNumber: true, align: 'right' } : undefined,
  }
}
