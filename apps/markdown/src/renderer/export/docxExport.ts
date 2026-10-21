import type { JSONContent } from '@tiptap/core'
import type { DocumentTypeProfile } from '@genoffice/agent-core'
import {
  BLANK_BULLET_NUM_ID,
  TABLE_HEADER_FILL,
  buildBlankDocx,
  generateTableModelXml,
  latexToOmml,
  mathParagraphXml,
  parseDocx,
  saveDocx,
} from '@genoffice/docx-engine'
import type {
  BlankDocxOptions,
  GeneratedBlock,
  NewImage,
  ParaFormat,
  Run,
  SaveBlock,
  SaveOptions,
  TableCell,
  TableModel,
  TableParagraph,
} from '@genoffice/docx-engine'
import { diagramLanguage } from '../editor/diagrams'
import type { DiagramLanguage } from '../editor/diagrams'

/** Resolve an authored image src to embeddable bytes; null → fall back to alt text */
export type ImageLoader = (src: string) => Promise<NewImage | null>

/** Rasterize a diagram code block; null → the source is exported as code */
export type DiagramRenderer = (
  source: string,
  language: DiagramLanguage,
) => Promise<NewImage | null>

/** widest image that fits the A4 text column */
export const DOCX_MAX_IMAGE_PX = 620

export interface DocxMapping {
  blocks: SaveBlock[]
  options: SaveOptions
}

const MAX_LIST_LEVEL = 4
const INDENT_STEP = 360
/** decimal abstractNum of the blank template (numbering.xml: 0 = bullet, 1 = decimal) */
const DECIMAL_ABSTRACT_NUM_ID = '1'
const CODE_FONT = 'Consolas'
const CODE_FILL = 'F2F3F5'

// ── inline content → Run[] ──

function runsFromInline(
  content: JSONContent[] | undefined,
  defaultFont?: string,
  defaultSize?: number,
): Run[] {
  const runs: Run[] = []
  for (const child of content ?? []) {
    if (child.type === 'hardBreak') {
      runs.push({ text: '\n' })
      continue
    }
    if (child.type === 'inlineMath') {
      // Run[] cannot carry OMML — keep the LaTeX source visible instead
      const latex = String(child.attrs?.latex ?? '')
      if (latex) runs.push({ text: `$${latex}$`, font: CODE_FONT })
      continue
    }
    if (child.type === 'image') {
      runs.push(altTextRun(child))
      continue
    }
    if (child.type !== 'text' || !child.text) continue
    const run: Run = { text: child.text }
    for (const mark of child.marks ?? []) {
      if (mark.type === 'bold') run.bold = true
      else if (mark.type === 'italic') run.italic = true
      else if (mark.type === 'strike') run.strike = true
      else if (mark.type === 'code') run.font = CODE_FONT
      else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
        run.link = { href: mark.attrs.href }
      }
    }
    if (!run.font && defaultFont) run.font = defaultFont
    if (!run.sizeHalfPoints && defaultSize) run.sizeHalfPoints = defaultSize
    runs.push(run)
  }
  return runs
}

function plainText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(plainText).join('')
}

// ── mapping walker ──

interface WalkContext {
  blocks: SaveBlock[]
  restartNums: NonNullable<NonNullable<SaveOptions['numbering']>['restartNums']>
  nextOrderedNumId: number
  loadImage: ImageLoader
  renderDiagram?: DiagramRenderer
  pendingImages: Array<{ index: number; src: string; alt: string }>
  pendingDiagrams: Array<{ index: number; source: string; language: DiagramLanguage }>
}

function mergeFormat(base: ParaFormat | undefined, extra: ParaFormat): ParaFormat {
  return { ...base, ...extra, indentLeft: (base?.indentLeft ?? 0) + (extra.indentLeft ?? 0) }
}

function pushParagraph(ctx: WalkContext, block: GeneratedBlock): void {
  ctx.blocks.push({ kind: 'generated', block })
}

function altTextRun(image: JSONContent): Run {
  const alt = String(image.attrs?.alt ?? '') || String(image.attrs?.src ?? '')
  return { text: `[${alt}]`, italic: true, color: '888888' }
}

/**
 * Runs cannot carry pictures: each inline image becomes a picture block of its
 * own (a placeholder until the async load), the text around it its own block.
 */
function pushTextblock(
  ctx: WalkContext,
  content: JSONContent[] | undefined,
  block: (runs: Run[]) => GeneratedBlock,
  defaultFont?: string,
  defaultSize?: number,
): void {
  if (!content?.some((child) => child.type === 'image')) {
    pushParagraph(ctx, block(runsFromInline(content, defaultFont, defaultSize)))
    return
  }
  let segment: JSONContent[] = []
  const flush = () => {
    if (segment.some((child) => child.type !== 'text' || child.text?.trim())) {
      pushParagraph(ctx, block(runsFromInline(segment, defaultFont, defaultSize)))
    }
    segment = []
  }
  for (const child of content) {
    if (child.type !== 'image') {
      segment.push(child)
      continue
    }
    flush()
    ctx.pendingImages.push({
      index: ctx.blocks.length,
      src: String(child.attrs?.src ?? ''),
      alt: String(child.attrs?.alt ?? ''),
    })
    ctx.blocks.push({ kind: 'generated', block: { type: 'paragraph', runs: [] } })
  }
  flush()
}

function walkList(
  ctx: WalkContext,
  node: JSONContent,
  kind: 'bullet' | 'ordered',
  ilvl: number,
  numId: string,
  base?: ParaFormat,
  profile?: DocumentTypeProfile,
): void {
  const defaultFont = profile?.typography.bodyFont
  const defaultSize = profile ? Math.round(profile.typography.bodySizePt * 2) : undefined
  for (const item of node.content ?? []) {
    if (item.type !== 'listItem' && item.type !== 'taskItem') continue
    let firstPara = true
    for (const child of item.content ?? []) {
      if (child.type === 'paragraph') {
        const runs = runsFromInline(child.content, defaultFont, defaultSize)
        if (item.type === 'taskItem') {
          runs.unshift({ text: item.attrs?.checked ? '☑ ' : '☐ ' })
        }
        if (firstPara && item.type !== 'taskItem') {
          pushParagraph(ctx, {
            type: 'listItem',
            list: { kind, numId, ilvl: Math.min(ilvl, MAX_LIST_LEVEL) },
            runs,
            format: base,
          })
        } else {
          // task items and continuation paragraphs indent under the marker
          pushParagraph(ctx, {
            type: 'paragraph',
            runs,
            format: mergeFormat(base, { indentLeft: INDENT_STEP * (ilvl + 1) }),
          })
        }
        firstPara = false
      } else if (child.type === 'bulletList' || child.type === 'taskList') {
        walkList(ctx, child, 'bullet', ilvl + 1, BLANK_BULLET_NUM_ID, base, profile)
      } else if (child.type === 'orderedList') {
        walkList(ctx, child, 'ordered', ilvl + 1, allocOrderedNumId(ctx), base, profile)
      } else {
        walkBlock(ctx, child, mergeFormat(base, { indentLeft: INDENT_STEP * (ilvl + 1) }), profile)
      }
    }
  }
}

function allocOrderedNumId(ctx: WalkContext): string {
  const numId = String(ctx.nextOrderedNumId++)
  ctx.restartNums.push({
    numId,
    abstractNumId: DECIMAL_ABSTRACT_NUM_ID,
    startOverrides: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1 },
  })
  return numId
}

function tableParagraphs(
  cell: JSONContent,
  defaultFont?: string,
  defaultSize?: number,
): TableParagraph[] {
  const paras: TableParagraph[] = []
  for (const child of cell.content ?? []) {
    if (child.type === 'paragraph')
      paras.push({ runs: runsFromInline(child.content, defaultFont, defaultSize) })
  }
  return paras.length > 0 ? paras : [{ runs: [] }]
}

function mapTable(node: JSONContent, profile?: DocumentTypeProfile): TableModel {
  const defaultFont = profile?.typography.bodyFont
  const defaultSize = profile ? Math.round(profile.typography.bodySizePt * 2) : undefined
  const rows: TableCell[][] = []
  for (const row of node.content ?? []) {
    if (row.type !== 'tableRow') continue
    const cells: TableCell[] = []
    for (const cell of row.content ?? []) {
      if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') continue
      const isHeader = cell.type === 'tableHeader'
      const rich = tableParagraphs(cell, defaultFont, defaultSize)
      cells.push({
        paras: rich.map((p) => p.runs.map((r) => r.text).join('')),
        richParas: rich,
        ...(Number(cell.attrs?.colspan) > 1 ? { colSpan: Number(cell.attrs?.colspan) } : {}),
        ...(isHeader ? { bold: true, fill: TABLE_HEADER_FILL } : {}),
      })
    }
    if (cells.length > 0) rows.push(cells)
  }
  return { rows }
}

function walkBlock(
  ctx: WalkContext,
  node: JSONContent,
  base?: ParaFormat,
  profile?: DocumentTypeProfile,
): void {
  const bodyFont = profile?.typography.bodyFont
  const bodySize = profile ? Math.round(profile.typography.bodySizePt * 2) : undefined
  switch (node.type) {
    case 'paragraph':
      pushTextblock(
        ctx,
        node.content,
        (runs) => ({ type: 'paragraph', runs, format: base }),
        bodyFont,
        bodySize,
      )
      break
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6) as number
      pushTextblock(
        ctx,
        node.content,
        (runs) => ({ type: 'heading', level, runs, format: base }),
        bodyFont,
      )
      break
    }
    case 'bulletList':
      walkList(ctx, node, 'bullet', 0, BLANK_BULLET_NUM_ID, base, profile)
      break
    case 'orderedList':
      walkList(ctx, node, 'ordered', 0, allocOrderedNumId(ctx), base, profile)
      break
    case 'taskList':
      walkList(ctx, node, 'bullet', 0, BLANK_BULLET_NUM_ID, base, profile)
      break
    case 'blockquote':
      for (const child of node.content ?? []) {
        walkBlock(ctx, child, mergeFormat(base, { indentLeft: INDENT_STEP, borders: 'l' }), profile)
      }
      break
    case 'codeBlock': {
      const source = plainText(node)
      const code: GeneratedBlock = {
        type: 'paragraph',
        runs: [{ text: source, font: CODE_FONT, sizeHalfPoints: 19 }],
        format: mergeFormat(base, { shadingFill: CODE_FILL }),
      }
      const language = diagramLanguage(node.attrs?.language)
      if (language && ctx.renderDiagram && source.trim()) {
        ctx.pendingDiagrams.push({ index: ctx.blocks.length, source, language })
      }
      pushParagraph(ctx, code)
      break
    }
    case 'horizontalRule':
      pushParagraph(ctx, {
        type: 'paragraph',
        runs: [],
        format: mergeFormat(base, { borders: 'b' }),
      })
      break
    case 'table':
      ctx.blocks.push({ kind: 'xml', xml: generateTableModelXml(mapTable(node, profile)) })
      break
    case 'blockMath': {
      const latex = String(node.attrs?.latex ?? '')
      try {
        ctx.blocks.push({ kind: 'xml', xml: mathParagraphXml(latexToOmml(latex)) })
      } catch {
        // LaTeX outside the OMML converter's subset: keep the source visible
        pushParagraph(ctx, {
          type: 'paragraph',
          runs: [{ text: `$$${latex}$$`, font: CODE_FONT }],
          format: base,
        })
      }
      break
    }
    default: {
      // unknown block: keep its text so nothing silently disappears
      const text = plainText(node)
      if (text.trim()) {
        const inlineRuns = runsFromInline(node.content, bodyFont, bodySize)
        const inlineText = inlineRuns.map((r) => r.text).join('')
        if (inlineRuns.length > 0 && inlineText.trim() === text.trim()) {
          pushParagraph(ctx, {
            type: 'paragraph',
            runs: inlineRuns,
            format: base,
          })
        } else {
          const run: Run = { text }
          if (bodyFont) run.font = bodyFont
          if (bodySize) run.sizeHalfPoints = bodySize
          pushParagraph(ctx, {
            type: 'paragraph',
            runs: [run],
            format: base,
          })
        }
      }
    }
  }
}

/** Map a ProseMirror document to docx-engine SaveBlocks (pure except image loading) */
export async function mapDocToSaveBlocks(
  doc: JSONContent,
  loadImage: ImageLoader,
  renderDiagram?: DiagramRenderer,
  profile?: DocumentTypeProfile,
): Promise<DocxMapping> {
  const ctx: WalkContext = {
    blocks: [],
    restartNums: [],
    nextOrderedNumId: 100,
    loadImage,
    renderDiagram,
    pendingImages: [],
    pendingDiagrams: [],
  }
  const base: ParaFormat | undefined = profile
    ? {
        lineSpacing: profile.typography.lineSpacing,
        spaceAfter: Math.round(profile.typography.paragraphSpacingAfterPt * 20),
      }
    : undefined
  for (const node of doc.content ?? []) walkBlock(ctx, node, base, profile)

  for (const pending of ctx.pendingDiagrams) {
    const image = await ctx.renderDiagram!(pending.source, pending.language).catch(() => null)
    if (image) ctx.blocks[pending.index] = { kind: 'image', image }
  }

  for (const pending of ctx.pendingImages) {
    const image = await loadImage(pending.src).catch(() => null)
    if (image) {
      ctx.blocks[pending.index] = { kind: 'image', image }
    } else {
      ctx.blocks[pending.index] = {
        kind: 'generated',
        block: { type: 'paragraph', runs: [altTextRun({ attrs: pending })] },
      }
    }
  }

  const options: SaveOptions =
    ctx.restartNums.length > 0 ? { numbering: { restartNums: ctx.restartNums } } : {}
  return { blocks: ctx.blocks, options }
}

/** md document (PM JSON) → brand-new .docx bytes, fully local */
export async function exportDocxBytes(
  doc: JSONContent,
  loadImage: ImageLoader,
  renderDiagram?: DiagramRenderer,
  extraOptions?: SaveOptions,
  profile?: DocumentTypeProfile,
): Promise<Uint8Array> {
  const mapping = await mapDocToSaveBlocks(doc, loadImage, renderDiagram, profile)
  const mergedOptions: SaveOptions = {
    ...mapping.options,
    ...extraOptions,
    ...(mapping.options.numbering || extraOptions?.numbering
      ? {
          numbering: {
            ...mapping.options.numbering,
            ...extraOptions?.numbering,
            restartNums: [
              ...(mapping.options.numbering?.restartNums ?? []),
              ...(extraOptions?.numbering?.restartNums ?? []),
            ],
          },
        }
      : {}),
  }
  const blankOptions: BlankDocxOptions | undefined = profile
    ? {
        font: profile.typography.bodyFont,
        fontSizeHalfPoints: Math.round(profile.typography.bodySizePt * 2),
        lineSpacingMultiplier: profile.typography.lineSpacing,
        paragraphSpacingAfterTwips: Math.round(profile.typography.paragraphSpacingAfterPt * 20),
        paperSize: profile.paperSize,
        pageMarginsTwips: {
          top: Math.round(profile.margins.top * 56.6929),
          right: Math.round(profile.margins.right * 56.6929),
          bottom: Math.round(profile.margins.bottom * 56.6929),
          left: Math.round(profile.margins.left * 56.6929),
        },
      }
    : undefined
  const parsed = await parseDocx(await buildBlankDocx(blankOptions))
  return saveDocx(parsed, mapping.blocks, mergedOptions)
}
