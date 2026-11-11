import type { zh } from './zh'

export const copy = {
  enable: 'Místní OCR',
  engine: 'Místní OCR engine',
  auto: 'Automaticky',
  tesseract: 'Pouze Tesseract',
  vision: 'Apple Vision (záloha TrueOCR, Tesseract)',
  autoHint: 'Automaticky (TrueOCR, záloha Tesseract; na macOS nejprve Apple Vision)',
} satisfies Record<keyof typeof zh, string>
