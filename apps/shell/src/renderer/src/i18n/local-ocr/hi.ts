import type { zh } from './zh'

export const copy = {
  enable: 'स्थानीय OCR',
  engine: 'स्थानीय OCR इंजन',
  auto: 'स्वचालित',
  tesseract: 'केवल Tesseract',
  vision: 'Apple Vision (TrueOCR, Tesseract बैकअप)',
  autoHint: 'स्वचालित (TrueOCR, Tesseract बैकअप; macOS पर पहले Apple Vision)',
} satisfies Record<keyof typeof zh, string>
