import JSZip from 'jszip'
import { PPR_CHILD_ORDER } from './generate'
import type { NumberingLevel } from './types'

/**
 * Blank document template for "new document" and AI from-scratch generation.
 *
 * The generate layer only references styles / numbering that already exist in
 * the package, so a fresh document must ship with the standard set: Normal,
 * Heading1-6, ListParagraph, Hyperlink, TOC1-9 (for generated TOC fields),
 * plus bullet (numId 1) and decimal (numId 2) numbering definitions.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const DOC_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

/** numId of the template's bullet list definition */
export const BLANK_BULLET_NUM_ID = '1'
/** numId of the template's ordered (decimal) list definition */
export const BLANK_ORDERED_NUM_ID = '2'

/** TOC entry styles referenced by generateTocFieldXml (indent grows per level) */
function tocStyle(level: number): string {
  const ind = level > 1 ? `<w:ind w:left="${220 * (level - 1)}"/>` : ''
  return (
    `<w:style w:type="paragraph" w:styleId="TOC${level}"><w:name w:val="toc ${level}"/>` +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    `<w:pPr><w:spacing w:after="100"/>${ind}</w:pPr></w:style>`
  )
}

function headingStyle(
  level: number,
  sizeHalfPoints: number,
  font?: string,
  office?: DocumentStyles,
): string {
  // Word lists Heading 3+ in the gallery only once the document uses them
  const hidden = level >= 3 && !office ? '<w:semiHidden/><w:unhideWhenUsed/>' : ''
  const rFonts = font
    ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}"${office ? ` w:eastAsia="${font}" w:cs="${font}"` : ''}/>`
    : ''
  const spacing = office
    ? `<w:spacing w:before="${office.headingSpaceBeforeTwips[Math.min(level, 3) - 1]}" w:after="${office.headingSpaceAfterTwips}"/>`
    : `<w:spacing w:before="${level <= 2 ? 240 : 160}" w:after="120"/>`
  const keep = office ? '<w:keepNext/><w:keepLines/>' : '<w:keepNext/>'
  const italic = office?.headingItalicLevels.includes(level) ? '<w:i/><w:iCs/>' : ''
  const bold = office ? '<w:b/><w:bCs/>' : '<w:b/>'
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/>${hidden}<w:qFormat/>` +
    `<w:pPr>${keep}${spacing}<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr>${rFonts}${bold}${italic}<w:sz w:val="${sizeHalfPoints}"/><w:szCs w:val="${sizeHalfPoints}"/></w:rPr></w:style>`
  )
}

/**
 * The default document style set (the pandoc reference.docx idea): one place
 * that fixes how headings, tables, quotes, code and captions look, so content
 * only names a style and never carries per-element formatting. Applied when
 * BlankDocxOptions.documentStyles is set (AI-created documents).
 */
export interface DocumentStyles {
  /** Heading 1..3 sizes in half-points (Heading 4-6 follow the body size) */
  headingSizesHalfPoints: [number, number, number]
  /** heading levels that are also italic */
  headingItalicLevels: number[]
  /** space before Heading 1..3 in twips */
  headingSpaceBeforeTwips: [number, number, number]
  /** space after every heading in twips */
  headingSpaceAfterTwips: number
  /** Title style size in half-points */
  titleSizeHalfPoints: number
  /** table cell margins (padding) in twips */
  tableCellMarginTwips: { top: number; bottom: number; left: number; right: number }
  /** table border width in eighths of a point (4 = 0.5 pt) */
  tableBorderEighths: number
  /** header-row shading, hex without '#' */
  tableHeaderFill: string
  /** monospace face and size (half-points) of code */
  codeFont: string
  codeSizeHalfPoints: number
  codeFill: string
}

export const DEFAULT_DOCUMENT_STYLES: DocumentStyles = {
  headingSizesHalfPoints: [32, 28, 26], // 16 / 14 / 13 pt
  headingItalicLevels: [3],
  headingSpaceBeforeTwips: [360, 280, 200], // 18 / 14 / 10 pt
  headingSpaceAfterTwips: 120, // 6 pt
  titleSizeHalfPoints: 40, // 20 pt
  tableCellMarginTwips: { top: 40, bottom: 40, left: 100, right: 100 },
  tableBorderEighths: 4,
  tableHeaderFill: 'F2F2F2',
  codeFont: 'Consolas',
  codeSizeHalfPoints: 20,
  codeFill: 'F2F3F5',
}

/** paragraph / table style ids the default style set defines and the markdown export references */
export const DOC_STYLE_IDS = {
  tableText: 'TableText',
  tableGrid: 'TableGrid',
  code: 'SourceCode',
  quote: 'Quote',
  caption: 'Caption',
  listBullet: 'ListBullet',
  listNumber: 'ListNumber',
} as const

/** styles added by the default style set (Quote and Title are swapped in quickStylesXml) */
function officeStylesXml(o: DocumentStyles): string {
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="${o.tableBorderEighths}" w:space="0" w:color="auto"/>`
  const m = o.tableCellMarginTwips
  const mar = (side: string, w: number) => `<w:${side} w:w="${w}" w:type="dxa"/>`
  return (
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
    '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
    '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    // Table Grid: thin single borders, padded cells
    `<w:style w:type="table" w:styleId="${DOC_STYLE_IDS.tableGrid}"><w:name w:val="Table Grid"/>` +
    '<w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>' +
    '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
    `<w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
    `<w:tblCellMar>${mar('top', m.top)}${mar('left', m.left)}${mar('bottom', m.bottom)}${mar('right', m.right)}</w:tblCellMar></w:tblPr></w:style>` +
    // text inside table cells: no paragraph gap
    paraStyle(
      DOC_STYLE_IDS.tableText,
      'Table Text',
      40,
      '<w:spacing w:before="0" w:after="0" w:line="264" w:lineRule="auto"/>',
    ) +
    paraStyle(
      DOC_STYLE_IDS.code,
      'Source Code',
      41,
      `<w:shd w:val="clear" w:color="auto" w:fill="${o.codeFill}"/><w:spacing w:before="60" w:after="120" w:line="240" w:lineRule="auto"/>`,
      `<w:rFonts w:ascii="${o.codeFont}" w:hAnsi="${o.codeFont}" w:cs="${o.codeFont}"/><w:sz w:val="${o.codeSizeHalfPoints}"/><w:szCs w:val="${o.codeSizeHalfPoints}"/>`,
    ) +
    paraStyle(
      DOC_STYLE_IDS.caption,
      'caption',
      35,
      '<w:spacing w:before="60" w:after="120" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>',
      '<w:i/><w:iCs/><w:sz w:val="24"/><w:szCs w:val="24"/>',
    ) +
    paraStyle(
      DOC_STYLE_IDS.listBullet,
      'List Bullet',
      36,
      `<w:numPr><w:numId w:val="${BLANK_BULLET_NUM_ID}"/></w:numPr><w:contextualSpacing/>`,
    ) +
    paraStyle(
      DOC_STYLE_IDS.listNumber,
      'List Number',
      37,
      `<w:numPr><w:numId w:val="${BLANK_ORDERED_NUM_ID}"/></w:numPr><w:contextualSpacing/>`,
    )
  )
}

/** accent1 (4472C4) shade BF / text1 tints of the Office theme, as Word caches them in w:val */
const ACCENT_DARK = 'w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"'
const TEXT_BF = 'w:val="404040" w:themeColor="text1" w:themeTint="BF"'
const TEXT_A6 = 'w:val="595959" w:themeColor="text1" w:themeTint="A6"'
const TEXT_A5 = 'w:val="5A5A5A" w:themeColor="text1" w:themeTint="A5"'

function paraStyle(id: string, name: string, priority: number, pPr: string, rPr = ''): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${priority}"/><w:qFormat/>` +
    `<w:pPr>${pPr}</w:pPr>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`
  )
}

function charStyle(id: string, name: string, priority: number, rPr: string): string {
  return (
    `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:uiPriority w:val="${priority}"/><w:qFormat/><w:rPr>${rPr}</w:rPr></w:style>`
  )
}

/** Word's Quick Style set (Normal and the headings are defined separately), in gallery order */
const quickStylesXml = (office?: DocumentStyles): string =>
  '<w:style w:type="paragraph" w:styleId="NoSpacing"><w:name w:val="No Spacing"/><w:uiPriority w:val="1"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>' +
  (office
    ? paraStyle(
        'Title',
        'Title',
        10,
        '<w:keepNext/><w:spacing w:before="0" w:after="240" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>',
        `<w:b/><w:bCs/><w:sz w:val="${office.titleSizeHalfPoints}"/><w:szCs w:val="${office.titleSizeHalfPoints}"/>`,
      )
    : paraStyle(
        'Title',
        'Title',
        10,
        '<w:spacing w:after="80" w:line="240" w:lineRule="auto"/><w:contextualSpacing/>',
        '<w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/>',
      )) +
  paraStyle(
    'Subtitle',
    'Subtitle',
    11,
    '<w:spacing w:after="160"/>',
    `<w:color ${TEXT_A6}/><w:spacing w:val="15"/><w:sz w:val="28"/><w:szCs w:val="28"/>`,
  ) +
  charStyle('SubtleEmphasis', 'Subtle Emphasis', 19, `<w:i/><w:iCs/><w:color ${TEXT_BF}/>`) +
  charStyle('Emphasis', 'Emphasis', 20, '<w:i/><w:iCs/>') +
  charStyle('IntenseEmphasis', 'Intense Emphasis', 21, `<w:i/><w:iCs/><w:color ${ACCENT_DARK}/>`) +
  charStyle('Strong', 'Strong', 22, '<w:b/><w:bCs/>') +
  (office
    ? paraStyle(
        'Quote',
        'Quote',
        29,
        '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="A6A6A6"/></w:pBdr><w:spacing w:before="120" w:after="120"/><w:ind w:left="567"/>',
        '<w:i/><w:iCs/>',
      )
    : paraStyle(
        'Quote',
        'Quote',
        29,
        '<w:spacing w:before="200" w:after="480"/><w:jc w:val="center"/>',
        `<w:i/><w:iCs/><w:color ${TEXT_BF}/>`,
      )) +
  paraStyle(
    'IntenseQuote',
    'Intense Quote',
    30,
    `<w:pBdr><w:top w:val="single" w:sz="4" w:space="10" w:color="2F5496" w:themeColor="accent1" w:themeShade="BF"/>` +
      `<w:bottom w:val="single" w:sz="4" w:space="10" w:color="2F5496" w:themeColor="accent1" w:themeShade="BF"/></w:pBdr>` +
      '<w:spacing w:before="360" w:after="440"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/>',
    `<w:i/><w:iCs/><w:color ${ACCENT_DARK}/>`,
  ) +
  charStyle('SubtleReference', 'Subtle Reference', 31, `<w:smallCaps/><w:color ${TEXT_A5}/>`) +
  charStyle(
    'IntenseReference',
    'Intense Reference',
    32,
    `<w:b/><w:bCs/><w:smallCaps/><w:color ${ACCENT_DARK}/><w:spacing w:val="5"/>`,
  ) +
  charStyle('BookTitle', 'Book Title', 33, '<w:b/><w:bCs/><w:i/><w:iCs/><w:spacing w:val="5"/>') +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
  '<w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'

const stylesXml = (options?: BlankDocxOptions): string => {
  const font = options?.font || 'Calibri'
  const sz = options?.fontSizeHalfPoints || 22
  const line = options?.lineSpacingMultiplier
    ? Math.round(options.lineSpacingMultiplier * 240)
    : 276
  const spaceAfter =
    options?.paragraphSpacingAfterTwips !== undefined ? options.paragraphSpacingAfterTwips : 120
  const office = options?.documentStyles
  // the default style set pins every font slot (ascii/hAnsi/eastAsia/cs) to the body
  // face so Vietnamese diacritics and complex scripts never fall back to another font
  const eastAsiaFont = options?.eastAsiaFont ?? (office ? font : undefined)
  const csAttr = office ? ` w:cs="${font}"` : ''
  const lang = options?.lang ?? 'en-US'
  const langXml = office ? `<w:lang w:val="${lang}" w:eastAsia="${lang}" w:bidi="ar-SA"/>` : ''
  const [h1, h2, h3] = office?.headingSizesHalfPoints ?? [32, 28, 26]
  return (
    XML_DECL +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    `<w:rFonts w:ascii="${font}"${eastAsiaFont ? ` w:eastAsia="${eastAsiaFont}"` : ''} w:hAnsi="${font}"${csAttr}/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>${langXml}` +
    '</w:rPr></w:rPrDefault>' +
    `<w:pPrDefault><w:pPr><w:spacing w:after="${spaceAfter}" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    headingStyle(1, h1, font, office) +
    headingStyle(2, h2, font, office) +
    headingStyle(3, h3, font, office) +
    headingStyle(4, office ? sz : 24, font, office) +
    headingStyle(5, office ? sz : 22, font, office) +
    headingStyle(6, office ? sz : 22, font, office) +
    quickStylesXml(office) +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    Array.from({ length: 9 }, (_, i) => tocStyle(i + 1)).join('') +
    (office ? officeStylesXml(office) : '') +
    '</w:styles>'
  )
}

function bulletLevels(): string {
  let xml = ''
  for (let ilvl = 0; ilvl < 5; ilvl++) {
    xml +=
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/>` +
      `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>` +
      '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>'
  }
  return xml
}

function decimalLevels(): string {
  let xml = ''
  for (let ilvl = 0; ilvl < 5; ilvl++) {
    xml +=
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${ilvl + 1}."/>` +
      `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
  }
  return xml
}

/** Custom numbering level (one level of a multilevel list / bullet library / numbering library definition) */
export interface CustomNumberingLevel {
  /** w:numFmt:decimal/bullet/lowerLetter/upperRoman/chineseCountingThousand… */
  numFmt: string
  /** w:lvlText: a pattern like "%1." or a literal bullet symbol */
  lvlText: string
  /** w:ind w:left(twips) */
  indentLeft: number
  /** w:ind w:hanging (twips, default 360) */
  hanging?: number
  /** w:start (default 1) */
  start?: number
  /** w:suff (default tab) */
  suff?: 'tab' | 'space' | 'nothing'
  /** w:lvlJc (default left) */
  lvlJc?: 'left' | 'center' | 'right'
  /** w:pPr/w:tabs: an explicit tab stop after the marker (twips) */
  tabStop?: number
  /** w:rPr of the marker: font family, size (half-points), color (hex), weight */
  font?: string
  szHalfPoints?: number
  color?: string
  bold?: boolean
  italic?: boolean
  /** w:pStyle: paragraphs in this style take the level's numbering */
  pStyle?: string
  /** w:isLgl: legal-style numbering (every placeholder shows as decimal) */
  isLgl?: boolean
  /** w:lvlRestart: restart this level after the given (higher) level; 0 = never */
  lvlRestart?: number
  /** w:lvlPicBulletId: draw a w:numPicBullet image instead of lvlText */
  picBulletId?: number
}

/** A parsed level in the shape the define/adjust dialogs edit */
export function customLevelFromNumberingLevel(level: NumberingLevel): CustomNumberingLevel {
  const out: CustomNumberingLevel = {
    numFmt: level.numFmt,
    lvlText: level.lvlText,
    indentLeft: level.indentLeft ?? 0,
    hanging: level.hanging ?? (level.indentLeft === undefined ? 360 : 0),
    start: level.start,
  }
  if (level.suff) out.suff = level.suff
  if (level.lvlJc) out.lvlJc = level.lvlJc
  if (level.font) out.font = level.font
  if (level.szHalfPoints) out.szHalfPoints = level.szHalfPoints
  if (level.color) out.color = level.color
  if (level.isLgl) out.isLgl = true
  if (level.picBulletId !== undefined) out.picBulletId = level.picBulletId
  if (level.bold) out.bold = true
  if (level.italic) out.italic = true
  if (level.tabStop !== undefined) out.tabStop = level.tabStop
  if (level.pStyle) out.pStyle = level.pStyle
  if (level.lvlRestart !== undefined) out.lvlRestart = level.lvlRestart
  return out
}

/** The renderer's overlay shape for a level the dialogs produced (display before save) */
export function numberingLevelFromCustom(
  l: CustomNumberingLevel,
  picBulletSrc?: string,
): NumberingLevel {
  const out: NumberingLevel = {
    numFmt: l.numFmt,
    lvlText: l.lvlText,
    start: l.start ?? 1,
    indentLeft: l.indentLeft,
    hanging: l.hanging ?? 360,
  }
  if (l.suff) out.suff = l.suff
  if (l.lvlJc) out.lvlJc = l.lvlJc
  if (l.font) out.font = l.font
  if (l.szHalfPoints) out.szHalfPoints = l.szHalfPoints
  if (l.color) out.color = l.color
  if (l.isLgl) out.isLgl = true
  if (l.picBulletId !== undefined) out.picBulletId = l.picBulletId
  if (picBulletSrc) out.picBulletSrc = picBulletSrc
  if (l.bold) out.bold = true
  if (l.italic) out.italic = true
  if (l.tabStop !== undefined) out.tabStop = l.tabStop
  if (l.pStyle) out.pStyle = l.pStyle
  if (l.lvlRestart !== undefined) out.lvlRestart = l.lvlRestart
  return out
}

const LVL_CHILD_ORDER = [
  'w:start',
  'w:numFmt',
  'w:lvlRestart',
  'w:pStyle',
  'w:isLgl',
  'w:suff',
  'w:lvlText',
  'w:lvlPicBulletId',
  'w:legacy',
  'w:lvlJc',
  'w:pPr',
  'w:rPr',
]

/**
 * Top-level children of a small element as [name, xml] pairs (no same-name
 * nesting inside a w:lvl). Any element name is matched, not just the w: ones:
 * matching w: alone dropped the w14 extension children of a level's rPr, and an
 * rPr holding nothing but those was deleted with them.
 */
function splitChildren(inner: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const re = /<([\w:]+)\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/\1>)/g
  for (const m of inner.matchAll(re)) out.push([m[1], m[0]])
  return out
}

function innerOf(xml: string): string {
  const open = xml.indexOf('>')
  const close = xml.lastIndexOf('</')
  return xml.endsWith('/>') || close < 0 ? '' : xml.slice(open + 1, close)
}

/**
 * Merge a dialog-produced level into an existing w:lvl: the fields the level
 * carries replace their elements, everything else in the original (legacy,
 * w14 extensions, rPr children the dialogs do not know) keeps its bytes.
 */
export function mergeLevelXml(existing: string, l: CustomNumberingLevel, ilvl: number): string {
  const children = new Map(splitChildren(innerOf(existing)))
  const set = (name: string, xml: string | null) => {
    if (xml === null) children.delete(name)
    else children.set(name, xml)
  }
  set('w:start', `<w:start w:val="${l.start ?? 1}"/>`)
  set('w:numFmt', `<w:numFmt w:val="${escAttr(l.numFmt)}"/>`)
  if (l.lvlRestart !== undefined) set('w:lvlRestart', `<w:lvlRestart w:val="${l.lvlRestart}"/>`)
  if (l.pStyle !== undefined)
    set('w:pStyle', l.pStyle ? `<w:pStyle w:val="${escAttr(l.pStyle)}"/>` : null)
  if (l.isLgl !== undefined) set('w:isLgl', l.isLgl ? '<w:isLgl/>' : null)
  if (l.suff !== undefined) set('w:suff', l.suff === 'tab' ? null : `<w:suff w:val="${l.suff}"/>`)
  set('w:lvlText', `<w:lvlText w:val="${escAttr(l.lvlText)}"/>`)
  if (l.picBulletId !== undefined)
    set('w:lvlPicBulletId', `<w:lvlPicBulletId w:val="${l.picBulletId}"/>`)
  set('w:lvlJc', `<w:lvlJc w:val="${l.lvlJc ?? 'left'}"/>`)

  const pPr = new Map(splitChildren(innerOf(children.get('w:pPr') ?? '')))
  const hanging = Math.round(l.hanging ?? 360)
  pPr.set('w:ind', `<w:ind w:left="${Math.round(l.indentLeft)}" w:hanging="${hanging}"/>`)
  if (l.tabStop !== undefined)
    pPr.set('w:tabs', `<w:tabs><w:tab w:val="num" w:pos="${Math.round(l.tabStop)}"/></w:tabs>`)
  // CT_PPrGeneral sequence, the same table generate.ts and style-upsert.ts
  // assemble and merge with. A w:lvl's pPr can carry any paragraph child a
  // producer saw fit to write (w:spacing, w:keepNext, w:jc, …), so the full
  // order matters, not just the two children this function writes. Anything
  // unlisted sorts last rather than first — indexOf returns -1, which would
  // hoist it to the front of w:pPr and, since Word validates the child order
  // strictly, make the saved document unreadable.
  const rank = (tag: string): number => {
    const i = PPR_CHILD_ORDER.indexOf(tag)
    return i < 0 ? PPR_CHILD_ORDER.length : i
  }
  const pPrXml = [...pPr.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([, xml]) => xml)
    .join('')
  set('w:pPr', `<w:pPr>${pPrXml}</w:pPr>`)

  const rPr = new Map(splitChildren(innerOf(children.get('w:rPr') ?? '')))
  if (l.font !== undefined) {
    const f = escAttr(l.font)
    if (l.font)
      rPr.set(
        'w:rFonts',
        `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}" w:hint="default"/>`,
      )
    else rPr.delete('w:rFonts')
  }
  const toggle = (name: string, on: boolean | undefined, xml: string) => {
    if (on === undefined) return
    if (on) rPr.set(name, xml)
    else rPr.delete(name)
  }
  toggle('w:b', l.bold, '<w:b/>')
  toggle('w:i', l.italic, '<w:i/>')
  if (l.color !== undefined) {
    if (l.color) rPr.set('w:color', `<w:color w:val="${escAttr(l.color)}"/>`)
    else rPr.delete('w:color')
  }
  if (l.szHalfPoints !== undefined) {
    if (l.szHalfPoints) {
      rPr.set('w:sz', `<w:sz w:val="${l.szHalfPoints}"/>`)
      rPr.set('w:szCs', `<w:szCs w:val="${l.szHalfPoints}"/>`)
    } else {
      rPr.delete('w:sz')
      rPr.delete('w:szCs')
    }
  }
  const rPrOrder = ['w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:color', 'w:sz', 'w:szCs']
  const rPrXml = [...rPr.entries()]
    .sort((a, b) => {
      const ia = rPrOrder.indexOf(a[0])
      const ib = rPrOrder.indexOf(b[0])
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    .map(([, xml]) => xml)
    .join('')
  set('w:rPr', rPrXml ? `<w:rPr>${rPrXml}</w:rPr>` : null)

  const body = [...children.entries()]
    .sort((a, b) => {
      const ia = LVL_CHILD_ORDER.indexOf(a[0])
      const ib = LVL_CHILD_ORDER.indexOf(b[0])
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    .map(([, xml]) => xml)
    .join('')
  const openTag = /<w:lvl\b[^>]*>/.exec(existing)?.[0] ?? `<w:lvl w:ilvl="${ilvl}">`
  return `${openTag.replace(/\/>$/, '>')}${body}</w:lvl>`
}

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One w:lvl in CT_Lvl child order */
export function customLevelXml(l: CustomNumberingLevel, ilvl: number): string {
  const parts = [`<w:start w:val="${l.start ?? 1}"/>`, `<w:numFmt w:val="${escAttr(l.numFmt)}"/>`]
  if (l.lvlRestart !== undefined) parts.push(`<w:lvlRestart w:val="${l.lvlRestart}"/>`)
  if (l.pStyle) parts.push(`<w:pStyle w:val="${escAttr(l.pStyle)}"/>`)
  if (l.isLgl) parts.push('<w:isLgl/>')
  if (l.suff && l.suff !== 'tab') parts.push(`<w:suff w:val="${l.suff}"/>`)
  parts.push(`<w:lvlText w:val="${escAttr(l.lvlText)}"/>`)
  if (l.picBulletId !== undefined) parts.push(`<w:lvlPicBulletId w:val="${l.picBulletId}"/>`)
  parts.push(`<w:lvlJc w:val="${l.lvlJc ?? 'left'}"/>`)
  const tabs =
    l.tabStop !== undefined
      ? `<w:tabs><w:tab w:val="num" w:pos="${Math.round(l.tabStop)}"/></w:tabs>`
      : ''
  const hanging = Math.round(l.hanging ?? 360)
  parts.push(
    `<w:pPr>${tabs}<w:ind w:left="${Math.round(l.indentLeft)}" w:hanging="${hanging}"/></w:pPr>`,
  )
  const rPr: string[] = []
  if (l.font) {
    const f = escAttr(l.font)
    rPr.push(
      `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}" w:hint="default"/>`,
    )
  }
  if (l.bold) rPr.push('<w:b/>')
  if (l.italic) rPr.push('<w:i/>')
  if (l.color) rPr.push(`<w:color w:val="${escAttr(l.color)}"/>`)
  if (l.szHalfPoints)
    rPr.push(`<w:sz w:val="${l.szHalfPoints}"/><w:szCs w:val="${l.szHalfPoints}"/>`)
  if (rPr.length) parts.push(`<w:rPr>${rPr.join('')}</w:rPr>`)
  return `<w:lvl w:ilvl="${ilvl}">${parts.join('')}</w:lvl>`
}

function customLevels(levels: CustomNumberingLevel[]): string {
  return levels.map((l, ilvl) => customLevelXml(l, ilvl)).join('')
}

/** w:numPicBullet with a DrawingML picture; the image relationship lives in numbering.xml.rels */
export function numPicBulletXml(id: number, rId: string): string {
  return (
    `<w:numPicBullet w:numPicBulletId="${id}"><w:drawing>` +
    `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="152400" cy="152400"/><wp:docPr id="${id}" name="Picture bullet ${id}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture bullet ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="152400" cy="152400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:numPicBullet>`
  )
}

/** One abstractNum definition; uses custom levels when provided, otherwise the blank-template style (5 levels) */
export function abstractNumXml(
  abstractNumId: string,
  kind: 'bullet' | 'ordered',
  levels?: CustomNumberingLevel[],
): string {
  const body = levels?.length
    ? customLevels(levels)
    : kind === 'bullet'
      ? bulletLevels()
      : decimalLevels()
  return `<w:abstractNum w:abstractNumId="${abstractNumId}">${body}</w:abstractNum>`
}

/** The blank template's numbering.xml (bullet numId 1 / decimal numId 2);
 *  base content used when the document has no such part */
export const BLANK_NUMBERING_XML =
  XML_DECL +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  `<w:abstractNum w:abstractNumId="0">${bulletLevels()}</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1">${decimalLevels()}</w:abstractNum>` +
  `<w:num w:numId="${BLANK_BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="${BLANK_ORDERED_NUM_ID}"><w:abstractNumId w:val="1"/></w:num>` +
  '</w:numbering>'

const NUMBERING_XML = BLANK_NUMBERING_XML

export type BlankPaperSize = 'A4' | 'Letter'

/** Word starts new documents on Letter in these OS regions and on A4 everywhere else. */
const LETTER_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'PH',
  'LR',
  'MM',
  'PR',
  'CL',
  'CO',
  'VE',
  'GT',
  'CR',
  'PA',
  'DO',
])

export function paperSizeForRegion(region: string | null | undefined): BlankPaperSize {
  return region && LETTER_REGIONS.has(region.toUpperCase()) ? 'Letter' : 'A4'
}

/** Paper size for a BCP 47 system locale such as `en-US` or `zh-Hans-CN`. */
export function paperSizeForLocale(locale: string | null | undefined): BlankPaperSize {
  if (!locale) return 'A4'
  let region: string | undefined
  try {
    region = new Intl.Locale(locale.replace(/_/g, '-')).maximize().region
  } catch {
    region = undefined
  }
  return paperSizeForRegion(region)
}

const PAPER_TWIPS: Record<BlankPaperSize, { w: number; h: number }> = {
  A4: { w: 11906, h: 16838 },
  Letter: { w: 12240, h: 15840 },
}

export interface BlankDocxOptions {
  /**
   * docDefaults East Asian font (w:eastAsia); pick per UI language so e.g.
   * Japanese/Korean users don't start with a Simplified-Chinese face.
   * When omitted no w:eastAsia is written — like an en-US Word document,
   * Word/our renderer then substitute per script when CJK text appears.
   */
  eastAsiaFont?: string
  /** Page size of the single section; defaults to A4. */
  paperSize?: BlankPaperSize
  font?: string
  fontSizeHalfPoints?: number
  lineSpacingMultiplier?: number
  paragraphSpacingAfterTwips?: number
  pageMarginsTwips?: { top: number; right: number; bottom: number; left: number }
  includePageNumbers?: boolean
  /** default document style set (headings, tables, quote, code, caption, list styles) */
  documentStyles?: DocumentStyles
  /** BCP 47 language of the content, written to docDefaults (w:lang) with documentStyles; default en-US */
  lang?: string
  /** document title, written to docProps/core.xml */
  title?: string
}

/** Build a minimal valid .docx: one empty paragraph, portrait page, standard styles. */
export async function buildBlankDocx(options?: BlankDocxOptions): Promise<Uint8Array> {
  const zip = new JSZip()

  const includePageNumbers = Boolean(options?.includePageNumbers)
  const footerOverride = includePageNumbers
    ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    : ''

  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      footerOverride +
      (options?.title
        ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        : '') +
      '</Types>',
  )

  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      (options?.title
        ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        : '') +
      '</Relationships>',
  )
  if (options?.title) {
    const now = new Date().toISOString().replace(/.d{3}Z$/, 'Z')
    zip.file(
      'docProps/core.xml',
      `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${escXml(options.title)}</dc:title>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
        '</cp:coreProperties>',
    )
  }

  const footerRel = includePageNumbers
    ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
    : ''

  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
      footerRel +
      '</Relationships>',
  )

  zip.file('word/styles.xml', stylesXml(options))
  zip.file('word/numbering.xml', NUMBERING_XML)

  if (includePageNumbers) {
    const footerXml =
      `${XML_DECL}<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>1</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p></w:ftr>'
    zip.file('word/footer1.xml', footerXml)
  }

  const paper = PAPER_TWIPS[options?.paperSize ?? 'A4']
  const margins = options?.pageMarginsTwips ?? { top: 1440, right: 1440, bottom: 1440, left: 1440 }
  const footerRef = includePageNumbers ? '<w:footerReference w:type="default" r:id="rId3"/>' : ''
  const sectPr =
    `<w:sectPr>${footerRef}<w:pgSz w:w="${paper.w}" w:h="${paper.h}"/>` +
    `<w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="708" w:footer="708" w:gutter="0"/>` +
    '</w:sectPr>'
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document ${DOC_NS}><w:body><w:p/>${sectPr}</w:body></w:document>`,
  )

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
