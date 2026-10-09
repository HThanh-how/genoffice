import iconDocx from './assets/file-docx.svg'
import iconHtml from './assets/file-html.svg'
import iconMd from './assets/file-md.svg'
import iconPdf from './assets/file-pdf.svg'
import iconPptx from './assets/file-pptx.svg'
import iconXlsx from './assets/file-xlsx.svg'

const FILE_ICONS: Record<string, string> = {
  doc: iconDocx,
  docx: iconDocx,
  rtf: iconDocx,
  odt: iconDocx,
  xls: iconXlsx,
  xlsx: iconXlsx,
  csv: iconXlsx,
  ppt: iconPptx,
  pptx: iconPptx,
  pdf: iconPdf,
  md: iconMd,
  markdown: iconMd,
  txt: iconMd,
  html: iconHtml,
  htm: iconHtml,
}

/** Icon for a file's type; unknown types share the plain-text one. */
export function iconFor(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  return FILE_ICONS[ext] ?? iconMd
}

/** The family a file belongs to; each has its own colour (tokens `--file-<kind>` in tokens.css). */
export type FileKind =
  'pdf' | 'sheet' | 'doc' | 'slides' | 'image' | 'video' | 'audio' | 'text' | 'archive' | 'other'

const KIND_BY_EXT: Record<string, FileKind> = {
  pdf: 'pdf',
  xlsx: 'sheet',
  xls: 'sheet',
  xlsm: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  ods: 'sheet',
  docx: 'doc',
  doc: 'doc',
  dotx: 'doc',
  rtf: 'doc',
  odt: 'doc',
  pptx: 'slides',
  ppt: 'slides',
  ppsx: 'slides',
  odp: 'slides',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  heic: 'image',
  tif: 'image',
  tiff: 'image',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  ogg: 'audio',
  aac: 'audio',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  json: 'text',
  xml: 'text',
  html: 'text',
  htm: 'text',
  log: 'text',
  yaml: 'text',
  yml: 'text',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
}

/** Extension of a file name, lower case ('' when it has none). */
export function extensionOf(name: string): string {
  return /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase() ?? ''
}

/** Kind of a file by its extension, case-insensitive; anything unknown is `other`. */
export function fileKindFor(name: string): FileKind {
  return KIND_BY_EXT[extensionOf(name)] ?? 'other'
}

/** Archives and unknown files share the neutral tokens. */
const TOKEN_OF_KIND: Record<FileKind, string> = {
  pdf: 'pdf',
  sheet: 'sheet',
  doc: 'doc',
  slides: 'slides',
  image: 'image',
  video: 'video',
  audio: 'audio',
  text: 'text',
  archive: 'other',
  other: 'other',
}

/** The semantic colour tokens of a file's kind: `fg` for the icon, `soft` for the tinted tile. */
export function fileTypeTokens(name: string): { kind: FileKind; fg: string; soft: string } {
  const kind = fileKindFor(name)
  const token = TOKEN_OF_KIND[kind]
  return { kind, fg: `--file-${token}`, soft: `--file-${token}-soft` }
}
