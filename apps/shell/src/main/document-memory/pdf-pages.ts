import { readFileSync, writeFileSync } from 'node:fs'
import { clampPdfPages, DEFAULT_PDF_PAGES } from './chunks'

/** How many pages of each PDF are read and indexed (the person's choice, 30 until they change it). */
export function readPdfPages(file: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && 'maxPages' in value
      ? clampPdfPages((value as { maxPages: unknown }).maxPages)
      : DEFAULT_PDF_PAGES
  } catch {
    return DEFAULT_PDF_PAGES
  }
}

export function writePdfPages(file: string, maxPages: number): void {
  writeFileSync(file, JSON.stringify({ maxPages }), 'utf8')
}
