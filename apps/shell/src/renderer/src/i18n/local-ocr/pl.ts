import type { zh } from './zh'

export const copy = {
  enable: 'Lokalny OCR',
  engine: 'Lokalny silnik OCR',
  auto: 'Automatycznie',
  tesseract: 'Tylko Tesseract',
  vision: 'Apple Vision (zapasowo TrueOCR, Tesseract)',
  autoHint: 'Automatycznie (TrueOCR, zapasowy Tesseract; na macOS najpierw Apple Vision)',
} satisfies Record<keyof typeof zh, string>
