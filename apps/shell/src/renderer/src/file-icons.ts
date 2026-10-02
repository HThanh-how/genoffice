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
